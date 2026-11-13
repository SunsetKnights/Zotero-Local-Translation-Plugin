// translator-host: UTF-8 JSONL protocol over stdin/stdout.
//
// stdout carries protocol frames only; diagnostics go to stderr. The stdin
// thread answers ping/cancel/shutdown without waiting for inference, a worker
// thread owns the model and the context, and a watcher thread exits when the
// Zotero process that launched us is gone.

#include "engine.h"
#include "parent_watch.h"
#include "model_info.h"

#include "llama.h"
#include "ggml-backend.h"
#include "nlohmann/json.hpp"

#include <windows.h>
#include <io.h>
#include <fcntl.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstring>
#include <cmath>
#include <stdexcept>
#include <deque>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

using json = nlohmann::json;

#ifndef TRANSLATOR_ENGINE_COMMIT
#define TRANSLATOR_ENGINE_COMMIT "unknown"
#endif
#ifndef TRANSLATOR_BUILD_ID
#define TRANSLATOR_BUILD_ID "dev"
#endif

namespace {

constexpr int kProtocolVersion = 1;
constexpr size_t kMaxFrameBytes = 1024 * 1024;
constexpr int64_t kTranslateDeadlineMs = 120000;

std::mutex g_outMutex;

void emit(const json & frame) {
    std::string line = frame.dump(-1, ' ', false, json::error_handler_t::replace);
    line.push_back('\n');
    std::lock_guard<std::mutex> lock(g_outMutex);
    std::fwrite(line.data(), 1, line.size(), stdout);
    std::fflush(stdout);
}

json base_frame(const std::string & type, const std::string & sessionId, const std::string & id) {
    json f;
    f["v"] = kProtocolVersion;
    f["sessionId"] = sessionId;
    f["id"] = id;
    f["type"] = type;
    return f;
}

void log_stderr(const std::string & message) {
    std::fprintf(stderr, "[translator-host] %s\n", message.c_str());
    std::fflush(stderr);
}

// The engine is chatty at INFO level (metadata dumps, tokenizer notes). Only
// warnings and errors reach stderr unless --verbose was requested, which keeps
// the diagnostics channel small and free of prompt content.
bool g_verbose = false;

void engine_log_callback(enum ggml_log_level level, const char * text, void * /*user_data*/) {
    zt::observe_engine_log(text);
    if (g_verbose || level == GGML_LOG_LEVEL_ERROR || level == GGML_LOG_LEVEL_WARN) {
        std::fputs(text, stderr);
        std::fflush(stderr);
    }
}

[[noreturn]] void emit_fatal(const std::string & code, const std::string & detail) {
    json f = base_frame("error", "", "startup");
    f["code"] = code;
    f["retryable"] = false;
    f["detail"] = detail;
    emit(f);
    std::exit(3);
}

struct Options {
    unsigned long parentPid = 0;
    int contextTokens = 8192;
    int threads = 4;
    // < 0 means "all layers" (llama.cpp convention); 0 keeps everything on the CPU
    int gpuLayers = 0;
    bool probeDevices = false;
    std::string inspectModel;
    bool verbose = false;
};

Options parse_options(int argc, char ** argv) {
    Options o;
    for (int i = 1; i < argc; ++i) {
        const std::string a = argv[i];
        auto next = [&](const char * name) -> std::string {
            if (i + 1 >= argc) {
                emit_fatal("ENGINE_START_FAILED", std::string("missing value for ") + name);
            }
            return argv[++i];
        };
        if (a == "--parent-pid") {
            o.parentPid = std::strtoul(next("--parent-pid").c_str(), nullptr, 10);
        }
        else if (a == "--context") {
            o.contextTokens = std::atoi(next("--context").c_str());
        }
        else if (a == "--threads") {
            o.threads = std::atoi(next("--threads").c_str());
        }
        else if (a == "--gpu-layers") {
            o.gpuLayers = std::atoi(next("--gpu-layers").c_str());
        }
        else if (a == "--probe-devices") {
            o.probeDevices = true;
        }
        else if (a == "--inspect-model") {
            o.inspectModel = next("--inspect-model");
        }
        else if (a == "--verbose") {
            o.verbose = true;
        }
        else {
            emit_fatal("ENGINE_START_FAILED", "unknown argument: " + a);
        }
    }
    if (o.contextTokens < 512) o.contextTokens = 512;
    if (o.threads < 1) o.threads = 1;
    if (o.threads > 64) o.threads = 64;
    return o;
}

struct WorkerTask {
    enum class Kind { Init, Translate } kind;
    json frame;
};

struct Shared {
    zt::Engine engine;
    std::atomic<bool> cancel{false};
    std::atomic<bool> shutdown{false};
    std::atomic<bool> ready{false};

