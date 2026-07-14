$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$projectRoot = Split-Path -Parent $PSScriptRoot
$nodePath = "C:\Program Files\nodejs\node.exe"
$vitePath = Join-Path $projectRoot "node_modules\vite\bin\vite.js"
$cloudflaredPath = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
$publicUrlPath = Join-Path $projectRoot ".nebulavm-public-url"
$hostTokenPath = Join-Path $projectRoot ".nebulavm-host-token"
$cloudflaredLogPath = Join-Path $projectRoot ".nebulavm-cloudflared.log"
$hyperVModule = Get-ChildItem `
  "$env:SystemRoot\System32\WindowsPowerShell\v1.0\Modules\Hyper-V" `
  -Recurse `
  -Filter "Hyper-V.psd1" `
  -ErrorAction SilentlyContinue |
  Sort-Object FullName -Descending |
  Select-Object -First 1

if ($hyperVModule) {
  Import-Module $hyperVModule.FullName -Force
}

function Start-NebulaGuest {
  if (-not (Get-Command Get-VM -ErrorAction SilentlyContinue)) {
    return
  }

  $vm = Get-VM -Name "NebulaVM-EMUSTAR" -ErrorAction SilentlyContinue
  if ($vm -and $vm.State -eq "Off") {
    Start-VM -VM $vm | Out-Null
  }
}

function Test-NebulaHost {
  try {
    $headers = @{}
    if (Test-Path -LiteralPath $hostTokenPath) {
      $token = (Get-Content -LiteralPath $hostTokenPath -Raw).Trim()
      if ($token) {
        $headers.Authorization = "Bearer $token"
      }
    }
    $response = Invoke-WebRequest `
      -UseBasicParsing `
      -Uri "http://127.0.0.1:5174/api/emustar-host/info" `
      -Headers $headers `
      -TimeoutSec 5
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

function Start-NebulaTunnel {
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

  $deadline = (Get-Date).AddSeconds(60)
  while ((Get-Date) -lt $deadline -and -not $process.HasExited) {
    Start-Sleep -Milliseconds 500
    if (-not (Test-Path -LiteralPath $cloudflaredLogPath)) {
      continue
    }
    $match = Select-String `
      -Path $cloudflaredLogPath `
      -Pattern "https://[a-z0-9-]+\.trycloudflare\.com" `
      -AllMatches
    if ($match) {
      $publicUrl = $match.Matches.Value | Select-Object -First 1
      Set-Content -LiteralPath $publicUrlPath -Value $publicUrl -Encoding ASCII
      return $process
    }
  }

  if (-not $process.HasExited) {
    Stop-Process -Id $process.Id -Force
  }
  throw "The NebulaVM public tunnel did not become ready."
}

function Sync-PublicUrlFromLog {
  if (-not (Test-Path -LiteralPath $cloudflaredLogPath)) {
    return
  }

  $match = Select-String `
    -Path $cloudflaredLogPath `
    -Pattern "https://[a-z0-9-]+\.trycloudflare\.com" `
    -AllMatches |
    Select-Object -Last 1
  if ($match) {
    $publicUrl = $match.Matches.Value | Select-Object -Last 1
    Set-Content -LiteralPath $publicUrlPath -Value $publicUrl -Encoding ASCII
  }
}

Set-Location $projectRoot
while ($true) {
  try {
    Start-NebulaGuest
    Start-NebulaHost
    $tunnel = Start-NebulaTunnel
    while (-not $tunnel.HasExited) {
      Start-Sleep -Seconds 5
      Sync-PublicUrlFromLog
      Start-NebulaHost
      Start-NebulaGuest
    }
  } catch {
    Add-Content `
      -LiteralPath $cloudflaredLogPath `
      -Value "[$(Get-Date -Format o)] Host supervisor: $($_.Exception.Message)"
  }
  if (-not (Get-Process cloudflared -ErrorAction SilentlyContinue)) {
    Remove-Item -LiteralPath $publicUrlPath -Force -ErrorAction SilentlyContinue
  } else {
    Sync-PublicUrlFromLog
  }
  Start-Sleep -Seconds 5
}
