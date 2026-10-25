@echo off
rem Guess It, HTO launcher for Windows: starts the local server and opens the game.
rem Needs Node.js (LTS) from https://nodejs.org, nothing else.
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js was not found. Install the LTS version from https://nodejs.org
  echo   then double-click this file again.
  echo.
  pause
  exit /b 1
)

if "%PORT%"=="" set PORT=5173

rem Open the browser a couple of seconds from now, once the server is listening.
start "" cmd /c "ping -n 3 127.0.0.1 >nul & start http://127.0.0.1:%PORT%"

echo.
echo   Guess It, HTO is running at http://127.0.0.1:%PORT%
echo   Close this window (or press Ctrl+C) to stop it.
echo.
node server.mjs
pause
