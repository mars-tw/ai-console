@echo off
setlocal DisableDelayedExpansion
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\quick-launch.ps1" -SourceRoot "%~dp0."
if errorlevel 1 (
  echo.
  echo Launch did not finish. Run the quick installer first.
  pause
  exit /b 1
)
exit /b 0
