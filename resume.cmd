@echo off
rem Let her talk again (clears the pause switch).
chcp 65001 >nul
cd /d "%~dp0"
node "%~dp0tools\switch.mjs" resume
echo.
pause
