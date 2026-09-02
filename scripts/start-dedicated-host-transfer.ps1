param(
  [Parameter(Mandatory = $true)]
  [string]$SpareAddress,

  [Parameter(Mandatory = $true)]
  [string]$BootstrapDrive,

  [int]$Port = 58473
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Test-IsAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-IsAdministrator)) {
  throw "Open PowerShell as Administrator before starting the private transfer."
}
if ($SpareAddress -notmatch "^192\.168\.0\.\d{1,3}$") {
  throw "The spare PC address must be on the expected 192.168.0.x home network."
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$bootstrapRoot = [IO.Path]::GetPathRoot([IO.Path]::GetFullPath($BootstrapDrive))
if (-not (Test-Path -LiteralPath $bootstrapRoot -PathType Container)) {
  throw "The bootstrap drive is not connected: $bootstrapRoot"
}
if ((Get-PSDrive -Name $bootstrapRoot.TrimEnd("\").TrimEnd(":")).Free -lt 2MB) {
  throw "The bootstrap drive needs at least 2 MB free for the downloader."
}

$route = Find-NetRoute -RemoteIPAddress $SpareAddress | Select-Object -First 1
$localAddress = Get-NetIPAddress -InterfaceIndex $route.InterfaceIndex -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -notlike "169.254.*" } |
  Select-Object -First 1 -ExpandProperty IPAddress
if (-not $localAddress) {
  throw "Could not find this PC's local address for the spare PC route."
}

$template = Get-ChildItem -LiteralPath (Join-Path $projectRoot "vm-disks\emustar-hyperv\disks") `
  -File -Filter "windows-11-template-*.vhdx" |
  Where-Object { $_.Length -ge 8GB } |
  Sort-Object -Property `
    @{ Expression = "LastWriteTimeUtc"; Descending = $true }, `
    @{ Expression = "Length"; Descending = $true } |
  Select-Object -First 1
if (-not $template) {
  throw "No prepared Windows 11 template disk was found."
}

$sourceArchive = Join-Path $projectRoot ".nebulavm-transfer-source.zip"
$configPath = Join-Path $projectRoot ".nebulavm-transfer-config.json"
$readyPath = Join-Path $projectRoot ".nebulavm-transfer-ready"
$pidPath = Join-Path $projectRoot ".nebulavm-transfer-process-id"
$outputLogPath = Join-Path $projectRoot ".nebulavm-transfer-output.log"
$errorLogPath = Join-Path $projectRoot ".nebulavm-transfer-error.log"
$firewallRule = "NebulaVM Dedicated Host Transfer"
$scheduledTask = "NebulaVM Dedicated Host Transfer"

Remove-Item -LiteralPath $sourceArchive, $configPath, $readyPath, $pidPath, $outputLogPath, $errorLogPath -Force -ErrorAction SilentlyContinue
Get-ScheduledTask -TaskName $scheduledTask -ErrorAction SilentlyContinue |
  Stop-ScheduledTask -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $scheduledTask -Confirm:$false -ErrorAction SilentlyContinue
& git -C $projectRoot archive --format=zip --output=$sourceArchive HEAD
if ($LASTEXITCODE -ne 0) {
  throw "Could not build the dedicated-host source archive."
}

Write-Host "Hashing the 27 GB Windows template once for end-to-end verification..." -ForegroundColor Cyan
$files = [ordered]@{
  source = [ordered]@{
    path = $sourceArchive
    name = "nebulavm-source.zip"
    sha256 = (Get-FileHash -LiteralPath $sourceArchive -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  template = [ordered]@{
    path = $template.FullName
    name = "windows-11-template-dedicated.vhdx"
    sha256 = (Get-FileHash -LiteralPath $template.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  }
}
foreach ($item in @(
  @{ Id = "admin-token"; Path = (Join-Path $projectRoot ".nebulavm-admin-token"); Name = ".nebulavm-admin-token" },
  @{ Id = "guest-credentials"; Path = (Join-Path $projectRoot ".nebulavm-guest-credentials.json"); Name = ".nebulavm-guest-credentials.json" }
)) {
  if (Test-Path -LiteralPath $item.Path -PathType Leaf) {
    $files[$item.Id] = [ordered]@{
      path = $item.Path
      name = $item.Name
      sha256 = (Get-FileHash -LiteralPath $item.Path -Algorithm SHA256).Hash.ToLowerInvariant()
    }
  }
}

$tokenBytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($tokenBytes)
$token = ([BitConverter]::ToString($tokenBytes) -replace "-", "").ToLowerInvariant()
[ordered]@{
  token = $token
  allowedAddress = $SpareAddress
  bindAddress = "0.0.0.0"
  port = $Port
  readyPath = $readyPath
  pidPath = $pidPath
  files = $files
} | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $configPath -Encoding UTF8

Get-NetFirewallRule -DisplayName $firewallRule -ErrorAction SilentlyContinue |
  Remove-NetFirewallRule -ErrorAction SilentlyContinue
New-NetFirewallRule `
  -DisplayName $firewallRule `
  -Direction Inbound `
  -Action Allow `
  -Protocol TCP `
  -LocalPort $Port `
  -RemoteAddress $SpareAddress `
  -Profile Any | Out-Null

$nodePath = "C:\Program Files\nodejs\node.exe"
$serverPath = Join-Path $PSScriptRoot "dedicated-host-transfer-server.mjs"
if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
  throw "Node.js was not found at $nodePath."
}
$action = New-ScheduledTaskAction `
  -Execute $nodePath `
  -Argument ('"{0}" "{1}"' -f $serverPath, $configPath) `
  -WorkingDirectory $projectRoot
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddHours(12)
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Days 2)
Register-ScheduledTask `
  -TaskName $scheduledTask `
  -Action $action `
  -Trigger $trigger `
  -Principal $principal `
  -Settings $settings `
  -Description "Temporary private NebulaVM host migration service." `
  -Force | Out-Null
Start-ScheduledTask -TaskName $scheduledTask

$deadline = (Get-Date).AddSeconds(15)
while ((Get-Date) -lt $deadline -and -not (Test-Path -LiteralPath $readyPath)) {
  Start-Sleep -Milliseconds 250
}
if (-not (Test-Path -LiteralPath $readyPath)) {
  $task = Get-ScheduledTaskInfo -TaskName $scheduledTask -ErrorAction SilentlyContinue
  throw "The private transfer service did not start. Scheduled task result: $($task.LastTaskResult)"
}

$baseUri = "http://${localAddress}:$Port"
$downloaderTemplate = @'
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$baseUri = "__BASE_URI__"
$token = "__TOKEN__"
$destination = "C:\NebulaVM-Dedicated-Host"
$headers = @{ Authorization = "Bearer $token" }

function Receive-TransferFile {
  param(
    [string]$Id,
    [string]$Path,
    [string]$ExpectedHash,
    [long]$ExpectedSize
  )

  New-Item -ItemType Directory -Path (Split-Path -Parent $Path) -Force | Out-Null
  if (Test-Path -LiteralPath $Path -PathType Leaf) {
    $currentSize = (Get-Item -LiteralPath $Path).Length
    if ($currentSize -eq $ExpectedSize) {
      $currentHash = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($currentHash -eq $ExpectedHash) {
        Write-Host "$Id is already complete and verified." -ForegroundColor Green
        return
      }
      Remove-Item -LiteralPath $Path -Force
    } elseif ($currentSize -gt $ExpectedSize) {
      Remove-Item -LiteralPath $Path -Force
    }
  }
  & "$env:SystemRoot\System32\curl.exe" `
    --fail --location --retry 20 --retry-delay 3 --continue-at - `
    --header "Authorization: Bearer $token" `
    "$baseUri/files/$Id" `
    --output $Path
  if ($LASTEXITCODE -ne 0) {
    throw "Transfer failed for $Id. Run this downloader again to resume."
  }
  $actualHash = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -ne $ExpectedHash) {
    Remove-Item -LiteralPath $Path -Force
    throw "Verification failed for $Id. The damaged copy was removed; run this downloader again."
  }
}

