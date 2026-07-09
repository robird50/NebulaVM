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

function Test-HyperVCmdlets {
  return $null -ne (Get-Command Get-VM -ErrorAction SilentlyContinue)
}

function Get-VmSnapshot {
  param([object]$Vm)

  if ($null -eq $Vm) {
    return $null
  }

  $security = Get-VMSecurity -VM $Vm -ErrorAction SilentlyContinue
  $firmware = Get-VMFirmware -VM $Vm -ErrorAction SilentlyContinue
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
    secureBoot = [bool]$firmware.SecureBoot
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

function Start-Emustar {
  $config = Read-Config
  Assert-HyperVReady

  $isoPath = [string]$config.isoPath
  if ([string]::IsNullOrWhiteSpace($isoPath) -or -not [IO.Path]::IsPathRooted($isoPath)) {
    throw "Enter an absolute ISO path, such as C:\Users\Dell\Downloads\Win11.iso."
  }
  if (-not (Test-Path -LiteralPath $isoPath -PathType Leaf)) {
    throw "The ISO file does not exist: $isoPath"
  }
  if ([IO.Path]::GetExtension($isoPath) -ne ".iso") {
    throw "EMUSTAR Hyper-V currently accepts CD-ROM ISO files."
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
  $vm = Get-VM -Name $vmName -ErrorAction SilentlyContinue

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

  Set-VM -VM $vm -AutomaticStartAction Nothing -AutomaticStopAction ShutDown -CheckpointType Disabled
  Set-VMMemory -VM $vm -DynamicMemoryEnabled $false -StartupBytes ($memoryMb * 1MB)
  Set-VMProcessor -VM $vm -Count $processorCount

  $dvd = Get-VMDvdDrive -VM $vm -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($dvd) {
    Set-VMDvdDrive -VMDvdDrive $dvd -Path $isoPath
  } else {
    Add-VMDvdDrive -VM $vm -Path $isoPath | Out-Null
  }

  Set-VMFirmware -VM $vm -EnableSecureBoot On -SecureBootTemplate MicrosoftWindows

  try {
    $security = Get-VMSecurity -VM $vm
    if (-not $security.TpmEnabled) {
      Set-VMKeyProtector -VM $vm -NewLocalKeyProtector
      Enable-VMTPM -VM $vm
    }
  } catch {
    $warnings.Add("Virtual TPM could not be enabled automatically: $($_.Exception.Message)")
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
