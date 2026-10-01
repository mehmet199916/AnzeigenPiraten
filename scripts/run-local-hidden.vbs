Option Explicit

Dim shell, files, scriptPath, runnerPath, powershellPath, command
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")

scriptPath = WScript.ScriptFullName
runnerPath = files.BuildPath(files.GetParentFolderName(scriptPath), "run-local.ps1")
powershellPath = shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
command = Chr(34) & powershellPath & Chr(34) _
  & " -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File " _
  & Chr(34) & runnerPath & Chr(34)

' Window style 0 keeps the periodic scan out of the user's desktop.
shell.Run command, 0, False
