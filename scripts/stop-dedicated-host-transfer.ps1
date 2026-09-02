$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$pidPath = Join-Path $projectRoot ".nebulavm-transfer-process-id"
$scheduledTask = "NebulaVM Dedicated Host Transfer"
Get-ScheduledTask -TaskName $scheduledTask -ErrorAction SilentlyContinue |
  Stop-ScheduledTask -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $scheduledTask -Confirm:$false -ErrorAction SilentlyContinue
if (Test-Path -LiteralPath $pidPath -PathType Leaf) {
  $transferPid = [int](Get-Content -LiteralPath $pidPath -Raw)
  $transferProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $transferPid" -ErrorAction SilentlyContinue
  if ($transferProcess.Name -eq "node.exe" -and
      $transferProcess.CommandLine -like "*dedicated-host-transfer-server.mjs*") {
    Stop-Process -Id $transferPid -Force -ErrorAction SilentlyContinue
  }
}
Get-NetFirewallRule -DisplayName "NebulaVM Dedicated Host Transfer" -ErrorAction SilentlyContinue |
  Remove-NetFirewallRule -ErrorAction SilentlyContinue
Remove-Item -LiteralPath `
  (Join-Path $projectRoot ".nebulavm-transfer-source.zip"), `
  (Join-Path $projectRoot ".nebulavm-transfer-config.json"), `
  (Join-Path $projectRoot ".nebulavm-transfer-ready"), `
  (Join-Path $projectRoot ".nebulavm-transfer-process-id"), `
  (Join-Path $projectRoot ".nebulavm-transfer-output.log"), `
  (Join-Path $projectRoot ".nebulavm-transfer-error.log") `
  -Force -ErrorAction SilentlyContinue
Write-Host "The private NebulaVM transfer service and firewall rule were removed." -ForegroundColor Green
