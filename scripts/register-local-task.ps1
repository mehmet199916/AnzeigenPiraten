$ErrorActionPreference = 'Stop'

$TaskName = 'AnzeigenPiraten Local Scan'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Launcher = Join-Path $PSScriptRoot 'run-local-hidden.vbs'
$WScript = Join-Path $env:SystemRoot 'System32\wscript.exe'
$CurrentUser = "$env:USERDOMAIN\$env:USERNAME"

$Action = New-ScheduledTaskAction `
  -Execute $WScript `
  -Argument "//B //NoLogo `"$Launcher`"" `
  -WorkingDirectory $RepoRoot
$Trigger = New-ScheduledTaskTrigger `
  -Once `
  -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes 5)
$Principal = New-ScheduledTaskPrincipal -UserId $CurrentUser -LogonType Interactive -RunLevel Limited
$Settings = New-ScheduledTaskSettingsSet `
  -MultipleInstances IgnoreNew `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 8)

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $Action `
  -Trigger $Trigger `
  -Principal $Principal `
  -Settings $Settings `
  -Description 'Scans Kleinanzeigen every five minutes with local Ollama, compares prices by product, and publishes changes to GitHub Pages.' `
  -Force | Out-Null

Write-Output "Registered '$TaskName' for the current Windows user."
Write-Output "Runs while this user is signed in; check $env:LOCALAPPDATA\AnzeigenPiraten\local-scan.log for output."
