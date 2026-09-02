param([switch]$DoNotStart)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$supervisorPath = Join-Path $PSScriptRoot "start-public-host.ps1"
$watchdogPath = Join-Path $PSScriptRoot "watch-public-host.ps1"
$hiddenLauncherPath = Join-Path $PSScriptRoot "run-powershell-hidden.vbs"
$taskName = "NebulaVM Host"
$watchdogTaskName = "NebulaVM Host Watchdog"
$interactiveUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

if ([string]::IsNullOrWhiteSpace($interactiveUser) -or $interactiveUser -eq "NT AUTHORITY\SYSTEM") {
  throw "Run this installer from the Windows account that will use NebulaVM Host, not as SYSTEM."
}

Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Stop-ScheduledTask -TaskName $watchdogTaskName -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

$action = New-ScheduledTaskAction `
  -Execute "wscript.exe" `
  -Argument "//B //NoLogo `"$hiddenLauncherPath`" `"$supervisorPath`"" `
  -WorkingDirectory $projectRoot

$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $interactiveUser
$logonTrigger.Delay = "PT10S"
$principal = New-ScheduledTaskPrincipal `
  -UserId $interactiveUser `
  -LogonType Interactive `
  -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -Hidden `
  -MultipleInstances IgnoreNew

Register-ScheduledTask `
  -TaskName $taskName `
  -Action $action `
  -Trigger $logonTrigger `
  -Principal $principal `
  -Settings $settings `
  -Description "Keeps NebulaVM Host and its hidden interactive display bridges available while this user is signed in." `
  -Force | Out-Null

$watchdogAction = New-ScheduledTaskAction `
  -Execute "wscript.exe" `
  -Argument "//B //NoLogo `"$hiddenLauncherPath`" `"$watchdogPath`"" `
  -WorkingDirectory $projectRoot
$watchdogTrigger = New-ScheduledTaskTrigger `
  -Once `
  -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes 1)
$watchdogSettings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 3) `
  -Hidden `
  -MultipleInstances IgnoreNew

Register-ScheduledTask `
  -TaskName $watchdogTaskName `
  -Action $watchdogAction `
  -Trigger $watchdogTrigger `
  -Principal $principal `
  -Settings $watchdogSettings `
  -Description "Checks NebulaVM Host and its public tunnel every minute, then safely restarts stale host components." `
  -Force | Out-Null

if ($DoNotStart) {
  Disable-ScheduledTask -TaskName $taskName | Out-Null
  Disable-ScheduledTask -TaskName $watchdogTaskName | Out-Null
} else {
  Start-ScheduledTask -TaskName $taskName
  Start-ScheduledTask -TaskName $watchdogTaskName
}
Get-ScheduledTask -TaskName $taskName, $watchdogTaskName