    std::mutex mu;
    std::condition_variable cv;
    std::deque<WorkerTask> queue;
    std::string runningTranslateId;
    std::string cancelTarget;
    bool cancelRequested = false;

    std::mutex prefsMu;
};

Shared g_shared;

void enqueue(WorkerTask task) {
    {
        std::lock_guard<std::mutex> lock(g_shared.mu);
        g_shared.queue.push_back(std::move(task));
    }
    g_shared.cv.notify_one();
}

std::wstring widen(const std::string & utf8) {
    if (utf8.empty()) return std::wstring();
    const int n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, utf8.data(), (int) utf8.size(), nullptr, 0);
    if (n <= 0) return std::wstring();
    std::wstring out(n, L'\0');
    MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, utf8.data(), (int) utf8.size(), out.data(), n);
    return out;
}

int g_defaultGpuLayers = 0;

json device_list() {
    json devices = json::array();
    const size_t count = ggml_backend_dev_count();
    for (size_t i = 0; i < count; ++i) {
        ggml_backend_dev_t dev = ggml_backend_dev_get(i);
        json d;
        d["name"] = ggml_backend_dev_name(dev);
        d["description"] = ggml_backend_dev_description(dev);
        const enum ggml_backend_dev_type type = ggml_backend_dev_type(dev);
        d["type"] = type == GGML_BACKEND_DEVICE_TYPE_CPU ? "cpu"
                  : (type == GGML_BACKEND_DEVICE_TYPE_GPU || type == GGML_BACKEND_DEVICE_TYPE_IGPU) ? "gpu"
                  : "accelerator";
        devices.push_back(d);
    }
    return devices;
}

int64_t checked_integer(const json & object, const char * key, int64_t fallback, int64_t min, int64_t max) {
    const auto value = object.value(key, json(fallback));
    if (!value.is_number_integer() || value.get<double>() < min || value.get<double>() > max)
        throw std::runtime_error(std::string("invalid ") + key);
    return value.get<int64_t>();
}

