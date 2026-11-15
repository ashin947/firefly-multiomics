@echo off
setlocal
title DEG Studio
cd /d "%~dp0"

echo ==========================================
echo   DEG Studio
echo ==========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found in PATH.
  echo Install Node.js 18+ and try again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo [1/2] Installing dependencies, please wait...
  call npm install
  if errorlevel 1 (
    echo.
    echo [ERROR] npm install failed. Check network and retry.
    pause
    exit /b 1
  )
)

echo [2/2] Starting...
echo.

set "ELECTRON_RUN_AS_NODE="
set "ELECTRON_NO_ATTACH_CONSOLE="

call npm run dev 2>&1
set "RC=%ERRORLEVEL%"

echo.
echo ------------------------------------------
echo Process exited with code %RC%.
echo If the window did not appear, see the log above.
echo ------------------------------------------
echo.
pause
