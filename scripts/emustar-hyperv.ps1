param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Status", "Start", "AutoRecover", "Stop", "RequestNewDisk", "Reset", "OpenConsole", "CloseConsole", "ResizeDisplay")]
  [string]$Action,

  [string]$ConfigBase64 = ""
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$vmName = "NebulaVM-EMUSTAR"
$warnings = [System.Collections.Generic.List[string]]::new()
$autopilotActions = [System.Collections.Generic.List[string]]::new()
$autopilotEventPath = Join-Path (Split-Path -Parent $PSScriptRoot) ".nebulavm-autopilot-events.jsonl"
$autopilotRunId = [Guid]::NewGuid().ToString("N")
$privateDiskTtlHours = 12
$privateDiskMaxBytes = [int64]80GB
$hostStorageReserveBytes = [int64]25GB

function Write-AutopilotEvent {
  param(
    [string]$Kind,
    [string]$Message
  )

  if ($Action -ne "AutoRecover" -or [string]::IsNullOrWhiteSpace($Message)) {
    return
  }
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

function Format-NebulaSize {
  param([int64]$Bytes)

  if ($Bytes -ge 1GB) {
    return "{0:N1} GB" -f ($Bytes / 1GB)
  }
  if ($Bytes -ge 1MB) {
    return "{0:N0} MB" -f ($Bytes / 1MB)
  }
  if ($Bytes -ge 1KB) {
    return "{0:N0} KB" -f ($Bytes / 1KB)
  }
  return "$Bytes bytes"
}

function Get-NebulaDriveFreeBytes {
  param([string]$TargetPath)

  $fullPath = [IO.Path]::GetFullPath($TargetPath)
  $root = [IO.Path]::GetPathRoot($fullPath)
  if ([string]::IsNullOrWhiteSpace($root)) {
    throw "NebulaVM could not identify the host drive for storage checks."
  }

  $driveName = $root.TrimEnd("\").TrimEnd(":")
  $drive = Get-PSDrive -Name $driveName -ErrorAction Stop
  return [int64]$drive.Free
}

function Assert-NebulaStorageReserve {
  param(
    [string]$TargetPath,
    [int64]$NeededBytes = 0,
    [string]$ActionText = "continue"
  )

  $freeBytes = Get-NebulaDriveFreeBytes -TargetPath $TargetPath
  $needed = [math]::Max([int64]0, $NeededBytes)
  if (($freeBytes - $needed) -ge $hostStorageReserveBytes) {
    return
  }

  $shortfall = ($hostStorageReserveBytes + $needed) - $freeBytes
  throw "NebulaVM host storage is too low to $ActionText. The public host keeps $(Format-NebulaSize $hostStorageReserveBytes) free so private VM disks cannot fill the drive. Free about $(Format-NebulaSize $shortfall) on the Windows host, then try again."
}

function Read-Config {
  if ([string]::IsNullOrWhiteSpace($ConfigBase64)) {
    return [pscustomobject]@{}
  }

  $bytes = [Convert]::FromBase64String($ConfigBase64)
  $json = [Text.Encoding]::UTF8.GetString($bytes)
  return $json | ConvertFrom-Json
}

function Get-FeatureState {
  try {
    return (Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V).State.ToString()
  } catch {
    return "Unavailable"
  }
}

function Import-HyperVModule {
  if ($null -ne (Get-Command Get-VM -ErrorAction SilentlyContinue)) {
    return
  }

  $moduleRoot = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\Modules\Hyper-V"
  $manifest = Get-ChildItem -LiteralPath $moduleRoot -Recurse -Filter "Hyper-V.psd1" -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending |
    Select-Object -First 1
  if ($manifest) {
    Import-Module $manifest.FullName -ErrorAction SilentlyContinue
  }
}

function Test-HyperVCmdlets {
  Import-HyperVModule
  return $null -ne (Get-Command Get-VM -ErrorAction SilentlyContinue)
}

function Get-VmSnapshot {
  param([object]$Vm)

  if ($null -eq $Vm) {
    return $null
  }

  $security = Get-VMSecurity -VM $Vm -ErrorAction SilentlyContinue
  $firmware = Get-VMFirmware -VMName $Vm.Name -ErrorAction SilentlyContinue
  $dvd = Get-VMDvdDrive -VM $Vm -ErrorAction SilentlyContinue | Select-Object -First 1
  $disk = Get-VMHardDiskDrive -VM $Vm -ErrorAction SilentlyContinue | Select-Object -First 1
  $addresses = @(
    Get-VMNetworkAdapter -VM $Vm -ErrorAction SilentlyContinue |
      ForEach-Object { $_.IPAddresses } |
      Where-Object { $_ -and $_ -notmatch "^169\.254\." -and $_ -notmatch "^fe80:" }
  )

  return [ordered]@{
    name = $Vm.Name
    state = $Vm.State.ToString()
    status = $Vm.Status
    generation = $Vm.Generation
    uptimeSeconds = [math]::Floor($Vm.Uptime.TotalSeconds)
    memoryMb = [math]::Round($Vm.MemoryStartup / 1MB)
    processorCount = $Vm.ProcessorCount
    secureBoot = $firmware.SecureBoot.ToString() -eq "On"
    tpm = [bool]$security.TpmEnabled
    isoPath = $dvd.Path
    diskPath = $disk.Path
    ipAddresses = $addresses
  }
}

function Convert-HyperVEvent {
  param([object]$Event)

  if ($null -eq $Event) {
    return $null
  }

  $message = ($Event.Message -replace "\s+", " ").Trim()
  if ($message.Length -gt 500) {
    $message = "$($message.Substring(0, 497))..."
  }

  return [ordered]@{
    timeCreated = $Event.TimeCreated.ToString("o")
    id = $Event.Id
    level = $Event.LevelDisplayName
    provider = $Event.ProviderName
    message = $message
  }
}

function Get-LatestHyperVEvent {
  param(
    [switch]$PowerOnly
  )

  $events = @()
  $startTime = (Get-Date).AddHours(-2)
  foreach ($logName in @("Microsoft-Windows-Hyper-V-Worker-Admin", "Microsoft-Windows-Hyper-V-VMMS-Admin")) {
    try {
      $events += Get-WinEvent `
        -FilterHashtable @{ LogName = $logName; StartTime = $startTime } `
        -MaxEvents 60 `
        -ErrorAction SilentlyContinue |
        Where-Object { $_.Message -like "*$vmName*" }
    } catch {
      # Some Windows editions keep individual Hyper-V logs disabled until first use.
    }
  }

  if ($PowerOnly) {
    $preferred = $events |
      Where-Object { $_.Id -in @(12030, 18502, 3050, 3122) } |
      Sort-Object TimeCreated -Descending |
      Select-Object -First 1
  } else {
    $preferred = $events |
      Where-Object {
        $_.LevelDisplayName -in @("Error", "Warning") -or
        $_.Id -in @(12030, 18502, 19060, 3050, 3122)
      } |
      Sort-Object TimeCreated -Descending |
      Select-Object -First 1
  }

  if (-not $preferred -and -not $PowerOnly) {
    $preferred = $events | Sort-Object TimeCreated -Descending | Select-Object -First 1
  }

  return Convert-HyperVEvent -Event $preferred
}

function Get-Status {
  $cmdletsReady = Test-HyperVCmdlets
  $featureState = if ($cmdletsReady) { "Enabled" } else { Get-FeatureState }
  $vm = $null
  $serviceState = "Unavailable"

  if ($cmdletsReady) {
    $vm = Get-VM -Name $vmName -ErrorAction SilentlyContinue
    $service = Get-Service vmms -ErrorAction SilentlyContinue
    if ($service) {
      $serviceState = $service.Status.ToString()
    }
  }

  $vmSnapshot = Get-VmSnapshot -Vm $vm
  $includeDiagnosticEvents = -not $vm -or $vm.State.ToString() -ne "Running"

  return [ordered]@{
    ok = $true
    engine = "Microsoft Hyper-V"
    featureState = $featureState
    restartRequired = $featureState -ne "Enabled" -or -not $cmdletsReady
    cmdletsReady = $cmdletsReady
    serviceState = $serviceState
    available = $featureState -eq "Enabled" -and $cmdletsReady
    vm = $vmSnapshot
    lastHyperVEvent = if ($includeDiagnosticEvents) { Get-LatestHyperVEvent } else { $null }
    lastHyperVPowerEvent = if ($includeDiagnosticEvents) { Get-LatestHyperVEvent -PowerOnly } else { $null }
  }
}

function Assert-HyperVReady {
  $status = Get-Status
  if (-not $status.available) {
    throw "Hyper-V has been enabled, but Windows must restart before EMUSTAR can use it."
  }
}

function Send-BootPromptKeys {
  param(
    [int]$Seconds = 14
  )

  $deadline = (Get-Date).AddSeconds($Seconds)
  $sent = 0
  while ((Get-Date) -lt $deadline) {
    $computer = Get-CimInstance `
      -Namespace root\virtualization\v2 `
      -ClassName Msvm_ComputerSystem `
      -Filter "ElementName='$vmName'" `
      -ErrorAction SilentlyContinue
    if ($computer) {
      $keyboard = Get-CimAssociatedInstance `
        -InputObject $computer `
        -ResultClassName Msvm_Keyboard `
        -ErrorAction SilentlyContinue |
        Select-Object -First 1
      if ($keyboard) {
        Invoke-CimMethod `
          -InputObject $keyboard `
          -MethodName TypeKey `
          -Arguments @{ KeyCode = [uint32]32 } `
          -ErrorAction SilentlyContinue |
          Out-Null
        Invoke-CimMethod `
          -InputObject $keyboard `
          -MethodName TypeKey `
          -Arguments @{ KeyCode = [uint32]13 } `
          -ErrorAction SilentlyContinue |
          Out-Null
        $sent += 2
      }
    }
    Start-Sleep -Milliseconds 160
  }

  return $sent
}

function Start-WindowsSetupLabConfigAutomation {
  $scriptPath = Join-Path $PSScriptRoot "emustar-windows-labconfig.ps1"
  if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
    $warnings.Add("Windows setup LabConfig automation was skipped because the helper script is missing.")
    return
  }

  $powershellPath = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  $argumentLine = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$scriptPath`" -VmName `"$vmName`""
  try {
    Start-Process -FilePath $powershellPath -ArgumentList $argumentLine -WindowStyle Hidden | Out-Null
    $warnings.Add("Windows setup LabConfig automation is armed for the language selection screen.")
  } catch {
    $warnings.Add("Windows setup LabConfig automation could not be started: $($_.Exception.Message)")
  }
}

function Get-BootDevice {
  param(
    [object]$Vm,
    [bool]$DiskFirst
  )

  if ($DiskFirst) {
    return Get-VMHardDiskDrive -VM $Vm | Select-Object -First 1
  }

  return Get-VMDvdDrive -VM $Vm | Select-Object -First 1
}

function Get-IsolatedDiskPath {
  param(
    [string]$VmDirectory,
    [string]$IsoPath,
    [string]$OwnerId
  )

  $safeOwnerId = ([string]$OwnerId -replace "[^a-zA-Z0-9_-]", "-").Trim("-")
  if ([string]::IsNullOrWhiteSpace($safeOwnerId)) {
    throw "EMUSTAR did not receive a valid storage owner."
  }

  $mediaName = [IO.Path]::GetFileNameWithoutExtension($IsoPath)
  $safeMediaName = ($mediaName -replace "[^a-zA-Z0-9_-]", "-").Trim("-")
  if ([string]::IsNullOrWhiteSpace($safeMediaName)) {
    $safeMediaName = "boot-media"
  }
  if ($safeMediaName.Length -gt 48) {
    $safeMediaName = $safeMediaName.Substring(0, 48)
  }

  $identity = "$safeOwnerId|$([IO.Path]::GetFullPath($IsoPath).ToLowerInvariant())"
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $hashBytes = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($identity))
  } finally {
    $sha.Dispose()
  }
  $shortHash = ([BitConverter]::ToString($hashBytes) -replace "-", "").Substring(0, 16).ToLowerInvariant()
  $diskDirectory = Join-Path $VmDirectory "disks"
  New-Item -ItemType Directory -Path $diskDirectory -Force | Out-Null
  return Join-Path $diskDirectory "$safeMediaName-$shortHash.vhdx"
}

