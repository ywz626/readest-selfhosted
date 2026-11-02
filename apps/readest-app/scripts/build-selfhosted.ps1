<#
.SYNOPSIS
  Readest 自托管版一键打包（Windows / Android）。

.DESCRIPTION
  把三个反复踩坑的环节固化下来：

    1) NODE_OPTIONS：终端里可能被注入了
       `--require=.../node-language-shim.cjs`（VS Code 扩展干的），Next 的构建
       worker 会继承它，在 "Creating an optimized production build" 阶段以
       0xC0000409 崩溃。而且 dotenv 默认不覆盖已存在的变量，所以
       .env.tauri.local 里的 --max-old-space-size 也失效。脚本统一覆盖成固定堆大小。

    2) 前置检查：Rust target、签名文件、env 文件缺什么直接报错，
       而不是等到 next build 跑完 5 分钟才失败。

    3) 产物定位：只列出「本次构建之后」生成的安装包，避免和旧包混淆。

  自托管相关的环境变量（NEXT_PUBLIC_SELFHOSTED / NEXT_PUBLIC_API_BASE_URL）由
  tauri.conf.json 的 beforeBuildCommand 从 .env.tauri.local + .env.server 读取，
  与手工命令完全一致。

  注意：本文件必须保持 UTF-8 with BOM。Windows PowerShell 5.1 会把「无 BOM 的
  UTF-8」按 GBK 解码，中文注释会直接变成语法错误（ps7 没这问题，所以容易漏测）。

.PARAMETER Target
  打哪个平台：windows（默认）/ android / all。

.PARAMETER WinArch
  Windows 架构：x64（默认）/ arm64 / x86。

.PARAMETER WinBundles
  Windows 安装包格式：nsis（默认）/ msi / all。

.PARAMETER AndroidFormat
  universal（默认，单个 APK 内含 arm64-v8a + armeabi-v7a）
  split（按 ABI 拆分，包更小）
  aab（Google Play 用）

.PARAMETER Devtools
  构建时启用 devtools 特性（release 包里可开调试面板），默认关闭。

.PARAMETER HeapMb
  Node 堆上限，默认 6144。机器空闲内存不足时往下调。

.PARAMETER SkipFrontend
  复用已有的 out/（不重新跑 next build）。node 构建是内存大户，也是 0xC0000409
  的头号受害者：先单独把前端构建成功，再用本开关只做打包/签名，可避免同一个坑
  反复踩。前提是 out/ 已是最新产物。

.PARAMETER DryRun
  只打印将要执行的命令，不做任何构建。

.EXAMPLE
  .\scripts\build-selfhosted.ps1

.EXAMPLE
  .\scripts\build-selfhosted.ps1 -Target android

.EXAMPLE
  .\scripts\build-selfhosted.ps1 -Target all -AndroidFormat split -WinBundles all

.EXAMPLE
  .\scripts\build-selfhosted.ps1 -Target android -DryRun
