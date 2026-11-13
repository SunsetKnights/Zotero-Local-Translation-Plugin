# Zotero 本地翻译

[GitHub 仓库](https://github.com/SunsetKnights/Zotero-Local-Translation-Plugin) · [版本发布](https://github.com/SunsetKnights/Zotero-Local-Translation-Plugin/releases)

在 Zotero PDF 阅读器中选中文字，使用本地 GGUF 模型翻译为简体中文。插件自带原生推理程序，模型由用户单独提供；运行时无需联网，也不依赖 Ollama 等外部服务。

支持多套模型配置、Vulkan GPU 加速、CPU 推理、流式译文、取消与重试，以及手动和空闲释放模型。

## 编译环境

- Windows x64；当前原生构建和发行包仅支持 Windows。
- Node.js 22 或更高版本，包含 npm。
- Visual Studio Build Tools，安装“使用 C++ 的桌面开发”，以及 MSVC x64/x86、Windows SDK、CMake、Ninja。
- PowerShell、`curl.exe` 和 `tar.exe`。
- 首次构建需要网络，用于下载 npm 依赖、固定版本的 llama.cpp 源码和官方 Vulkan 库。

原生依赖的版本、下载地址和校验值记录在 [native/vendor.lock.json](native/vendor.lock.json)。脚本使用 Visual Studio 的 `vswhere.exe` 自动定位工具链，并复用官方 Vulkan DLL，因此无需额外安装 Vulkan SDK。

## 从源码编译

在项目根目录打开 PowerShell，执行：

```powershell
npm ci
npm run build
```

`npm run build` 依次检查 TypeScript、编译原生引擎、构建插件、打包并校验 XPI。

也可以分步执行：

```powershell
npm run typecheck
npm run build:native
npm run build:addon
npm run package
npm run verify:package
```

如果下载原生依赖时需要代理，可以单独执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-native.ps1 -Proxy 本地代理地址
npm run build:addon
npm run package
npm run verify:package
```

主要输出：

```text
dist/local-translation-<version>-win-x64-lite.xpi
dist/updates.json
dist/build-manifest.json
dist/SHA256SUMS
```

版本号以 `package.json` 为准。安装包包含推理程序及运行库，不包含模型。`verify:package` 校验包结构、CRC、运行时完整性，以及模型文件是否被错误打包。

修改插件 TypeScript、界面或样式后，重新执行 `build:addon`、`package` 和 `verify:package`。修改原生 C++ 代码或依赖锁文件后，先重新执行 `build:native`。

## 插件更新

Zotero 从仓库根目录的 `updates.json` 读取已发布版本、兼容范围和安装包校验值。XPI 安装包也可以从 GitHub Releases 下载。[更新清单](https://raw.githubusercontent.com/SunsetKnights/Zotero-Local-Translation-Plugin/main/updates.json) · [下载已发布版本](https://github.com/SunsetKnights/Zotero-Local-Translation-Plugin/releases)

## 安装与使用

1. 在 Zotero 的“工具 → 插件”中选择“从文件安装插件”，安装生成的 XPI。插件清单声明兼容 Zotero 8–11。
2. 将模型保存在独立目录。当前支持引擎能够加载的单文件 GGUF 文本生成模型，不支持分片模型、OCR 或整篇文档翻译。建议使用腾讯混元翻译模型，可根据需求选择量化版本，地址：https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF
3. 打开“工具 → 本地翻译设置”，点击“新增”，填写配置名称并选择模型文件。
4. 选择参数预设或填写自定义参数。提示词必须包含且只包含一个 `{text}`；当前目标语言固定为简体中文。聊天模板留空时使用模型内置模板，模型未提供模板时需要手动填写。
5. 点击详情面板底部的“保存当前配置”。这一步只保存路径和参数，不切换当前模型。同一个模型文件可以创建多套配置。
6. 在顶部列表选中配置，点击“切换为当前配置”。实际检测通过后才启用。GPU 检测失败但 CPU 检测成功时，需要明确选择以 CPU 启用；失败或取消会保留原来启用的配置。
7. 打开带有文本层的 PDF，选中文字后点击“翻译”。结果窗口支持查看原文、复制译文、取消和重试。

### 配置管理

- 点击列表的任意位置选择整行，在下方面板查看详情；点击“修改”后编辑。
- 保存正在使用配置的新版本，不会改变当前启用的参数。重新切换并通过检测后才启用更新，重启 Zotero 也会保留这一差别。
- 删除只移除配置记录，不删除模型文件。正在使用的配置需要先切换到其他配置才能删除。
- 翻译、加载、取消收尾和检测期间，不能修改、保存、删除或切换配置。
- 首次升级会迁移旧配置；更早版本已解压到 Zotero 配置目录的模型仍可原地使用。

### 运行与资源设置

每套配置独立保存 CPU 线程数、GPU 策略和 GPU 层数。GPU 层数 `-1` 表示尝试全部层，正整数表示部分层。显存不足时，可以减小 GPU 层数或上下文长度，保存后重新检测。

模型首次翻译时加载，默认保持常驻。通用设置中可以手动释放模型，或开启空闲自动释放；释放后，下一次翻译重新加载已启用的配置。窗口底部持续显示实际模型和引擎状态。

插件会检查 GGUF 基本格式和实际加载结果。模型来源与文件正确性由用户负责；不同架构、量化类型和提示词的兼容性取决于当前引擎。

第三方许可见 [resources/licenses/NOTICE.md](resources/licenses/NOTICE.md)。