function Get-IsolatedTemplateDiskPath {
  param(
    [string]$VmDirectory,
    [string]$TemplateDiskPath,
    [string]$OwnerId
  )

  $safeOwnerId = ([string]$OwnerId -replace "[^a-zA-Z0-9_-]", "-").Trim("-")
  if ([string]::IsNullOrWhiteSpace($safeOwnerId)) {
    throw "EMUSTAR did not receive a valid storage owner for the Windows template."
  }

  $identity = "$safeOwnerId|windows-11-template|$([IO.Path]::GetFullPath($TemplateDiskPath).ToLowerInvariant())"
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $hashBytes = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($identity))
  } finally {
    $sha.Dispose()
  }
  $shortHash = ([BitConverter]::ToString($hashBytes) -replace "-", "").Substring(0, 16).ToLowerInvariant()
  $diskDirectory = Join-Path $VmDirectory "disks"
  New-Item -ItemType Directory -Path $diskDirectory -Force | Out-Null
  return Join-Path $diskDirectory "private-windows-11-template-$shortHash.vhdx"
}

function Test-ManagedPrivateDiskName {
  param([string]$Name)

  if ($Name -match "(?i)^windows-11-template-[a-f0-9]+\.vhdx$") {
    return $false
  }
  if ($Name -match "(?i)^private-windows-11-template-[a-f0-9]+\.vhdx$") {
    return $true
  }
  return $Name -match "(?i)^.+-[a-f0-9]{16}\.vhdx$"
}

function Get-ActiveEmustarDiskPaths {
  $active = @{}
  try {
    $vm = Get-VM -Name $vmName -ErrorAction SilentlyContinue
    if ($vm) {
      Get-VMHardDiskDrive -VM $vm -ErrorAction SilentlyContinue |
        Where-Object { $_.Path } |
        ForEach-Object {
          $active[[IO.Path]::GetFullPath([string]$_.Path).ToLowerInvariant()] = $true
        }
    }
  } catch {
    # Active disk detection is best effort. Unknown disks are left alone by later path checks.
  }
  return $active
}

function Remove-ManagedPrivateDisk {
  param([object]$Disk)

  try {
    Remove-Item -LiteralPath $Disk.Path -Force -ErrorAction Stop
    return $true
  } catch {
    return $false
  }
}

function Cleanup-EmustarPrivateDisks {
  param([string]$VmDirectory)

  $diskDirectory = Join-Path $VmDirectory "disks"
  if (-not (Test-Path -LiteralPath $diskDirectory -PathType Container)) {
    return
  }

  $activeDiskPaths = Get-ActiveEmustarDiskPaths
  $cutoff = (Get-Date).ToUniversalTime().AddHours(-1 * $privateDiskTtlHours)
  $items = @(
    Get-ChildItem -LiteralPath $diskDirectory -Filter "*.vhdx" -File -ErrorAction SilentlyContinue |
      Where-Object { Test-ManagedPrivateDiskName -Name $_.Name } |
      ForEach-Object {
        [pscustomobject]@{
          Path = $_.FullName
          Key = [IO.Path]::GetFullPath($_.FullName).ToLowerInvariant()
          Size = [int64]$_.Length
          LastWriteUtc = $_.LastWriteTimeUtc
        }
      }
  )

  $removedCount = 0
  $removedBytes = [int64]0
  foreach ($item in $items) {
    if ($activeDiskPaths.ContainsKey($item.Key)) {
      continue
    }
    if ($item.LastWriteUtc -gt $cutoff) {
      continue
    }
    if (Remove-ManagedPrivateDisk -Disk $item) {
      $removedCount += 1
      $removedBytes += [int64]$item.Size
    }
  }

  $remaining = @(
    Get-ChildItem -LiteralPath $diskDirectory -Filter "*.vhdx" -File -ErrorAction SilentlyContinue |
      Where-Object { Test-ManagedPrivateDiskName -Name $_.Name } |
      ForEach-Object {
        [pscustomobject]@{
          Path = $_.FullName
          Key = [IO.Path]::GetFullPath($_.FullName).ToLowerInvariant()
          Size = [int64]$_.Length
          LastWriteUtc = $_.LastWriteTimeUtc
        }
      } |
      Sort-Object LastWriteUtc
  )
  $totalBytes = [int64]($remaining | Measure-Object -Property Size -Sum).Sum
  foreach ($item in $remaining) {
    if ($totalBytes -le $privateDiskMaxBytes) {
      break
    }
    if ($activeDiskPaths.ContainsKey($item.Key)) {
      continue
    }
    if (Remove-ManagedPrivateDisk -Disk $item) {
      $removedCount += 1
      $removedBytes += [int64]$item.Size
      $totalBytes -= [int64]$item.Size
    }
  }

  if ($removedCount -gt 0) {
    $warnings.Add("Cleaned up $removedCount old private Hyper-V disk(s) and reclaimed $(Format-NebulaSize $removedBytes).")
  }
}

function Ensure-TemplateChildDisk {
  param(
    [string]$ChildDiskPath,
    [string]$ParentDiskPath
  )

  if (Test-Path -LiteralPath $ChildDiskPath -PathType Leaf) {
    return
  }

  $parentItem = Get-Item -LiteralPath $ParentDiskPath -ErrorAction Stop
  $parentAttributes = $parentItem.Attributes
  try {
    if (($parentAttributes -band [IO.FileAttributes]::ReadOnly) -eq 0) {
      $parentItem.Attributes = $parentAttributes -bor [IO.FileAttributes]::ReadOnly
    }
    New-VHD -Path $ChildDiskPath -ParentPath $ParentDiskPath -Differencing | Out-Null
  } catch {
    if (Test-Path -LiteralPath $ChildDiskPath -PathType Leaf) {
      Remove-Item -LiteralPath $ChildDiskPath -Force -ErrorAction SilentlyContinue
    }
    throw "Could not create your private Windows 11 template disk: $($_.Exception.Message)"
  } finally {
    try {
      $parentItem.Refresh()
      $parentItem.Attributes = $parentItem.Attributes -bor [IO.FileAttributes]::ReadOnly
    } catch {
      # Keeping the golden template read-only is best effort after creation.
    }
  }
}