#>
[CmdletBinding()]
param(
    [ValidateSet('windows', 'android', 'all')]
    [string]$Target = 'windows',

    [ValidateSet('x64', 'arm64', 'x86')]
    [string]$WinArch = 'x64',

    [ValidateSet('nsis', 'msi', 'all')]
    [string]$WinBundles = 'nsis',

    [ValidateSet('universal', 'split', 'aab')]
    [string]$AndroidFormat = 'universal',

    [switch]$Devtools,

    [ValidateRange(2048, 16384)]
    [int]$HeapMb = 6144,

    [switch]$SkipFrontend,

    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:AppDir = Split-Path -Parent $PSScriptRoot
$script:DryRun = [bool]$DryRun
# 预置：StrictMode Latest 下，未赋值的变量连读都会报错，而 finally 里要读它。
$script:OriginalNodeOptions = $null

function Write-Step {
    param([string]$Text)
    Write-Host ''
    Write-Host "==> $Text" -ForegroundColor Cyan
}

function Write-Info {
    param([string]$Text)
    Write-Host "    $Text" -ForegroundColor DarkGray
}

function Write-Ok {
    param([string]$Text)
    Write-Host "  ok  $Text" -ForegroundColor Green
}

function Write-WarnLine {
    param([string]$Text)
    Write-Host "  !   $Text" -ForegroundColor Yellow
}

function Format-ExitCode {
    param([int]$Code)
    # -1073740791 -> 0xC0000409，直接给人看的十六进制更利于查资料
    $hex = '{0:X8}' -f ($Code -band 0xFFFFFFFF)
    return "$Code (0x$hex)"
}

function Invoke-Pnpm {
    param([string[]]$PnpmArgs)

    $quoted = ($PnpmArgs | ForEach-Object {
            if ($_ -match '[\s{}"]') { '"' + $_ + '"' } else { $_ }
        }) -join ' '

    if ($script:DryRun) {
        Write-Host "  [dry-run] pnpm $quoted" -ForegroundColor Magenta
        return $true
    }

    Write-Info "pnpm $quoted"
    & pnpm @PnpmArgs
    $code = $LASTEXITCODE
    if ($code -ne 0) {
        $hint = ''
        if (($code -band 0xFFFFFFFF) -eq 0xC0000409) {
            $hint = ' NODE_OPTIONS 里若还有 --require（node-language-shim），next build 会在编译阶段崩溃，先清掉再试。'
        }
        throw "构建失败，退出码 $(Format-ExitCode $code)。$hint"
    }
    return $true
}

function Assert-Command {
    param([string]$Name)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "找不到命令 '$Name'，请先安装并加入 PATH。"
    }
}

function Get-InstalledRustTargets {
    $out = & rustup target list --installed 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "无法读取 rustup 目标列表：$out"
    }
    return @($out | ForEach-Object { $_.ToString().Trim() } | Where-Object { $_ -ne '' })
}

function Assert-RustTarget {
    param([string]$TargetTriple)
    if ($script:RustTargets -notcontains $TargetTriple) {
        throw "缺少 Rust 目标 '$TargetTriple'。先执行： rustup target add $TargetTriple"
    }
    Write-Ok "rust target $TargetTriple"
}

function Get-WindowsTriple {
    param([string]$Arch)
    switch ($Arch) {
        'x64' { return 'x86_64-pc-windows-msvc' }
        'arm64' { return 'aarch64-pc-windows-msvc' }
        'x86' { return 'i686-pc-windows-msvc' }
        default { throw "不支持的 Windows 架构：$Arch" }
    }
}

function Show-Artifacts {
    param(
        [datetime]$Since,
        [string]$Directory,
        [string]$Filter
    )

    if (-not (Test-Path -LiteralPath $Directory)) {
        Write-WarnLine "产物目录不存在：$Directory"
        return
    }

    $files = @(Get-ChildItem -LiteralPath $Directory -Recurse -File -Filter $Filter -ErrorAction SilentlyContinue |
            Where-Object { $_.LastWriteTime -ge $Since } |
            Sort-Object LastWriteTime)

    if ($files.Count -eq 0) {
        Write-WarnLine "该目录下没有本次新生成的 $Filter（可能是缓存命中，未重新打包）"
        return
    }

    Write-Host '  本次产物：' -ForegroundColor Green
    foreach ($f in $files) {
        $mb = [math]::Round($f.Length / 1MB, 1)
        Write-Host ("    {0}  ({1} MB)" -f $f.FullName, $mb) -ForegroundColor Green
    }
}

# Windows 的 bundle 目录可能落在 src-tauri/target（默认）或仓库根的 target
# （src-tauri 属于上层 cargo workspace 时就是后者），两个都探一遍。
function Get-BundleDirs {
    param([string]$Triple)
    $candidates = @(
        (Join-Path $script:AppDir "src-tauri/target/$Triple/release/bundle"),
        (Join-Path $script:AppDir "../../target/$Triple/release/bundle")
    )
    return @($candidates |
            Where-Object { Test-Path -LiteralPath $_ } |
            ForEach-Object { (Resolve-Path -LiteralPath $_).Path })
}

