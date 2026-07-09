$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$supervisorPath = Join-Path $PSScriptRoot "start-public-host.ps1"
$taskName = "NebulaVM Host"

$action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$supervisorPath`"" `
  -WorkingDirectory $projectRoot

$startupTrigger = New-ScheduledTaskTrigger -AtStartup
$startupTrigger.Delay = "PT30S"
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn
$principal = New-ScheduledTaskPrincipal `
  -UserId "SYSTEM" `
  -LogonType ServiceAccount `
  -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew

Register-ScheduledTask `
  -TaskName $taskName `
  -Action $action `
  -Trigger @($startupTrigger, $logonTrigger) `
  -Principal $principal `
  -Settings $settings `
  -Description "Keeps the NebulaVM browser host, Windows VM, and public tunnel available." `
  -Force | Out-Null

Start-ScheduledTask -TaskName $taskName
Get-ScheduledTask -TaskName $taskName
