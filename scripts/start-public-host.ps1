$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$projectRoot = Split-Path -Parent $PSScriptRoot
$nodePath = "C:\Program Files\nodejs\node.exe"
$vitePath = Join-Path $projectRoot "node_modules\vite\bin\vite.js"
$cloudflaredPath = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
$publicUrlPath = Join-Path $projectRoot ".nebulavm-public-url"
$hostTokenPath = Join-Path $projectRoot ".nebulavm-host-token"
$cloudflaredLogPath = Join-Path $projectRoot ".nebulavm-cloudflared.log"
$netlifyRegistryUrl = if ($env:NEBULAVM_REGISTRY_URL) {
  $env:NEBULAVM_REGISTRY_URL
} else {
  "https://nebulavm.netlify.app/.netlify/functions/host-registry"
}
$lastRegistryPublish = Get-Date 0

function Get-NebulaHostToken {
  if (-not (Test-Path -LiteralPath $hostTokenPath)) {
    return ""
  }
  return (Get-Content -LiteralPath $hostTokenPath -Raw).Trim()
}

function Get-NebulaAuthorizationHeaders {
  $headers = @{}
  $token = Get-NebulaHostToken
  if ($token) {
    $headers.Authorization = "Bearer $token"
  }
  return $headers
}

function Test-NebulaHost {
  try {
    $response = Invoke-WebRequest `
      -UseBasicParsing `
      -Uri "http://127.0.0.1:5174/api/emustar-host/info" `
      -Headers (Get-NebulaAuthorizationHeaders) `
      -TimeoutSec 5
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

function Test-NebulaPublicHost([string]$PublicUrl) {
  if (-not $PublicUrl) {
    return $false
  }

  try {
    $response = Invoke-WebRequest `
      -UseBasicParsing `
      -Uri "$($PublicUrl.TrimEnd('/'))/api/emustar-host/info" `
      -Headers (Get-NebulaAuthorizationHeaders) `
      -TimeoutSec 12
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

function Start-NebulaHost {
  if (Test-NebulaHost) {
    return
  }

  Start-Process `
    -FilePath $nodePath `
    -ArgumentList @($vitePath, "--host", "0.0.0.0", "--port", "5174", "--strictPort") `
    -WorkingDirectory $projectRoot `
    -WindowStyle Hidden | Out-Null

  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $deadline) {
    if (Test-NebulaHost) {
      return
    }
    Start-Sleep -Milliseconds 500
  }
  throw "NebulaVM Host did not start on port 5174."
}

function Get-NebulaTunnelProcesses {
  try {
    return @(
      Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" -ErrorAction Stop |
        Where-Object {
          $_.CommandLine -like "*tunnel*" -and
          $_.CommandLine -like "*127.0.0.1:5174*"
        }
    )
  } catch {
    return @()
  }
}

function Stop-NebulaTunnels {
  foreach ($tunnelProcess in (Get-NebulaTunnelProcesses)) {
    Stop-Process -Id $tunnelProcess.ProcessId -Force -ErrorAction SilentlyContinue
  }
}

function Get-PublicUrlFromLog {
  if (-not (Test-Path -LiteralPath $cloudflaredLogPath)) {
    return ""
  }

  $match = Select-String `
    -Path $cloudflaredLogPath `
    -Pattern "https://[a-z0-9-]+\.trycloudflare\.com" `
    -AllMatches |
    Select-Object -Last 1
  if (-not $match) {
    return ""
  }
  return ($match.Matches.Value | Select-Object -Last 1)
}

function Test-TunnelRejected {
  if (-not (Test-Path -LiteralPath $cloudflaredLogPath)) {
    return $false
  }
  return [bool](Select-String `
    -Path $cloudflaredLogPath `
    -Pattern "Unauthorized: Tunnel not found|Register tunnel error from server side" `
    -Quiet)
}

function Start-NebulaTunnel {
  Stop-NebulaTunnels
  Remove-Item -LiteralPath $publicUrlPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $cloudflaredLogPath -Force -ErrorAction SilentlyContinue

  $process = Start-Process `
    -FilePath $cloudflaredPath `
    -ArgumentList @(
      "tunnel",
      "--url", "http://127.0.0.1:5174",
      "--protocol", "http2",
      "--no-autoupdate",
      "--logfile", $cloudflaredLogPath,
      "--loglevel", "info"
    ) `
    -WindowStyle Hidden `
    -PassThru

  $deadline = (Get-Date).AddSeconds(90)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 750
    $process.Refresh()
    if ($process.HasExited -or (Test-TunnelRejected)) {
      break
    }

    $publicUrl = Get-PublicUrlFromLog
    if ($publicUrl -and (Test-NebulaPublicHost $publicUrl)) {
      Set-Content -LiteralPath $publicUrlPath -Value $publicUrl -Encoding ASCII
      return @{
        Process = $process
        PublicUrl = $publicUrl
      }
    }
  }

  if (-not $process.HasExited) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $publicUrlPath -Force -ErrorAction SilentlyContinue
  throw "The NebulaVM public tunnel did not pass its health check."
}

function Publish-NetlifyRegistry([string]$PublicUrl, [switch]$Force) {
  $hostToken = Get-NebulaHostToken
  if (-not $PublicUrl -or -not $hostToken) {
    return
  }
  if (-not $Force -and ((Get-Date) - $script:lastRegistryPublish).TotalSeconds -lt 30) {
    return
  }
  if (-not (Test-NebulaPublicHost $PublicUrl)) {
    throw "The public tunnel failed its health check before registry publishing."
  }

  $body = @{
    publicUrl = $PublicUrl
    accessToken = $hostToken
  } | ConvertTo-Json -Compress
  Invoke-WebRequest `
    -UseBasicParsing `
    -Method Post `
    -Uri $netlifyRegistryUrl `
    -ContentType "application/json" `
    -Body $body `
    -TimeoutSec 15 | Out-Null
  $script:lastRegistryPublish = Get-Date
}

$createdNew = $false
$supervisorMutex = [System.Threading.Mutex]::new(
  $true,
  "Global\NebulaVM-Host-Supervisor",
  [ref]$createdNew
)
if (-not $createdNew) {
  $supervisorMutex.Dispose()
  exit 0
}

Set-Location $projectRoot
try {
  while ($true) {
    try {
      Start-NebulaHost
      $tunnel = Start-NebulaTunnel
      Publish-NetlifyRegistry -PublicUrl $tunnel.PublicUrl -Force

      $consecutiveHealthFailures = 0
      while ($true) {
        Start-Sleep -Seconds 5
        $tunnel.Process.Refresh()
        if ($tunnel.Process.HasExited -or (Test-TunnelRejected)) {
          throw "The public tunnel stopped or was rejected."
        }

        Start-NebulaHost
        if (Test-NebulaPublicHost $tunnel.PublicUrl) {
          $consecutiveHealthFailures = 0
          Publish-NetlifyRegistry -PublicUrl $tunnel.PublicUrl
        } else {
          $consecutiveHealthFailures += 1
          if ($consecutiveHealthFailures -ge 3) {
            throw "The public tunnel failed three consecutive health checks."
          }
        }
      }
    } catch {
      Add-Content `
        -LiteralPath $cloudflaredLogPath `
        -Value "[$(Get-Date -Format o)] Host supervisor: $($_.Exception.Message)"
      Stop-NebulaTunnels
      Remove-Item -LiteralPath $publicUrlPath -Force -ErrorAction SilentlyContinue
      Start-Sleep -Seconds 5
    }
  }
} finally {
  Stop-NebulaTunnels
  Remove-Item -LiteralPath $publicUrlPath -Force -ErrorAction SilentlyContinue
  $supervisorMutex.ReleaseMutex()
  $supervisorMutex.Dispose()
}
