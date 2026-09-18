[CmdletBinding()]
param(
    [string]$SourceRoot = '',
    [string]$InstallRoot = '',
    [switch]$PlanOnly,
    [switch]$LibraryOnly
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'quick-payload.ps1')

function Assert-LaunchPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    $candidate = [IO.Path]::GetFullPath($Path)
    $cursor = $candidate
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw '啟動路徑包含連結或重新導向的資料夾，請使用實際安裝目錄。'
            }
        }
        $parent = [IO.Directory]::GetParent($cursor)
        if ($null -eq $parent) { break }
        $cursor = $parent.FullName
    }
    return $candidate
}

function Read-LaunchJson {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    if ((Get-Item -LiteralPath $Path).Length -gt 65536) { throw '啟動設定檔過大。' }
    return ([IO.File]::ReadAllText((Assert-LaunchPath $Path)) | ConvertFrom-Json)
}

function Test-LaunchPayload {
    param([string]$Directory, [string]$Version)
    return (Test-QuickPayload -Root $Directory -Version $Version)
}

function Get-QuickLaunchPlan {
    param([Parameter(Mandatory = $true)][string]$SourceRoot,
          [Parameter(Mandatory = $true)][string]$InstallRoot)
    $source = Assert-LaunchPath $SourceRoot
    $installed = Assert-LaunchPath $InstallRoot
    $manifest = Read-LaunchJson (Join-Path $source 'scripts\quick-start.json')
    if ($null -eq $manifest -or $manifest.version -notmatch '^\d+\.\d+\.\d+$' -or
        $manifest.repository -ne 'mars-tw/ai-console' -or
        $manifest.asset -ne ('ai-console-win32-x64-v' + $manifest.version + '.zip')) {
        throw '快速啟動設定不完整，請重新下載完整的官方壓縮包。'
    }
    if (Test-Path -LiteralPath (Join-Path $source 'AI控制台.exe')) {
        if (-not (Test-LaunchPayload $source $manifest.version)) {
            throw '程式資料夾不完整或版本不符，請重新解壓縮整個 Windows ZIP。'
        }
        return [pscustomobject]@{ mode = 'portable'; version = $manifest.version;
            executable = (Join-Path $source 'AI控制台.exe'); workingDirectory = $source;
            arguments = @('--devspace') }
    }

    # A source checkout may already have been built by its developer.
    $package = Read-LaunchJson (Join-Path $source 'package.json')
    $electron = Join-Path $source 'node_modules\electron\dist\electron.exe'
    if ($null -ne $package -and $package.name -eq 'ai-console' -and
        $package.version -eq $manifest.version -and
        (Test-Path -LiteralPath $electron -PathType Leaf) -and
        (Test-Path -LiteralPath (Join-Path $source 'dist\index.html') -PathType Leaf)) {
        $null = Assert-LaunchPath $electron
        return [pscustomobject]@{ mode = 'source'; version = $package.version;
            executable = $electron; workingDirectory = $source; arguments = @($source, '--devspace') }
    }

    $pointer = Read-LaunchJson (Join-Path $installed 'current.json')
    if ($null -ne $pointer) {
        if ($pointer.version -notmatch '^\d+\.\d+\.\d+$' -or
            $pointer.executable -ne ('versions/' + $pointer.version + '/AI控制台.exe') -or
            [version]$pointer.version -lt [version]$manifest.version) {
            throw '已安裝版本的啟動設定無效或較舊，請重新執行快速安裝。'
        }
        $directory = Join-Path $installed ('versions\' + $pointer.version)
        if (-not (Test-LaunchPayload $directory $pointer.version)) {
            throw '已安裝的程式檔案不完整，請執行快速安裝修復。'
        }
        return [pscustomobject]@{ mode = 'installed'; version = $pointer.version;
            executable = (Join-Path $directory 'AI控制台.exe'); workingDirectory = $directory;
            arguments = @('--devspace') }
    }
    throw '尚未找到可啟動的控制台，請先雙擊「快速安裝.cmd」。'
}

function Invoke-QuickLaunch {
    param([string]$SourceRoot, [string]$InstallRoot, [switch]$PlanOnly)
    $plan = Get-QuickLaunchPlan -SourceRoot $SourceRoot -InstallRoot $InstallRoot
    if ($PlanOnly) { return $plan }
    # Start-Process joins ArgumentList into a Windows command line. Quote the
    # developer checkout path explicitly; filesystem names cannot contain a quote.
    $arguments = '--devspace'
    if ($plan.mode -eq 'source') { $arguments = '"' + $plan.workingDirectory.TrimEnd('\') + '" --devspace' }
    $null = Start-Process -FilePath $plan.executable -ArgumentList $arguments -WorkingDirectory $plan.workingDirectory -PassThru
    return $plan
}

if (-not $LibraryOnly) {
    try {
        if (-not $SourceRoot) { $SourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')) }
        if (-not $InstallRoot) { $InstallRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Programs\AIConsole' }
        $plan = Invoke-QuickLaunch -SourceRoot $SourceRoot -InstallRoot $InstallRoot -PlanOnly:$PlanOnly
        if ($PlanOnly) { $plan | ConvertTo-Json -Depth 4 -Compress }
        else { Write-Host '已啟動 DevSpace 控制台。' }
    } catch {
        Write-Host ('無法啟動：' + $_.Exception.Message) -ForegroundColor Red
        exit 1
    }
}
