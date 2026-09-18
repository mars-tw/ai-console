# Create a shortcut to the packaged desktop app, with a source-build fallback.
[CmdletBinding()]
param([switch]$DevSpace)

$ErrorActionPreference = 'Stop'
$appRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$packedExe = Join-Path $appRoot 'release\clean\AI控制台-win32-x64\AI控制台.exe'
$electronExe = Join-Path $appRoot 'node_modules\electron\dist\electron.exe'
$appArgs = ''
if (Test-Path -LiteralPath $packedExe -PathType Leaf) {
    $targetExe = $packedExe
} elseif ((Test-Path -LiteralPath $electronExe -PathType Leaf) -and
          (Test-Path -LiteralPath (Join-Path $appRoot 'dist\index.html') -PathType Leaf)) {
    $targetExe = $electronExe
    $appArgs = '"' + $appRoot + '"'
} else {
    throw 'Build the desktop app first: npm ci; npm run build; npm run pack'
}
if ($DevSpace) { $appArgs = ($appArgs + ' --devspace').Trim() }
$desktopDir = [Environment]::GetFolderPath('DesktopDirectory')
$shortcutName = if ($DevSpace) { 'DevSpace 控制台.lnk' } else { 'AI 控制台.lnk' }
$shortcutFile = Join-Path $desktopDir $shortcutName
$shortcutShell = New-Object -ComObject WScript.Shell
$shortcut = $shortcutShell.CreateShortcut($shortcutFile)
$shortcut.TargetPath = $targetExe
$shortcut.Arguments = $appArgs
$shortcut.WorkingDirectory = Split-Path -Parent $targetExe
$shortcut.Description = if ($DevSpace) { 'AI Console - DevSpace desktop workspace and tasks' } else { 'AI Console' }
$shortcut.IconLocation = $targetExe + ',0'
$shortcut.Save()
Write-Output $shortcutFile
