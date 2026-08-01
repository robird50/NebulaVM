param(
  [string]$VmName = "NebulaVM-EMUSTAR",
  [int]$MaxSeconds = 180,
  [int]$InitialDelaySeconds = 18
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Get-VirtualKeyboard {
  $vm = Get-CimInstance `
    -Namespace root\virtualization\v2 `
    -ClassName Msvm_ComputerSystem `
    -Filter "ElementName='$VmName'" `
    -ErrorAction SilentlyContinue
  if (-not $vm) {
    return $null
  }

  return Get-CimAssociatedInstance -InputObject $vm -ResultClassName Msvm_Keyboard -ErrorAction SilentlyContinue |
    Select-Object -First 1
}

function Invoke-KeyboardMethod {
  param(
    [object]$Keyboard,
    [string]$MethodName,
    [hashtable]$Arguments
  )

  $result = Invoke-CimMethod -InputObject $Keyboard -MethodName $MethodName -Arguments $Arguments -ErrorAction Stop
  return [int]$result.ReturnValue -eq 0
}

function Send-KeyChord {
  param(
    [object]$Keyboard,
    [uint32[]]$KeyCodes
  )

  foreach ($keyCode in $KeyCodes) {
    [void](Invoke-KeyboardMethod -Keyboard $Keyboard -MethodName "PressKey" -Arguments @{ KeyCode = $keyCode })
    Start-Sleep -Milliseconds 60
  }
  [array]::Reverse($KeyCodes)
  foreach ($keyCode in $KeyCodes) {
    [void](Invoke-KeyboardMethod -Keyboard $Keyboard -MethodName "ReleaseKey" -Arguments @{ KeyCode = $keyCode })
    Start-Sleep -Milliseconds 60
  }
}

function Send-Key {
  param(
    [object]$Keyboard,
    [uint32]$KeyCode
  )

  [void](Invoke-KeyboardMethod -Keyboard $Keyboard -MethodName "TypeKey" -Arguments @{ KeyCode = $KeyCode })
  Start-Sleep -Milliseconds 160
}

function Send-TextLine {
  param(
    [object]$Keyboard,
    [string]$Text
  )

  [void](Invoke-KeyboardMethod -Keyboard $Keyboard -MethodName "TypeText" -Arguments @{ AsciiText = $Text })
  Send-Key -Keyboard $Keyboard -KeyCode 13
}

function Test-WindowsSetupLikeFrame {
  param([string]$Path)

  Add-Type -AssemblyName System.Drawing

  $bitmap = [System.Drawing.Bitmap]::FromFile($Path)
  try {
    $sampleCount = 0
    $purpleCount = 0
    $lightCount = 0
    $startY = [math]::Floor($bitmap.Height * 0.18)
    $endY = [math]::Floor($bitmap.Height * 0.92)
    $stepX = [math]::Max(8, [math]::Floor($bitmap.Width / 72))
    $stepY = [math]::Max(8, [math]::Floor($bitmap.Height / 44))

    for ($y = $startY; $y -lt $endY; $y += $stepY) {
      for ($x = 0; $x -lt $bitmap.Width; $x += $stepX) {
        $pixel = $bitmap.GetPixel($x, $y)
        $sampleCount += 1
        if ($pixel.B -gt 55 -and $pixel.R -lt 95 -and $pixel.G -lt 95) {
          $purpleCount += 1
        }
        if ($pixel.R -gt 185 -and $pixel.G -gt 185 -and $pixel.B -gt 185) {
          $lightCount += 1
        }
      }
    }

    if ($sampleCount -le 0) {
      return $false
    }

    $purpleRatio = $purpleCount / $sampleCount
    $lightRatio = $lightCount / $sampleCount
    return $purpleRatio -gt 0.08 -and $lightRatio -gt 0.05
  } finally {
    $bitmap.Dispose()
  }
}

function Wait-ForWindowsSetupFrame {
  $frameScript = Join-Path $PSScriptRoot "emustar-console-frame.ps1"
  if (-not (Test-Path -LiteralPath $frameScript -PathType Leaf)) {
    return $false
  }

  $deadline = (Get-Date).AddSeconds($MaxSeconds)
  $framePath = Join-Path ([IO.Path]::GetTempPath()) "nebulavm-labconfig-$PID.jpg"
  while ((Get-Date) -lt $deadline) {
    try {
      $json = & powershell.exe `
        -NoLogo `
        -NoProfile `
        -NonInteractive `
        -ExecutionPolicy Bypass `
        -File $frameScript `
        -VmName $VmName `
        -OutputPath $framePath 2>$null |
        Select-Object -Last 1
      $result = $json | ConvertFrom-Json -ErrorAction Stop
      if ($result.ok -and (Test-Path -LiteralPath $framePath -PathType Leaf)) {
        if (Test-WindowsSetupLikeFrame -Path $framePath) {
          Remove-Item -LiteralPath $framePath -Force -ErrorAction SilentlyContinue
          return $true
        }
      }
    } catch {
      # Keep waiting while setup is still booting.
    }

    Start-Sleep -Seconds 3
  }

  Remove-Item -LiteralPath $framePath -Force -ErrorAction SilentlyContinue
  return $false
}

try {
  Start-Sleep -Seconds $InitialDelaySeconds
  if (-not (Wait-ForWindowsSetupFrame)) {
    exit 0
  }

  $keyboard = Get-VirtualKeyboard
  if (-not $keyboard) {
    exit 0
  }

  # Shift+F10 opens the Windows Setup command prompt in WinPE.
  Send-KeyChord -Keyboard $keyboard -KeyCodes @([uint32]16, [uint32]121)
  Start-Sleep -Milliseconds 1500
  Send-TextLine -Keyboard $keyboard -Text 'reg add "HKLM\SYSTEM\Setup\LabConfig" /f'
  Start-Sleep -Milliseconds 400
  Send-TextLine -Keyboard $keyboard -Text 'reg add "HKLM\SYSTEM\Setup\LabConfig" /v BypassRAMCheck /t REG_DWORD /d 1 /f'
  Start-Sleep -Milliseconds 400
  Send-TextLine -Keyboard $keyboard -Text "exit"
} catch {
  exit 0
}