function Set-NebulaWallpaperInHive {
  param([string]$HiveRoot)

  & reg.exe add "$HiveRoot\Control Panel\Desktop" `
    /v Wallpaper /t REG_SZ /d "C:\Windows\Web\Wallpaper\Windows\img0.jpg" /f | Out-Null
  & reg.exe add "$HiveRoot\Control Panel\Desktop" `
    /v WallpaperStyle /t REG_SZ /d 10 /f | Out-Null
  & reg.exe add "$HiveRoot\Control Panel\Desktop" `
    /v TileWallpaper /t REG_SZ /d 0 /f | Out-Null
  & reg.exe delete "$HiveRoot\Control Panel\Desktop" `
    /v TranscodedImageCache /f 2>$null | Out-Null
  & reg.exe delete "$HiveRoot\Control Panel\Desktop" `
    /v TranscodedImageCache_000 /f 2>$null | Out-Null
  & reg.exe add "$HiveRoot\Software\Microsoft\Windows\CurrentVersion\Explorer\Wallpapers" `
    /v BackgroundHistoryPath0 /t REG_SZ /d "C:\Windows\Web\Wallpaper\Windows\img0.jpg" /f | Out-Null
  & reg.exe add "$HiveRoot\Software\Microsoft\Windows\CurrentVersion\Explorer\Wallpapers" `
    /v CurrentWallpaperPath /t REG_SZ /d "C:\Windows\Web\Wallpaper\Windows\img0.jpg" /f | Out-Null
  & reg.exe delete "$HiveRoot\Software\Microsoft\Windows\CurrentVersion\Explorer\Wallpapers" `
    /v TranscodedImageCache /f 2>$null | Out-Null
  & reg.exe add "$HiveRoot\Software\Microsoft\Windows\CurrentVersion\Policies\ActiveDesktop" `
    /v NoChangingWallPaper /t REG_DWORD /d 0 /f | Out-Null
  & reg.exe delete "$HiveRoot\Software\Microsoft\Windows\CurrentVersion\Policies\System" `
    /v Wallpaper /f 2>$null | Out-Null
  & reg.exe delete "$HiveRoot\Software\Microsoft\Windows\CurrentVersion\Policies\System" `
    /v WallpaperStyle /f 2>$null | Out-Null
}

function Set-NebulaWallpaperActiveSetup {
  param([string]$WindowsDrive)

  $payloadDirectory = Join-Path $WindowsDrive "NebulaVM"
  New-Item -ItemType Directory -Path $payloadDirectory -Force | Out-Null

  $wallpaperScript = @'
$ErrorActionPreference = "SilentlyContinue"
$wallpaperCandidates = @(
  "C:\Windows\Web\Wallpaper\Windows\img0.jpg",
  "C:\Windows\Web\4K\Wallpaper\Windows\img0_3840x2400.jpg",
  "C:\Windows\Web\4K\Wallpaper\Windows\img0_2560x1600.jpg",
  "C:\Windows\Web\4K\Wallpaper\Windows\img0_1920x1200.jpg",
  "C:\Windows\Web\4K\Wallpaper\Windows\img0_1366x768.jpg"
)
$wallpaper = $wallpaperCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (Test-Path -LiteralPath $wallpaper -PathType Leaf) {
  $themeDirectory = Join-Path $env:APPDATA "Microsoft\Windows\Themes"
  Remove-Item -LiteralPath (Join-Path $themeDirectory "TranscodedWallpaper") -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath (Join-Path $themeDirectory "Transcoded_000") -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath (Join-Path $themeDirectory "CachedFiles") -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -Path "HKCU:\Control Panel\Desktop" -Force | Out-Null
  Set-ItemProperty -Path "HKCU:\Control Panel\Desktop" -Name Wallpaper -Value $wallpaper
  Set-ItemProperty -Path "HKCU:\Control Panel\Desktop" -Name WallpaperStyle -Value "10"
  Set-ItemProperty -Path "HKCU:\Control Panel\Desktop" -Name TileWallpaper -Value "0"
  Remove-ItemProperty -Path "HKCU:\Control Panel\Desktop" -Name TranscodedImageCache -ErrorAction SilentlyContinue
  Remove-ItemProperty -Path "HKCU:\Control Panel\Desktop" -Name TranscodedImageCache_000 -ErrorAction SilentlyContinue
  New-Item -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Wallpapers" -Force | Out-Null
  Set-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Wallpapers" -Name BackgroundHistoryPath0 -Value $wallpaper
  Set-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Wallpapers" -Name CurrentWallpaperPath -Value $wallpaper
  Remove-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Wallpapers" -Name TranscodedImageCache -ErrorAction SilentlyContinue
  New-Item -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Policies\ActiveDesktop" -Force | Out-Null
  New-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Policies\ActiveDesktop" -Name NoChangingWallPaper -Value 0 -PropertyType DWord -Force | Out-Null
  Remove-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Policies\System" -Name Wallpaper -ErrorAction SilentlyContinue
  Remove-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Policies\System" -Name WallpaperStyle -ErrorAction SilentlyContinue
  Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class NebulaWallpaper { [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode)] public static extern bool SystemParametersInfo(int uAction, int uParam, string lpvParam, int fuWinIni); }' -ErrorAction SilentlyContinue
  [NebulaWallpaper]::SystemParametersInfo(20, 0, $wallpaper, 3) | Out-Null
  Start-Process rundll32.exe -ArgumentList "user32.dll,UpdatePerUserSystemParameters" -WindowStyle Hidden
}
'@
  Set-Content -LiteralPath (Join-Path $payloadDirectory "apply-wallpaper.ps1") -Value $wallpaperScript -Encoding UTF8

  $offlineSoftware = Join-Path $WindowsDrive "Windows\System32\Config\SOFTWARE"
  if (Test-Path -LiteralPath $offlineSoftware -PathType Leaf) {
    $softwareHive = "HKLM\NebulaTemplateSoftware$PID"
    & reg.exe load $softwareHive $offlineSoftware | Out-Null
    if ($LASTEXITCODE -eq 0) {
      try {
        & reg.exe add "$softwareHive\Microsoft\Active Setup\Installed Components\NebulaVM-Wallpaper" `
          /v Version /t REG_SZ /d "1,0,0,5" /f | Out-Null
        & reg.exe add "$softwareHive\Microsoft\Active Setup\Installed Components\NebulaVM-Wallpaper" `
          /v StubPath /t REG_SZ /d "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File C:\NebulaVM\apply-wallpaper.ps1" /f | Out-Null
        & reg.exe add "$softwareHive\Microsoft\Windows\CurrentVersion\Run" `
          /v NebulaVMWallpaper /t REG_SZ /d "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File C:\NebulaVM\apply-wallpaper.ps1" /f | Out-Null
      } finally {
        & reg.exe unload $softwareHive | Out-Null
      }
    }
  }
}

function Set-NebulaWallpaperForOfflineUsers {
  param([string]$WindowsDrive)

  $profileRoots = @(
    (Join-Path $WindowsDrive "Users\Default"),
    (Get-ChildItem -LiteralPath (Join-Path $WindowsDrive "Users") -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -notin @("All Users", "Default", "Default User", "Public") } |
      Select-Object -ExpandProperty FullName)
  ) | Where-Object { $_ }

  $index = 0
  foreach ($profileRoot in $profileRoots) {
    $userHive = Join-Path $profileRoot "NTUSER.DAT"
    if (-not (Test-Path -LiteralPath $userHive -PathType Leaf)) {
      continue
    }

    $index += 1
    $hiveRoot = "HKLM\NebulaUserWallpaper$PID$index"
    & reg.exe load $hiveRoot $userHive | Out-Null
    if ($LASTEXITCODE -ne 0) {
      continue
    }
    try {
      Set-NebulaWallpaperInHive -HiveRoot $hiveRoot
      $themesDirectory = Join-Path $profileRoot "AppData\Roaming\Microsoft\Windows\Themes"
      Remove-Item -LiteralPath (Join-Path $themesDirectory "TranscodedWallpaper") -Force -ErrorAction SilentlyContinue
      Remove-Item -LiteralPath (Join-Path $themesDirectory "Transcoded_000") -Force -ErrorAction SilentlyContinue
      Remove-Item -LiteralPath (Join-Path $themesDirectory "CachedFiles") -Recurse -Force -ErrorAction SilentlyContinue
    } finally {
      & reg.exe unload $hiveRoot | Out-Null
    }
  }
}