function Invoke-WindowsBuild {
    $triple = Get-WindowsTriple $WinArch
    Assert-RustTarget $triple

    # `--bundles` only takes msi/nsis (comma separated). "all" is the
    # tauri.conf.json spelling, not a CLI value.
    $bundleArg = if ($WinBundles -eq 'all') { 'msi,nsis' } else { $WinBundles }

    Write-Step "Windows $WinArch ($triple)，bundle = $bundleArg"
    if ($Devtools) { Write-Info '启用 devtools 特性' }
    if ($bundleArg -match 'msi' -and $script:ProductName -match '[^\x00-\x7F]') {
        # WiX 3 的 MSI 数据库是 ANSI 代码页，中文产品名会让 light.exe 失败
        # （"failed to run ... light.exe"）。这不是本仓库的配置问题。
        Write-WarnLine ("产品名「{0}」含非 ASCII 字符，MSI 会被 WiX 拒绝；这个平台请用 -WinBundles nsis" -f $script:ProductName)
    }

    $pnpmArgs = @(
        'exec', 'dotenv',
        '-e', '.env.tauri.local',
        '-e', '.env.server',
        '--', 'tauri', 'build',
        '--target', $triple,
        '--bundles', $bundleArg
    )
    if ($Devtools) { $pnpmArgs += @('--features', 'devtools') }
    if ($SkipFrontend) { $pnpmArgs += @('--config', '{"build":{"beforeBuildCommand":null}}') }

    $since = Get-Date
    Invoke-Pnpm -PnpmArgs $pnpmArgs | Out-Null

    if (-not $script:DryRun) {
        $bundleDirs = @(Get-BundleDirs $triple)
        if ($bundleDirs.Count -eq 0) {
            Write-WarnLine "未找到 bundle 目录（target-dir 可能被自定义了）：$triple"
        }
        foreach ($bundleDir in $bundleDirs) {
            Show-Artifacts -Since $since -Directory $bundleDir -Filter '*.exe'
            Show-Artifacts -Since $since -Directory $bundleDir -Filter '*.msi'
        }
    }
}

function Invoke-AndroidBuild {
    Assert-RustTarget 'aarch64-linux-android'
    Assert-RustTarget 'armv7-linux-androideabi'

    Write-Step "Android（arm64-v8a + armeabi-v7a），格式 = $AndroidFormat"

    $keystore = Join-Path $script:AppDir 'src-tauri/gen/android/keystore.properties'
    if (Test-Path -LiteralPath $keystore) {
        Write-Ok '找到 keystore.properties（release 包会被签名）'
    }
    else {
        Write-WarnLine '未找到 src-tauri/gen/android/keystore.properties，产物将是未签名包（装不上）'
    }

    $propsPath = Join-Path $script:AppDir 'src-tauri/gen/android/app/tauri.properties'
    if (Test-Path -LiteralPath $propsPath) {
        $nameMatch = Select-String -LiteralPath $propsPath -Pattern '^tauri\.android\.versionName=(.*)$'
        $codeMatch = Select-String -LiteralPath $propsPath -Pattern '^tauri\.android\.versionCode=(.*)$'
        if ($nameMatch -and $codeMatch) {
            Write-Info ("当前 versionName={0} versionCode={1}（覆盖安装必须递增 versionCode）" -f $nameMatch.Matches[0].Groups[1].Value, $codeMatch.Matches[0].Groups[1].Value)
        }
    }

    if (-not $env:NDK_HOME -and -not $env:ANDROID_NDK_HOME) {
        Write-WarnLine '未设置 NDK_HOME / ANDROID_NDK_HOME，Gradle 的 llvm-strip 步骤可能失败'
    }
    if ($Devtools) { Write-Info '启用 devtools 特性' }

    $pnpmArgs = @(
        'exec', 'dotenv',
        '-v', 'KEEP_SOURCEMAPS=1',
        '-e', '.env.tauri',
        '-e', '.env.tauri.local',
        '-e', '.env.server',
        '--', 'tauri', 'android', 'build',
        '-t', 'aarch64',
        '-t', 'armv7'
    )
    switch ($AndroidFormat) {
        'universal' { $pnpmArgs += @('--apk') }
        'split' { $pnpmArgs += @('--split-per-abi', '--apk') }
        'aab' { $pnpmArgs += @('--split-per-abi', '--aab') }
    }
    if ($Devtools) { $pnpmArgs += @('--features', 'devtools') }
    if ($SkipFrontend) { $pnpmArgs += @('--config', '{"build":{"beforeBuildCommand":null}}') }

    $since = Get-Date
    Invoke-Pnpm -PnpmArgs $pnpmArgs | Out-Null

    if (-not $script:DryRun) {
        $outputs = Join-Path $script:AppDir 'src-tauri/gen/android/app/build/outputs'
        Show-Artifacts -Since $since -Directory $outputs -Filter '*.apk'
        Show-Artifacts -Since $since -Directory $outputs -Filter '*.aab'
    }
}

