#requires -Version 5.1
<#!
Guided, loopback-only setup for the pinned DevSpace 1.0.8 contract.
Existing configuration, auth and patched installations are never overwritten.
Sources: https://github.com/Waishnav/devspace/tree/v1.0.8/src
         https://git-scm.com/install/windows
         https://learn.microsoft.com/windows/package-manager/winget/install
#>
[CmdletBinding()]
param(
    [switch]$NonInteractive,
    [switch]$PlanOnly,
    [switch]$LibraryOnly,
    [string]$ProjectRoot,
    [ValidateSet('codex', 'claude')][string]$Provider,
    [string]$DevSpaceHome,
    [switch]$InstallPrerequisites,
    [switch]$InstallDevSpace,
    [switch]$Configure
)

function Get-DevSpaceHome {
    param([string]$RequestedPath)
    if ($RequestedPath) { return [IO.Path]::GetFullPath($RequestedPath) }
    if ($env:DEVSPACE_CONFIG_DIR) { return [IO.Path]::GetFullPath($env:DEVSPACE_CONFIG_DIR) }
    return Join-Path ([Environment]::GetFolderPath('UserProfile')) '.devspace'
}

function ConvertTo-DevSpaceNativeArgument {
    param([AllowEmptyString()][string]$Value)
    # Windows CommandLineToArgvW/CRT quoting, including embedded quotes and final backslashes.
    return '"' + ([regex]::Replace($Value, '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"'
}

function Invoke-DevSpaceNative {
    param([string]$Executable, [string[]]$ArgumentList, [int]$TimeoutSeconds = 30)
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $Executable
    $start.Arguments = (($ArgumentList | ForEach-Object { ConvertTo-DevSpaceNativeArgument $_ }) -join ' ')
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.StandardOutputEncoding = New-Object Text.UTF8Encoding($false)
    $start.StandardErrorEncoding = New-Object Text.UTF8Encoding($false)
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $start
    try {
        if (-not $process.Start()) { throw '無法啟動程式。' }
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            $process.Kill()
            throw '檢查逾時。請在終端機手動檢查 Node.js 與 DevSpace。'
        }
        return [pscustomobject]@{ ExitCode = $process.ExitCode; Output = $stdout.Result; Error = $stderr.Result }
    } finally { $process.Dispose() }
}

function Test-DevSpaceNodeVersion {
    param([string]$Version)
    if ($Version -notmatch '^v?(\d+)\.(\d+)\.(\d+)$') { return $false }
    $parsed = [version]($Version -replace '^v', '')
    return $parsed -ge [version]'22.19.0' -and $parsed -lt [version]'27.0.0'
}

function Get-DevSpaceRuntime {
    $node = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    $nodePath = if ($node) { $node.Source } else { $null }
    $version = $null
    if ($nodePath) {
        try {
            $probe = Invoke-DevSpaceNative $nodePath @('--version')
            if ($probe.ExitCode -eq 0) { $version = $probe.Output.Trim() }
        } catch { $version = $null }
    }
    $prefixes = New-Object 'Collections.Generic.List[string]'
    if ($nodePath) { $prefixes.Add((Split-Path -Parent $nodePath)) }
    foreach ($commandName in @('devspace.cmd', 'devspace.ps1', 'npm.cmd')) {
        $command = Get-Command $commandName -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($command -and $command.Source) { $prefixes.Add((Split-Path -Parent $command.Source)) }
    }
    if ($env:APPDATA) { $prefixes.Add((Join-Path $env:APPDATA 'npm')) }
    if ($env:NPM_CONFIG_PREFIX) { $prefixes.Add($env:NPM_CONFIG_PREFIX) }
    $npmCli = $null
    $cli = $null
    foreach ($prefix in ($prefixes | Select-Object -Unique)) {
        $candidate = Join-Path $prefix 'node_modules\npm\bin\npm-cli.js'
        if (-not $npmCli -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { $npmCli = $candidate }
        $candidate = Join-Path $prefix 'node_modules\@waishnav\devspace\dist\cli.js'
        if (-not $cli -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { $cli = $candidate }
    }
    $bash = $null
    $git = Get-Command git.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    $bashCandidates = @()
    if ($env:DEVSPACE_BASH_PATH) { $bashCandidates += $env:DEVSPACE_BASH_PATH }
    if ($env:CLAUDE_CODE_GIT_BASH_PATH) { $bashCandidates += $env:CLAUDE_CODE_GIT_BASH_PATH }
    if ($git) { $bashCandidates += Join-Path (Split-Path -Parent (Split-Path -Parent $git.Source)) 'bin\bash.exe' }
    if ($env:ProgramFiles) { $bashCandidates += Join-Path $env:ProgramFiles 'Git\bin\bash.exe' }
    if (${env:ProgramFiles(x86)}) { $bashCandidates += Join-Path ${env:ProgramFiles(x86)} 'Git\bin\bash.exe' }
    if ($env:LOCALAPPDATA) { $bashCandidates += Join-Path $env:LOCALAPPDATA 'Programs\Git\bin\bash.exe' }
    foreach ($candidate in $bashCandidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { $bash = $candidate; break }
    }
    return [pscustomobject]@{
        NodePath = $nodePath; NodeVersion = $version; NodeCompatible = (Test-DevSpaceNodeVersion $version)
        NpmCliPath = $npmCli; CliPath = $cli; BashPath = $bash; GitPath = $(if ($git) { $git.Source } else { $null })
    }
}

function Get-DevSpaceExistingFiles {
    param([string]$ConfigDirectory)
    $configPaths = @('config.json', 'config.jsonc', 'config.yaml', 'config.yml') | ForEach-Object { Join-Path $ConfigDirectory $_ }
    $existing = @($configPaths | Where-Object { Test-Path -LiteralPath $_ })
    $auth = Join-Path $ConfigDirectory 'auth.json'
    $authExists = Test-Path -LiteralPath $auth
    $supported = @($existing | Where-Object { ([IO.Path]::GetExtension($_) -in @('.json', '.jsonc')) -and (Test-Path -LiteralPath $_ -PathType Leaf) })
    return [pscustomobject]@{
        HasAny = ($existing.Count -gt 0 -or $authExists)
        Complete = (($supported.Count -gt 0) -and $authExists -and (Test-Path -LiteralPath $auth -PathType Leaf))
        ConfigPaths = $existing
    }
}

function Update-DevSpaceProcessPath {
    $paths = @([Environment]::GetEnvironmentVariable('Path', 'Machine'), [Environment]::GetEnvironmentVariable('Path', 'User'), $env:PATH)
    $env:PATH = (($paths | Where-Object { $_ }) -join ';')
}

function Confirm-DevSpaceAction {
    param([string]$Message, [switch]$Explicit, [switch]$Unattended)
    if ($Explicit) { return $true }
    if ($Unattended) { return $false }
    return (Read-Host "$Message [y/N]") -match '^(y|yes)$'
}

function Install-DevSpacePrerequisite {
    param([ValidateSet('OpenJS.NodeJS.LTS', 'Git.Git')][string]$PackageId, [switch]$Unattended)
    $winget = Get-Command winget.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $winget) {
        throw '找不到 winget。請手動安裝 Node.js：https://nodejs.org/en/download，以及 Git for Windows：https://git-scm.com/install/windows，完成後重跑快速安裝。'
    }
    $installArgs = @('install', '--id', $PackageId, '--exact', '--source', 'winget')
    if ($Unattended) { $installArgs += '--disable-interactivity' }
    # Deliberately keep winget's license/source agreement prompts; do not autoaccept them.
    & $winget.Source @installArgs | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "winget 未完成 $PackageId 安裝。請查看上方提示，或到 Node.js／Git 官方網站手動安裝。" }
    Update-DevSpaceProcessPath
}

function Install-DevSpacePackage {
    param($Runtime)
    if (-not $Runtime.NpmCliPath) { throw '找不到 npm-cli.js。請修復 Node.js 的 npm 安裝：https://nodejs.org/en/download。' }
    # Use the real node executable and npm's JavaScript entry, never cmd /c or string-built shell code.
    & $Runtime.NodePath $Runtime.NpmCliPath 'install' '--global' '@waishnav/devspace@1.0.8' | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'DevSpace 安裝失敗。請查看 npm 錯誤訊息，確認網路及 Node.js 安裝後重試。' }
    Update-DevSpaceProcessPath
}

