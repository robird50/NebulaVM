$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$pidPath = Join-Path $projectRoot ".nebulavm-transfer-process-id"
if (Test-Path -LiteralPath $pidPath -PathType Leaf) {
  $transferPid = [int](Get-Content -LiteralPath $pidPath -Raw)
  Stop-Process -Id $transferPid -Force -ErrorAction SilentlyContinue
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
