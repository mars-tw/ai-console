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

function Write-QuickInstallProgress {
    param(
        [Parameter(Mandatory = $true)][string]$Activity,
        [Parameter(Mandatory = $true)][string]$Status,
        [int]$Current = -1,
        [int]$Total = -1,
        [switch]$Completed
    )
    if ($Completed) {
        Write-Progress -Activity $Activity -Status $Status -Completed
        Write-Host ($Activity + '：' + $Status)
        return
    }
    if ($Total -gt 0 -and $Current -ge 0) {
        $percent = [Math]::Min(100, [Math]::Max(0, [int](($Current * 100) / $Total)))
        Write-Progress -Activity $Activity -Status ($Status + " ($Current/$Total)") -PercentComplete $percent
        return
    }
    if ($Current -ge 0) {
        Write-Progress -Activity $Activity -Status ($Status + ' ' + $Current + ' 個檔案')
        return
    }
    Write-Progress -Activity $Activity -Status $Status
    Write-Host ($Activity + '：' + $Status)
}

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

function Get-PayloadInventory {
    param([string]$Root, [string]$ProgressActivity = '', [int]$ExpectedCount = 0)
    $base = (Assert-SafePath $Root).TrimEnd('\', '/')
    $pending = New-Object 'System.Collections.Generic.Stack[string]'
    $pending.Push($base)
    $files = @{}
    [int]$processed = 0
    while ($pending.Count -gt 0) {
        foreach ($item in Get-ChildItem -LiteralPath $pending.Pop() -Force) {
            $null = Assert-ChildPath $item.FullName $base
            if ($item.PSIsContainer) { $pending.Push($item.FullName); continue }
            $relative = $item.FullName.Substring($base.Length + 1).Replace('\', '/')
            if ($files.ContainsKey($relative)) { throw 'Duplicate file paths in app payload.' }
            $files[$relative] = Get-Sha256 $item.FullName
            $processed++
            if ($ProgressActivity) {
                if ($ExpectedCount -gt 0) {
                    Write-QuickInstallProgress -Activity $ProgressActivity -Status '已檢查檔案' -Current $processed -Total $ExpectedCount
                } else {
                    Write-QuickInstallProgress -Activity $ProgressActivity -Status '已檢查' -Current $processed
                }
            }
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
        [int]$processedEntries = 0
        foreach ($record in $entries) {
            if ($record.Directory) {
                $null = [IO.Directory]::CreateDirectory($record.Path)
            } else {
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
            $processedEntries++
            Write-QuickInstallProgress -Activity '解壓縮下載包' -Status '已處理項目' -Current $processedEntries -Total $entries.Count
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
        $ProgressPreference = 'Continue'
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
    Write-QuickInstallProgress -Activity '下載發行檔' -Status '正在下載 SHA256 校驗碼'
    Receive-ReleaseFile ($base + 'SHA256SUMS.txt') $sums
    Write-QuickInstallProgress -Activity '下載發行檔' -Status '已下載檔案' -Current 1 -Total 2
    Receive-ReleaseFile ($base + $Manifest.asset) $archive
    Write-QuickInstallProgress -Activity '下載發行檔' -Status '已下載檔案' -Current 2 -Total 2
    if ((Get-Item -LiteralPath $archive).Length -gt 1610612736) { throw 'Release archive exceeds the download size limit.' }
    Write-QuickInstallProgress -Activity '下載發行檔' -Status '完成' -Completed

    Write-QuickInstallProgress -Activity '驗證下載校驗碼' -Status '正在比對 SHA256'
    Assert-ReleaseChecksum $archive $sums $Manifest.asset
    Write-QuickInstallProgress -Activity '驗證下載校驗碼' -Status '完成' -Completed

    $unpacked = Join-Path $Scratch 'unpacked'
    Write-QuickInstallProgress -Activity '解壓縮下載包' -Status '正在安全解壓縮'
    Expand-SafeArchive $archive $unpacked
    Write-QuickInstallProgress -Activity '解壓縮下載包' -Status '完成' -Completed

    Write-QuickInstallProgress -Activity '驗證下載內容' -Status '正在檢查必要檔案與版本'
    $payload = $null
    if (Test-PortablePayload $unpacked $Manifest.version) {
        $payload = $unpacked
    } else {
        $children = @(Get-ChildItem -LiteralPath $unpacked -Force)
        if ($children.Count -eq 1 -and $children[0].PSIsContainer -and (Test-PortablePayload $children[0].FullName $Manifest.version)) {
            $payload = $children[0].FullName
        }
    }
    if (-not $payload) { throw '下載包缺少必要檔案，或版本不符。請重新下載完整版本後再試。' }
    Write-QuickInstallProgress -Activity '驗證下載內容' -Status '完成' -Completed
    return $payload
}

function Install-AppPayload([string]$Payload, [string]$Destination, [string]$Version) {
    if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid installation version.' }
    Write-QuickInstallProgress -Activity '驗證安裝來源' -Status '正在檢查必要檔案與雜湊'
    if (-not (Test-PortablePayload $Payload $Version)) { throw '程式缺少必要檔案，或版本不符。請重新解壓縮完整的下載包。' }
    Write-QuickInstallProgress -Activity '驗證安裝來源' -Status '完成' -Completed

    Write-QuickInstallProgress -Activity '建立安裝清單' -Status '正在計算檔案雜湊'
    $inventory = Get-PayloadInventory $Payload -ProgressActivity '建立安裝清單'
    Write-QuickInstallProgress -Activity '建立安裝清單' -Status ('完成，共 ' + $inventory.Count + ' 個檔案') -Completed

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
            Write-QuickInstallProgress -Activity '驗證既有安裝' -Status '正在比對已安裝檔案'
            $targetValid = Test-PortablePayload $target $Version
            $targetInventory = $null
            if ($targetValid) {
                $targetInventory = Get-PayloadInventory $target -ProgressActivity '驗證既有安裝' -ExpectedCount $inventory.Count
            }
            if (-not $targetValid -or -not (Test-EqualInventory $inventory $targetInventory)) {
                throw '[VERSION_CONFLICT] 這個版本的安裝資料夾已有不同檔案，原有檔案已保留。請用 InstallRoot 指定其他安裝位置。'
            }
            Write-QuickInstallProgress -Activity '驗證既有安裝' -Status '完成' -Completed
            return (Join-Path $target 'AI控制台.exe')
        }
        $stage = Assert-ChildPath (Join-Path $versions ('.staging-' + [Guid]::NewGuid().ToString('N'))) $versions
        $null = [IO.Directory]::CreateDirectory($stage)
        [int]$copied = 0
        Write-QuickInstallProgress -Activity '複製安裝檔案' -Status '正在複製已驗證檔案'
        foreach ($relative in ($inventory.Keys | Sort-Object)) {
            $from = Assert-ChildPath (Join-Path $Payload $relative) $Payload
            $to = Assert-ChildPath (Join-Path $stage $relative) $stage
            $null = [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($to))
            [IO.File]::Copy($from, $to, $false)
            $copied++
            Write-QuickInstallProgress -Activity '複製安裝檔案' -Status '已複製檔案' -Current $copied -Total $inventory.Count
        }
        Write-QuickInstallProgress -Activity '複製安裝檔案' -Status '完成' -Completed

        Write-QuickInstallProgress -Activity '驗證已安裝檔案' -Status '正在重新檢查必要檔案與雜湊'
        $stageValid = Test-PortablePayload $stage $Version
        $stageInventory = $null
        if ($stageValid) {
            $stageInventory = Get-PayloadInventory $stage -ProgressActivity '驗證已安裝檔案' -ExpectedCount $inventory.Count
        }
        if (-not $stageValid -or -not (Test-EqualInventory $inventory $stageInventory)) {
            throw '複製後的檔案驗證未通過，舊版本已保留。請重新下載完整版本後再試。'
        }
        Write-QuickInstallProgress -Activity '驗證已安裝檔案' -Status '完成' -Completed

        Write-QuickInstallProgress -Activity '啟用安裝版本' -Status '正在啟用已驗證版本'
        [IO.Directory]::Move($stage, $target)
        Write-QuickInstallProgress -Activity '啟用安裝版本' -Status '完成' -Completed
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
    $folders = @([Environment]::GetFolderPath('DesktopDirectory'), (Join-Path ([Environment]::GetFolderPath('Programs')) 'AI Console'))
    [int]$created = 0
    [int]$total = $folders.Count * 2
    Write-QuickInstallProgress -Activity '建立捷徑' -Status '正在建立桌面與開始功能表捷徑'
    foreach ($folder in $folders) {
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
            $created++
            Write-QuickInstallProgress -Activity '建立捷徑' -Status '已建立捷徑' -Current $created -Total $total
        }
    }
    Write-QuickInstallProgress -Activity '建立捷徑' -Status '完成' -Completed
}

function Show-DevSpaceResumeInstructions {
    param([switch]$AfterFailure)
    if ($AfterFailure) {
        Write-Host '控制台不需要重新安裝。修正上述錯誤後，可依下列方式重新執行 DevSpace 設定。'
    } else {
        Write-Host '本次未執行 DevSpace 設定；既有設定保持不變。尚未設定者可依下列方式接續。'
    }
    Write-Host '回到快速安裝包資料夾，在 PowerShell 執行：'
    Write-Host 'powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-devspace.ps1'
}

function Request-DevSpaceSetupNow {
    Write-Host ''
    Write-Host '控制台已安裝並驗證完成。DevSpace 可以現在設定，也可以稍後再設定。'
    Write-Host '[1] 現在設定 DevSpace'
    Write-Host '[2] 稍後設定，先開啟控制台'
    while ($true) {
        try { $choice = Read-Host '請輸入 1 或 2（直接按 Enter 代表 2）' }
        catch {
            Write-Host ('無法讀取設定選擇，已改為稍後設定：' + $_.Exception.Message) -ForegroundColor Yellow
            return $false
        }
        if ([string]::IsNullOrWhiteSpace($choice) -or $choice.Trim() -eq '2') { return $false }
        if ($choice.Trim() -eq '1') { return $true }
        Write-Host '請輸入 1 或 2。' -ForegroundColor Yellow
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
    if (-not $Preview) { Write-QuickInstallProgress -Activity '檢查安裝來源' -Status '正在確認本機是否有完整安裝包' }
    $portable = Test-PortablePayload $sourcePath $pin.version
    if (-not $Preview) {
        $sourceStatus = if ($portable) { '完成，使用本機完整包' } else { '完成，將下載固定版本' }
        Write-QuickInstallProgress -Activity '檢查安裝來源' -Status $sourceStatus -Completed
    }
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
    $appInstalled = $false
    try {
        $payload = $sourcePath
        if (-not $portable) {
            $scratch = Assert-ChildPath (Join-Path $dataRoot ('download-' + [Guid]::NewGuid().ToString('N'))) $dataRoot
            $null = [IO.Directory]::CreateDirectory($scratch)
            $payload = Get-DownloadedPayload $pin $scratch
        }
        $exe = Install-AppPayload $payload $destinationPath $pin.version

        Write-QuickInstallProgress -Activity '設定目前版本' -Status '正在寫入已驗證版本指標'
        Write-CurrentPointer $destinationPath $pin.version
        Write-QuickInstallProgress -Activity '設定目前版本' -Status '完成' -Completed
        New-AppShortcuts $exe

        $appInstalled = $true
        [IO.File]::AppendAllText($log, 'App payload verified and activated.' + [Environment]::NewLine)
        Write-Host ('控制台安裝完成並已驗證：' + $exe) -ForegroundColor Green

        $devspaceStatus = '已略過'
        if ($OmitDevSpace) {
            [IO.File]::AppendAllText($log, 'DevSpace setup skipped by explicit option.' + [Environment]::NewLine)
            Write-Host '已依 SkipDevSpace 略過 DevSpace 設定。'
            Show-DevSpaceResumeInstructions
        } elseif (-not (Request-DevSpaceSetupNow)) {
            $devspaceStatus = '稍後設定'
            [IO.File]::AppendAllText($log, 'DevSpace setup deferred by user.' + [Environment]::NewLine)
            Write-Host '已選擇「稍後設定，先開啟控制台」。' -ForegroundColor Cyan
            Show-DevSpaceResumeInstructions
        } else {
            try {
                Invoke-DevSpaceSetup
                $devspaceStatus = '已設定'
                [IO.File]::AppendAllText($log, 'DevSpace setup completed.' + [Environment]::NewLine)
                Write-Host 'DevSpace 設定完成。' -ForegroundColor Green
            } catch {
                $devspaceStatus = '未完成'
                # Keep the actionable error visible, but do not copy setup output or credentials into the installer log.
                [IO.File]::AppendAllText($log, 'DevSpace setup incomplete; see the actionable console error.' + [Environment]::NewLine)
                Write-Host ('控制台已安裝；DevSpace 設定未完成：' + $_.Exception.Message) -ForegroundColor Yellow
                Show-DevSpaceResumeInstructions -AfterFailure
            }
        }

        if ($OmitLaunch) {
            [IO.File]::AppendAllText($log, 'Launch skipped by explicit option.' + [Environment]::NewLine)
            Write-Host '已依 NoLaunch 略過自動開啟；可稍後使用捷徑啟動。'
        } else {
            Write-QuickInstallProgress -Activity '開啟控制台' -Status '正在啟動已安裝程式'
            Start-InstalledApp $exe
            Write-QuickInstallProgress -Activity '開啟控制台' -Status '完成' -Completed
        }

        [IO.File]::AppendAllText($log, 'Quick install completed.' + [Environment]::NewLine)
        Write-Host ('快速安裝流程完成。控制台狀態：已安裝；DevSpace 狀態：' + $devspaceStatus)
        Write-Host ('安裝紀錄：' + $log)
        return $exe
    } catch {
        # Do not capture transcripts, subprocess stderr, credentials, or provider output.
        if ($appInstalled) {
            [IO.File]::AppendAllText($log, 'Post-install step failed. App payload remains installed.' + [Environment]::NewLine)
            Write-Host '控制台已安裝，但後續步驟發生錯誤；已安裝檔案不會回復或刪除。' -ForegroundColor Yellow
        } else {
            [IO.File]::AppendAllText($log, 'Quick install failed. See the actionable console error.' + [Environment]::NewLine)
        }
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
