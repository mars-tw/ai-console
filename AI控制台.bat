@echo off
rem AI Console launcher - opens the DESKTOP app (not the browser).
rem
rem ASCII ONLY in this file. cmd.exe reads .bat in the machine's ANSI codepage,
rem so any non-ASCII path written here gets mangled and "if exist" silently fails.
rem That is why the packaged folder is located by wildcard instead of by name.
setlocal enabledelayedexpansion
set ROOT=%~dp0

rem 1. Packaged desktop build - find it by wildcard so the Chinese app name
rem    never has to appear in this file.
set PACKED=
for /d %%D in ("%ROOT%release\*-win32-x64") do (
  for %%F in ("%%D\*.exe") do set PACKED=%%F
)
if defined PACKED (
  start "" "!PACKED!"
  goto :done
)

rem 2. Dev desktop app via the local electron binary.
rem    NOTE: %ROOT% ends with a backslash, and "C:\path\" makes the trailing
rem    backslash escape the closing quote on the Windows command line - electron
rem    then gets a mangled path and silently loads its default app instead.
rem    So strip the trailing backslash before passing it as an argument.
set APPDIR=%ROOT:~0,-1%
set ELECTRON=%ROOT%node_modules\electron\dist\electron.exe
if exist "%ELECTRON%" (
  start "AIConsole" "%ELECTRON%" "%APPDIR%"
  goto :done
)

rem 3. Last resort: start the API and open a browser tab
echo Desktop app not found. Build it with:
echo    npm install ^&^& npm run build ^&^& npm run pack
call "%ROOT%server\start-api.bat"
timeout /t 3 /nobreak >nul
start "" "http://127.0.0.1:5177/"

:done
endlocal
