// Weight-free GGUF inspection. Files stay owned by the user; no hashes, copies
// or writes are performed. The same checks run before every model load.
#pragma once

#include "gguf.h"
#include "nlohmann/json.hpp"
#include <cstdio>
#include <cstring>
#include <memory>
#include <string>

namespace zt {

inline bool inspect_model(const std::string & path, const std::wstring & widePath,
                          nlohmann::json & result, std::string & code, std::string & detail) {
    auto fail = [&](const char * c, const char * d) { code = c; detail = d; return false; };
    if (path.size() < 5 || _stricmp(path.c_str() + path.size() - 5, ".gguf") != 0)
        return fail("MODEL_FORMAT_UNSUPPORTED", "select a .gguf file");
    std::unique_ptr<FILE, decltype(&fclose)> file(_wfopen(widePath.c_str(), L"rb"), fclose);
    if (!file) return fail("MODEL_NOT_FOUND", "cannot open model file");
    unsigned char header[24] = {};
    if (fread(header, 1, sizeof(header), file.get()) != sizeof(header) || memcmp(header, "GGUF", 4) != 0)
        return fail("MODEL_FORMAT_UNSUPPORTED", "invalid GGUF header");
    uint32_t version = 0;
    memcpy(&version, header + 4, 4);
    if (version != 2 && version != 3) return fail("MODEL_FORMAT_UNSUPPORTED", "unsupported GGUF version");
    _fseeki64(file.get(), 0, SEEK_END);
    const auto bytes = _ftelli64(file.get());
    rewind(file.get());
    gguf_init_params params = {true, nullptr};
    std::unique_ptr<gguf_context, decltype(&gguf_free)> meta(gguf_init_from_file_ptr(file.get(), params), gguf_free);
    if (!meta) return fail("MODEL_FORMAT_UNSUPPORTED", "cannot read GGUF metadata");
    auto stringValue = [&](const std::string & key) -> std::string {
        const auto i = gguf_find_key(meta.get(), key.c_str());
        return i >= 0 && gguf_get_kv_type(meta.get(), i) == GGUF_TYPE_STRING ? gguf_get_val_str(meta.get(), i) : "";
    };
    auto uintValue = [&](const std::string & key, uint64_t fallback) -> uint64_t {
        const auto i = gguf_find_key(meta.get(), key.c_str());
        if (i < 0) return fallback;
        switch (gguf_get_kv_type(meta.get(), i)) {
            case GGUF_TYPE_UINT8: return gguf_get_val_u8(meta.get(), i);
            case GGUF_TYPE_UINT16: return gguf_get_val_u16(meta.get(), i);
            case GGUF_TYPE_UINT32: return gguf_get_val_u32(meta.get(), i);
            case GGUF_TYPE_UINT64: return gguf_get_val_u64(meta.get(), i);
            default: return fallback;
        }
    };
    const std::string arch = stringValue("general.architecture");
    if (arch.empty()) return fail("MODEL_FORMAT_UNSUPPORTED", "missing general.architecture");
    const auto splitCount = uintValue("split.count", 1);
    if (splitCount != 1 || uintValue("split.no", 0) != 0)
        return fail("MODEL_SPLIT_UNSUPPORTED", "only single-file GGUF models are supported");
    const auto kind = stringValue("general.type");
    if (!kind.empty() && kind != "model") return fail("MODEL_FORMAT_UNSUPPORTED", "select a text generation model, not an adapter");
    if (gguf_get_n_tensors(meta.get()) <= 0) return fail("MODEL_FORMAT_UNSUPPORTED", "model contains no tensors");
    const uint64_t dataOffset = gguf_get_data_offset(meta.get());
    if (bytes < 0 || dataOffset > static_cast<uint64_t>(bytes))
        return fail("MODEL_FORMAT_UNSUPPORTED", "truncated GGUF file");
    const uint64_t available = static_cast<uint64_t>(bytes) - dataOffset;
    for (int64_t i = 0; i < gguf_get_n_tensors(meta.get()); ++i) {
        const auto offset = gguf_get_tensor_offset(meta.get(), i);
        const auto size = gguf_get_tensor_size(meta.get(), i);
        if (offset > available || size > available - offset)
            return fail("MODEL_FORMAT_UNSUPPORTED", "truncated GGUF tensor data");
    }
    result = {
        {"v", 1}, {"type", "model-info"}, {"name", stringValue("general.name")},
        {"architecture", arch}, {"contextLength", uintValue(arch + ".context_length", 0)},
        {"chatTemplate", stringValue("tokenizer.chat_template")},
        {"splitCount", splitCount}, {"fileType", uintValue("general.file_type", 0)},
        {"bytes", bytes}, {"ggufVersion", version}
    };
    return true;
}

} // namespace zt
