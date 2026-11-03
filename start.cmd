@echo off
chcp 65001 >nul
title 1000 - launch
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\serve.ps1" %*
if errorlevel 1 pause
