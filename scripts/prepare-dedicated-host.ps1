param([switch]$AcknowledgeWindows10Risk)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Test-IsAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Install-WingetPackage {
  param([string]$Id, [string]$DisplayName)

  $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
  if (-not $winget) {
    throw "$DisplayName is missing and Windows Package Manager is unavailable. Install $DisplayName manually, then rerun this preparation."
  }
  & $winget.Source install --id $Id -e --silent --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) {
    throw "$DisplayName could not be installed by Windows Package Manager."
  }
}

if (-not (Test-IsAdministrator)) {
  throw "Open PowerShell as Administrator before preparing the NebulaVM host."
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$os = Get-CimInstance Win32_OperatingSystem
$computer = Get-CimInstance Win32_ComputerSystem
$processor = Get-CimInstance Win32_Processor | Select-Object -First 1
$systemDrive = Get-PSDrive -Name $env:SystemDrive.TrimEnd(":")
$template = Get-ChildItem -LiteralPath (Join-Path $projectRoot "vm-disks\emustar-hyperv\disks") `
  -File -Filter "windows-11-template-*.vhdx" |
  Where-Object { $_.Length -ge 8GB } |
  Sort-Object -Property `
    @{ Expression = "LastWriteTimeUtc"; Descending = $true }, `
    @{ Expression = "Length"; Descending = $true } |
  Select-Object -First 1

if ($os.Caption -notmatch "Windows 10 Pro|Windows 11 Pro|Education|Enterprise") {
  throw "This PC needs Windows Pro, Education, or Enterprise for Microsoft Hyper-V. Detected: $($os.Caption)."
}
if ([int64]$computer.TotalPhysicalMemory -lt 7.5GB) {
  throw "This dedicated host needs at least 8 GB of physical RAM."
}
if ([int64]$systemDrive.Free -lt 100GB) {
  throw "Keep at least 100 GB free before activating this dedicated host."
}
if (-not $template) {
  throw "The prepared Windows 11 template VHDX is missing from the transfer folder."
}
if ($processor.SecondLevelAddressTranslationExtensions -eq $false) {
  throw "This CPU does not report the second-level address translation required by Hyper-V."
}
if ($processor.VirtualizationFirmwareEnabled -eq $false) {
  throw "CPU virtualization is disabled in BIOS/UEFI. Enable Intel Virtualization Technology, then rerun this script."
}
if ($os.Caption -match "Windows 10" -and -not $AcknowledgeWindows10Risk) {
  Write-Warning "Windows 10 standard support ended on October 14, 2025. Do not expose an unpatched host to public uploads."
  throw "Rerun with -AcknowledgeWindows10Risk only after enabling Windows 10 ESU or accepting the security risk."
}

$hyperV = Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All
if ($hyperV.State -ne "Enabled") {
  Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All -All -NoRestart | Out-Null
  Write-Warning "Hyper-V was enabled. Restart Windows, then rerun this exact preparation command."
  exit 3010
}

$nodePath = "C:\Program Files\nodejs\node.exe"
if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
  Install-WingetPackage -Id "OpenJS.NodeJS.LTS" -DisplayName "Node.js LTS"
}
$cloudflaredPaths = @(
  "C:\Program Files (x86)\cloudflared\cloudflared.exe",
  "C:\Program Files\cloudflared\cloudflared.exe",
  "$env:LOCALAPPDATA\Microsoft\WinGet\Links\cloudflared.exe"
)
if (-not ($cloudflaredPaths | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1)) {
  Install-WingetPackage -Id "Cloudflare.cloudflared" -DisplayName "Cloudflare Tunnel"
}

if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
  throw "Node.js was installed but is not available yet. Restart Windows and rerun this script."
}

Push-Location $projectRoot
try {
  & "C:\Program Files\nodejs\npm.cmd" ci --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) {
    throw "NebulaVM dependencies could not be installed."
  }
} finally {
  Pop-Location
}

$template.Attributes = $template.Attributes -bor [IO.FileAttributes]::ReadOnly
& icacls.exe $template.FullName /grant 'NT VIRTUAL MACHINE\Virtual Machines:(R)' | Out-Null
powercfg.exe /change standby-timeout-ac 0 | Out-Null
powercfg.exe /change hibernate-timeout-ac 0 | Out-Null

& (Join-Path $PSScriptRoot "install-host-autostart.ps1") -DoNotStart | Out-Null

Write-Host "NebulaVM spare host preparation succeeded." -ForegroundColor Green
Write-Host "The public host tasks are installed but disabled, so this PC is not serving visitors yet." -ForegroundColor Yellow
Write-Host "Next: disable the old host, then run scripts\activate-dedicated-host.ps1 here as Administrator." -ForegroundColor Cyan