function Ensure-WindowsTemplateWallpaper {
  param([string]$VhdPath)

  if (-not (Test-Path -LiteralPath $VhdPath -PathType Leaf)) {
    return
  }

  $mountedHere = $false
  $diskImage = $null
  try {
    $diskImage = Mount-VHD -Path $VhdPath -Passthru -ErrorAction Stop
    $mountedHere = $true
    $disk = $diskImage | Get-Disk -ErrorAction Stop
    $windowsPartition = Get-Partition -DiskNumber $disk.Number -ErrorAction Stop |
      Where-Object { $_.Type -eq "Basic" -or [string]$_.GptType -eq "{EBD0A0A2-B9E5-4433-87C0-68B6B72699C7}" } |
      Sort-Object Size -Descending |
      Select-Object -First 1
    if (-not $windowsPartition) {
      return
    }

    if (-not $windowsPartition.DriveLetter) {
      $windowsPartition | Add-PartitionAccessPath -AssignDriveLetter -ErrorAction Stop | Out-Null
      $windowsPartition = Get-Partition -DiskNumber $disk.Number -PartitionNumber $windowsPartition.PartitionNumber
    }

    $windowsDrive = "$($windowsPartition.DriveLetter):"
    if (-not (Test-Path -LiteralPath (Join-Path $windowsDrive "Windows") -PathType Container)) {
      return
    }

    Set-NebulaWallpaperActiveSetup -WindowsDrive $windowsDrive
    Set-NebulaWallpaperForOfflineUsers -WindowsDrive $windowsDrive
    $warnings.Add("Applied the NebulaVM Windows wallpaper repair hook to this private template disk.")
  } catch {
    $warnings.Add("Windows wallpaper repair could not be applied before boot: $($_.Exception.Message)")
  } finally {
    if ($mountedHere) {
      Dismount-VHD -Path $VhdPath -ErrorAction SilentlyContinue
    }
  }
}

