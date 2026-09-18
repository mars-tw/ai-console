@echo off
setlocal DisableDelayedExpansion
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\quick-install.ps1" -SourceRoot "%~dp0."
if errorlevel 1 (
  echo.
  echo Installation did not finish. See the message above.
  pause
  exit /b 1
)
exit /b 0
