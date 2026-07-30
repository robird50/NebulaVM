param(
  [string]$VmName = "NebulaVM-EMUSTAR",
  [string]$OutputPath = "",
  [switch]$ContentOnly
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

  public struct POINT {
    public int X;
    public int Y;
  }

  public static class NativeConsoleFrame {
    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    public static extern bool GetClientRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    public static extern bool ClientToScreen(IntPtr hWnd, ref POINT lpPoint);

    [DllImport("user32.dll")]
    public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  }
}
"@
  }
}

function Get-TargetConsoleProcesses {
  $processIds = Get-CimInstance Win32_Process -Filter "Name = 'vmconnect.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*$VmName*" } |
    Select-Object -ExpandProperty ProcessId

  if (-not $processIds) {
    return @()
  }

  return @(Get-Process -Id $processIds -ErrorAction SilentlyContinue)
}

function Get-ConsoleProcess {
  param([bool]$OpenIfMissing = $true)

  $process = Get-TargetConsoleProcesses |
    Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero -and $_.MainWindowTitle -like "*$VmName*" } |
    Select-Object -First 1

  if ($process -or -not $OpenIfMissing) {
    return $process
  }

  Get-TargetConsoleProcesses | Stop-Process -Force -ErrorAction SilentlyContinue

  Start-Process "$env:SystemRoot\System32\vmconnect.exe" -ArgumentList "localhost", $VmName | Out-Null
  $deadline = (Get-Date).AddSeconds(20)
  do {
    Start-Sleep -Milliseconds 350
    $process = Get-TargetConsoleProcesses |
      Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero -and $_.MainWindowTitle -like "*$VmName*" } |
      Select-Object -First 1
  } while (-not $process -and (Get-Date) -lt $deadline)

  if (-not $process) {
    Get-TargetConsoleProcesses | Stop-Process -Force -ErrorAction SilentlyContinue
  }

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

function Get-ConsoleClientBounds {
  param(
    [object]$Process,
    [object]$WindowBounds
  )

  $rect = New-Object NebulaVM.RECT
  $origin = New-Object NebulaVM.POINT
  if (
    -not [NebulaVM.NativeConsoleFrame]::GetClientRect($Process.MainWindowHandle, [ref]$rect) -or
    -not [NebulaVM.NativeConsoleFrame]::ClientToScreen($Process.MainWindowHandle, [ref]$origin)
  ) {
    throw "The Hyper-V setup console content area could not be measured."
  }

  $width = [math]::Max(0, [int]($rect.Right - $rect.Left))
  $height = [math]::Max(0, [int]($rect.Bottom - $rect.Top))
  $offsetX = [int]($origin.X - $WindowBounds.left)
  $offsetY = [int]($origin.Y - $WindowBounds.top)
  if ($width -lt 64 -or $height -lt 64) {
    throw "The Hyper-V setup console content area is too small to mirror."
  }

  return [ordered]@{
    offsetX = [math]::Max(0, $offsetX)
    offsetY = [math]::Max(0, $offsetY)
    width = [math]::Min($width, [int]$WindowBounds.width - [math]::Max(0, $offsetX))
    height = [math]::Min($height, [int]$WindowBounds.height - [math]::Max(0, $offsetY))
  }
}

function Hide-ConsoleFromHost {
  param([object]$Process)

  try {
    # Keep one reusable capture console minimized while the requester uses the browser viewport.
    [NebulaVM.NativeConsoleFrame]::ShowWindow($Process.MainWindowHandle, 2) | Out-Null
  } catch {
    # Best effort only.
  }
}

function Capture-ConsoleBitmap {
  param(
    [object]$Process,
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

    if (-not $printed) {
      $graphics.Clear([System.Drawing.Color]::FromArgb(18, 24, 31))
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
    Capture-ConsoleBitmap -Process $process -Bitmap $bitmap
    $outputBitmap = $bitmap
    if ($ContentOnly) {
      $clientBounds = Get-ConsoleClientBounds -Process $process -WindowBounds $bounds
      $cropRect = New-Object System.Drawing.Rectangle `
        $clientBounds.offsetX, $clientBounds.offsetY, $clientBounds.width, $clientBounds.height
      $outputBitmap = $bitmap.Clone($cropRect, $bitmap.PixelFormat)
    }
    $stream = New-Object System.IO.MemoryStream
    try {
      $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
        Where-Object { $_.MimeType -eq "image/jpeg" } |
        Select-Object -First 1
      $encoderParams = New-Object System.Drawing.Imaging.EncoderParameters 1
      $encoderParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), 72L
      $outputBitmap.Save($stream, $codec, $encoderParams)
      $bytes = $stream.ToArray()
    } finally {
      $stream.Dispose()
      if ($outputBitmap -ne $bitmap) {
        $outputBitmap.Dispose()
      }
    }
  } finally {
    Hide-ConsoleFromHost -Process $process
    $bitmap.Dispose()
  }

  $payload = [ordered]@{
    ok = $true
    mimeType = "image/jpeg"
    width = if ($ContentOnly) { $clientBounds.width } else { $bounds.width }
    height = if ($ContentOnly) { $clientBounds.height } else { $bounds.height }
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
