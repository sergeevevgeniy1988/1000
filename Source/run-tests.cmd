@echo off
chcp 65001 >nul
title 1000 - tests
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found.
  echo Install Node.js 18 or newer to run the tests.
  echo The game itself does not need Node.js.
  echo.
  pause
  exit /b 1
)

node --test tests/
if errorlevel 1 (
  echo.
  echo Tests failed.
  pause
  exit /b 1
)

echo.
echo All tests passed.
pause
