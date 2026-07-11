param(
  [string]$VmName = "NebulaVM-EMUSTAR",
  [string]$OutputPath = ""
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Ensure-BridgeAssemblies {
  Add-Type -AssemblyName System.Drawing
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
}

function Get-ConsoleProcess {
  param([bool]$OpenIfMissing = $true)

  $process = Get-Process vmconnect -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero -and $_.MainWindowTitle -like "*$VmName*" } |
    Select-Object -First 1

  if ($process -or -not $OpenIfMissing) {
    return $process
  }

  Start-Process "$env:SystemRoot\System32\vmconnect.exe" -ArgumentList "localhost", $VmName | Out-Null
  $deadline = (Get-Date).AddSeconds(8)
  do {
    Start-Sleep -Milliseconds 350
    $process = Get-Process vmconnect -ErrorAction SilentlyContinue |
      Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero -and $_.MainWindowTitle -like "*$VmName*" } |
      Select-Object -First 1
  } while (-not $process -and (Get-Date) -lt $deadline)

  return $process
}

function Get-ConsoleBounds {
  param([object]$Process)

  $element = [System.Windows.Automation.AutomationElement]::FromHandle($Process.MainWindowHandle)
  if (-not $element) {
    throw "The Hyper-V setup console window could not be measured."
  }

  try {
    $element.SetFocus()
    Start-Sleep -Milliseconds 120
  } catch {
    # Screen capture can still work if Windows refuses focus.
  }

  $rect = $element.Current.BoundingRectangle
  $width = [math]::Max(0, [int][math]::Round($rect.Width))
  $height = [math]::Max(0, [int][math]::Round($rect.Height))
  if ($width -lt 64 -or $height -lt 64) {
    throw "The Hyper-V setup console window is too small to mirror."
  }

  return [ordered]@{
    left = [int][math]::Round($rect.Left)
    top = [int][math]::Round($rect.Top)
    width = $width
    height = $height
  }
}

try {
  Ensure-BridgeAssemblies
  $process = Get-ConsoleProcess -OpenIfMissing $true
  if (-not $process) {
    throw "The Hyper-V setup console could not be opened."
  }

  $bounds = Get-ConsoleBounds -Process $process
  $bitmap = New-Object System.Drawing.Bitmap $bounds.width, $bounds.height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen($bounds.left, $bounds.top, 0, 0, $bitmap.Size)
    $stream = New-Object System.IO.MemoryStream
    try {
      $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
        Where-Object { $_.MimeType -eq "image/jpeg" } |
        Select-Object -First 1
      $encoderParams = New-Object System.Drawing.Imaging.EncoderParameters 1
      $encoderParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), 72L
      $bitmap.Save($stream, $codec, $encoderParams)
      $bytes = $stream.ToArray()
    } finally {
      $stream.Dispose()
    }
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }

  $payload = [ordered]@{
    ok = $true
    mimeType = "image/jpeg"
    width = $bounds.width
    height = $bounds.height
    title = $process.MainWindowTitle
  }

  if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $payload.image = [Convert]::ToBase64String($bytes)
  } else {
    $directory = Split-Path -Parent $OutputPath
    if (-not [string]::IsNullOrWhiteSpace($directory)) {
      New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
    [IO.File]::WriteAllBytes($OutputPath, $bytes)
    $payload.outputPath = $OutputPath
  }

  $payload | ConvertTo-Json -Depth 4 -Compress
} catch {
  [ordered]@{
    ok = $false
    error = $_.Exception.Message
  } | ConvertTo-Json -Depth 4 -Compress
  exit 1
}
