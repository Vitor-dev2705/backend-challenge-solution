@echo off
setlocal
cd /d "%~dp0"

where powershell.exe >nul 2>&1
if errorlevel 1 (
  echo PowerShell was not found. Windows PowerShell is required to run this installer.
  pause
  exit /b 1
)

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-windows.ps1"
set "RESULT=%ERRORLEVEL%"

if not "%RESULT%"=="0" (
  echo.
  echo Setup failed. Read the message above, fix the reported issue, and run this file again.
  pause
  exit /b %RESULT%
)

echo.
echo Setup completed. Start the API with: bun run start
pause
