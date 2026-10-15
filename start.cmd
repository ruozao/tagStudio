@echo off
chcp 65001 >nul 2>nul
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode

echo.
echo   tagStudio - starting...
echo   The browser will open automatically. Close this window to quit.
echo.

node server.js %*
if errorlevel 1 goto failed
goto end

:nonode
echo.
echo   [ERROR] Node.js not found.
echo   Please install Node.js 18 or newer: https://nodejs.org/
echo.
pause
exit /b 1

:failed
echo.
echo   [ERROR] Startup failed. See messages above.
pause
exit /b 1

:end
endlocal