function Test-DevSpaceCli {
    param($Runtime)
    if (-not $Runtime.NodeCompatible -or -not $Runtime.CliPath) { return $false }
    try {
        $result = Invoke-DevSpaceNative $Runtime.NodePath @($Runtime.CliPath, '--version')
        return $result.ExitCode -eq 0 -and $result.Output.Trim() -match '^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$'
    } catch { return $false }
}

function Assert-DevSpacePlainDirectoryAncestry {
    param([string]$Directory)
    $current = [IO.Path]::GetFullPath($Directory)
    while ($current) {
        $item = Get-Item -LiteralPath $current -Force -ErrorAction SilentlyContinue
        if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "路徑包含符號連結或 junction：$current。請改用實際資料夾完整路徑，確認存取範圍後重試。"
        }
        $parent = [IO.Path]::GetDirectoryName($current.TrimEnd('\', '/'))
        if ($parent -eq $current) { break }
        $current = $parent
    }
}

function Resolve-DevSpaceProjectRoot {
    param([string]$Directory)
    if (-not $Directory -or -not [IO.Path]::IsPathRooted($Directory) -or -not (Test-Path -LiteralPath $Directory -PathType Container)) {
        throw '請指定已存在的專案資料夾完整路徑，例如 C:\Projects\my-app。快速安裝不會自動建立或授權整個磁碟。'
    }
    $resolved = (Get-Item -LiteralPath $Directory).FullName
    if ($resolved.TrimEnd('\', '/') -eq [IO.Path]::GetPathRoot($resolved).TrimEnd('\', '/')) {
        throw '請選擇專案子資料夾，不能直接授權整個磁碟。'
    }
    Assert-DevSpacePlainDirectoryAncestry $resolved
    $git = Get-Command git.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($git) {
        # Only inspect metadata. CLI dispatch resolves a Git subdirectory to the repository root.
        $probe = Invoke-DevSpaceNative $git.Source @('-C', $resolved, 'rev-parse', '--show-toplevel') -TimeoutSeconds 8
        if ($probe.ExitCode -eq 0) {
            $gitRoot = [IO.Path]::GetFullPath($probe.Output.Trim()).TrimEnd('\', '/')
            if (-not $gitRoot.Equals($resolved.TrimEnd('\', '/'), [StringComparison]::OrdinalIgnoreCase)) {
                throw "所選資料夾屬於上層 Git 專案：$gitRoot。DevSpace 派工會使用 Git 根目錄；請明確選擇該根目錄後重試，不會自動擴大允許範圍。"
            }
        }
    }
    return $resolved
}

function Assert-DevSpaceFreshVersion {
    param($Runtime)
    $manifestPath = Join-Path (Split-Path -Parent (Split-Path -Parent $Runtime.CliPath)) 'package.json'
    try { $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { throw '無法確認 DevSpace 版本。請先執行 devspace --version，保留現有安裝並使用相同版本的設定方式。' }
    if ($manifest.name -ne '@waishnav/devspace' -or $manifest.version -ne '1.0.8') {
        throw '全新設定精靈適用 DevSpace 1.0.8。已保留你的其他版本；請先依該版本文件完成 devspace init，再重跑快速安裝。'
    }
}

function New-DevSpaceConfiguration {
    param([string]$ConfigDirectory, [string]$Directory, [ValidateSet('codex', 'claude')][string]$SelectedProvider)
    if (Get-DevSpaceExistingFiles $ConfigDirectory | Select-Object -ExpandProperty HasAny) {
        throw '已有 DevSpace 設定或認證檔，已保留原檔。請先檢查現有設定；快速安裝不會覆寫。'
    }
    Assert-DevSpacePlainDirectoryAncestry $ConfigDirectory
    $resolved = Resolve-DevSpaceProjectRoot $Directory
    if (-not $SelectedProvider) { throw '請明確選擇 codex 或 claude。' }
    $config = [ordered]@{
        host = '127.0.0.1'; port = 7676; allowedRoots = @($resolved); publicBaseUrl = $null
        subagents = [ordered]@{ enabled = $true; providers = @([ordered]@{ id = $SelectedProvider; enabled = $true }) }
    }
    $bytes = New-Object byte[] 32
    $random = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $random.GetBytes($bytes) } finally { $random.Dispose() }
    $auth = @{ ownerToken = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_') }
    [IO.Directory]::CreateDirectory($ConfigDirectory) | Out-Null
    # CreateNew prevents even a concurrent setup from replacing credentials or configuration.
    foreach ($entry in @(@{ Name = 'config.json'; Value = $config }, @{ Name = 'auth.json'; Value = $auth })) {
        $file = [IO.File]::Open((Join-Path $ConfigDirectory $entry.Name), [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try {
            $data = (New-Object Text.UTF8Encoding($false)).GetBytes(($entry.Value | ConvertTo-Json -Depth 8) + "`n")
            $file.Write($data, 0, $data.Length)
        } finally { $file.Dispose() }
    }
}

function Show-DevSpaceProviderNextSteps {
    Write-Host 'DevSpace 設定完成。請在桌面控制台選擇專案，再送出工作。'
    Write-Host '派工前仍需安裝並登入所選的 AI 工具；本步驟不會呼叫模型，也不代表帳號有可用額度。'
    Write-Host 'Codex：https://developers.openai.com/codex/cli/'
    Write-Host 'Claude Code：https://code.claude.com/docs/en/setup'
}

function Invoke-DevSpaceSetup {
    param(
        [switch]$Unattended, [switch]$DryRun, [string]$Directory, [string]$SelectedProvider,
        [string]$ConfigDirectory, [switch]$AllowPrerequisites, [switch]$AllowPackage, [switch]$AllowConfiguration
    )
    $ConfigDirectory = Get-DevSpaceHome $ConfigDirectory
    $existing = Get-DevSpaceExistingFiles $ConfigDirectory
    $runtime = Get-DevSpaceRuntime
    if ($DryRun) {
        Write-Host "預覽：DevSpace 設定位置 $ConfigDirectory"
        Write-Host "已有設定或認證檔：$($existing.HasAny)；設定與認證檔齊全：$($existing.Complete)"
        Write-Host "Node.js：$($runtime.NodeVersion)；版本符合：$($runtime.NodeCompatible)；Git Bash：$([bool]$runtime.BashPath)；DevSpace CLI：$([bool]$runtime.CliPath)"
        Write-Host '本次只檢查，不安裝、不建立檔案。已有設定將保留；全新設定只授權你指定的專案資料夾。'
        return
    }
    if ($existing.HasAny -and -not $existing.Complete) {
        throw "DevSpace 設定不完整，已保留 $ConfigDirectory 的全部原檔。請備份後檢查 config.json／config.jsonc 與 auth.json，確認使用原來的 DevSpace 版本修復；不會自動重設認證。"
    }
    if ($runtime.NodePath -and -not $runtime.NodeCompatible) {
        throw "現有 Node.js $($runtime.NodeVersion) 不符合 >=22.19 <27。已保留現有版本；請先使用自己的版本管理工具或 https://nodejs.org/en/download 選擇相容版本，再重跑。"
    }
    if (-not $runtime.NodePath) {
        if (-not (Confirm-DevSpaceAction '缺少 Node.js，要使用 winget 安裝 Node.js LTS 嗎？' -Explicit:$AllowPrerequisites -Unattended:$Unattended)) {
            throw '需要 Node.js >=22.19 <27。請到 https://nodejs.org/en/download 安裝後重跑，或明確指定 -InstallPrerequisites。'
        }
        Install-DevSpacePrerequisite 'OpenJS.NodeJS.LTS' -Unattended:$Unattended
        $runtime = Get-DevSpaceRuntime
        if (-not $runtime.NodeCompatible) { throw '安裝後仍找不到相容的 Node.js。請檢查 PATH 與 https://nodejs.org/en/download，需 >=22.19 <27。' }
    }
    if (-not $runtime.BashPath -or -not $runtime.GitPath) {
        if (-not (Confirm-DevSpaceAction '缺少 Git for Windows／Git Bash，要使用 winget 安裝嗎？' -Explicit:$AllowPrerequisites -Unattended:$Unattended)) {
            throw '需要 Git for Windows 與 Git Bash。請到 https://git-scm.com/install/windows 安裝後重跑，或明確指定 -InstallPrerequisites。'
        }
        Install-DevSpacePrerequisite 'Git.Git' -Unattended:$Unattended
        $runtime = Get-DevSpaceRuntime
        if (-not $runtime.BashPath -or -not $runtime.GitPath) { throw '安裝後仍找不到 Git Bash。請確認 Git for Windows 的安裝位置與 PATH，再重跑。' }
    }
    if ($runtime.CliPath) {
        if (-not (Test-DevSpaceCli $runtime)) { throw '已有 DevSpace 安裝但無法執行，已保留原版本。請執行 devspace --version 檢查錯誤並修復，不會自動重新安裝或覆蓋本機修改。' }
    } else {
        if ($existing.HasAny) { throw '找到現有 DevSpace 設定，但找不到可用 CLI。請恢復原本的安裝與 PATH；為保留本機擴充，本次不會安裝其他版本覆蓋。' }
        if (-not (Confirm-DevSpaceAction '要安裝 DevSpace 1.0.8 嗎？' -Explicit:$AllowPackage -Unattended:$Unattended)) {
            throw '尚未安裝 DevSpace。請重新執行互動式快速安裝，或明確指定 -InstallDevSpace。'
        }
        Install-DevSpacePackage $runtime
        $runtime = Get-DevSpaceRuntime
        if (-not (Test-DevSpaceCli $runtime)) { throw 'DevSpace 安裝後仍無法執行，請檢查上方 npm 訊息與 devspace --version。' }
    }
    if ($existing.Complete) {
        Write-Host "沿用既有 DevSpace 與 $ConfigDirectory 的設定，認證、允許目錄及本機 provider 均保留。"
        Show-DevSpaceProviderNextSteps
        return
    }
    Assert-DevSpaceFreshVersion $runtime
    if ($Unattended -and -not $AllowConfiguration) {
        throw '尚未設定 DevSpace。請重新執行互動式快速安裝，或明確指定 -Configure -ProjectRoot <已存在的專案完整路徑> -Provider codex|claude。'
    }
    if (-not $Directory -and -not $Unattended) { $Directory = Read-Host '允許 DevSpace 存取哪個專案？請輸入已存在的資料夾完整路徑' }
    $Directory = Resolve-DevSpaceProjectRoot $Directory
    if (-not $SelectedProvider -and -not $Unattended) { $SelectedProvider = (Read-Host '要使用哪個執行者？輸入 codex 或 claude').Trim().ToLowerInvariant() }
    if ($SelectedProvider -notin @('codex', 'claude')) { throw '請明確選擇 -Provider codex 或 -Provider claude。' }
    New-DevSpaceConfiguration -ConfigDirectory $ConfigDirectory -Directory $Directory -SelectedProvider $SelectedProvider
    Write-Host "已建立本機設定：$ConfigDirectory；允許目錄：$Directory；執行者：$SelectedProvider。"
    Write-Host '服務僅監聽 127.0.0.1:7676。'
    Show-DevSpaceProviderNextSteps
}

if (-not $LibraryOnly) {
    $ErrorActionPreference = 'Stop'
    try {
        Invoke-DevSpaceSetup -Unattended:$NonInteractive -DryRun:$PlanOnly -Directory $ProjectRoot -SelectedProvider $Provider -ConfigDirectory $DevSpaceHome -AllowPrerequisites:$InstallPrerequisites -AllowPackage:$InstallDevSpace -AllowConfiguration:$Configure
        exit 0
    } catch {
        Write-Host ("DevSpace 快速設定未完成：" + $_.Exception.Message) -ForegroundColor Red
        exit 1
    }
}
