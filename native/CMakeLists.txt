cmake_minimum_required(VERSION 3.20)

# translator-host: the native inference helper shipped with the plugin.
#
# The engine is upstream llama.cpp pinned by commit. Backends are separate DLLs
# (GGML_BACKEND_DL): the CPU variants are built here, and the Vulkan backend is
# the official DLL from the same upstream release, so no Vulkan SDK is needed to
# produce the package.
set(TRANSLATOR_ENGINE_COMMIT "unknown" CACHE STRING "llama.cpp commit the engine was built from")
set(TRANSLATOR_ENGINE_VERSION "unknown" CACHE STRING "llama.cpp build number")
set(TRANSLATOR_BUILD_ID "dev" CACHE STRING "runtime build id")
option(TRANSLATOR_WITH_VULKAN "Build the Vulkan backend from source (requires Vulkan SDK)" OFF)

set(LLAMA_CPP_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../build/engine/llama.cpp" CACHE PATH "Pinned llama.cpp source tree")
if(NOT EXISTS "${LLAMA_CPP_DIR}/CMakeLists.txt")
    message(FATAL_ERROR "llama.cpp source not found at ${LLAMA_CPP_DIR}; run scripts/build-native.ps1 to fetch it")
endif()

# Shared llama/ggml plus dynamically loaded backends: this is what lets the
# helper use the official Vulkan backend DLL without compiling shaders.
set(BUILD_SHARED_LIBS ON CACHE BOOL "" FORCE)
set(GGML_BACKEND_DL ON CACHE BOOL "" FORCE)
set(GGML_CPU_ALL_VARIANTS ON CACHE BOOL "" FORCE)

set(LLAMA_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_TOOLS OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_SERVER OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_COMMON ON CACHE BOOL "" FORCE)
# Local inference needs no HTTPS. LLAMA_CURL is ignored by this llama.cpp
# version; leaving OpenSSL enabled links DLLs found only on the build runner.
set(LLAMA_OPENSSL OFF CACHE BOOL "" FORCE)
set(GGML_CCACHE OFF CACHE BOOL "" FORCE)
set(GGML_RPC OFF CACHE BOOL "" FORCE)

# MSVC OpenMP would add vcomp140.dll to the shipped runtime for little gain.
set(GGML_OPENMP OFF CACHE BOOL "" FORCE)

if(TRANSLATOR_WITH_VULKAN)
    set(GGML_VULKAN ON CACHE BOOL "" FORCE)
else()
    set(GGML_VULKAN OFF CACHE BOOL "" FORCE)
endif()

project(translator_host CXX C)

add_subdirectory("${LLAMA_CPP_DIR}" "${CMAKE_BINARY_DIR}/llama.cpp" EXCLUDE_FROM_ALL)

add_executable(translator-host
    src/main.cpp
    src/engine.cpp
)

target_compile_features(translator-host PRIVATE cxx_std_17)
if(MSVC)
    # llama.cpp common headers contain UTF-8 string literals (jinja / chat templates)
    target_compile_options(translator-host PRIVATE /utf-8)
endif()
target_compile_definitions(translator-host PRIVATE
    TRANSLATOR_ENGINE_COMMIT="${TRANSLATOR_ENGINE_COMMIT}"
    TRANSLATOR_ENGINE_VERSION="${TRANSLATOR_ENGINE_VERSION}"
    TRANSLATOR_BUILD_ID="${TRANSLATOR_BUILD_ID}"
    NOMINMAX
    WIN32_LEAN_AND_MEAN
)
target_link_libraries(translator-host PRIVATE llama llama-common)
target_include_directories(translator-host PRIVATE
    "${LLAMA_CPP_DIR}/include"
    "${LLAMA_CPP_DIR}/common"
    "${LLAMA_CPP_DIR}/ggml/include"
    "${LLAMA_CPP_DIR}/vendor"
)

set_target_properties(translator-host PROPERTIES
    OUTPUT_NAME "translator-host"
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin"
)