$manifest = Invoke-RestMethod -Uri "$baseUri/manifest" -Headers $headers -TimeoutSec 15
if (-not $manifest.ok) { throw "The private transfer manifest is unavailable." }

$archive = Join-Path $env:TEMP "nebulavm-source.zip"
Receive-TransferFile `
  -Id "source" `
  -Path $archive `
  -ExpectedHash $manifest.files.source.sha256 `
  -ExpectedSize $manifest.files.source.size
New-Item -ItemType Directory -Path $destination -Force | Out-Null
Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force
Remove-Item -LiteralPath $archive -Force

$diskPath = Join-Path $destination "vm-disks\emustar-hyperv\disks\windows-11-template-dedicated.vhdx"
Receive-TransferFile `
  -Id "template" `
  -Path $diskPath `
  -ExpectedHash $manifest.files.template.sha256 `
  -ExpectedSize $manifest.files.template.size
(Get-Item -LiteralPath $diskPath).Attributes =
  (Get-Item -LiteralPath $diskPath).Attributes -bor [IO.FileAttributes]::ReadOnly

foreach ($id in @("admin-token", "guest-credentials")) {
  $property = $manifest.files.PSObject.Properties[$id]
  $entry = if ($property) { $property.Value } else { $null }
  if ($entry) {
    Receive-TransferFile `
      -Id $id `
      -Path (Join-Path $destination $entry.name) `
      -ExpectedHash $entry.sha256 `
      -ExpectedSize $entry.size
  }
}

Write-Host "NebulaVM transfer completed and verified." -ForegroundColor Green
Write-Host "Next, open PowerShell as Administrator and run:" -ForegroundColor Cyan
Write-Host "  cd C:\NebulaVM-Dedicated-Host"
Write-Host "  powershell.exe -ExecutionPolicy Bypass -File .\scripts\prepare-dedicated-host.ps1"
'@
$downloader = $downloaderTemplate.Replace("__BASE_URI__", $baseUri).Replace("__TOKEN__", $token)
$downloaderPath = Join-Path $bootstrapRoot "Download-NebulaVM-Host.ps1"
$downloader | Set-Content -LiteralPath $downloaderPath -Encoding UTF8

Write-Host "Private transfer service is ready." -ForegroundColor Green
Write-Host "Move the small USB to the spare PC and run: $downloaderPath" -ForegroundColor Cyan
Write-Host "Run the same downloader again if Wi-Fi drops; the 27 GB transfer will resume." -ForegroundColor Yellow
