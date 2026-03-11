@echo off
setlocal
cd /d C:\Users\tazzo\factory-gemini-shim
if not defined RESTART_DELAY_SECONDS set "RESTART_DELAY_SECONDS=2"

:restart
echo [%date% %time%] starting factory-gemini-shim
node server.js
set "EXIT_CODE=%ERRORLEVEL%"

if "%EXIT_CODE%"=="0" (
  echo [%date% %time%] factory-gemini-shim stopped normally
  exit /b 0
)

echo [%date% %time%] factory-gemini-shim exited with code %EXIT_CODE%, restarting in %RESTART_DELAY_SECONDS%s
timeout /t %RESTART_DELAY_SECONDS% /nobreak >nul
goto restart
