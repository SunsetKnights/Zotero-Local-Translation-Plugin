# Reproducible native build: fetch the pinned llama.cpp source, fetch the official
# Vulkan backend DLL from the same upstream build, build translator-host.exe with
# MSVC, and write resources/runtime-manifest.json.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-native.ps1
#        [-ForceFetch] [-Proxy http://127.0.0.1:10808]

param(
  [switch]$ForceFetch,
  [string]$Proxy = ''
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Lock = Get-Content (Join-Path $Root 'native\vendor.lock.json') -Raw | ConvertFrom-Json
$EngineDir = Join-Path $Root 'build\engine\llama.cpp'
$DownloadDir = Join-Path $Root 'build\download'
$BuildDir = Join-Path $Root 'build\native'
$VendorDir = Join-Path $Root 'build\vendor\win-x64'
$RuntimeDir = Join-Path $Root 'resources\win-x64'
$ProxyArgs = if ($Proxy) { @('-x', $Proxy) } else { @() }

function Assert-ProjectPath([string]$Path) {
  $absolute = [System.IO.Path]::GetFullPath($Path)
  $prefix = [System.IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
  if (-not $absolute.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "path is outside the project: $absolute"
  }
  return $absolute
}

function Remove-ProjectDirectory([string]$Path) {
  $target = Assert-ProjectPath $Path
  if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
}

function Get-VsTools {
  $vswhere = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
  if (-not (Test-Path $vswhere)) { throw 'vswhere.exe not found; install Visual Studio Build Tools' }
  $json = @(& $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -format json | ConvertFrom-Json)
  if (-not $json -or $json.Count -eq 0) { throw 'MSVC toolset not found' }
  $path = $json[0].installationPath
  return @{
    VcVars = Join-Path $path 'VC\Auxiliary\Build\vcvars64.bat'
    CMake = Join-Path $path 'Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe'
    Ninja = Join-Path $path 'Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja\ninja.exe'
    Redist = Join-Path $path 'VC\Redist\MSVC'
    Version = $json[0].installationVersion
  }
}

function Assert-Hash([string]$Path, [string]$Expected, [string]$Label) {
  $actual = (Get-FileHash $Path -Algorithm SHA256).Hash.ToLower()
  if ($actual -ne $Expected) { throw "$Label sha256 mismatch: $actual" }
  Write-Host "$Label sha256 ok: $actual"
}

function Invoke-Download([string]$Url, [string]$Out, [int64]$Bytes) {
  $Out = Assert-ProjectPath $Out
  New-Item -ItemType Directory -Force -Path (Split-Path $Out) | Out-Null
  & curl.exe --fail -sS -L --retry 3 --retry-delay 2 --max-time 1800 @ProxyArgs -o $Out $Url
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $Out)) {
    throw "download failed: $Url; configure -Proxy if GitHub is not reachable"
  }
  if ($Bytes -gt 0 -and (Get-Item -LiteralPath $Out).Length -ne $Bytes) {
    throw "download size mismatch: $Out"
  }
}

Write-Host '=== 1. engine source ==='
if ($ForceFetch -or -not (Test-Path (Join-Path $EngineDir 'CMakeLists.txt'))) {
  $tarball = Join-Path $DownloadDir 'llamacpp-source.tar.gz'
  if ($ForceFetch -or -not (Test-Path $tarball)) {
    Invoke-Download $Lock.source.tarball $tarball $Lock.source.bytes
  }
  Assert-Hash $tarball $Lock.source.sha256 'engine source'
  $engineParent = Split-Path $EngineDir
  $extracted = Assert-ProjectPath (Join-Path $engineParent ('llama.cpp-' + $Lock.engine.commit))
  Remove-ProjectDirectory $EngineDir
  Remove-ProjectDirectory $extracted
  New-Item -ItemType Directory -Force -Path $engineParent | Out-Null
  & tar.exe -xzf $tarball -C $engineParent
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $extracted 'CMakeLists.txt'))) {
    throw 'engine source extraction failed or archive layout does not match the pinned commit'
  }
  $engineTarget = Assert-ProjectPath $EngineDir
  Move-Item -LiteralPath $extracted -Destination $engineTarget
}

Write-Host '=== 2. official Vulkan backend ==='
if ($ForceFetch -or -not (Test-Path (Join-Path $VendorDir 'ggml-vulkan.dll'))) {
  $zip = Join-Path $DownloadDir 'llama-vulkan.zip'
  if ($ForceFetch -or -not (Test-Path $zip)) {
    Invoke-Download $Lock.vulkanBackend.release $zip 0
  }
  Assert-Hash $zip $Lock.vulkanBackend.zipSha256 'vulkan release zip'
  $tmp = Join-Path $BuildDir 'vulkan-extract'
  Remove-ProjectDirectory $tmp
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  New-Item -ItemType Directory -Force -Path $VendorDir | Out-Null
  foreach ($name in @('ggml-vulkan.dll', 'libomp.dll')) {
    Copy-Item (Join-Path $tmp $name) (Join-Path $VendorDir $name) -Force
    Assert-Hash (Join-Path $VendorDir $name) $Lock.vulkanBackend.files.$name "vendor $name"
  }
  Remove-ProjectDirectory $tmp
}

