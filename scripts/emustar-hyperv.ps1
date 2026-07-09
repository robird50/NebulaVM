param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Status", "Start", "Stop", "Reset", "OpenConsole")]
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

function Start-Emustar {
  $config = Read-Config
  Assert-HyperVReady

  $isoPath = [string]$config.isoPath
  $isoProvided = -not [string]::IsNullOrWhiteSpace($isoPath)
  if ($isoProvided) {
    if (-not [IO.Path]::IsPathRooted($isoPath)) {
      throw "Enter an absolute ISO path, such as C:\Users\Dell\Downloads\Win11.iso."
    }
    if (-not (Test-Path -LiteralPath $isoPath -PathType Leaf)) {
      throw "The ISO file does not exist: $isoPath"
    }
    if ([IO.Path]::GetExtension($isoPath) -ne ".iso") {
      throw "EMUSTAR Hyper-V currently accepts CD-ROM ISO files."
    }
  }

  $vm = Get-VM -Name $vmName -ErrorAction SilentlyContinue
  if ($vm -and -not $isoProvided) {
    Set-VM -VM $vm -AutomaticStartAction Start -AutomaticStopAction ShutDown
    if ($vm.State -eq "Off") {
      Set-LowHostMemoryProfile -Vm $vm -MemoryMb 3072
      Set-InstalledWindowsBoot -Vm $vm -DetachDvd $true
      Start-VM -VM $vm | Out-Null
      $vm = Get-VM -Name $vmName
    }
    if ([string]$config.displayMode -eq "external") {
      Start-Process "$env:SystemRoot\System32\vmconnect.exe" -ArgumentList "localhost", $vmName
    }
    return [ordered]@{
      ok = $true
      engine = "Microsoft Hyper-V"
      created = $false
      bootOrder = "disk-first"
      displayMode = [string]$config.displayMode
      vm = Get-VmSnapshot -Vm $vm
      warnings = $warnings
    }
  }
  if (-not $vm -and -not $isoProvided) {
    throw "Choose an ISO the first time EMUSTAR creates a Windows VM."
  }

  $memoryMb = [math]::Min(6144, [math]::Max(2048, [int]$config.memoryMb))
  $diskSizeGb = [math]::Min(256, [math]::Max(64, [int]$config.diskSizeGb))
  $processorCount = [math]::Min(2, [math]::Max(1, [Environment]::ProcessorCount - 1))
  $diskFirst = [string]$config.bootOrder -eq "123"
  $vmDirectory = [string]$config.vmDirectory
  if ([string]::IsNullOrWhiteSpace($vmDirectory)) {
    throw "The EMUSTAR VM directory was not supplied."
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
    Stop-VM -VM $vm -Force -TurnOff
    $vm = Get-VM -Name $vmName
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

try {
  $result = switch ($Action) {
    "Status" { Get-Status }
    "Start" { Start-Emustar }
    "Stop" { Stop-Emustar }
    "Reset" { Reset-Emustar }
    "OpenConsole" { Open-EmustarConsole }
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