zt::ModelParameters parse_parameters(const json & frame, const json & metadata) {
    zt::ModelParameters p;
    const auto raw = frame.value("modelParameters", json::object());
    if (!raw.is_object()) throw std::runtime_error("modelParameters must be an object");
    auto integer = [&](const char * key, int64_t fallback, int64_t min, int64_t max) -> int64_t {
        return checked_integer(raw, key, fallback, min, max);
    };
    auto number = [&](const char * key, double fallback, double min, double max, bool exclusiveMin = false) -> float {
        const auto value = raw.value(key, json(fallback));
        if (!value.is_number()) throw std::runtime_error(std::string("invalid ") + key);
        const auto n = value.get<double>();
        if (!std::isfinite(n) || n < min || n > max || (exclusiveMin && n == min))
            throw std::runtime_error(std::string("invalid ") + key);
        return static_cast<float>(n);
    };
    p.promptTemplate = raw.value("promptTemplate", zt::default_prompt_template());
    const auto placeholder = p.promptTemplate.find("{text}");
    // UTF-8 byte limits admit the equivalent UTF-16 UI limits for CJK text.
    if (p.promptTemplate.empty() || p.promptTemplate.size() > 131072 || placeholder == std::string::npos
        || p.promptTemplate.find("{text}", placeholder + 6) != std::string::npos)
        throw std::runtime_error("promptTemplate requires exactly one {text}");
    p.chatTemplate = raw.value("chatTemplate", std::string());
    if (p.chatTemplate.size() > 1048576) throw std::runtime_error("chatTemplate is too large");
    const auto legacyContext = checked_integer(frame, "contextTokens", 8192, 512, 131072);
    p.contextTokens = static_cast<int>(integer("contextTokens", legacyContext, 512, 131072));
    p.maxInputTokens = static_cast<int>(integer("maxInputTokens", 2048, 1, 131072));
    p.maxOutputTokens = static_cast<int>(integer("maxOutputTokens", 4096, 1, 131072));
    const auto trainedContext = metadata.value("contextLength", uint64_t(0));
    if ((trainedContext > 0 && static_cast<uint64_t>(p.contextTokens) > trainedContext)
        || p.maxInputTokens + p.maxOutputTokens + zt::kContextMargin >= p.contextTokens)
        throw std::runtime_error("input/output budget exceeds context or model context limit");
    p.temperature = number("temperature", .7, 0, 2);
    p.topP = number("topP", .6, 0, 1, true);
    p.topK = static_cast<int>(integer("topK", 20, 0, 1000));
    p.repeatPenalty = number("repeatPenalty", 1.05, 0, 2, true);
    p.seed = static_cast<uint32_t>(integer("seed", 42, 0, 4294967295LL));
    return p;
}

void handle_init(const json & frame) {
    const std::string sessionId = frame.value("sessionId", std::string());
    const std::string id = frame.value("id", std::string());

    auto fail = [&](const std::string & code, const std::string & detail, bool retryable) {
        json f = base_frame("error", sessionId, id);
        f["code"] = code;
        f["retryable"] = retryable;
        if (!detail.empty()) f["detail"] = detail;
        emit(f);
    };

    if (g_shared.ready.load()) {
        fail("PROTOCOL_ERROR", "session already initialized", false);
        return;
    }

    const std::string modelPath = frame.value("modelPath", std::string());
    if (modelPath.empty()) { fail("MODEL_NOT_FOUND", "select a model file", false); return; }
    json metadata;
    std::string loadError, detail;
    if (!zt::inspect_model(modelPath, widen(modelPath), metadata, loadError, detail)) {
        fail(loadError, detail, false);
        return;
    }
    zt::ModelParameters parameters;
    int threads, gpuLayers;
    bool allowCpuFallback;
    try {
        threads = static_cast<int>(checked_integer(frame, "threads", 4, 1, 64));
        gpuLayers = static_cast<int>(checked_integer(frame, "gpuLayers", g_defaultGpuLayers, -1, 10000));
        const auto fallback = frame.value("allowCpuFallback", json(true));
        if (!fallback.is_boolean()) throw std::runtime_error("allowCpuFallback must be boolean");
        allowCpuFallback = fallback.get<bool>();
        parameters = parse_parameters(frame, metadata);
    }
    catch (const std::exception & e) { fail("MODEL_CONFIG_INVALID", e.what(), false); return; }
    if (!g_shared.engine.load(modelPath, parameters, threads, gpuLayers, allowCpuFallback, loadError)) {
        fail(loadError, "model initialization failed", false);
        return;
    }
    g_shared.ready.store(true);

    json ready = base_frame("ready", sessionId, id);
    ready["modelSha256"] = ""; // compatibility field; no model hashing is performed
    ready["engineCommit"] = TRANSLATOR_ENGINE_COMMIT;
    ready["engineVersion"] = TRANSLATOR_ENGINE_VERSION;
    ready["buildId"] = TRANSLATOR_BUILD_ID;
    ready["contextTokens"] = g_shared.engine.contextTokens();
    ready["threads"] = g_shared.engine.threads();
    ready["gpuLayers"] = g_shared.engine.gpuLayers();
    ready["gpuFallback"] = g_shared.engine.gpuFallback();
    ready["gpuOffloaded"] = g_shared.engine.gpuOffloaded();
    ready["devices"] = device_list();
    ready["templateVersion"] = zt::kTemplateVersion;
    ready["maxInputTokens"] = g_shared.engine.maxInputTokens();
    ready["maxOutputTokens"] = g_shared.engine.maxOutputTokens();
    emit(ready);
}

