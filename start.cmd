@echo off
rem 双击即可启动。参数会透传给 node（例如 start.cmd --console）
chcp 65001 >nul
cd /d "%~dp0"
node src/index.mjs %*
echo.
echo [进程已退出] 按任意键关闭窗口...
pause >nul
