$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$supervisorPath = Join-Path $PSScriptRoot "start-public-host.ps1"
$taskName = "NebulaVM Host"
$interactiveUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

if ([string]::IsNullOrWhiteSpace($interactiveUser) -or $interactiveUser -eq "NT AUTHORITY\SYSTEM") {
  throw "Run this installer from the Windows account that will use NebulaVM Host, not as SYSTEM."
}

$action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$supervisorPath`"" `
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
  -MultipleInstances IgnoreNew

Register-ScheduledTask `
  -TaskName $taskName `
  -Action $action `
  -Trigger $logonTrigger `
  -Principal $principal `
  -Settings $settings `
  -Description "Keeps NebulaVM Host and its hidden interactive display bridges available while this user is signed in." `
  -Force | Out-Null

Start-ScheduledTask -TaskName $taskName
Get-ScheduledTask -TaskName $taskName
