$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$projectRoot = Split-Path -Parent $PSScriptRoot
$nodePath = "C:\Program Files\nodejs\node.exe"
$vitePath = Join-Path $projectRoot "node_modules\vite\bin\vite.js"
$cloudflaredPath = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
$publicUrlPath = Join-Path $projectRoot ".nebulavm-public-url"
$hostTokenPath = Join-Path $projectRoot ".nebulavm-host-token"
$cloudflaredLogPath = Join-Path $projectRoot ".nebulavm-cloudflared.log"
$autopilotEventPath = Join-Path $projectRoot ".nebulavm-autopilot-events.jsonl"
$autopilotRunId = [Guid]::NewGuid().ToString("N")
$netlifyRegistryUrl = if ($env:NEBULAVM_REGISTRY_URL) {
  $env:NEBULAVM_REGISTRY_URL
} else {
  "https://nebulavm.online/.netlify/functions/host-registry"
}
$lastRegistryPublish = Get-Date 0

function Write-AutopilotEvent {
  param(
    [string]$Kind,
    [string]$Message
  )

  if (Test-Path -LiteralPath $autopilotEventPath) {
    $eventLog = Get-Item -LiteralPath $autopilotEventPath -ErrorAction SilentlyContinue
    if ($eventLog -and $eventLog.Length -gt 262144) {
      Move-Item -LiteralPath $autopilotEventPath -Destination "$autopilotEventPath.old" -Force
    }
  }
  [ordered]@{
    id = [Guid]::NewGuid().ToString("N")
    runId = $autopilotRunId
    timestamp = (Get-Date).ToUniversalTime().ToString("o")
    kind = $Kind
    message = $Message
  } | ConvertTo-Json -Compress | Add-Content -LiteralPath $autopilotEventPath -Encoding UTF8
}

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

function Test-NebulaHostPort {
  $client = [Net.Sockets.TcpClient]::new()
  try {
    $connection = $client.ConnectAsync("127.0.0.1", 5174)
    return $connection.Wait(1000) -and $client.Connected
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

function Get-NebulaHostProcesses {
  try {
    return @(
      Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop |
        Where-Object {
          $_.CommandLine -like "*NebulaVM*" -and
          $_.CommandLine -like "*vite*" -and
          $_.CommandLine -like "*--port*" -and
          $_.CommandLine -like "*5174*"
        }
    )
  } catch {
    return @()
  }
}

function Stop-NebulaHostProcesses {
  foreach ($hostProcess in (Get-NebulaHostProcesses)) {
    Stop-Process -Id $hostProcess.ProcessId -Force -ErrorAction SilentlyContinue
  }
}

function Test-NebulaPublicHost([string]$PublicUrl) {
  if (-not $PublicUrl) {
    return $false
  }

  try {
    $publicUri = [Uri]$PublicUrl
    $dnsLookup = [Net.Dns]::GetHostAddressesAsync($publicUri.DnsSafeHost)
    if (-not $dnsLookup.Wait(4000) -or $dnsLookup.Result.Count -eq 0) {
      return $false
    }

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

  # A healthy Vite process can still be finishing startup when the supervisor
  # begins. Give that existing listener time to answer instead of racing it
  # with a second strict-port process.
  if (Test-NebulaHostPort) {
    $existingHostDeadline = (Get-Date).AddSeconds(15)
    while ((Get-Date) -lt $existingHostDeadline) {
      if (Test-NebulaHost) {
        return
      }
      Start-Sleep -Milliseconds 500
    }
  }

  Stop-NebulaHostProcesses

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

function Get-ExistingNebulaTunnel {
  $publicUrl = if (Test-Path -LiteralPath $publicUrlPath) {
    (Get-Content -LiteralPath $publicUrlPath -Raw).Trim()
  } else {
    ""
  }
  $tunnelProcess = Get-NebulaTunnelProcesses | Select-Object -First 1
  if (-not $tunnelProcess -or -not (Test-NebulaPublicHost $publicUrl)) {
    return $null
  }

  try {
    return @{
      Process = Get-Process -Id $tunnelProcess.ProcessId -ErrorAction Stop
      PublicUrl = $publicUrl
    }
  } catch {
    return $null
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
    -Pattern "Unauthorized: Tunnel not found" `
    -Quiet)
}

function Start-NebulaTunnel {
  Write-AutopilotEvent -Kind "command" -Message "Starting a replacement Cloudflare bridge for the NebulaVM host."
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
    Start-Sleep -Seconds 2
    $process.Refresh()
    if ($process.HasExited -or (Test-TunnelRejected)) {
      break
    }

    $publicUrl = Get-PublicUrlFromLog
    if ($publicUrl -and (Test-NebulaPublicHost $publicUrl)) {
      Set-Content -LiteralPath $publicUrlPath -Value $publicUrl -Encoding ASCII
      Write-AutopilotEvent -Kind "file" -Message "Wrote the live bridge to .nebulavm-public-url."
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
  if ($Force) {
    Write-AutopilotEvent -Kind "success" -Message "Published the verified bridge to the public host registry."
  }
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
      $tunnel = Get-ExistingNebulaTunnel
      if ($tunnel) {
        Write-AutopilotEvent -Kind "check" -Message "Adopted the healthy public bridge and resumed its registry heartbeat."
      } else {
        $tunnel = Start-NebulaTunnel
      }
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
      Write-AutopilotEvent -Kind "error" -Message "Host supervisor retry: $($_.Exception.Message)"
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