Write-Host '=== 3. configure and build ==='
$tools = Get-VsTools
foreach ($toolPath in @($tools.VcVars, $tools.CMake, $tools.Ninja)) {
  if (-not (Test-Path -LiteralPath $toolPath)) { throw "required Visual Studio build tool missing: $toolPath" }
}
$configure = @(
  '-S', (Join-Path $Root 'native'),
  '-B', $BuildDir,
  '-G', 'Ninja',
  '-DCMAKE_BUILD_TYPE=Release',
  '-DCMAKE_TRY_COMPILE_CONFIGURATION=Release',
  "-DCMAKE_MAKE_PROGRAM=$($tools.Ninja)",
  "-DTRANSLATOR_ENGINE_COMMIT=$($Lock.engine.commit)",
  "-DTRANSLATOR_ENGINE_VERSION=$($Lock.engine.buildNumber)",
  '-DTRANSLATOR_BUILD_ID=release'
)
# A small generated command file keeps the MSVC environment and quoted paths
# together. All directory removal/moving remains in PowerShell above/below.
New-Item -ItemType Directory -Force -Path $BuildDir | Out-Null
$quotedConfigure = ($configure | ForEach-Object { '"' + $_ + '"' }) -join ' '
$buildCommands = @(
  '@echo off',
  ('call "' + $tools.VcVars + '" >nul'),
  'if errorlevel 1 exit /b %errorlevel%',
  ('"' + $tools.CMake + '" ' + $quotedConfigure),
  'if errorlevel 1 exit /b %errorlevel%',
  ('"' + $tools.CMake + '" --build "' + $BuildDir + '" --target translator-host'),
  'exit /b %errorlevel%'
)
$buildScript = Join-Path $BuildDir 'build-runtime.cmd'
[System.IO.File]::WriteAllLines($buildScript, $buildCommands, [System.Text.Encoding]::Default)
& cmd.exe /d /c $buildScript
if ($LASTEXITCODE -ne 0) { throw "native build failed with exit code $LASTEXITCODE" }

Write-Host '=== 4. collect runtime ==='
Remove-ProjectDirectory $RuntimeDir
New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null

$binDir = Join-Path $BuildDir 'bin'
Copy-Item (Join-Path $binDir 'translator-host.exe') $RuntimeDir -Force
foreach ($dll in @('llama.dll', 'llama-common.dll', 'ggml.dll', 'ggml-base.dll')) {
  Copy-Item (Join-Path $binDir $dll) $RuntimeDir -Force
}
Get-ChildItem $binDir -Filter 'ggml-cpu-*.dll' | ForEach-Object { Copy-Item $_.FullName $RuntimeDir -Force }
Copy-Item (Join-Path $VendorDir 'ggml-vulkan.dll') $RuntimeDir -Force
Copy-Item (Join-Path $VendorDir 'libomp.dll') $RuntimeDir -Force

# MSVC runtime DLLs: the official Vulkan DLL is built against the dynamic CRT.
$crt = Get-ChildItem (Join-Path $tools.Redist '*\x64\Microsoft.VC*.CRT') -Directory | Sort-Object Name | Select-Object -Last 1
if ($crt) {
  Get-ChildItem $crt.FullName -Filter '*.dll' | ForEach-Object { Copy-Item $_.FullName $RuntimeDir -Force }
}
else {
  Write-Warning 'MSVC CRT redistributable folder not found; relying on the system runtime'
}

$files = @()
foreach ($file in (Get-ChildItem $RuntimeDir -File | Sort-Object Name)) {
  $files += [pscustomobject]@{
    name = $file.Name
    sha256 = (Get-FileHash $file.FullName -Algorithm SHA256).Hash.ToLower()
    bytes = $file.Length
  }
}

$engineShort = $Lock.engine.commit.Substring(0, 10)
$hostHash = ($files | Where-Object { $_.name -eq 'translator-host.exe' }).sha256
$buildId = "win-x64-vulkan-$engineShort-" + $hostHash.Substring(0, 8)
$manifest = [pscustomobject]@{
  buildId = $buildId
  engineCommit = $Lock.engine.commit
  engineVersion = $Lock.engine.buildNumber
  platform = 'win-x64'
  backends = $Lock.build.backends
  minimumCpu = $Lock.build.minimumCpu
  files = $files
  builtAt = (Get-Date).ToString('o')
  buildOptions = $Lock.build.options
}
# Windows PowerShell 5's Set-Content -Encoding utf8 prepends a BOM, which is
# rejected by JSON.parse in the packager and the Zotero runtime.
$manifestJson = $manifest | ConvertTo-Json -Depth 6
[System.IO.File]::WriteAllText(
  (Join-Path $Root 'resources\runtime-manifest.json'),
  $manifestJson + [Environment]::NewLine,
  (New-Object System.Text.UTF8Encoding($false))
)

Write-Host "runtime build id: $buildId"
$files | ForEach-Object { Write-Host ("  {0,-28} {1,10} bytes" -f $_.name, $_.bytes) }
Write-Host 'manifest: resources\runtime-manifest.json'
