param(
  [string]$WindowsIso = "C:\Users\Dell\Downloads\Win11_25H2_English_x64_v2.iso",
  [string]$VmName = "NebulaVM-EMUSTAR",
  [int]$ImageIndex = 6
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$projectRoot = Split-Path -Parent $PSScriptRoot
$vmDirectory = Join-Path $projectRoot "vm-disks\emustar-hyperv"
$credentialsPath = Join-Path $projectRoot ".nebulavm-guest-credentials.json"
$tightVncPath = Join-Path $vmDirectory "tightvnc-2.8.88-64bit.msi"
$tightVncUrl = "https://www.tightvnc.com/download/2.8.88/tightvnc-2.8.88-gpl-setup-64bit.msi"
$hyperVModule = Get-ChildItem `
  "$env:SystemRoot\System32\WindowsPowerShell\v1.0\Modules\Hyper-V" `
  -Recurse `
  -Filter "Hyper-V.psd1" |
  Sort-Object FullName -Descending |
  Select-Object -First 1

if (-not (Test-Path -LiteralPath $WindowsIso -PathType Leaf)) {
  throw "Windows ISO not found: $WindowsIso"
}
if (-not $hyperVModule) {
  throw "The Hyper-V PowerShell module is unavailable."
}

Import-Module $hyperVModule.FullName -Force
New-Item -ItemType Directory -Path $vmDirectory -Force | Out-Null

if (Test-Path -LiteralPath $credentialsPath) {
  $credentials = Get-Content -LiteralPath $credentialsPath -Raw | ConvertFrom-Json
} else {
  $credentials = [pscustomobject]@{
    username = "Nebula"
    adminPassword = "Nebula-" + ([guid]::NewGuid().ToString("N").Substring(0, 14)) + "!"
    vncPassword = [guid]::NewGuid().ToString("N").Substring(0, 8)
    createdAt = (Get-Date).ToString("o")
  }
  $credentials | ConvertTo-Json | Set-Content -LiteralPath $credentialsPath -Encoding ASCII
}

if (-not (Test-Path -LiteralPath $tightVncPath)) {
  Invoke-WebRequest -UseBasicParsing -Uri $tightVncUrl -OutFile $tightVncPath
}
if ((Get-Item -LiteralPath $tightVncPath).Length -lt 2000000) {
  throw "The TightVNC installer download is incomplete."
}

$vm = Get-VM -Name $VmName -ErrorAction SilentlyContinue
if (-not $vm) {
  $vhdPath = Join-Path $vmDirectory "nebulavm-emustar.vhdx"
  if (-not (Test-Path -LiteralPath $vhdPath)) {
    New-VHD -Path $vhdPath -Dynamic -SizeBytes 64GB | Out-Null
  }
  $defaultSwitch = Get-VMSwitch -Name "Default Switch" -ErrorAction SilentlyContinue
  $newVmParameters = @{
    Name = $VmName
    Generation = 2
    MemoryStartupBytes = 768MB
    VHDPath = $vhdPath
    Path = $vmDirectory
  }
  if ($defaultSwitch) {
    $newVmParameters.SwitchName = $defaultSwitch.Name
  }
  $vm = New-VM @newVmParameters
}
$vmDisk = Get-VMHardDiskDrive -VM $vm | Select-Object -First 1
if (-not $vmDisk) {
  throw "$VmName does not have a virtual hard disk."
}
$vhdPath = $vmDisk.Path

if ($vm.State -ne "Off") {
  Stop-VM -VM $vm -TurnOff -Force
}

$displaySwitchName = "NebulaVM Display"
$displayAdapterName = "Browser Display"
if (-not (Get-VMSwitch -Name $displaySwitchName -ErrorAction SilentlyContinue)) {
  New-VMSwitch -Name $displaySwitchName -SwitchType Internal | Out-Null
}
$hostDisplayAdapter = Get-NetAdapter -Name "vEthernet ($displaySwitchName)"
if (-not (Get-NetIPAddress -InterfaceIndex $hostDisplayAdapter.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object IPAddress -eq "192.168.231.1")) {
  Get-NetIPAddress -InterfaceIndex $hostDisplayAdapter.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Remove-NetIPAddress -Confirm:$false
  New-NetIPAddress `
    -InterfaceIndex $hostDisplayAdapter.ifIndex `
    -IPAddress "192.168.231.1" `
    -PrefixLength 24 | Out-Null
}
if (-not (Get-VMNetworkAdapter -VM $vm -Name $displayAdapterName -ErrorAction SilentlyContinue)) {
  Add-VMNetworkAdapter -VM $vm -SwitchName $displaySwitchName -Name $displayAdapterName
}
$displayMac = (Get-VMNetworkAdapter -VM $vm -Name $displayAdapterName).MacAddress

