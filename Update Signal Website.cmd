@echo off
title Update Signal website
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0work\setup-signal-iis.ps1" -DeployUpdate
if errorlevel 1 (
  echo.
  echo Signal update failed. No account or database files were changed.
) else (
  echo.
  echo Signal was updated successfully. Refresh https://localhost:8443/ in your browser.
)
echo.
pause