void handle_translate(const json & frame) {
    const std::string sessionId = frame.value("sessionId", std::string());
    const std::string id = frame.value("id", std::string());
    const std::string text = frame.value("text", std::string());
    const std::string target = frame.value("targetLanguage", std::string());

    auto fail = [&](const std::string & code, const std::string & detail, bool retryable) {
        json f = base_frame("error", sessionId, id);
        f["code"] = code;
        f["retryable"] = retryable;
        if (!detail.empty()) f["detail"] = detail;
        emit(f);
    };

    if (!g_shared.ready.load()) {
        fail("ENGINE_START_FAILED", "engine not initialized", true);
        return;
    }
    if (text.empty()) {
        fail("NO_SELECTION", "empty text", false);
        return;
    }
    if (target != "zh-CN" && target != "en") {
        fail("PROTOCOL_ERROR", "unsupported targetLanguage", false);
        return;
    }

    const int32_t sourceTokens = g_shared.engine.countSourceTokens(text);
    if (sourceTokens > g_shared.engine.maxInputTokens()) {
        json f = base_frame("error", sessionId, id);
        f["code"] = "INPUT_TOO_LONG";
        f["retryable"] = false;
        f["inputTokens"] = sourceTokens;
        f["limit"] = g_shared.engine.maxInputTokens();
        emit(f);
        return;
    }

    {
        std::lock_guard<std::mutex> lock(g_shared.mu);
        if (!g_shared.runningTranslateId.empty()) {
            // only reachable if the caller ignored a busy response
            fail("ENGINE_BUSY", "another translation is running", true);
            return;
        }
        g_shared.runningTranslateId = id;
        g_shared.cancelRequested = false;
        g_shared.cancelTarget.clear();
    }
    g_shared.cancel.store(false);

    zt::Callbacks callbacks;
    callbacks.onStarted = [&](int32_t inputTokens) {
        json f = base_frame("started", sessionId, id);
        f["inputTokens"] = inputTokens;
        emit(f);
    };
    callbacks.onDelta = [&](int seq, const std::string & piece) {
        json f = base_frame("delta", sessionId, id);
        f["seq"] = seq;
        f["text"] = piece;
        emit(f);
    };

    const int64_t deadline = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count() + kTranslateDeadlineMs;

    const zt::GenerateResult result = g_shared.engine.generate(text, target, callbacks, g_shared.cancel, deadline);

    bool cancelWon = false;
    {
        std::lock_guard<std::mutex> lock(g_shared.mu);
        cancelWon = g_shared.cancelRequested && g_shared.cancelTarget == id;
        g_shared.runningTranslateId.clear();
    }

    if (cancelWon) {
        json f = base_frame("cancelled", sessionId, id);
        f["reason"] = "user";
        emit(f);
    }
    else if (result.ok || result.errorCode == "OUTPUT_TRUNCATED") {
        json f = base_frame("result", sessionId, id);
        f["text"] = result.text;
        f["finishReason"] = result.finish == zt::FinishReason::Length ? "length" : "eos";
        f["outputTokens"] = result.outputTokens;
        f["inputTokens"] = result.inputTokens;
        f["timingMs"] = { { "prefill", result.prefillMs }, { "generation", result.generationMs } };
        if (result.errorCode == "OUTPUT_TRUNCATED") f["truncated"] = true;
        emit(f);
    }
    else {
        json f = base_frame("error", sessionId, id);
        f["code"] = result.errorCode.empty() ? "ENGINE_CRASHED" : result.errorCode;
        f["retryable"] = result.retryable;
        f["partialOutputTokens"] = result.outputTokens;
        if (!result.detail.empty()) f["detail"] = result.detail;
        emit(f);
    }
}