$isoMountedHere = $false
$vhdMountedHere = $false
$isoDrive = $null
$systemDrive = $null
$windowsDrive = $null

try {
  $isoImage = Get-DiskImage -ImagePath $WindowsIso -ErrorAction SilentlyContinue
  if (-not $isoImage.Attached) {
    Mount-DiskImage -ImagePath $WindowsIso | Out-Null
    $isoMountedHere = $true
  }
  $isoDrive = (Get-DiskImage -ImagePath $WindowsIso | Get-Volume).DriveLetter
  if (-not $isoDrive) {
    throw "The Windows ISO did not receive a drive letter."
  }

  $imageFile = @(
    "$($isoDrive):\sources\install.wim",
    "$($isoDrive):\sources\install.esd"
  ) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if (-not $imageFile) {
    throw "The Windows install image was not found in the ISO."
  }

  Dismount-VHD -Path $vhdPath -ErrorAction SilentlyContinue
  Mount-VHD -Path $vhdPath | Out-Null
  $vhdMountedHere = $true
  $hostDisk = Get-DiskImage -ImagePath $vhdPath | Get-Disk

  if ($hostDisk.PartitionStyle -ne "RAW") {
    Clear-Disk -Number $hostDisk.Number -RemoveData -RemoveOEM -Confirm:$false
  }
  Initialize-Disk -Number $hostDisk.Number -PartitionStyle GPT

  $systemPartition = New-Partition `
    -DiskNumber $hostDisk.Number `
    -Size 260MB `
    -AssignDriveLetter `
    -GptType "{C12A7328-F81F-11D2-BA4B-00A0C93EC93B}"
  Format-Volume -Partition $systemPartition -FileSystem FAT32 -NewFileSystemLabel "System" -Confirm:$false | Out-Null

  New-Partition `
    -DiskNumber $hostDisk.Number `
    -Size 16MB `
    -GptType "{E3C9E316-0B5C-4DB8-817D-F92DF00215AE}" | Out-Null

  $windowsPartition = New-Partition `
    -DiskNumber $hostDisk.Number `
    -UseMaximumSize `
    -AssignDriveLetter `
    -GptType "{EBD0A0A2-B9E5-4433-87C0-68B6B72699C7}"
  Format-Volume -Partition $windowsPartition -FileSystem NTFS -NewFileSystemLabel "Windows" -Confirm:$false | Out-Null

  $systemDrive = "$($systemPartition.DriveLetter):"
  $windowsDrive = "$($windowsPartition.DriveLetter):"

  Write-Host "Applying Windows image index $ImageIndex to $windowsDrive..."
  & dism.exe `
    /Apply-Image `
    "/ImageFile:$imageFile" `
    "/Index:$ImageIndex" `
    "/ApplyDir:$windowsDrive\"
  if ($LASTEXITCODE -ne 0) {
    throw "DISM failed while applying Windows image index $ImageIndex."
  }

  $payloadDirectory = Join-Path $windowsDrive "NebulaVM"
  New-Item -ItemType Directory -Path $payloadDirectory -Force | Out-Null
  Copy-Item -LiteralPath $tightVncPath -Destination (Join-Path $payloadDirectory "tightvnc.msi") -Force

  $guestSetup = @'
$ErrorActionPreference = "Stop"
$logPath = "C:\NebulaVM\setup.log"
Start-Transcript -Path $logPath -Append
try {
  Set-ItemProperty "HKLM:\System\CurrentControlSet\Control\Terminal Server" -Name fDenyTSConnections -Value 0
  Enable-NetFirewallRule -DisplayGroup "Remote Desktop" -ErrorAction SilentlyContinue

  $displayMac = "__DISPLAY_MAC__" -replace "(..)(?!$)", '$1-'
  $displayAdapter = Get-NetAdapter | Where-Object MacAddress -eq $displayMac | Select-Object -First 1
  if ($displayAdapter) {
    Get-NetIPAddress -InterfaceIndex $displayAdapter.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue |
      Remove-NetIPAddress -Confirm:$false
    New-NetIPAddress `
      -InterfaceIndex $displayAdapter.ifIndex `
      -IPAddress "192.168.231.2" `
      -PrefixLength 24 | Out-Null
  }

  $vncPassword = "__VNC_PASSWORD__"
  $arguments = @(
    "/i", "C:\NebulaVM\tightvnc.msi",
    "/quiet", "/norestart",
    "ADDLOCAL=Server",
    "SERVER_REGISTER_AS_SERVICE=1",
    "SERVER_ADD_FIREWALL_EXCEPTION=1",
    "SET_USEVNCAUTHENTICATION=1",
    "VALUE_OF_USEVNCAUTHENTICATION=1",
    "SET_PASSWORD=1",
    "VALUE_OF_PASSWORD=$vncPassword",
    "SET_USECONTROLAUTHENTICATION=1",
    "VALUE_OF_USECONTROLAUTHENTICATION=1",
    "SET_CONTROLPASSWORD=1",
    "VALUE_OF_CONTROLPASSWORD=$vncPassword",
    "SET_ACCEPTHTTPCONNECTIONS=1",
    "VALUE_OF_ACCEPTHTTPCONNECTIONS=0"
  )
  $installer = Start-Process msiexec.exe -ArgumentList $arguments -Wait -PassThru
  if ($installer.ExitCode -ne 0) {
    throw "TightVNC installation failed with code $($installer.ExitCode)."
  }

  Set-Service -Name tvnserver -StartupType Automatic
  Start-Service -Name tvnserver
  if (-not (Get-NetFirewallRule -DisplayName "NebulaVM VNC" -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule `
      -DisplayName "NebulaVM VNC" `
      -Direction Inbound `
      -Action Allow `
      -Protocol TCP `
      -LocalPort 5900 `
      -Profile Any | Out-Null
  }
  New-Item -ItemType File -Path "C:\NebulaVM-Guest-Ready.txt" -Force | Out-Null
} finally {
  Stop-Transcript
}
'@.Replace("__VNC_PASSWORD__", [string]$credentials.vncPassword).
  Replace("__DISPLAY_MAC__", $displayMac)
  Set-Content -LiteralPath (Join-Path $payloadDirectory "setup-guest.ps1") -Value $guestSetup -Encoding UTF8

  $setupScripts = Join-Path $windowsDrive "Windows\Setup\Scripts"
  New-Item -ItemType Directory -Path $setupScripts -Force | Out-Null
  @'
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\NebulaVM\setup-guest.ps1
exit /b 0
'@ | Set-Content -LiteralPath (Join-Path $setupScripts "SetupComplete.cmd") -Encoding ASCII

  $escapedPassword = [Security.SecurityElement]::Escape([string]$credentials.adminPassword)
  $unattend = @"
