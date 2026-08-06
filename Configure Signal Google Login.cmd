@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Configure-SignalGoogleLogin.ps1"
if errorlevel 1 (
  echo.
  echo Google sign-in was not configured.
)
echo.
pause
