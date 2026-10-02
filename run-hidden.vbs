' Launch the QQ big-fish bot with a HIDDEN window.
' NOTE: keep this file pure ASCII. wscript.exe reads .vbs as ANSI, so non-ASCII
' characters (e.g. Chinese comments) get mangled and break the script.
' Invoked by Task Scheduler via wscript.exe so no black window pops up.
' The bot already logs to logs\bot.log; this also keeps stdout/stderr in
' logs\console.log so that failures before the logger starts are visible.
'
' The project directory is derived from this script's own location, so the file
' works wherever you clone the repo -- no hardcoded path to edit.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

projDir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = projDir

logDir = fso.BuildPath(projDir, "logs")
If Not fso.FolderExists(logDir) Then fso.CreateFolder(logDir)

logFile = fso.BuildPath(logDir, "console.log")
sh.Run "cmd /c node src\index.mjs >> """ & logFile & """ 2>&1", 0, False
