@echo off
chcp 65001 >nul
title 1000 - LAN launch
cd /d "%~dp0"
echo.
echo   1000 - LAN mode
echo   Allow PowerShell through Windows Firewall for PRIVATE networks when asked.
echo   Public bind addresses are refused; use this only on a trusted local network.
echo   Keep this window open and keep the host browser tab open during the game.
echo.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\serve.ps1" -Lan %*
if errorlevel 1 pause
