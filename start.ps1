# 一键启动 QQ 大肥鱼机器人
# 用法：
#   .\start.ps1              连接 QQ
#   .\start.ps1 --console    不连 QQ，在终端里聊天（调人设用）
#   .\start.ps1 --check      只做自检
$ErrorActionPreference = 'Stop'
Set-Location -Path (Split-Path -Parent $MyInvocation.MyCommand.Path)

# 让中文在 Windows 终端里正常显示
try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $OutputEncoding = [System.Text.Encoding]::UTF8
} catch { }

node src/index.mjs @args
exit $LASTEXITCODE
