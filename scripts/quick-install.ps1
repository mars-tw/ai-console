[CmdletBinding()]
param(
    [string]$SourceRoot = '',
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'Programs\AIConsole'),
    [switch]$NonInteractive,
    [switch]$SkipDevSpace,
    [switch]$NoLaunch,
    [switch]$PlanOnly,
    [switch]$LibraryOnly
)

$ErrorActionPreference = 'Stop'
$script:InstallerDirectory = $PSScriptRoot
if (-not $SourceRoot) { $SourceRoot = Split-Path -Parent $PSScriptRoot }
. (Join-Path $PSScriptRoot 'quick-payload.ps1')

function Assert-SafePath([string]$Path) {
    $full = [IO.Path]::GetFullPath($Path)
    if ($full.StartsWith('\\')) { throw 'Network and device paths are not supported by quick install.' }
    $cursor = $full
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'Linked files, junctions, and linked parent directories are not supported.'
            }
        }
        $parent = [IO.Path]::GetDirectoryName($cursor)
        if ($parent -eq $cursor) { break }
        $cursor = $parent
    }
    return $full
}

function Assert-ChildPath([string]$Path, [string]$Parent) {
    $full = Assert-SafePath $Path
    $base = (Assert-SafePath $Parent).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    if (-not $full.StartsWith($base, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Installer destination escaped its intended directory.'
    }
    return $full
}

function Get-QuickInstallManifest {
    $path = Assert-SafePath (Join-Path $script:InstallerDirectory 'quick-start.json')
    $pin = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($pin.version -notmatch '^\d+\.\d+\.\d+$' -or $pin.repository -cne 'mars-tw/ai-console' -or
        $pin.asset -cne ('ai-console-win32-x64-v' + $pin.version + '.zip')) {
        throw 'The quick-start release manifest is invalid.'
    }
    return $pin
}

function Test-PortablePayload([string]$Root, [string]$Version) {
    return (Test-QuickPayload -Root $Root -Version $Version -VerifyHashes)
}

function Get-PayloadInventory([string]$Root) {
    $base = (Assert-SafePath $Root).TrimEnd('\', '/')
    $pending = New-Object 'System.Collections.Generic.Stack[string]'
    $pending.Push($base)
    $files = @{}
    while ($pending.Count -gt 0) {
        foreach ($item in Get-ChildItem -LiteralPath $pending.Pop() -Force) {
            $null = Assert-ChildPath $item.FullName $base
            if ($item.PSIsContainer) { $pending.Push($item.FullName); continue }
            $relative = $item.FullName.Substring($base.Length + 1).Replace('\', '/')
            if ($files.ContainsKey($relative)) { throw 'Duplicate file paths in app payload.' }
            $files[$relative] = Get-Sha256 $item.FullName
        }
    }
    return $files
}

function Get-Sha256([string]$Path) {
    $stream = [IO.File]::OpenRead((Assert-SafePath $Path))
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '') }
    finally { $sha.Dispose(); $stream.Dispose() }
}

function Test-EqualInventory($First, $Second) {
    if ($First.Count -ne $Second.Count) { return $false }
    foreach ($key in $First.Keys) {
        if (-not $Second.ContainsKey($key) -or $First[$key] -cne $Second[$key]) { return $false }
    }
    return $true
}

function Expand-SafeArchive {
    param([string]$Archive, [string]$Destination, [long]$MaxExpandedBytes = 2147483648, [int]$MaxEntries = 50000)
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archivePath = Assert-SafePath $Archive
    $target = Assert-SafePath $Destination
    if (Test-Path -LiteralPath $target) { throw 'Archive destination must be new.' }
    $zip = [IO.Compression.ZipFile]::OpenRead($archivePath)
    try {
        $seen = @{}
        $entries = New-Object 'System.Collections.Generic.List[object]'
        [long]$expanded = 0
        if ($zip.Entries.Count -gt $MaxEntries) { throw 'Archive has too many entries.' }
        foreach ($entry in $zip.Entries) {
            $name = $entry.FullName.Replace('\', '/')
            $directory = $name.EndsWith('/')
            $name = $name.TrimEnd('/')
            if (-not $name -or $name.StartsWith('/') -or $name.Contains(':')) { throw 'Unsafe archive path.' }
            foreach ($part in $name.Split('/')) {
                if (-not $part -or $part -in @('.', '..') -or $part -match '[. ]$' -or
                    $part -match '[\x00-\x1f<>"|?*]' -or $part -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') {
                    throw 'Unsafe archive path.'
                }
            }
            [long]$attributes = $entry.ExternalAttributes
            $unixType = ($attributes -shr 16) -band 61440
            if (($attributes -band 1024) -ne 0 -or ($unixType -notin @(0, 32768, 16384))) {
                throw 'Archive links and special files are not supported.'
            }
            if ($seen.ContainsKey($name)) { throw 'Archive contains duplicate or case-colliding paths.' }
            $seen[$name] = $directory
            $expanded += $entry.Length
            if ($expanded -gt $MaxExpandedBytes -or ($entry.Length -gt 1048576 -and $entry.Length -gt ($entry.CompressedLength * 1000))) {
                throw 'Archive expansion exceeds the installer limits.'
            }
            $file = Assert-ChildPath (Join-Path $target $name) $target
            $entries.Add(@{ Entry = $entry; Path = $file; Directory = $directory; Name = $name })
        }
        foreach ($record in $entries) {
            $parent = $record.Name
            while ($parent.Contains('/')) {
                $parent = $parent.Substring(0, $parent.LastIndexOf('/'))
                if ($seen.ContainsKey($parent) -and -not $seen[$parent]) { throw 'Archive file/directory collision.' }
            }
        }
        $null = [IO.Directory]::CreateDirectory($target)
        foreach ($record in $entries) {
            if ($record.Directory) { $null = [IO.Directory]::CreateDirectory($record.Path); continue }
            $null = [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($record.Path))
            $inputStream = $record.Entry.Open()
            $outputStream = $null
            try {
                $outputStream = [IO.File]::Open($record.Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
                $buffer = New-Object byte[] 81920
                [long]$written = 0
                while (($count = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                    $written += $count
                    if ($written -gt $record.Entry.Length -or $written -gt $MaxExpandedBytes) { throw 'Archive entry exceeds its declared size.' }
                    $outputStream.Write($buffer, 0, $count)
                }
                if ($outputStream.Length -ne $record.Entry.Length) { throw 'Archive entry size mismatch.' }
            } finally {
                if ($outputStream) { $outputStream.Dispose() }
                $inputStream.Dispose()
            }
        }
    } finally { $zip.Dispose() }
}

function Receive-ReleaseFile([string]$Uri, [string]$OutFile) {
    if ($Uri -notmatch '^https://github\.com/mars-tw/ai-console/releases/download/v\d+\.\d+\.\d+/[A-Za-z0-9_.-]+$') {
        throw 'Unexpected release download URL.'
    }
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $previousProgress = $ProgressPreference
    try {
        $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $OutFile -MaximumRedirection 5 -TimeoutSec 900 -ErrorAction Stop | Out-Null
    }
    catch { throw '下載失敗或逾時。請確認網路連線，以及 GitHub 上是否已有這個版本，再重新執行快速安裝。' }
    finally { $ProgressPreference = $previousProgress }
}

function Assert-ReleaseChecksum([string]$Archive, [string]$Checksums, [string]$Asset) {
    $found = @()
    foreach ($line in Get-Content -LiteralPath $Checksums -Encoding UTF8) {
        if ($line -match '^([a-fA-F0-9]{64})\s+\*?(.+?)\s*$' -and $Matches[2] -ceq $Asset) { $found += $Matches[1] }
    }
    if ($found.Count -ne 1) { throw '下載包缺少唯一的 SHA256 校驗碼，請重新下載完整版本。' }
    if ((Get-Sha256 $Archive) -ine $found[0]) { throw '[CHECKSUM_MISMATCH] 下載包的 SHA256 校驗碼不符，尚未安裝。請重新下載後再試。' }
}

function Get-DownloadedPayload($Manifest, [string]$Scratch) {
    $base = 'https://github.com/mars-tw/ai-console/releases/download/v' + $Manifest.version + '/'
    $archive = Join-Path $Scratch $Manifest.asset
    $sums = Join-Path $Scratch 'SHA256SUMS.txt'
    Receive-ReleaseFile ($base + 'SHA256SUMS.txt') $sums
    Receive-ReleaseFile ($base + $Manifest.asset) $archive
    if ((Get-Item -LiteralPath $archive).Length -gt 1610612736) { throw 'Release archive exceeds the download size limit.' }
    Assert-ReleaseChecksum $archive $sums $Manifest.asset
    $unpacked = Join-Path $Scratch 'unpacked'
    Expand-SafeArchive $archive $unpacked
    if (Test-PortablePayload $unpacked $Manifest.version) { return $unpacked }
    $children = @(Get-ChildItem -LiteralPath $unpacked -Force)
    if ($children.Count -eq 1 -and $children[0].PSIsContainer -and (Test-PortablePayload $children[0].FullName $Manifest.version)) {
        return $children[0].FullName
    }
    throw '下載包缺少必要檔案，或版本不符。請重新下載完整版本後再試。'
}

function Install-AppPayload([string]$Payload, [string]$Destination, [string]$Version) {
    if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid installation version.' }
    if (-not (Test-PortablePayload $Payload $Version)) { throw '程式缺少必要檔案，或版本不符。請重新解壓縮完整的下載包。' }
    $inventory = Get-PayloadInventory $Payload
    $root = Assert-SafePath $Destination
    $versions = Assert-ChildPath (Join-Path $root 'versions') $root
    $target = Assert-ChildPath (Join-Path $versions $Version) $versions
    $null = [IO.Directory]::CreateDirectory($versions)
    $lockPath = Assert-ChildPath (Join-Path $root '.quick-install.lock') $root
    try { $lock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
    catch { throw '另一個安裝程式正在使用這個資料夾。請等它完成，再重新執行。' }
    $stage = $null
    try {
        if (Test-Path -LiteralPath $target) {
            if (-not (Test-PortablePayload $target $Version) -or -not (Test-EqualInventory $inventory (Get-PayloadInventory $target))) {
                throw '[VERSION_CONFLICT] 這個版本的安裝資料夾已有不同檔案，原有檔案已保留。請用 InstallRoot 指定其他安裝位置。'
            }
            return (Join-Path $target 'AI控制台.exe')
        }
        $stage = Assert-ChildPath (Join-Path $versions ('.staging-' + [Guid]::NewGuid().ToString('N'))) $versions
        $null = [IO.Directory]::CreateDirectory($stage)
        foreach ($relative in $inventory.Keys) {
            $from = Assert-ChildPath (Join-Path $Payload $relative) $Payload
            $to = Assert-ChildPath (Join-Path $stage $relative) $stage
            $null = [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($to))
            [IO.File]::Copy($from, $to, $false)
        }
        if (-not (Test-PortablePayload $stage $Version) -or -not (Test-EqualInventory $inventory (Get-PayloadInventory $stage))) {
            throw '複製後的檔案驗證未通過，舊版本已保留。請重新下載完整版本後再試。'
        }
        [IO.Directory]::Move($stage, $target)
        return (Join-Path $target 'AI控制台.exe')
    } finally {
        $lock.Dispose()
        if ($stage -and (Test-Path -LiteralPath $stage)) {
            $null = Assert-ChildPath $stage $versions
            $null = Get-PayloadInventory $stage
            Remove-Item -LiteralPath $stage -Recurse -Force
        }
    }
}

function Write-CurrentPointer([string]$Destination, [string]$Version) {
    if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid installation version.' }
    $root = Assert-SafePath $Destination
    $payload = Assert-ChildPath (Join-Path $root ('versions/' + $Version)) $root
    if (-not (Test-PortablePayload $payload $Version)) { throw '程式檔案不完整，無法設為目前使用的版本。請重新安裝。' }
    $pointer = Assert-ChildPath (Join-Path $root 'current.json') $root
    $temp = Assert-ChildPath (Join-Path $root ('.current-' + [Guid]::NewGuid().ToString('N') + '.json')) $root
    $data = @{ version = $Version; executable = ('versions/' + $Version + '/AI控制台.exe') } | ConvertTo-Json
    try {
        [IO.File]::WriteAllText($temp, $data, (New-Object Text.UTF8Encoding($false)))
        if (Test-Path -LiteralPath $pointer) { [IO.File]::Replace($temp, $pointer, [NullString]::Value) }
        else { [IO.File]::Move($temp, $pointer) }
    } finally { if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force } }
}

function New-AppShortcuts([string]$Executable) {
    $shell = New-Object -ComObject WScript.Shell
    foreach ($folder in @([Environment]::GetFolderPath('DesktopDirectory'), (Join-Path ([Environment]::GetFolderPath('Programs')) 'AI Console'))) {
        $null = Assert-SafePath $folder
        $null = [IO.Directory]::CreateDirectory($folder)
        foreach ($devspace in @($false, $true)) {
            $name = if ($devspace) { 'DevSpace 控制台.lnk' } else { 'AI 控制台.lnk' }
            $path = Assert-ChildPath (Join-Path $folder $name) $folder
            $shortcut = $shell.CreateShortcut($path)
            $shortcut.TargetPath = $Executable
            $shortcut.Arguments = if ($devspace) { '--devspace' } else { '' }
            $shortcut.WorkingDirectory = Split-Path -Parent $Executable
            $shortcut.IconLocation = $Executable + ',0'
            $shortcut.Description = if ($devspace) { 'DevSpace desktop console' } else { 'AI Console' }
            $shortcut.Save()
        }
    }
}

function Invoke-DevSpaceSetup {
    $helper = Assert-SafePath (Join-Path $script:InstallerDirectory 'setup-devspace.ps1')
    if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) { throw '控制台已安裝，但缺少 DevSpace 設定程式。請重新下載完整的快速安裝包後再執行。' }
    $global:LASTEXITCODE = 0
    & $helper
    if (-not $? -or $LASTEXITCODE -ne 0) { throw '控制台已安裝，DevSpace 尚未設定完成。請依畫面說明處理後，重新執行 setup-devspace.ps1。' }
}

function Start-InstalledApp([string]$Executable) {
    Start-Process -FilePath $Executable -ArgumentList '--devspace' -WorkingDirectory (Split-Path -Parent $Executable) | Out-Null
}

function Invoke-QuickInstall {
    param([string]$Source, [string]$Destination, [switch]$Unattended, [switch]$OmitDevSpace, [switch]$OmitLaunch, [switch]$Preview)
    $pin = Get-QuickInstallManifest
    $sourcePath = Assert-SafePath $Source
    $destinationPath = Assert-SafePath $Destination
    $portable = Test-PortablePayload $sourcePath $pin.version
    $plan = [ordered]@{
        version = $pin.version; source = $(if ($portable) { 'portable' } else { 'github-release' })
        installRoot = $destinationPath; executable = (Join-Path $destinationPath ('versions/' + $pin.version + '/AI控制台.exe'))
        download = $(if ($portable) { $null } else { 'https://github.com/mars-tw/ai-console/releases/download/v' + $pin.version + '/' + $pin.asset })
        devspaceSetup = (-not $OmitDevSpace); launch = (-not $OmitLaunch); requiresAdmin = $false
    }
    if ($Preview) { return ($plan | ConvertTo-Json -Depth 4) }
    if ($Unattended -and -not $OmitDevSpace) { throw '[INSTALL_NONINTERACTIVE] NonInteractive 必須搭配 SkipDevSpace。請另外執行 setup-devspace.ps1，明確指定要安裝或設定的項目。' }
    if (-not $portable -and ((Test-Path -LiteralPath (Join-Path $sourcePath 'AI控制台.exe')) -or (Test-Path -LiteralPath (Join-Path $sourcePath 'resources/app/package.json')))) {
        throw '這份免安裝版缺少必要檔案，或版本不符。請重新解壓縮對應版本的完整下載包。'
    }
    $dataRoot = Assert-SafePath (Join-Path $env:LOCALAPPDATA 'AIConsole')
    $logs = Assert-ChildPath (Join-Path $dataRoot 'installer-logs') $dataRoot
    $null = [IO.Directory]::CreateDirectory($logs)
    $log = Assert-ChildPath (Join-Path $logs ((Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N') + '.log')) $logs
    [IO.File]::WriteAllText($log, 'Quick install started: ' + $pin.version + [Environment]::NewLine)
    $scratch = $null
    try {
        $payload = $sourcePath
        if (-not $portable) {
            $scratch = Assert-ChildPath (Join-Path $dataRoot ('download-' + [Guid]::NewGuid().ToString('N'))) $dataRoot
            $null = [IO.Directory]::CreateDirectory($scratch)
            Write-Host ('正在下載 AI 控制台 ' + $pin.version + '，完成後會驗證檔案。')
            $payload = Get-DownloadedPayload $pin $scratch
        }
        $exe = Install-AppPayload $payload $destinationPath $pin.version
        Write-CurrentPointer $destinationPath $pin.version
        New-AppShortcuts $exe
        [IO.File]::AppendAllText($log, 'App payload verified and activated.' + [Environment]::NewLine)
        if (-not $OmitDevSpace) { Invoke-DevSpaceSetup }
        if (-not $OmitLaunch) { Start-InstalledApp $exe }
        [IO.File]::AppendAllText($log, 'Quick install completed.' + [Environment]::NewLine)
        Write-Host ('安裝完成：' + $exe)
        Write-Host ('安裝紀錄：' + $log)
        return $exe
    } catch {
        # Do not capture transcripts, subprocess stderr, credentials, or provider output.
        [IO.File]::AppendAllText($log, 'Quick install failed. See the actionable console error.' + [Environment]::NewLine)
        Write-Host ('安裝紀錄：' + $log)
        throw
    } finally {
        if ($scratch -and (Test-Path -LiteralPath $scratch)) {
            $null = Assert-ChildPath $scratch $dataRoot
            $null = Get-PayloadInventory $scratch
            Remove-Item -LiteralPath $scratch -Recurse -Force
        }
    }
}

if (-not $LibraryOnly) {
    try {
        Invoke-QuickInstall -Source $SourceRoot -Destination $InstallRoot -Unattended:$NonInteractive -OmitDevSpace:$SkipDevSpace -OmitLaunch:$NoLaunch -Preview:$PlanOnly
    } catch {
        Write-Error $_.Exception.Message -ErrorAction Continue
        exit 1
    }
}
