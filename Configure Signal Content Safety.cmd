@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Configure-SignalContentSafety.ps1"
echo.
pause
