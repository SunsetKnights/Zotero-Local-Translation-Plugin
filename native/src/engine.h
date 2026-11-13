// llama.cpp engine wrapper for an external GGUF model. One model, one context,
// one running request. All generation state is reset between requests so a
// cancelled or finished translation cannot leak into the next one.
#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <string>
#include <vector>

struct llama_model;
struct llama_context;
struct llama_vocab;
struct llama_sampler;
struct llama_memory_i;
struct common_chat_templates;

namespace zt {

constexpr int kMaxInputTokens   = 2048;
constexpr int kMaxOutputTokens  = 4096;
constexpr int kContextMargin    = 128;
constexpr const char * kTemplateVersion = "selection-translation-v1";

struct ModelParameters {
    std::string promptTemplate;
    std::string chatTemplate;
    int contextTokens = 8192;
    int maxInputTokens = kMaxInputTokens;
    int maxOutputTokens = kMaxOutputTokens;
    float temperature = 0.7f;
    float topP = 0.6f;
    int topK = 20;
    float repeatPenalty = 1.05f;
    uint32_t seed = 42;
};

std::string default_prompt_template();
// Observe diagnostics even when INFO output is suppressed. The pinned engine
// reports actual layer offload here; an unobserved offload is never a success.
void observe_engine_log(const char * text);

enum class FinishReason {
    Eos,
    Length,
    Cancelled,
    Timeout,
    Error,
};

struct GenerateResult {
    bool ok = false;
    std::string errorCode;
    bool retryable = true;
    std::string detail;
    std::string text;
    FinishReason finish = FinishReason::Error;
    int32_t inputTokens = 0;
    int32_t outputTokens = 0;
    int64_t prefillMs = 0;
    int64_t generationMs = 0;
};

struct Callbacks {
    std::function<void(int32_t inputTokens)> onStarted;
    std::function<void(int seq, const std::string & piece)> onDelta;
};

class Engine {
public:
    Engine() = default;
    ~Engine();

    bool load(const std::string & modelPath, const ModelParameters & parameters,
              int threads, int gpuLayers, bool allowCpuFallback, std::string & error);

    bool loaded() const { return model_ != nullptr && ctx_ != nullptr; }
    int contextTokens() const { return contextTokens_; }
    int threads() const { return threads_; }
    int gpuLayers() const { return gpuLayers_; }
    bool gpuFallback() const { return gpuFallback_; }
    bool gpuOffloaded() const { return gpuOffloaded_; }
    int maxInputTokens() const { return parameters_.maxInputTokens; }
    int maxOutputTokens() const { return parameters_.maxOutputTokens; }

    // Counts tokens of the normalized source text without rendering a prompt.
    int32_t countSourceTokens(const std::string & text) const;

    // Renders the configured translation prompt through the selected chat
    // template, applied exactly once.
    bool buildPrompt(const std::string & text, const std::string & targetLanguage,
                     std::string & prompt, std::string & error) const;

    GenerateResult generate(const std::string & sourceText, const std::string & targetLanguage,
                            const Callbacks & callbacks, std::atomic<bool> & cancel,
                            int64_t deadlineMs);

private:
    void unload();
    bool loadAttempt(const std::string & modelPath, int threads, int gpuLayers, std::string & error);
    void resetState();

    llama_model * model_ = nullptr;
    llama_context * ctx_ = nullptr;
    const llama_vocab * vocab_ = nullptr;
    llama_sampler * sampler_ = nullptr;
    common_chat_templates * chatTemplates_ = nullptr;
    int contextTokens_ = 0;
    int threads_ = 0;
    int gpuLayers_ = 0;
    bool gpuFallback_ = false;
    bool gpuOffloaded_ = false;
    ModelParameters parameters_;
};

extern std::atomic<bool> g_abortRequested;

} // namespace zt