# ---------------------------------------------------------------- main

Push-Location $script:AppDir
try {
    Write-Step "工作目录 $script:AppDir"

    Assert-Command 'pnpm'
    Assert-Command 'rustup'

    $localEnv = Join-Path $script:AppDir '.env.tauri.local'
    if (-not (Test-Path -LiteralPath $localEnv)) {
        throw "缺少 .env.tauri.local（里面是 NEXT_PUBLIC_API_BASE_URL 等自托管配置），请先创建。"
    }
    Write-Ok '.env.tauri.local'

    # 产品名决定 MSI 里那些 ASCII 列，中文名会让 WiX 的 light.exe 直接失败
    $script:ProductName = ''
    $confPath = Join-Path $script:AppDir 'src-tauri/tauri.conf.json'
    if (Test-Path -LiteralPath $confPath) {
        try {
            $script:ProductName = ([System.IO.File]::ReadAllText($confPath) | ConvertFrom-Json).productName
        }
        catch {
            $script:ProductName = ''
        }
    }

    # ① NODE_OPTIONS：覆盖掉 shim，同时把堆固定下来。
    # 记下原值，交给 finally 还原，避免污染调用方会话里的后续 pnpm/next。
    $script:OriginalNodeOptions = $env:NODE_OPTIONS
    if ($script:OriginalNodeOptions) {
        Write-WarnLine "检测到已存在的 NODE_OPTIONS，将被覆盖：$script:OriginalNodeOptions"
    }
    $env:NODE_OPTIONS = "--max-old-space-size=$HeapMb"
    Write-Ok "NODE_OPTIONS=$env:NODE_OPTIONS"

    # ② 内存：next build 峰值很吃内存，提前提醒而不是等它崩
    $os = Get-CimInstance Win32_OperatingSystem
    $freeGb = [math]::Round($os.FreePhysicalMemory / 1MB, 1)
    if ($freeGb -lt 6) {
        Write-WarnLine "当前可用物理内存仅 $freeGb GB，构建可能 OOM；建议先关掉浏览器/游戏，或用 -HeapMb 降到 4096"
    }
    else {
        Write-Info "可用物理内存 $freeGb GB"
    }

    # ③ 复用已有前端产物时，先确认它真的存在
    if ($SkipFrontend) {
        $outDir = Join-Path $script:AppDir 'out'
        if (-not (Test-Path -LiteralPath $outDir)) {
            throw "out/ 不存在，无法 -SkipFrontend。先跑一次完整构建（不带该开关）。"
        }
        $newestOut = Get-ChildItem -LiteralPath $outDir -Recurse -File -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($newestOut) {
            Write-WarnLine ("复用已有前端产物 out/（最新 {0}），不会重新跑 next build" -f $newestOut.LastWriteTime)
        }
    }

    # ④ Rust 目标
    $script:RustTargets = Get-InstalledRustTargets

    if ($Target -eq 'windows' -or $Target -eq 'all') {
        Invoke-WindowsBuild
    }
    if ($Target -eq 'android' -or $Target -eq 'all') {
        Invoke-AndroidBuild
    }

    Write-Step '完成'
    if ($script:DryRun) {
        Write-Host '  [dry-run] 以上命令未实际执行' -ForegroundColor Magenta
    }
    exit 0
}
catch {
    Write-Host ''
    Write-Host "  x  $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
finally {
    # 别把副作用留给调用方：$env: 是进程级的，脚本返回后同一个窗口里的
    # 后续 pnpm/next 仍会读到被改写的 NODE_OPTIONS。
    if ($script:OriginalNodeOptions) {
        $env:NODE_OPTIONS = $script:OriginalNodeOptions
    }
    else {
        Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
    }
    Pop-Location
}
