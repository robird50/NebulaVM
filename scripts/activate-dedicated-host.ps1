$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$taskName = "NebulaVM Host"
$watchdogTaskName = "NebulaVM Host Watchdog"
$projectRoot = Split-Path -Parent $PSScriptRoot
$hostTokenPath = Join-Path $projectRoot ".nebulavm-host-token"
$publicUrlPath = Join-Path $projectRoot ".nebulavm-public-url"

Enable-ScheduledTask -TaskName $taskName | Out-Null
Enable-ScheduledTask -TaskName $watchdogTaskName | Out-Null
Start-ScheduledTask -TaskName $taskName
Start-ScheduledTask -TaskName $watchdogTaskName

$deadline = (Get-Date).AddMinutes(3)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 3
  if (-not (Test-Path -LiteralPath $hostTokenPath) -or -not (Test-Path -LiteralPath $publicUrlPath)) {
    continue
  }
  $token = (Get-Content -LiteralPath $hostTokenPath -Raw).Trim()
  $publicUrl = (Get-Content -LiteralPath $publicUrlPath -Raw).Trim()
  if (-not $token -or -not $publicUrl) {
    continue
  }
  try {
    $response = Invoke-WebRequest `
      -UseBasicParsing `
      -Uri "$($publicUrl.TrimEnd('/'))/api/emustar-host/info" `
      -Headers @{ Authorization = "Bearer $token" } `
      -TimeoutSec 12
    if ($response.StatusCode -eq 200) {
      Write-Host "NebulaVM dedicated host is online and verified." -ForegroundColor Green
      Write-Host "Public bridge: $publicUrl" -ForegroundColor Cyan
      exit 0
    }
  } catch {
    # The supervisor may still be replacing its initial Quick Tunnel.
  }
}

throw "The dedicated host did not pass its public health check within three minutes."
