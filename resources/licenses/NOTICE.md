# Third-party notices

This plugin bundles a native inference binary and GPU backend libraries, but no model weights. Each carries its own license; nothing here replaces or overrides
those licenses.

## llama.cpp (engine, CPU backend, helper)

* Source: `https://github.com/ggml-org/llama.cpp`, commit
  `f1a7dea99aae1623bad10c4ce31fe220033ab7f6` (build 11954), unmodified
* License: MIT - full text in `llama.cpp-LICENSE.txt`
* The project compiles the CPU backend variants from that commit; no patches are
  applied. `native/vendor.lock.json` pins the source tarball and its SHA-256.

## Vulkan backend (official prebuilt DLL)

* `ggml-vulkan.dll` and `libomp.dll` are taken unmodified from the official
  llama.cpp release `b11954` (`llama-b11954-bin-win-vulkan-x64.zip`)
* `ggml-vulkan.dll` is covered by the llama.cpp MIT license
* `libomp.dll` is LLVM OpenMP; license text in `LLVM-OpenMP-LICENSE.txt`
* Using the official DLL avoids requiring the Vulkan SDK (shader compiler) on
  build machines; the exact release zip hash is pinned in
  `native/vendor.lock.json`

## nlohmann/json

* Version 3.12.0, vendored inside the llama.cpp tree (`vendor/nlohmann/json.hpp`)
* License: MIT - header text in `nlohmann-json-LICENSE.txt`

## cpp-httplib

* Vendored inside the llama.cpp tree; linked into the helper through
  `llama-common` (the plugin never makes HTTP calls itself)
* License: MIT - full text in `cpp-httplib-LICENSE.txt`

## Microsoft Visual C++ runtime

* `msvcp140*.dll`, `vcruntime140*.dll`, `concrt140.dll`, `vccorlib140.dll` are
  redistributed from the Visual Studio 2026 BuildTools redistributable set
* Redistribution is permitted under the Visual Studio license terms for
  applications built with that toolset

## User-supplied model weights

Models are selected from user-managed files. The plugin does not copy, download,
or verify their SHA-256. Users choose their own model source and applicable license.