<?xml version="1.0" encoding="utf-8"?>
<unattend xmlns="urn:schemas-microsoft-com:unattend">
  <settings pass="specialize">
    <component name="Microsoft-Windows-Shell-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
      <ComputerName>NEBULA-WIN11</ComputerName>
      <RegisteredOwner>NebulaVM</RegisteredOwner>
      <TimeZone>Pacific Standard Time</TimeZone>
    </component>
  </settings>
  <settings pass="oobeSystem">
    <component name="Microsoft-Windows-International-Core" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
      <InputLocale>0409:00000409</InputLocale>
      <SystemLocale>en-US</SystemLocale>
      <UILanguage>en-US</UILanguage>
      <UserLocale>en-US</UserLocale>
    </component>
    <component name="Microsoft-Windows-Shell-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State">
      <OOBE>
        <HideEULAPage>true</HideEULAPage>
        <HideLocalAccountScreen>true</HideLocalAccountScreen>
        <HideOnlineAccountScreens>true</HideOnlineAccountScreens>
        <HideWirelessSetupInOOBE>true</HideWirelessSetupInOOBE>
        <NetworkLocation>Work</NetworkLocation>
        <ProtectYourPC>3</ProtectYourPC>
        <SkipMachineOOBE>true</SkipMachineOOBE>
        <SkipUserOOBE>true</SkipUserOOBE>
      </OOBE>
      <UserAccounts>
        <LocalAccounts>
          <LocalAccount wcm:action="add">
            <Name>Nebula</Name>
            <Group>Administrators</Group>
            <DisplayName>Nebula</DisplayName>
            <Password><Value>$escapedPassword</Value><PlainText>true</PlainText></Password>
          </LocalAccount>
        </LocalAccounts>
      </UserAccounts>
      <AutoLogon>
        <Enabled>true</Enabled>
        <LogonCount>10</LogonCount>
        <Username>Nebula</Username>
        <Password><Value>$escapedPassword</Value><PlainText>true</PlainText></Password>
      </AutoLogon>
    </component>
  </settings>
