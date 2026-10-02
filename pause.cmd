@echo off
rem Quick stop for the bot WITHOUT killing the process:
rem she keeps listening and remembering, just stops talking.
rem Default 30 minutes.  Double-click and answer the prompt for other durations.
chcp 65001 >nul
cd /d "%~dp0"
set /p MIN="暂停多少分钟？（直接回车 = 30，输入 0 = 一直暂停）: "
if "%MIN%"=="" set MIN=30
node "%~dp0tools\switch.mjs" pause %MIN%
echo.
pause
