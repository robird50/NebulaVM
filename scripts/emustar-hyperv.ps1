param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Status", "Start", "Stop", "Reset", "OpenConsole", "CloseConsole", "ResizeDisplay")]
  [string]$Action,

  [string]$ConfigBase64 = ""
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$vmName = "NebulaVM-EMUSTAR"
$warnings = [System.Collections.Generic.List[string]]::new()

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

function Get-Status {
  $featureState = Get-FeatureState
  $cmdletsReady = Test-HyperVCmdlets
  $vm = $null
  $serviceState = "Unavailable"

  if ($cmdletsReady) {
    $vm = Get-VM -Name $vmName -ErrorAction SilentlyContinue
    $service = Get-Service vmms -ErrorAction SilentlyContinue
    if ($service) {
      $serviceState = $service.Status.ToString()
    }
  }

  return [ordered]@{
    ok = $true
    engine = "Microsoft Hyper-V"
    featureState = $featureState
    restartRequired = $featureState -ne "Enabled" -or -not $cmdletsReady
    cmdletsReady = $cmdletsReady
    serviceState = $serviceState
    available = $featureState -eq "Enabled" -and $cmdletsReady
    vm = Get-VmSnapshot -Vm $vm
  }
}

function Assert-HyperVReady {
  $status = Get-Status
  if (-not $status.available) {
    throw "Hyper-V has been enabled, but Windows must restart before EMUSTAR can use it."
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

function Set-LowHostMemoryProfile {
  param(
    [object]$Vm,
    [int]$MemoryMb
  )

  $hostMemoryBytes = (Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory
  if ($hostMemoryBytes -le 10GB) {
    Set-VMMemory -VM $Vm `
      -DynamicMemoryEnabled $true `
      -StartupBytes 768MB `
      -MinimumBytes 512MB `
      -MaximumBytes ($MemoryMb * 1MB) `
      -Buffer 10
    return
  }

  Set-VMMemory -VM $Vm -DynamicMemoryEnabled $false -StartupBytes ($MemoryMb * 1MB)
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

  throw "EMUSTAR is still in Hyper-V state '$lastState'. Wait a few seconds or end the session, then launch again."
}

function Start-Emustar {
  $config = Read-Config
  Assert-HyperVReady

  $isoPath = [string]$config.isoPath
  $isoProvided = -not [string]::IsNullOrWhiteSpace($isoPath)
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
  if (-not $isoProvided) {
    throw "Choose an ISO path before launching EMUSTAR."
  }

  $vm = Get-VM -Name $vmName -ErrorAction SilentlyContinue

  $memoryMb = [math]::Min(6144, [math]::Max(2048, [int]$config.memoryMb))
  $diskSizeGb = [math]::Min(256, [math]::Max(64, [int]$config.diskSizeGb))
  $processorCount = [math]::Min(2, [math]::Max(1, [Environment]::ProcessorCount - 1))
  $diskFirst = [string]$config.bootOrder -eq "123"
  $vmDirectory = [string]$config.vmDirectory
  if ([string]::IsNullOrWhiteSpace($vmDirectory)) {
    throw "The EMUSTAR VM directory was not supplied."
  }

  if ($vm -and $vm.State -eq "Running") {
    $mountedIso = Get-VMDvdDrive -VM $vm -ErrorAction SilentlyContinue |
      Select-Object -First 1 |
      ForEach-Object { [string]$_.Path }
    if ($mountedIso -and ([IO.Path]::GetFullPath($mountedIso) -eq [IO.Path]::GetFullPath($isoPath))) {
      if ([string]$config.displayMode -eq "external") {
        Start-Process "$env:SystemRoot\System32\vmconnect.exe" -ArgumentList "localhost", $vmName
      } else {
        Close-EmustarConsole | Out-Null
      }
      $warnings.Add("EMUSTAR attached to the VM that was already running with this ISO.")
      return [ordered]@{
        ok = $true
        engine = "Microsoft Hyper-V"
        created = $false
        attachedExisting = $true
        bootOrder = $(if ($diskFirst) { "disk-first" } else { "cdrom-first" })
        displayMode = [string]$config.displayMode
        vm = Get-VmSnapshot -Vm $vm
        warnings = $warnings
      }
    }
  }

  New-Item -ItemType Directory -Path $vmDirectory -Force | Out-Null
  $vhdPath = Join-Path $vmDirectory "nebulavm-emustar.vhdx"
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

  Set-VM -VM $vm -AutomaticStartAction Start -AutomaticStopAction ShutDown -CheckpointType Disabled
  Set-LowHostMemoryProfile -Vm $vm -MemoryMb $memoryMb
  Set-VMProcessor -VM $vm -Count $processorCount

  $dvd = Get-VMDvdDrive -VM $vm -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($dvd) {
    Set-VMDvdDrive -VMDvdDrive $dvd -Path $isoPath
  } else {
    Add-VMDvdDrive -VM $vm -Path $isoPath | Out-Null
  }

  try {
    $security = Get-VMSecurity -VM $vm
    $firmware = Get-VMFirmware -VMName $vm.Name
    if (-not $security.TpmEnabled) {
      Set-VMFirmware -VM $vm -EnableSecureBoot On -SecureBootTemplate MicrosoftWindows
      Set-VMKeyProtector -VM $vm -NewLocalKeyProtector
      Enable-VMTPM -VM $vm
    } elseif ($firmware.SecureBoot.ToString() -ne "On") {
      $warnings.Add("Secure Boot remains off so this installation ISO can boot on the host firmware.")
    }
  } catch {
    $warnings.Add("Secure Boot or virtual TPM could not be configured automatically: $($_.Exception.Message)")
  }

  $firstBootDevice = Get-BootDevice -Vm $vm -DiskFirst $diskFirst
  if ($firstBootDevice) {
    Set-VMFirmware -VM $vm -FirstBootDevice $firstBootDevice
  }

  Start-VM -VM $vm | Out-Null

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
  }
}

function Stop-Emustar {
  Assert-HyperVReady
  $vm = Get-VM -Name $vmName -ErrorAction SilentlyContinue
  if ($vm -and $vm.State -ne "Off") {
    Stop-VM -VM $vm -Force -TurnOff
  }
  return [ordered]@{ ok = $true; vm = Get-VmSnapshot -Vm (Get-VM -Name $vmName -ErrorAction SilentlyContinue) }
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
  Get-Process vmconnect -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowTitle -like "*$vmName*" } |
    ForEach-Object {
      Stop-Process -Id $_.Id -Force
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
    "Stop" { Stop-Emustar }
    "Reset" { Reset-Emustar }
    "OpenConsole" { Open-EmustarConsole }
    "CloseConsole" { Close-EmustarConsole }
    "ResizeDisplay" { Resize-EmustarDisplay }
  }
  $result | ConvertTo-Json -Depth 8 -Compress
} catch {
  [ordered]@{
    ok = $false
    error = $_.Exception.Message
    action = $Action
  } | ConvertTo-Json -Depth 4 -Compress
  exit 1
}