</unattend>
"@
  $pantherDirectory = Join-Path $windowsDrive "Windows\Panther"
  New-Item -ItemType Directory -Path $pantherDirectory -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $pantherDirectory "Unattend.xml") -Value $unattend -Encoding UTF8

  $offlineSoftware = Join-Path $windowsDrive "Windows\System32\Config\SOFTWARE"
  & reg.exe load HKLM\NebulaOfflineSoftware $offlineSoftware | Out-Null
  try {
    & reg.exe add "HKLM\NebulaOfflineSoftware\Microsoft\Windows\CurrentVersion\OOBE" `
      /v BypassNRO /t REG_DWORD /d 1 /f | Out-Null
  } finally {
    & reg.exe unload HKLM\NebulaOfflineSoftware | Out-Null
  }

  $guestBcdboot = Join-Path $windowsDrive "Windows\System32\bcdboot.exe"
  & $guestBcdboot "$windowsDrive\Windows" /s $systemDrive /f UEFI
  if ($LASTEXITCODE -ne 0) {
    throw "BCDBOOT could not create the VM's UEFI boot files."
  }
} finally {
  if ($vhdMountedHere) {
    Dismount-VHD -Path $vhdPath -ErrorAction SilentlyContinue
  }
  if ($isoMountedHere) {
    Dismount-DiskImage -ImagePath $WindowsIso -ErrorAction SilentlyContinue | Out-Null
  }
}

$vm = Get-VM -Name $VmName
$vmDisk = Get-VMHardDiskDrive -VM $vm | Select-Object -First 1
Get-VMDvdDrive -VM $vm | Set-VMDvdDrive -Path $null
$firmware = Get-VMFirmware -VMName $vm.Name
$windowsBoot = $firmware.BootOrder |
  Where-Object { $_.BootType -eq "File" -and [string]$_.FirmwarePath -like "*\EFI\Microsoft\Boot\bootmgfw.efi*" } |
  Select-Object -First 1
$hardDiskBoot = $firmware.BootOrder |
  Where-Object { $_.BootType -eq "Drive" -and $_.Device -and $_.Device.ToString() -like "*HardDiskDrive*" } |
  Select-Object -First 1
if ($windowsBoot) {
  $bootOrder = @($windowsBoot)
  if ($hardDiskBoot) {
    $bootOrder += $hardDiskBoot
  }
  $bootOrder += @($firmware.BootOrder | Where-Object { $_ -ne $windowsBoot -and $_ -ne $hardDiskBoot })
  Set-VMFirmware -VM $vm -EnableSecureBoot Off -BootOrder $bootOrder
} else {
  Set-VMFirmware -VM $vm -EnableSecureBoot Off -FirstBootDevice $vmDisk
}
Set-VM -VM $vm -AutomaticStartAction Start -AutomaticStopAction ShutDown -CheckpointType Disabled
Set-VMProcessor -VM $vm -Count 2
Set-VMMemory -VM $vm -DynamicMemoryEnabled $true -MinimumBytes 512MB -StartupBytes 768MB -MaximumBytes 3GB -Buffer 10
try {
  $security = Get-VMSecurity -VM $vm
  if (-not $security.TpmEnabled) {
    Set-VMKeyProtector -VM $vm -NewLocalKeyProtector
    Enable-VMTPM -VM $vm
  }
} catch {
  Write-Warning "Virtual TPM could not be enabled: $($_.Exception.Message)"
}
Start-VM -VM $vm | Out-Null

[pscustomobject]@{
  vm = $VmName
  windowsIso = $WindowsIso
  imageIndex = $ImageIndex
  vhd = $vhdPath
  username = $credentials.username
  credentialsPath = $credentialsPath
  vncPort = 5900
}
