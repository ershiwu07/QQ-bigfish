@echo off
rem 停止大肥鱼机器人（无窗口模式下的“关机”按钮）
chcp 65001 >nul
cd /d "%~dp0"
node tools\stop.mjs
echo.
pause >nul
