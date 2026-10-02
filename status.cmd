@echo off
rem Double-click this file to see whether the bot is actually running.
chcp 65001 >nul
cd /d "%~dp0"
node "%~dp0tools\status.mjs"
echo.
pause
