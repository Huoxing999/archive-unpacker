@echo off
title Archive Unpacker
setlocal

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found.
  echo Please install Node.js 22 or newer from https://nodejs.org/
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo First run: installing dependencies, please wait...
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo [ERROR] Dependency installation failed. Please check your network and try again.
    echo.
    pause
    exit /b 1
  )
)

echo Starting Archive Unpacker...
call npm start
if errorlevel 1 (
  echo.
  echo [INFO] The app has exited. If startup failed, please check the error above.
  echo.
  pause
)

endlocal