function Set-LowHostMemoryProfile {
  param(
    [object]$Vm,
    [int]$MemoryMb,
    [bool]$FixedStartup = $false
  )

  if ($FixedStartup) {
    $freeMemoryMb = [math]::Floor((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1KB)
    $hardReserveMb = 512
    $comfortReserveMb = 1024
    if ($freeMemoryMb -lt ($MemoryMb + $hardReserveMb)) {
      throw "Hyper-V needs $MemoryMb MB for this Windows guest plus at least $hardReserveMb MB for the public host. Only $freeMemoryMb MB is currently free. Wait until the host has more memory or choose a lighter VM."
    }
    if ($freeMemoryMb -lt ($MemoryMb + $comfortReserveMb)) {
      $warnings.Add("Host memory is tight: $freeMemoryMb MB is free for a fixed $MemoryMb MB Windows startup allocation.")
    }
    Set-VMMemory -VM $Vm -DynamicMemoryEnabled $false -StartupBytes ($MemoryMb * 1MB)
    return
  }

  $hostMemoryBytes = (Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory
  if ($hostMemoryBytes -le 10GB) {
    $freeMemoryMb = [math]::Floor((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1KB)
    $preferredStartupMb = [math]::Min($MemoryMb, 1024)
    $minimumBootMb = [math]::Min($MemoryMb, 768)
    $reserveMb = 768
    $startupMb = if ($freeMemoryMb -ge ($preferredStartupMb + $reserveMb)) {
      $preferredStartupMb
    } else {
      $minimumBootMb
    }
    $minimumMb = [math]::Min($startupMb, 512)
    if ($freeMemoryMb -lt ($startupMb + $reserveMb)) {
      throw "Hyper-V needs about $($startupMb + $reserveMb) MB of free host memory to boot this ISO, but only $freeMemoryMb MB is currently free. Wait until the host has more memory or choose a lighter VM."
    }
    Set-VMMemory -VM $Vm `
      -DynamicMemoryEnabled $true `
      -StartupBytes ($startupMb * 1MB) `
      -MinimumBytes ($minimumMb * 1MB) `
      -MaximumBytes ($MemoryMb * 1MB) `
      -Buffer 5
    if ($startupMb -lt $MemoryMb) {
      $warnings.Add("Low-memory host mode starts EMUSTAR with $startupMb MB and lets it grow dynamically to $MemoryMb MB.")
    }
    return
  }

  Set-VMMemory -VM $Vm -DynamicMemoryEnabled $false -StartupBytes ($MemoryMb * 1MB)
}

function Get-RequestedDisplaySize {
  param([object]$Config)

  $width = 1280
  $height = 720
  if ($Config.PSObject.Properties.Name -contains "displayWidth") {
    $width = [int]$Config.displayWidth
  }
  if ($Config.PSObject.Properties.Name -contains "displayHeight") {
    $height = [int]$Config.displayHeight
  }

  $width = [math]::Min(7680, [math]::Max(640, $width))
  $height = [math]::Min(4320, [math]::Max(360, $height))
  $width = $width - ($width % 2)
  $height = $height - ($height % 2)
  return [pscustomobject]@{ Width = $width; Height = $height }
}

function Set-EmustarVideoMode {
  param(
    [object]$Vm,
    [int]$Width,
    [int]$Height
  )

  try {
    Set-VMVideo `
      -VMName $Vm.Name `
      -ResolutionType Single `
      -HorizontalResolution $Width `
      -VerticalResolution $Height | Out-Null
    $warnings.Add("Requested Hyper-V display size ${Width}x${Height}.")
  } catch {
    $warnings.Add("Hyper-V display size could not be configured before boot: $($_.Exception.Message)")
  }
}

function Set-InstalledWindowsBoot {
  param(
    [object]$Vm,
    [bool]$DetachDvd = $false
  )

  if ($DetachDvd) {
    Get-VMDvdDrive -VM $Vm -ErrorAction SilentlyContinue | Set-VMDvdDrive -Path $null
  }

  $firmware = Get-VMFirmware -VMName $Vm.Name -ErrorAction SilentlyContinue
  if (-not $firmware) {
    return
  }

  $windowsBoot = $firmware.BootOrder |
    Where-Object { $_.BootType -eq "File" -and [string]$_.FirmwarePath -like "*\EFI\Microsoft\Boot\bootmgfw.efi*" } |
    Select-Object -First 1
  $hardDisk = $firmware.BootOrder |
    Where-Object { $_.BootType -eq "Drive" -and $_.Device -and $_.Device.ToString() -like "*HardDiskDrive*" } |
    Select-Object -First 1

  if ($windowsBoot) {
    $bootOrder = @($windowsBoot)
    if ($hardDisk) {
      $bootOrder += $hardDisk
    }
    $bootOrder += @($firmware.BootOrder | Where-Object { $_ -ne $windowsBoot -and $_ -ne $hardDisk })
    Set-VMFirmware -VM $Vm -EnableSecureBoot Off -BootOrder $bootOrder
  } elseif ($hardDisk) {
    Set-VMFirmware -VM $Vm -EnableSecureBoot Off -FirstBootDevice $hardDisk
  }
}

function Repair-TemplateDvdAttachments {
  param([object]$Vm)

  $dvdDrives = @(Get-VMDvdDrive -VM $Vm -ErrorAction SilentlyContinue)
  $cleared = 0
  $removed = 0
  for ($index = 0; $index -lt $dvdDrives.Count; $index += 1) {
    $drive = $dvdDrives[$index]
    if (-not [string]::IsNullOrWhiteSpace([string]$drive.Path)) {
      Set-VMDvdDrive -VMDvdDrive $drive -Path $null -ErrorAction Stop
      $cleared += 1
    }
    if ($index -gt 0) {
      Remove-VMDvdDrive -VMDvdDrive $drive -ErrorAction Stop
      $removed += 1
    }
  }

  if ($cleared -gt 0 -or $removed -gt 0) {
    $action = "removed $cleared stale DVD image attachment(s) and $removed extra DVD drive(s) before the prepared Windows disk boot."
    Write-AutopilotEvent -Kind "file" -Message $action
    $autopilotActions.Add($action)
    $warnings.Add("NebulaVM Autopilot: $action")
  }
}

function Repair-EmustarDiskAccess {
  param([string]$DiskPath)

  if ([string]::IsNullOrWhiteSpace($DiskPath) -or -not (Test-Path -LiteralPath $DiskPath -PathType Leaf)) {
    return
  }

  try {
    $diskName = [IO.Path]::GetFileName($DiskPath)
    Write-AutopilotEvent -Kind "file" -Message "Refreshing Hyper-V access for $diskName."
    $grant = "*S-1-5-83-0:(M)"
    & icacls.exe $DiskPath /grant $grant /C /Q | Out-Null
    if ($LASTEXITCODE -ne 0) {
      throw "icacls exited with code $LASTEXITCODE"
    }
    Write-AutopilotEvent -Kind "success" -Message "Hyper-V access is ready for $diskName."
  } catch {
    $warnings.Add("NebulaVM Autopilot could not refresh Hyper-V access to the private disk: $($_.Exception.Message)")
  }
}

function Get-EmustarStartFailureReason {
  $events = @()
  foreach ($logName in @(
    "Microsoft-Windows-Hyper-V-Worker-Admin",
    "Microsoft-Windows-Hyper-V-VMMS-Admin"
  )) {
    try {
      $events += Get-WinEvent -FilterHashtable @{
        LogName = $logName
        StartTime = (Get-Date).AddMinutes(-3)
        Level = 2
      } -MaxEvents 30 -ErrorAction Stop |
        Where-Object { $_.Message -match [regex]::Escape($vmName) }
    } catch {
      continue
    }
  }

  $orderedEvents = @($events | Sort-Object TimeCreated -Descending)
  foreach ($candidate in @(
    @{ Pattern = "(?i)0x80070570|corrupt|unreadable"; Reason = "a stale or damaged virtual media attachment" },
    @{ Pattern = "(?i)0x80070005|access is denied|permission"; Reason = "Hyper-V did not have permission to open an attached disk" },
    @{ Pattern = "(?i)0x8007000E|not enough memory|memory resources"; Reason = "the host could not reserve the requested VM memory" },
    @{ Pattern = "(?i)0x80070020|being used by another process|location is in use"; Reason = "another Hyper-V operation was still using an attached device" },
    @{ Pattern = "(?i)synthetic scsi|failed to power on"; Reason = "a Hyper-V virtual storage controller could not power on" }
  )) {
    if ($orderedEvents | Where-Object { $_.Message -match $candidate.Pattern } | Select-Object -First 1) {
      return $candidate.Reason
    }
  }

  $latest = $orderedEvents | Select-Object -First 1
  if ($latest) {
    $message = ([string]$latest.Message -replace "\s+", " ").Trim()
    if ($message.Length -gt 500) {
      $message = $message.Substring(0, 500) + "..."
    }
    return $message
  }
  return "Hyper-V rejected the first start attempt without recording a specific host event"
}

function Get-EmustarVmIdText {
  param([object]$Vm)

  if (-not $Vm) {
    return ""
  }

  foreach ($propertyName in @("Id", "VMId")) {
    if ($Vm.PSObject.Properties.Name -contains $propertyName) {
      $value = $Vm.$propertyName
      if ($value -is [guid]) {
        return $value.Guid.ToString().ToLowerInvariant()
      }
      if ($value) {
        return ([string]$value).Trim("{}").ToLowerInvariant()
      }
    }
  }

  return ""
}

function Stop-EmustarWorkerProcess {
  param([object]$Vm)

  $vmIdText = Get-EmustarVmIdText -Vm $Vm
  if ([string]::IsNullOrWhiteSpace($vmIdText)) {
    return $false
  }

  $workers = Get-CimInstance Win32_Process -Filter "Name = 'vmwp.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
      $_.CommandLine -and $_.CommandLine.ToLowerInvariant().Contains($vmIdText)
    }

  $stoppedAny = $false
  foreach ($worker in $workers) {
    try {
      Stop-Process -Id $worker.ProcessId -Force -ErrorAction Stop
      $stoppedAny = $true
    } catch {
      $warnings.Add("NebulaVM could not clear stuck Hyper-V worker process $($worker.ProcessId): $($_.Exception.Message)")
    }
  }

  return $stoppedAny
}

function Stop-EmustarForConfiguration {
  param([object]$Vm)

  $deadline = (Get-Date).AddSeconds(75)
  $stopRequested = $false
  $lastState = if ($Vm) { $Vm.State.ToString() } else { "Unknown" }

  while ((Get-Date) -lt $deadline) {
    $current = Get-VM -Name $Vm.Name -ErrorAction Stop
    $lastState = $current.State.ToString()
    if ($lastState -eq "Off") {
      return $current
    }

    if ($lastState -eq "Saved") {
      Remove-VMSavedState -VM $current -ErrorAction SilentlyContinue
      Start-Sleep -Seconds 1
      continue
    }

    if (-not $stopRequested -and $lastState -in @("Running", "Paused", "Suspended")) {
      try {
        Stop-VM -VM $current -Force -TurnOff -ErrorAction Stop
        $stopRequested = $true
      } catch {
        $warnings.Add("EMUSTAR is waiting for Hyper-V to leave state '$lastState' before reconfiguring: $($_.Exception.Message)")
      }
    }

    Start-Sleep -Seconds 1
  }

  if ($lastState -eq "Stopping") {
    $current = Get-VM -Name $Vm.Name -ErrorAction SilentlyContinue
    $warnings.Add("Hyper-V kept EMUSTAR in 'Stopping', so NebulaVM is clearing the stuck worker for this VM only.")
    $clearedWorker = Stop-EmustarWorkerProcess -Vm $current
    if ($clearedWorker) {
      $recoveryDeadline = (Get-Date).AddSeconds(30)
      while ((Get-Date) -lt $recoveryDeadline) {
        $current = Get-VM -Name $Vm.Name -ErrorAction SilentlyContinue
        if (-not $current -or $current.State.ToString() -eq "Off") {
          return $current
        }
        $lastState = $current.State.ToString()
        Start-Sleep -Seconds 1
      }
    }
  }

  throw "EMUSTAR is still in Hyper-V state '$lastState'. Wait a few seconds or end the session, then launch again."
}

function Start-Emustar {
  $config = Read-Config
  Assert-HyperVReady

  $isoPath = [string]$config.isoPath
  $templateDiskPath = [string]$config.templateDiskPath
  $isoProvided = -not [string]::IsNullOrWhiteSpace($isoPath)
  $templateDiskProvided = -not [string]::IsNullOrWhiteSpace($templateDiskPath)
  if ($isoProvided) {
    if (-not [IO.Path]::IsPathRooted($isoPath)) {
      throw "Enter an absolute ISO path, such as C:\Users\Dell\Downloads\Your.iso."
    }
    if (-not (Test-Path -LiteralPath $isoPath -PathType Leaf)) {
      throw "The ISO file does not exist: $isoPath"
    }
    if ([IO.Path]::GetExtension($isoPath) -ne ".iso") {
      throw "EMUSTAR Hyper-V currently accepts CD-ROM ISO files."
    }
  }
  if ($templateDiskProvided) {
    if (-not [IO.Path]::IsPathRooted($templateDiskPath)) {
      throw "The prepared Windows template disk path must be absolute."
    }
    if (-not (Test-Path -LiteralPath $templateDiskPath -PathType Leaf)) {
      throw "The prepared Windows template disk does not exist: $templateDiskPath"
    }
    if ([IO.Path]::GetExtension($templateDiskPath) -ne ".vhdx") {
      throw "The prepared Windows template must be a VHDX disk."
    }
    $templateDiskPath = [IO.Path]::GetFullPath($templateDiskPath)
  }
  if (-not $isoProvided -and -not $templateDiskProvided) {
    throw "Choose an ISO path or Windows template disk before launching Hyper-V."
  }

  $vm = Get-VM -Name $vmName -ErrorAction SilentlyContinue

  $memoryMb = [math]::Min(6144, [math]::Max(512, [int]$config.memoryMb))
  $diskSizeGb = [math]::Min(256, [math]::Max(64, [int]$config.diskSizeGb))
  $processorCount = [math]::Min(2, [math]::Max(1, [Environment]::ProcessorCount - 1))
  $diskFirst = $templateDiskProvided -or [string]$config.bootOrder -eq "123"
  $guestType = [string]$config.guestType
  $isWindowsGuest = $guestType -eq "windows"
  if ($templateDiskProvided) {
    $isWindowsGuest = $true
  }
  if ([string]::IsNullOrWhiteSpace($guestType)) {
    $isWindowsGuest = [IO.Path]::GetFileName($isoPath) -match '(?i)(^|[^a-z0-9])(windows|win(?:dows)?[\s_-]*[0-9]+|w[0-9]+)(?=[^a-z0-9]|$)'
  }
  $displaySize = Get-RequestedDisplaySize -Config $config
  $vmDirectory = [string]$config.vmDirectory
  if ([string]::IsNullOrWhiteSpace($vmDirectory)) {
    throw "The EMUSTAR VM directory was not supplied."
  }
  $storageOwnerId = [string]$config.storageOwnerId
  if ([string]::IsNullOrWhiteSpace($storageOwnerId)) {
    throw "EMUSTAR requires a private device identity before it can create a virtual disk."
  }
  New-Item -ItemType Directory -Path $vmDirectory -Force | Out-Null
  Cleanup-EmustarPrivateDisks -VmDirectory $vmDirectory
  $privateDiskCushionBytes = if ($templateDiskProvided) {
    [int64]8GB
  } else {
    [int64]([math]::Min($diskSizeGb, 8) * 1GB)
  }
  Assert-NebulaStorageReserve `
    -TargetPath $vmDirectory `
    -NeededBytes $privateDiskCushionBytes `
    -ActionText "create a private Hyper-V disk"
  $vhdPath = if ($templateDiskProvided) {
    Get-IsolatedTemplateDiskPath -VmDirectory $vmDirectory -TemplateDiskPath $templateDiskPath -OwnerId $storageOwnerId
  } else {
    Get-IsolatedDiskPath -VmDirectory $vmDirectory -IsoPath $isoPath -OwnerId $storageOwnerId
  }

  if ($templateDiskProvided -and $vm) {
    Repair-TemplateDvdAttachments -Vm $vm
  }

  if ($vm -and $vm.State -in @("Running", "Saved")) {
    $mountedIso = Get-VMDvdDrive -VM $vm -ErrorAction SilentlyContinue |
      Select-Object -First 1 |
      ForEach-Object { [string]$_.Path }
    $mountedDisk = Get-VMHardDiskDrive -VM $vm -ErrorAction SilentlyContinue |
      Select-Object -First 1 |
      ForEach-Object { [string]$_.Path }
    $sameIso = if ($templateDiskProvided) {
      [string]::IsNullOrWhiteSpace($mountedIso)
    } else {
      $mountedIso -and ([IO.Path]::GetFullPath($mountedIso) -eq [IO.Path]::GetFullPath($isoPath))
    }
    $sameDisk = $mountedDisk -and
      ([IO.Path]::GetFullPath($mountedDisk) -eq [IO.Path]::GetFullPath($vhdPath))
    if ($sameIso -and $sameDisk) {
      $configuredMemory = Get-VMMemory -VM $vm
      $requestedMaximumBytes = $memoryMb * 1MB
      $requiredStartupBytes = [math]::Min($memoryMb, 768) * 1MB
      $lowMemoryWindowsHost = $isWindowsGuest -and
        (Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory -le 10GB
      $memoryMatches = if ($lowMemoryWindowsHost) {
        [bool]$configuredMemory.DynamicMemoryEnabled -and
          [int64]$configuredMemory.Maximum -eq [int64]$requestedMaximumBytes -and
          [int64]$configuredMemory.Startup -ge [int64]$requiredStartupBytes
      } elseif ($isWindowsGuest) {
        -not [bool]$configuredMemory.DynamicMemoryEnabled -and
          [int64]$configuredMemory.Startup -eq [int64]$requestedMaximumBytes
      } else {
        [int64]$configuredMemory.Maximum -eq [int64]$requestedMaximumBytes -and
          [int64]$configuredMemory.Startup -ge [int64]$requiredStartupBytes
      }
      if ($memoryMatches) {
        if ($vm.State -eq "Saved") {
          Start-VM -VM $vm -ErrorAction Stop | Out-Null
          $vm = Get-VM -Name $vmName -ErrorAction Stop
          $warnings.Add("Hyper-V resumed the saved Windows session without repeating a cold boot.")
        }
        if ([string]$config.displayMode -eq "external") {
          Start-Process "$env:SystemRoot\System32\vmconnect.exe" -ArgumentList "localhost", $vmName
        } else {
          Close-EmustarConsole | Out-Null
        }
        $warnings.Add(
          $(if ($templateDiskProvided) {
            "Hyper-V attached to the VM that was already running with this prepared Windows template disk."
          } else {
            "Hyper-V attached to the VM that was already running with this ISO."
          })
        )
        return [ordered]@{
          ok = $true
          engine = "Microsoft Hyper-V"
          created = $false
          attachedExisting = $true
          bootOrder = $(if ($diskFirst) { "disk-first" } else { "cdrom-first" })
          displayMode = [string]$config.displayMode
          vm = Get-VmSnapshot -Vm $vm
          warnings = $warnings
          autopilotActions = $autopilotActions
        }
      }
      $warnings.Add("EMUSTAR restarted the existing VM to apply the requested memory settings.")
    }
  }

  if ($templateDiskProvided -and $vm -and $vm.State -ne "Off") {
    $vm = Stop-EmustarForConfiguration -Vm $vm
  }

  if ($templateDiskProvided) {
    Ensure-TemplateChildDisk -ChildDiskPath $vhdPath -ParentDiskPath $templateDiskPath
    Ensure-WindowsTemplateWallpaper -VhdPath $vhdPath
    Repair-EmustarDiskAccess -DiskPath $vhdPath
  }

  if (-not $vm) {
    if (-not (Test-Path -LiteralPath $vhdPath)) {
      New-VHD -Path $vhdPath -Dynamic -SizeBytes ($diskSizeGb * 1GB) | Out-Null
    }

    $switch = Get-VMSwitch -Name "Default Switch" -ErrorAction SilentlyContinue
    if (-not $switch) {
      $switch = Get-VMSwitch | Where-Object SwitchType -in @("External", "Internal") | Select-Object -First 1
    }

    $newVmParams = @{
      Name = $vmName
      Generation = 2
      MemoryStartupBytes = $memoryMb * 1MB
      VHDPath = $vhdPath
      Path = $vmDirectory
    }
    if ($switch) {
      $newVmParams.SwitchName = $switch.Name
    } else {
      $warnings.Add("No Hyper-V virtual switch exists yet, so the VM was created without networking.")
    }

    $vm = New-VM @newVmParams
  } elseif ($vm.State -ne "Off") {
    $vm = Stop-EmustarForConfiguration -Vm $vm
  }

  $currentDisk = Get-VMHardDiskDrive -VM $vm -ErrorAction SilentlyContinue | Select-Object -First 1
  $currentDiskPath = if ($currentDisk) { [string]$currentDisk.Path } else { "" }
  $diskChanged = -not $currentDiskPath -or
    ([IO.Path]::GetFullPath($currentDiskPath) -ne [IO.Path]::GetFullPath($vhdPath))
  if ($diskChanged) {
    if (-not (Test-Path -LiteralPath $vhdPath)) {
      if ($templateDiskProvided) {
        Ensure-TemplateChildDisk -ChildDiskPath $vhdPath -ParentDiskPath $templateDiskPath
      } else {
        New-VHD -Path $vhdPath -Dynamic -SizeBytes ($diskSizeGb * 1GB) | Out-Null
      }
    }
    if ($currentDisk) {
      Remove-VMHardDiskDrive -VMHardDiskDrive $currentDisk
    }
    Add-VMHardDiskDrive -VM $vm -Path $vhdPath | Out-Null
    $warnings.Add("Attached the private virtual disk for this device and ISO.")
  }

  Set-VM -VM $vm -AutomaticStartAction Nothing -AutomaticStopAction Save -CheckpointType Disabled
  $useFixedWindowsMemory = $isWindowsGuest -and
    (Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory -gt 10GB
  Set-LowHostMemoryProfile -Vm $vm -MemoryMb $memoryMb -FixedStartup $useFixedWindowsMemory
  Set-VMProcessor -VM $vm -Count $processorCount
  Set-EmustarVideoMode -Vm $vm -Width $displaySize.Width -Height $displaySize.Height

  $dvd = Get-VMDvdDrive -VM $vm -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($templateDiskProvided -or -not $isoProvided) {
    Repair-TemplateDvdAttachments -Vm $vm
  } else {
    if ($dvd) {
      Set-VMDvdDrive -VMDvdDrive $dvd -Path $isoPath
    } else {
      Add-VMDvdDrive -VM $vm -Path $isoPath | Out-Null
    }
  }

  try {
    $security = Get-VMSecurity -VM $vm
    $firmware = Get-VMFirmware -VMName $vm.Name
    if ($isWindowsGuest) {
      if (-not $security.TpmEnabled) {
        Set-VMFirmware -VM $vm -EnableSecureBoot On -SecureBootTemplate MicrosoftWindows
        Set-VMKeyProtector -VM $vm -NewLocalKeyProtector
        Enable-VMTPM -VM $vm
      } elseif ($firmware.SecureBoot.ToString() -ne "On") {
        Set-VMFirmware -VM $vm -EnableSecureBoot On
      }
    } elseif ($firmware.SecureBoot.ToString() -eq "On") {
      Set-VMFirmware -VM $vm -EnableSecureBoot Off
    }
  } catch {
    $warnings.Add("Secure Boot or virtual TPM could not be configured automatically: $($_.Exception.Message)")
  }

  $firstBootDevice = Get-BootDevice -Vm $vm -DiskFirst $diskFirst
  if ($firstBootDevice) {
    Set-VMFirmware -VM $vm -FirstBootDevice $firstBootDevice
  }

  $vm = Get-VM -Name $vmName -ErrorAction Stop
  if ($vm.State -eq "Off") {
    try {
      Start-VM -VM $vm -ErrorAction Stop | Out-Null
    } catch {
      $vm = Get-VM -Name $vmName -ErrorAction Stop
      if ($vm.State -ne "Running") {
        if ($_.Exception.Message -match "(?i)not enough memory|memory resources|0x8007000E") {
          throw "EMUSTAR could not reserve enough host memory. Close a few applications or browser tabs, then launch it again."
        }
        if (-not $templateDiskProvided) {
          throw
        }

        $rootReason = Get-EmustarStartFailureReason
        Repair-TemplateDvdAttachments -Vm $vm
        Repair-EmustarDiskAccess -DiskPath $vhdPath
        $action = "found the root cause as $rootReason; repaired the prepared disk devices and permissions, then retried once."
        $autopilotActions.Add($action)
        $warnings.Add("NebulaVM Autopilot: $action")
        try {
          Start-VM -VM $vm -ErrorAction Stop | Out-Null
        } catch {
          throw "NebulaVM Autopilot could not recover the Hyper-V start. Root cause: $rootReason. Retry failed: $($_.Exception.Message)"
        }
      }
      if ($vm.State -eq "Running") {
        $warnings.Add("EMUSTAR detected that Hyper-V had already started the VM and attached to it.")
      }
    }
  } elseif ($vm.State -ne "Running") {
    throw "EMUSTAR cannot start while Hyper-V is in state '$($vm.State)'."
  }

  if (-not $templateDiskProvided -and -not $diskFirst -and $isoProvided) {
    $bootKeyCount = Send-BootPromptKeys
    if ($bootKeyCount -gt 0) {
      $warnings.Add("Sent boot prompt keys so CD-ROM setup can start automatically.")
    }
    if ($isWindowsGuest) {
      Start-WindowsSetupLabConfigAutomation
    }
  }

  if ([string]$config.displayMode -eq "external") {
    Start-Process "$env:SystemRoot\System32\vmconnect.exe" -ArgumentList "localhost", $vmName
  } else {
    Close-EmustarConsole | Out-Null
  }

  $vm = Get-VM -Name $vmName
  return [ordered]@{
    ok = $true
    engine = "Microsoft Hyper-V"
    created = $true
    bootOrder = $(if ($diskFirst) { "disk-first" } else { "cdrom-first" })
    displayMode = [string]$config.displayMode
    vm = Get-VmSnapshot -Vm $vm
    warnings = $warnings
    autopilotActions = $autopilotActions
  }
}

function Stop-Emustar {
  Assert-HyperVReady
  $vm = Get-VM -Name $vmName -ErrorAction SilentlyContinue
  if ($vm -and $vm.State -in @("Running", "Paused", "Suspended")) {
    Save-VM -VM $vm -ErrorAction Stop
    $vm = Get-VM -Name $vmName -ErrorAction Stop
    $warnings.Add("Saved the Hyper-V session so its RAM is released and the next launch can resume quickly.")
  } elseif ($vm -and $vm.State -notin @("Off", "Saved")) {
    $vm = Stop-EmustarForConfiguration -Vm $vm
  }
  return [ordered]@{
    ok = $true
    vm = Get-VmSnapshot -Vm (Get-VM -Name $vmName -ErrorAction SilentlyContinue)
    warnings = $warnings
  }
}

function Recover-Emustar {
  Assert-HyperVReady
  Write-AutopilotEvent -Kind "inspect" -Message "Inspecting NebulaVM-EMUSTAR and its attached devices."
  $vm = Get-VM -Name $vmName -ErrorAction SilentlyContinue
  if (-not $vm) {
    throw "NebulaVM Autopilot cannot recover Hyper-V because its VM no longer exists. Launch it again to rebuild the VM."
  }

  if ($vm.State -eq "Running") {
    $action = "confirmed Hyper-V is still running and canceled the unnecessary restart."
    Write-AutopilotEvent -Kind "success" -Message $action
    $autopilotActions.Add($action)
    $warnings.Add("NebulaVM Autopilot: $action")
  } else {
    if ($vm.State -eq "Stopping") {
      Write-AutopilotEvent -Kind "command" -Message "Waiting for the stopping VM to reach a safe state."
      $vm = Stop-EmustarForConfiguration -Vm $vm
    }
    if ($vm.State -notin @("Off", "Saved")) {
      throw "NebulaVM Autopilot cannot safely recover Hyper-V while it is in state '$($vm.State)'."
    }

    $disk = Get-VMHardDiskDrive -VM $vm -ErrorAction SilentlyContinue | Select-Object -First 1
    $diskPath = if ($disk) { [string]$disk.Path } else { "" }
    if ([string]::IsNullOrWhiteSpace($diskPath) -or -not (Test-Path -LiteralPath $diskPath -PathType Leaf)) {
      throw "NebulaVM Autopilot found that the VM's virtual disk is missing. Request a new disk or launch the template again."
    }

    $preparedWindowsDisk = [IO.Path]::GetFileName($diskPath) -match "^private-windows-11-template-.*\.vhdx$"
    if ($preparedWindowsDisk) {
      Repair-TemplateDvdAttachments -Vm $vm
    }
    Repair-EmustarDiskAccess -DiskPath $diskPath

    try {
      Write-AutopilotEvent -Kind "command" -Message "Starting NebulaVM-EMUSTAR once."
      Start-VM -VM $vm -ErrorAction Stop | Out-Null
    } catch {
      $rootReason = Get-EmustarStartFailureReason
      if (-not $preparedWindowsDisk) {
        throw "NebulaVM Autopilot could not restart Hyper-V. Root cause: $rootReason."
      }
      Repair-TemplateDvdAttachments -Vm $vm
      Repair-EmustarDiskAccess -DiskPath $diskPath
      try {
        Write-AutopilotEvent -Kind "command" -Message "Retrying the repaired Hyper-V start once."
        Start-VM -VM $vm -ErrorAction Stop | Out-Null
      } catch {
        throw "NebulaVM Autopilot could not recover Hyper-V. Root cause: $rootReason. Retry failed: $($_.Exception.Message)"
      }
    }

    $action = "confirmed the VM stopped unexpectedly, repaired its attached devices and disk access, and restarted it once."
    Write-AutopilotEvent -Kind "success" -Message $action
    $autopilotActions.Add($action)
    $warnings.Add("NebulaVM Autopilot: $action")
  }

  return [ordered]@{
    ok = $true
    recovered = $true
    vm = Get-VmSnapshot -Vm (Get-VM -Name $vmName -ErrorAction Stop)
    warnings = $warnings
    autopilotActions = $autopilotActions
  }
}

function Remove-EmustarDiskFile {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return
  }

  for ($attempt = 1; $attempt -le 5; $attempt += 1) {
    try {
      Remove-Item -LiteralPath $Path -Force -ErrorAction Stop
      return
    } catch {
      if ($attempt -eq 5) {
        throw "Could not remove the old private Hyper-V disk because it is still locked: $($_.Exception.Message)"
      }
      Start-Sleep -Milliseconds (350 * $attempt)
    }
  }
}

function Request-NewEmustarDisk {
  $config = Read-Config
  Assert-HyperVReady

  $isoPath = [string]$config.isoPath
  $templateDiskPath = [string]$config.templateDiskPath
  $isoProvided = -not [string]::IsNullOrWhiteSpace($isoPath)
  $templateDiskProvided = -not [string]::IsNullOrWhiteSpace($templateDiskPath)
  if (-not $isoProvided -and -not $templateDiskProvided) {
    throw "Choose an ISO path or Windows 11 Template before requesting a new Hyper-V disk."
  }

  if ($isoProvided) {
    if (-not [IO.Path]::IsPathRooted($isoPath) -or -not (Test-Path -LiteralPath $isoPath -PathType Leaf)) {
      throw "The selected ISO file is no longer available on the host."
    }
    $isoPath = [IO.Path]::GetFullPath($isoPath)
  }
  if ($templateDiskProvided) {
    if (-not [IO.Path]::IsPathRooted($templateDiskPath) -or -not (Test-Path -LiteralPath $templateDiskPath -PathType Leaf)) {
      throw "The Windows 11 Template disk is no longer available on the host."
    }
    $templateDiskPath = [IO.Path]::GetFullPath($templateDiskPath)
  }

  $vmDirectory = [string]$config.vmDirectory
  if ([string]::IsNullOrWhiteSpace($vmDirectory)) {
    throw "The Hyper-V VM directory was not supplied."
  }
  $storageOwnerId = [string]$config.storageOwnerId
  if ([string]::IsNullOrWhiteSpace($storageOwnerId)) {
    throw "NebulaVM needs this browser's private device identity before it can replace the disk."
  }
  New-Item -ItemType Directory -Path $vmDirectory -Force | Out-Null
  Cleanup-EmustarPrivateDisks -VmDirectory $vmDirectory

  $diskSizeGb = [math]::Min(256, [math]::Max(64, [int]$config.diskSizeGb))
  $privateDiskCushionBytes = if ($templateDiskProvided) {
    [int64]8GB
  } else {
    [int64]([math]::Min($diskSizeGb, 8) * 1GB)
  }
  Assert-NebulaStorageReserve `
    -TargetPath $vmDirectory `
    -NeededBytes $privateDiskCushionBytes `
    -ActionText "replace a private Hyper-V disk"
  $vhdPath = if ($templateDiskProvided) {
    Get-IsolatedTemplateDiskPath -VmDirectory $vmDirectory -TemplateDiskPath $templateDiskPath -OwnerId $storageOwnerId
  } else {
    Get-IsolatedDiskPath -VmDirectory $vmDirectory -IsoPath $isoPath -OwnerId $storageOwnerId
  }

  $vm = Get-VM -Name $vmName -ErrorAction SilentlyContinue
  $reattach = $false
  $stoppedVm = $false
  if ($vm) {
    $currentDisk = Get-VMHardDiskDrive -VM $vm -ErrorAction SilentlyContinue |
      Where-Object { $_.Path -and ([IO.Path]::GetFullPath([string]$_.Path) -eq [IO.Path]::GetFullPath($vhdPath)) } |
      Select-Object -First 1
    if ($currentDisk) {
      $reattach = $true
      if ($vm.State -ne "Off") {
        $vm = Stop-EmustarForConfiguration -Vm $vm
        $stoppedVm = $true
      }
      $currentDisk = Get-VMHardDiskDrive -VM $vm -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -and ([IO.Path]::GetFullPath([string]$_.Path) -eq [IO.Path]::GetFullPath($vhdPath)) } |
        Select-Object -First 1
      if ($currentDisk) {
        Remove-VMHardDiskDrive -VMHardDiskDrive $currentDisk
      }
    }
  }

  Remove-EmustarDiskFile -Path $vhdPath
  if ($templateDiskProvided) {
    Ensure-TemplateChildDisk -ChildDiskPath $vhdPath -ParentDiskPath $templateDiskPath
    Ensure-WindowsTemplateWallpaper -VhdPath $vhdPath
  } else {
    New-VHD -Path $vhdPath -Dynamic -SizeBytes ($diskSizeGb * 1GB) | Out-Null
  }

  if ($reattach -and $vm) {
    Add-VMHardDiskDrive -VM $vm -Path $vhdPath | Out-Null
  }

  return [ordered]@{
    ok = $true
    diskPath = $vhdPath
    stoppedVm = $stoppedVm
    message = $(if ($templateDiskProvided) {
      "Fresh private Windows 11 Template disk ready. Launch Hyper-V to boot from the new copy."
    } else {
      "Fresh private Hyper-V disk ready. Launch Hyper-V to boot with a clean disk."
    })
    vm = Get-VmSnapshot -Vm (Get-VM -Name $vmName -ErrorAction SilentlyContinue)
    warnings = $warnings
  }
}

function Reset-Emustar {
  Assert-HyperVReady
  $vm = Get-VM -Name $vmName -ErrorAction Stop
  if ($vm.State -eq "Off") {
    Start-VM -VM $vm | Out-Null
  } else {
    Restart-VM -VM $vm -Force | Out-Null
  }
  return [ordered]@{ ok = $true; vm = Get-VmSnapshot -Vm (Get-VM -Name $vmName) }
}

function Open-EmustarConsole {
  Assert-HyperVReady
  $vm = Get-VM -Name $vmName -ErrorAction Stop
  Start-Process "$env:SystemRoot\System32\vmconnect.exe" -ArgumentList "localhost", $vmName
  return [ordered]@{ ok = $true; vm = Get-VmSnapshot -Vm $vm }
}

function Close-EmustarConsole {
  $closed = 0
  Get-CimInstance Win32_Process -Filter "Name = 'vmconnect.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*$vmName*" } |
    ForEach-Object {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
      $closed += 1
    }

  return [ordered]@{ ok = $true; closed = $closed }
}

function Get-GuestCredential {
  $projectRoot = Split-Path -Parent $PSScriptRoot
  $credentialsPath = Join-Path $projectRoot ".nebulavm-guest-credentials.json"
  if (-not (Test-Path -LiteralPath $credentialsPath)) {
    throw "The EMUSTAR guest credentials file is missing. Finish guest setup before resizing the desktop."
  }

  $credentials = Get-Content -LiteralPath $credentialsPath -Raw | ConvertFrom-Json
  if (
    $credentials.PSObject.Properties.Name -contains "passwordDisabled" -and
    [bool]$credentials.passwordDisabled -and
    [string]::IsNullOrWhiteSpace([string]$credentials.adminPassword)
  ) {
    throw "Live guest control is unavailable because the Windows account is passwordless. The fixed Hyper-V video mode will be used instead."
  }
  $securePassword = ConvertTo-SecureString ([string]$credentials.adminPassword) -AsPlainText -Force
  return [pscredential]::new([string]$credentials.username, $securePassword)
}

function Resize-EmustarDisplay {
  $config = Read-Config
  Assert-HyperVReady
  $vm = Get-VM -Name $vmName -ErrorAction Stop
  if ($vm.State -ne "Running") {
    throw "Start the EMUSTAR VM before resizing the guest display."
  }

  $width = [math]::Min(7680, [math]::Max(640, [int]$config.width))
  $height = [math]::Min(4320, [math]::Max(360, [int]$config.height))
  $width = $width - ($width % 2)
  $height = $height - ($height % 2)
  $accepted = $false
  $method = ""
  $resultCode = $null

  try {
    if ($vm.State -eq "Off") {
      Set-VMVideo `
        -VMName $vmName `
        -ResolutionType Single `
        -HorizontalResolution $width `
        -VerticalResolution $height | Out-Null
      $accepted = $true
      $method = "hyperv-video"
    } else {
      $warnings.Add("Hyper-V video size changes apply only while the VM is off, so NebulaVM tried live guest resize instead.")
    }
  } catch {
    $warnings.Add("Hyper-V video resize was not accepted: $($_.Exception.Message)")
  }

  if (-not $accepted) {
    try {
      $credential = Get-GuestCredential
      $guestResult = Invoke-Command -VMName $vmName -Credential $credential -ScriptBlock {
        param([int]$Width, [int]$Height)

        $typeDefinition = @"
using System;
using System.Runtime.InteropServices;

public static class NebulaDisplay {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
  public struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
    public string dmDeviceName;
    public short dmSpecVersion;
    public short dmDriverVersion;
    public short dmSize;
    public short dmDriverExtra;
    public int dmFields;
    public int dmPositionX;
    public int dmPositionY;
    public int dmDisplayOrientation;
    public int dmDisplayFixedOutput;
    public short dmColor;
    public short dmDuplex;
    public short dmYResolution;
    public short dmTTOption;
    public short dmCollate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
    public string dmFormName;
    public short dmLogPixels;
    public int dmBitsPerPel;
    public int dmPelsWidth;
    public int dmPelsHeight;
    public int dmDisplayFlags;
    public int dmDisplayFrequency;
    public int dmICMMethod;
    public int dmICMIntent;
    public int dmMediaType;
    public int dmDitherType;
    public int dmReserved1;
    public int dmReserved2;
    public int dmPanningWidth;
    public int dmPanningHeight;
  }

  [DllImport("user32.dll", CharSet = CharSet.Ansi)]
  public static extern int EnumDisplaySettings(string deviceName, int modeNum, ref DEVMODE devMode);

  [DllImport("user32.dll", CharSet = CharSet.Ansi)]
  public static extern int ChangeDisplaySettings(ref DEVMODE devMode, int flags);
}
"@

        if (-not ("NebulaDisplay" -as [type])) {
          Add-Type -TypeDefinition $typeDefinition
        }

        $current = New-Object NebulaDisplay+DEVMODE
        $current.dmSize = [Runtime.InteropServices.Marshal]::SizeOf($current)
        [NebulaDisplay]::EnumDisplaySettings($null, -1, [ref]$current) | Out-Null

        $current.dmPelsWidth = $Width
        $current.dmPelsHeight = $Height
        $current.dmFields = $current.dmFields -bor 0x80000 -bor 0x100000
        $result = [NebulaDisplay]::ChangeDisplaySettings([ref]$current, 1)
        if ($result -ne 0) {
          $result = [NebulaDisplay]::ChangeDisplaySettings([ref]$current, 0)
        }

        [ordered]@{
          ok = $result -eq 0
          result = $result
          width = $Width
          height = $Height
        }
      } -ArgumentList $width, $height

      $accepted = [bool]$guestResult.ok
      $method = "guest-display"
      $resultCode = $guestResult.result
    } catch {
      $warnings.Add("Live Windows guest resize was not accepted: $($_.Exception.Message)")
    }
  }

  if (-not $accepted) {
    $warnings.Add("NebulaVM requested a noVNC desktop resize; if the guest VNC server refuses it, the browser can scale but cannot invent extra OS desktop pixels.")
  }

  return [ordered]@{
    ok = $true
    accepted = $accepted
    method = $method
    result = $resultCode
    width = $width
    height = $height
    warnings = $warnings
    vm = Get-VmSnapshot -Vm (Get-VM -Name $vmName -ErrorAction SilentlyContinue)
  }
}

try {
  $result = switch ($Action) {
    "Status" { Get-Status }
    "Start" { Start-Emustar }
    "AutoRecover" { Recover-Emustar }
    "Stop" { Stop-Emustar }
    "RequestNewDisk" { Request-NewEmustarDisk }
    "Reset" { Reset-Emustar }
    "OpenConsole" { Open-EmustarConsole }
    "CloseConsole" { Close-EmustarConsole }
    "ResizeDisplay" { Resize-EmustarDisplay }
  }
  $result | ConvertTo-Json -Depth 8 -Compress
} catch {
  Write-AutopilotEvent -Kind "error" -Message $_.Exception.Message
  [ordered]@{
    ok = $false
    error = $_.Exception.Message
    action = $Action
  } | ConvertTo-Json -Depth 4 -Compress
  exit 1
}