void worker_loop() {
    while (true) {
        WorkerTask task;
        {
            std::unique_lock<std::mutex> lock(g_shared.mu);
            g_shared.cv.wait(lock, [] { return g_shared.shutdown.load() || !g_shared.queue.empty(); });
            if (g_shared.shutdown.load() && g_shared.queue.empty()) {
                return;
            }
            task = std::move(g_shared.queue.front());
            g_shared.queue.pop_front();
        }
        try {
            if (task.kind == WorkerTask::Kind::Init) handle_init(task.frame);
            else handle_translate(task.frame);
        }
        catch (const std::exception & e) {
            json error = base_frame("error", task.frame.value("sessionId", std::string()), task.frame.value("id", std::string()));
            error["code"] = "PROTOCOL_ERROR";
            error["retryable"] = false;
            error["detail"] = e.what();
            emit(error);
        }
    }
}

void parent_watch_thread(HANDLE parentHandle) {
    WaitForSingleObject(parentHandle, INFINITE);
    log_stderr("parent process exited, shutting down");
    g_shared.cancel.store(true);
    g_shared.shutdown.store(true);
    g_shared.cv.notify_all();
    // Do not wait for a long generation to unwind: the parent is gone.
    std::this_thread::sleep_for(std::chrono::milliseconds(200));
    std::_Exit(0);
}

void probe_devices() {
    json out;
    out["v"] = kProtocolVersion;
    out["type"] = "devices";
    out["engineCommit"] = TRANSLATOR_ENGINE_COMMIT;
    out["engineVersion"] = TRANSLATOR_ENGINE_VERSION;
    out["buildId"] = TRANSLATOR_BUILD_ID;
    out["devices"] = device_list();
    emit(out);
}

// Reads one LF-terminated frame into `line`. Returns false at EOF.
bool read_frame(std::string & line) {
    static std::string buffer;
    static bool eof = false;
    while (true) {
        const size_t pos = buffer.find('\n');
        if (pos != std::string::npos) {
            line.assign(buffer, 0, pos);
            buffer.erase(0, pos + 1);
            if (!line.empty() && line.back() == '\r') line.pop_back();
            return true;
        }
        if (buffer.size() > kMaxFrameBytes) {
            emit_fatal("PROTOCOL_ERROR", "frame exceeds 1 MiB");
        }
        if (eof) {
            if (buffer.empty()) return false;
            line.swap(buffer);
            buffer.clear();
            if (!line.empty() && line.back() == '\r') line.pop_back();
            return true;
        }
        char chunk[65536];
        // _read returns as soon as some bytes are available; fread would block
        // until the whole buffer is filled, which never happens on a pipe.
        const int got = _read(_fileno(stdin), chunk, (unsigned) sizeof(chunk));
        if (got <= 0) {
            eof = true;
            continue;
        }
        buffer.append(chunk, (size_t) got);
    }
}

} // namespace

