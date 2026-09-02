param(
  [Parameter(Mandatory = $true)]
  [string]$DestinationPath
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$projectRoot = Split-Path -Parent $PSScriptRoot
$destination = [IO.Path]::GetFullPath($DestinationPath)
$projectFullPath = [IO.Path]::GetFullPath($projectRoot)
if ($destination.TrimEnd("\") -eq [IO.Path]::GetPathRoot($destination).TrimEnd("\")) {
  throw "Choose a folder on the transfer drive, not the drive root itself."
}
if ($destination.StartsWith($projectFullPath, [StringComparison]::OrdinalIgnoreCase)) {
  throw "The transfer folder must be outside the current NebulaVM project."
}

$templateDirectory = Join-Path $projectRoot "vm-disks\emustar-hyperv\disks"
$template = Get-ChildItem -LiteralPath $templateDirectory -File -Filter "windows-11-template-*.vhdx" |
  Where-Object { $_.Length -ge 8GB } |
  Sort-Object -Property `
    @{ Expression = "LastWriteTimeUtc"; Descending = $true }, `
    @{ Expression = "Length"; Descending = $true } |
  Select-Object -First 1
if (-not $template) {
  throw "No prepared Windows 11 template disk was found."
}

$destinationRoot = [IO.Path]::GetPathRoot($destination)
$destinationDrive = Get-Volume -DriveLetter $destinationRoot.TrimEnd("\").TrimEnd(":") -ErrorAction Stop
if ($destinationDrive.FileSystem -eq "FAT32" -and $template.Length -gt 4GB) {
  throw "The transfer drive uses FAT32 and cannot hold the Windows template. Use an NTFS or exFAT drive."
}
if ($destinationDrive.SizeRemaining -lt ($template.Length + 5GB)) {
  throw "The transfer destination needs at least $([math]::Ceiling(($template.Length + 5GB) / 1GB)) GB free."
}

New-Item -ItemType Directory -Path $destination -Force | Out-Null
$archive = Join-Path $env:TEMP "nebulavm-dedicated-host-$([Guid]::NewGuid().ToString('N')).zip"
try {
  & git -C $projectRoot archive --format=zip --output=$archive HEAD
  if ($LASTEXITCODE -ne 0) {
    throw "Could not export the NebulaVM source tree."
  }
  Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force
} finally {
  Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
}

$destinationDiskDirectory = Join-Path $destination "vm-disks\emustar-hyperv\disks"
New-Item -ItemType Directory -Path $destinationDiskDirectory -Force | Out-Null
$destinationTemplate = Join-Path $destinationDiskDirectory "windows-11-template-dedicated.vhdx"
& robocopy.exe `
  $template.DirectoryName `
  $destinationDiskDirectory `
  $template.Name `
  /J /R:2 /W:2 /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -gt 7) {
  throw "The Windows template transfer failed with robocopy exit code $LASTEXITCODE."
}
if ($template.Name -ne [IO.Path]::GetFileName($destinationTemplate)) {
  Move-Item -LiteralPath (Join-Path $destinationDiskDirectory $template.Name) -Destination $destinationTemplate -Force
}
(Get-Item -LiteralPath $destinationTemplate).Attributes =
  (Get-Item -LiteralPath $destinationTemplate).Attributes -bor [IO.FileAttributes]::ReadOnly

foreach ($privateFile in @(".nebulavm-admin-token", ".nebulavm-guest-credentials.json")) {
  $source = Join-Path $projectRoot $privateFile
  if (Test-Path -LiteralPath $source -PathType Leaf) {
    Copy-Item -LiteralPath $source -Destination (Join-Path $destination $privateFile) -Force
  }
}

@"
NebulaVM dedicated-host transfer

This folder contains private administrative credentials and a licensed Windows
virtual disk. Keep it private and do not upload or share it.

On the spare PC, open PowerShell as Administrator in this folder and run:

  powershell.exe -ExecutionPolicy Bypass -File .\scripts\prepare-dedicated-host.ps1

The preparation step does not make the spare PC public. Follow the displayed
cutover steps only after preparation succeeds.
"@ | Set-Content -LiteralPath (Join-Path $destination "PRIVATE-TRANSFER-README.txt") -Encoding UTF8

Write-Host "Dedicated-host transfer is ready at: $destination" -ForegroundColor Green
Write-Host "Template copied: $([math]::Round($template.Length / 1GB, 1)) GB" -ForegroundColor Cyan
Write-Warning "Keep this folder private because it contains NebulaVM administrator credentials."
