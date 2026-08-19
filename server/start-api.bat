@echo off
rem Start the AI Console API. All paths resolve relative to this file.
rem Python discovery: Kimi desktop's bundled venv first (it has the extra deps),
rem then whatever python is on PATH.
setlocal
set PYW=%APPDATA%\kimi-desktop\daimon-share\daimon\runtime\python\.venv\Scripts\pythonw.exe
if not exist "%PYW%" set PYW=pythonw.exe
start "AIConsoleAPI" /min "%PYW%" "%~dp0api.py"
endlocal