int wmain(int argc, wchar_t ** wideArgv) {
    std::vector<std::string> utf8Args;
    std::vector<char *> argv;
    for (int i = 0; i < argc; ++i) {
        const int size = WideCharToMultiByte(CP_UTF8, 0, wideArgv[i], -1, nullptr, 0, nullptr, nullptr);
        std::string arg(size, '\0');
        WideCharToMultiByte(CP_UTF8, 0, wideArgv[i], -1, arg.data(), size, nullptr, nullptr);
        utf8Args.push_back(std::move(arg));
    }
    for (auto & arg : utf8Args) argv.push_back(arg.data());
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);

    const Options options = parse_options(argc, argv.data());
    g_verbose = options.verbose;
    g_defaultGpuLayers = options.gpuLayers;
    llama_log_set(engine_log_callback, nullptr);
    if (!options.inspectModel.empty()) {
        json result;
        std::string code, detail;
        try {
            if (zt::inspect_model(options.inspectModel, widen(options.inspectModel), result, code, detail)) {
                emit(result);
                return 0;
            }
        }
        catch (const std::exception & e) { code = "MODEL_FORMAT_UNSUPPORTED"; detail = e.what(); }
        emit({{"v", 1}, {"type", "error"}, {"code", code}, {"detail", detail}});
        return 2;
    }
    // Backends are separate DLLs; load them from the executable directory before
    // any device enumeration or model load.
    ggml_backend_load_all();
    llama_log_set(engine_log_callback, nullptr);

    if (options.probeDevices) {
        probe_devices();
        return 0;
    }

    HANDLE parentHandle = nullptr;
    const zt::ParentInfo parent = zt::open_parent(options.parentPid, parentHandle);
    if (!parent.handleOpen) {
        emit_fatal("ENGINE_START_FAILED", "parent process validation failed: " + parent.error);
    }

    std::thread watcher(parent_watch_thread, parentHandle);
    watcher.detach();

    std::thread worker(worker_loop);
    worker.detach();

    std::string line;
    while (!g_shared.shutdown.load()) {
        if (!read_frame(line)) {
            log_stderr("stdin closed");
            break;
        }
        if (line.empty()) {
            continue;
        }

        json frame;
        try {
            frame = json::parse(line);
        }
        catch (const std::exception & e) {
            emit_fatal("PROTOCOL_ERROR", std::string("invalid json: ") + e.what());
        }

        const std::string type = frame.value("type", std::string());
        const std::string sessionId = frame.value("sessionId", std::string());
        const std::string id = frame.value("id", std::string());

        if (frame.value("v", 0) != kProtocolVersion) {
            emit_fatal("PROTOCOL_ERROR", "unsupported protocol version");
        }
        if (id.empty()) {
            emit_fatal("PROTOCOL_ERROR", "missing id");
        }

        if (type == "ping") {
            emit(base_frame("pong", sessionId, id));
        }
        else if (type == "init" || type == "translate") {
            WorkerTask task;
            task.kind = type == "init" ? WorkerTask::Kind::Init : WorkerTask::Kind::Translate;
            task.frame = std::move(frame);
            enqueue(std::move(task));
        }
        else if (type == "cancel") {
            const std::string target = frame.value("targetId", std::string());
            std::string outcome = "not-found";
            {
                std::lock_guard<std::mutex> lock(g_shared.mu);
                if (!g_shared.runningTranslateId.empty() && g_shared.runningTranslateId == target) {
                    g_shared.cancelRequested = true;
                    g_shared.cancelTarget = target;
                    outcome = "accepted";
                }
                else if (g_shared.ready.load() && g_shared.runningTranslateId.empty()) {
                    outcome = "already-finished";
                }
            }
            if (outcome == "accepted") {
                g_shared.cancel.store(true);
                // the engine's decode abort callback polls this flag, which is what
                // makes a long prefill interruptible
                zt::g_abortRequested.store(true, std::memory_order_relaxed);
            }
            json ack = base_frame("ack", sessionId, id);
            ack["targetId"] = target;
            ack["outcome"] = outcome;
            emit(ack);
        }
        else if (type == "shutdown") {
            json ack = base_frame("ack", sessionId, id);
            ack["targetId"] = id;
            ack["outcome"] = "accepted";
            emit(ack);
            g_shared.cancel.store(true);
            g_shared.shutdown.store(true);
            g_shared.cv.notify_all();
            break;
        }
        else {
            emit_fatal("PROTOCOL_ERROR", "unknown message type: " + type);
        }
    }

    g_shared.cancel.store(true);
    g_shared.shutdown.store(true);
    g_shared.cv.notify_all();

    // Give the worker a bounded chance to unwind, then exit without waiting.
    for (int i = 0; i < 30; ++i) {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
        std::lock_guard<std::mutex> lock(g_shared.mu);
        if (g_shared.queue.empty() && g_shared.runningTranslateId.empty()) {
            break;
        }
    }
    std::fflush(stdout);
    std::_Exit(0);
}
