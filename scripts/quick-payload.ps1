# Shared, read-only validation for both installation and quick launch.
function Get-QuickPayloadRequiredFiles {
    return @(
        'AI控制台.exe', 'icudtl.dat', 'resources.pak', 'locales/en-US.pak',
        'resources/app/package.json', 'resources/app/electron/main.cjs',
        'resources/app/electron/pty.cjs', 'resources/app/electron/preload.cjs',
        'resources/app/dist/index.html', 'resources/app/server/api.py',
        'resources/app/server/devspace_console.py', 'resources/app/scripts/find-python.cjs',
        'resources/app/runtime/python/python.exe', 'resources/app/runtime/python/python3.dll',
        'resources/app/runtime/python/python314.dll', 'resources/app/runtime/python/python314.zip',
        'resources/app/runtime/python/python314._pth', 'resources/app/runtime/python/runtime.json'
    )
}

function Assert-QuickPayloadPath([string]$Path) {
    $full = [IO.Path]::GetFullPath($Path)
    if ($full.StartsWith('\\')) { throw 'Payload network and device paths are not supported.' }
    $cursor = $full
    while ($cursor) {
        $item = Get-Item -LiteralPath $cursor -Force -ErrorAction SilentlyContinue
        if ($null -ne $item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'Payload contains a linked file, directory, or ancestor.'
        }
        $cursor = [IO.Path]::GetDirectoryName($cursor)
    }
    return $full
}

function Get-QuickPayloadHash([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $hash = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $hash.Dispose(); $stream.Dispose() }
}

function Assert-QuickPayload {
    param([string]$Root, [string]$Version, [switch]$VerifyHashes)
    if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid payload version.' }
    $base = (Assert-QuickPayloadPath $Root).TrimEnd('\', '/')
    $prefix = $base + [IO.Path]::DirectorySeparatorChar
    $manifestPath = Assert-QuickPayloadPath (Join-Path $base 'quick-payload.json')
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf) -or (Get-Item -LiteralPath $manifestPath).Length -gt 33554432) {
        throw 'Missing or oversized payload manifest.'
    }
    $manifest = [IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json
    if ($manifest.schemaVersion -ne 1 -or $manifest.version -cne $Version -or
        $manifest.files -isnot [Array] -or $manifest.files.Count -eq 0 -or $manifest.files.Count -gt 50000) {
        throw 'Invalid payload manifest or version.'
    }
    $seen = @{}
    [long]$total = 0
    foreach ($entry in $manifest.files) {
        if ($entry.path -isnot [string] -or -not $entry.path -or $entry.path.Contains('\') -or
            $entry.path.Contains(':') -or $entry.path.StartsWith('/') -or $entry.path -ieq 'quick-payload.json') {
            throw 'Unsafe payload manifest path.'
        }
        foreach ($part in $entry.path.Split('/')) {
            if (-not $part -or $part -in @('.', '..') -or $part -match '[. ]$' -or
                $part -match '[\x00-\x1f<>"|?*]' -or $part -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') {
                throw 'Unsafe payload manifest path.'
            }
        }
        if ($seen.ContainsKey($entry.path)) { throw 'Duplicate payload manifest path.' }
        if (($entry.size -isnot [int] -and $entry.size -isnot [long]) -or $entry.size -lt 0 -or
            $entry.sha256 -isnot [string] -or $entry.sha256 -cnotmatch '^[0-9a-f]{64}$') {
            throw 'Invalid payload manifest size or checksum.'
        }
        $total += $entry.size
        if ($total -gt 2147483648) { throw 'Payload exceeds the size limit.' }
        $seen[$entry.path] = $entry
        $path = Assert-QuickPayloadPath (Join-Path $base $entry.path)
        if (-not $path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or
            -not (Test-Path -LiteralPath $path -PathType Leaf) -or (Get-Item -LiteralPath $path).Length -ne $entry.size) {
            throw 'Payload file is missing or has an unexpected size.'
        }
        if ($VerifyHashes -and (Get-QuickPayloadHash $path) -cne $entry.sha256) { throw 'Payload checksum mismatch.' }
    }
    foreach ($required in Get-QuickPayloadRequiredFiles) {
        if (-not $seen.ContainsKey($required) -or $seen[$required].size -le 0) { throw 'Payload manifest omits a required app or runtime file.' }
    }
    $packagePath = Join-Path $base 'resources/app/package.json'
    if ((Get-Item -LiteralPath $packagePath).Length -gt 65536) { throw 'Invalid app package metadata.' }
    $package = [IO.File]::ReadAllText($packagePath) | ConvertFrom-Json
    if ($package.name -cne 'ai-console' -or $package.version -cne $Version -or $package.main -cne 'electron/main.cjs') {
        throw 'Unexpected app package identity or entrypoint.'
    }
}

function Test-QuickPayload {
    param([string]$Root, [string]$Version, [switch]$VerifyHashes)
    try { Assert-QuickPayload -Root $Root -Version $Version -VerifyHashes:$VerifyHashes; return $true }
    catch { return $false }
}
