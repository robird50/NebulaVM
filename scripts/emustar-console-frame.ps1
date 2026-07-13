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

  if (-not ("NebulaVM.NativeConsoleFrame" -as [type])) {
    Add-Type @"
using System;
using System.Runtime.InteropServices;

namespace NebulaVM {
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  public static class NativeConsoleFrame {
    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  }
}
"@
  }
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

  $rect = New-Object NebulaVM.RECT
  if (-not [NebulaVM.NativeConsoleFrame]::GetWindowRect($Process.MainWindowHandle, [ref]$rect)) {
    throw "The Hyper-V setup console window could not be measured."
  }

  $width = [math]::Max(0, [int]($rect.Right - $rect.Left))
  $height = [math]::Max(0, [int]($rect.Bottom - $rect.Top))
  if ($width -lt 64 -or $height -lt 64) {
    [NebulaVM.NativeConsoleFrame]::ShowWindow($Process.MainWindowHandle, 4) | Out-Null
    Start-Sleep -Milliseconds 160
    if (-not [NebulaVM.NativeConsoleFrame]::GetWindowRect($Process.MainWindowHandle, [ref]$rect)) {
      throw "The Hyper-V setup console window could not be measured."
    }
    $width = [math]::Max(0, [int]($rect.Right - $rect.Left))
    $height = [math]::Max(0, [int]($rect.Bottom - $rect.Top))
  }
  if ($width -lt 64 -or $height -lt 64) {
    throw "The Hyper-V setup console window is too small to mirror."
  }

  return [ordered]@{
    left = [int]$rect.Left
    top = [int]$rect.Top
    width = $width
    height = $height
  }
}

function Hide-ConsoleFromHost {
  param([object]$Process)

  try {
    # Keep VMConnect off the host desktop while the requester uses the browser viewport.
    [NebulaVM.NativeConsoleFrame]::ShowWindow($Process.MainWindowHandle, 0) | Out-Null
  } catch {
    # Best effort only.
  }
}

function Test-BitmapHasContent {
  param([System.Drawing.Bitmap]$Bitmap)

  $colors = New-Object 'System.Collections.Generic.HashSet[string]'
  $stepX = [math]::Max(1, [int]($Bitmap.Width / 24))
  $stepY = [math]::Max(1, [int]($Bitmap.Height / 24))
  for ($y = 0; $y -lt $Bitmap.Height; $y += $stepY) {
    for ($x = 0; $x -lt $Bitmap.Width; $x += $stepX) {
      $pixel = $Bitmap.GetPixel($x, $y)
      [void]$colors.Add("$($pixel.R),$($pixel.G),$($pixel.B)")
      if ($colors.Count -gt 8) {
        return $true
      }
    }
  }
  return $false
}

function Capture-ConsoleBitmap {
  param(
    [object]$Process,
    [object]$Bounds,
    [System.Drawing.Bitmap]$Bitmap
  )

  $graphics = [System.Drawing.Graphics]::FromImage($Bitmap)
  try {
    $hdc = $graphics.GetHdc()
    try {
      $printed = [NebulaVM.NativeConsoleFrame]::PrintWindow($Process.MainWindowHandle, $hdc, 2)
    } finally {
      $graphics.ReleaseHdc($hdc)
    }

    if (-not $printed -or -not (Test-BitmapHasContent -Bitmap $Bitmap)) {
      [NebulaVM.NativeConsoleFrame]::ShowWindow($Process.MainWindowHandle, 4) | Out-Null
      Start-Sleep -Milliseconds 160
      $graphics.CopyFromScreen($Bounds.left, $Bounds.top, 0, 0, $Bitmap.Size)
    }
  } finally {
    $graphics.Dispose()
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
  try {
    Capture-ConsoleBitmap -Process $process -Bounds $bounds -Bitmap $bitmap
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
    Hide-ConsoleFromHost -Process $process
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
