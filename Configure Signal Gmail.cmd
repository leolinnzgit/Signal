@echo off
setlocal

set "SIGNAL_ROOT=%~dp0"
set "SETUP_EXE=%SIGNAL_ROOT%work\gmail-setup\Signal.GmailSetup.exe"
set "OAUTH_CLIENT=%~1"
if not defined OAUTH_CLIENT set "OAUTH_CLIENT=%SIGNAL_GMAIL_OAUTH_CLIENT%"

if not exist "%SETUP_EXE%" (
  echo The Signal Gmail OAuth utility has not been built.
  echo Run: npm run gmail:setup:build
  pause
  exit /b 1
)

if not defined OAUTH_CLIENT (
  echo Provide the Google OAuth client JSON as the first argument or set:
  echo SIGNAL_GMAIL_OAUTH_CLIENT
  pause
  exit /b 1
)

if not exist "%OAUTH_CLIENT%" (
  echo The configured Google OAuth client file was not found:
  echo %OAUTH_CLIENT%
  pause
  exit /b 1
)

start "Signal Gmail OAuth Setup" "%SETUP_EXE%" --credentials "%OAUTH_CLIENT%" --site "C:\inetpub\Signal" --source "%SIGNAL_ROOT%iis-publish"
