$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$projectRoot = Split-Path -Parent $PSScriptRoot
$hostTaskName = "NebulaVM Host"
$hostScriptPath = Join-Path $PSScriptRoot "start-public-host.ps1"
$vitePath = Join-Path $projectRoot "node_modules\vite\bin\vite.js"
$publicUrlPath = Join-Path $projectRoot ".nebulavm-public-url"
$hostTokenPath = Join-Path $projectRoot ".nebulavm-host-token"
$watchdogLogPath = Join-Path $projectRoot ".nebulavm-watchdog.log"
$registryUrl = if ($env:NEBULAVM_REGISTRY_URL) {
  $env:NEBULAVM_REGISTRY_URL
} else {
  "https://nebulavm.online/.netlify/functions/host-registry"
}

function Write-WatchdogLog([string]$Message) {
  if (Test-Path -LiteralPath $watchdogLogPath) {
    $log = Get-Item -LiteralPath $watchdogLogPath -ErrorAction SilentlyContinue
    if ($log -and $log.Length -gt 262144) {
      Move-Item -LiteralPath $watchdogLogPath -Destination "$watchdogLogPath.old" -Force
    }
  }
  Add-Content -LiteralPath $watchdogLogPath -Value "[$(Get-Date -Format o)] $Message"
}

function Get-HostToken {
  if (-not (Test-Path -LiteralPath $hostTokenPath)) {
    return ""
  }
  return (Get-Content -LiteralPath $hostTokenPath -Raw).Trim()
}

function Get-AuthorizationHeaders {
  $token = Get-HostToken
  if (-not $token) {
    return @{}
  }
  return @{ Authorization = "Bearer $token" }
}

function Test-LocalHost {
  try {
    $response = Invoke-WebRequest `
      -UseBasicParsing `
      -Uri "http://127.0.0.1:5174/api/emustar-host/info" `
      -Headers (Get-AuthorizationHeaders) `
      -TimeoutSec 5
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

function Get-PublicUrl {
  if (-not (Test-Path -LiteralPath $publicUrlPath)) {
    return ""
  }
  return (Get-Content -LiteralPath $publicUrlPath -Raw).Trim()
}

function Test-PublicHost([string]$PublicUrl) {
  if (-not $PublicUrl) {
    return $false
  }
  try {
    $response = Invoke-WebRequest `
      -UseBasicParsing `
      -Uri "$($PublicUrl.TrimEnd('/'))/api/emustar-host/info" `
      -Headers (Get-AuthorizationHeaders) `
      -TimeoutSec 10
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

function Publish-Registry([string]$PublicUrl) {
  $token = Get-HostToken
  if (-not $PublicUrl -or -not $token) {
    return
  }
  $body = @{
    publicUrl = $PublicUrl
    accessToken = $token
  } | ConvertTo-Json -Compress
  Invoke-WebRequest `
    -UseBasicParsing `
    -Method Post `
    -Uri $registryUrl `
    -ContentType "application/json" `
    -Body $body `
    -TimeoutSec 15 | Out-Null
}

function Get-NebulaProcesses {
  try {
    return @(
      Get-CimInstance Win32_Process -ErrorAction Stop |
        Where-Object {
          ($_.Name -eq "powershell.exe" -and $_.ProcessId -ne $PID -and $_.CommandLine -like "*$hostScriptPath*") -or
          ($_.Name -eq "node.exe" -and $_.CommandLine -like "*$vitePath*" -and $_.CommandLine -like "*5174*") -or
          ($_.Name -eq "cloudflared.exe" -and $_.CommandLine -like "*127.0.0.1:5174*")
        }
    )
  } catch {
    return @()
  }
}

function Restart-NebulaHost {
  Write-WatchdogLog "The host failed two health checks. Restarting only NebulaVM Host and its tunnel."
  Stop-ScheduledTask -TaskName $hostTaskName -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2

  foreach ($process in (Get-NebulaProcesses)) {
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $publicUrlPath -Force -ErrorAction SilentlyContinue
  Start-ScheduledTask -TaskName $hostTaskName -ErrorAction Stop

  $deadline = (Get-Date).AddMinutes(2)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 3
    $publicUrl = Get-PublicUrl
    if ((Test-LocalHost) -and (Test-PublicHost $publicUrl)) {
      Publish-Registry $publicUrl
      Write-WatchdogLog "Recovery succeeded and the public registry was refreshed."
      return
    }
  }
  throw "NebulaVM Host did not pass its public health check within two minutes."
}

$createdNew = $false
$watchdogMutex = [System.Threading.Mutex]::new(
  $true,
  "Global\NebulaVM-Host-Watchdog",
  [ref]$createdNew
)
if (-not $createdNew) {
  $watchdogMutex.Dispose()
  exit 0
}

try {
  $publicUrl = Get-PublicUrl
  if ((Test-LocalHost) -and (Test-PublicHost $publicUrl)) {
    Publish-Registry $publicUrl
    exit 0
  }

  Start-Sleep -Seconds 5
  $publicUrl = Get-PublicUrl
  if ((Test-LocalHost) -and (Test-PublicHost $publicUrl)) {
    Publish-Registry $publicUrl
    exit 0
  }

  Restart-NebulaHost
} catch {
  Write-WatchdogLog "Recovery failed: $($_.Exception.Message)"
  exit 1
} finally {
  $watchdogMutex.ReleaseMutex()
  $watchdogMutex.Dispose()
}
