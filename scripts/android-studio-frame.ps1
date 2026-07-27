param(
  [string]$OutputPath = "",
  [string]$AvdName = "",
  [switch]$AllowLaunch,
  [switch]$OpenDeviceManager
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Ensure-BridgeAssemblies {
  Add-Type -AssemblyName System.Drawing
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes

  if (-not ("NebulaVM.NativeConsoleFrame" -as [type])) {
    Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;

namespace NebulaVM {
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  public static class NativeConsoleFrame {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();

    [DllImport("user32.dll")]
    public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int X, int Y);

    [DllImport("user32.dll")]
    public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);

    public static string WindowTitle(IntPtr hWnd) {
      var text = new StringBuilder(512);
      GetWindowText(hWnd, text, text.Capacity);
      return text.ToString();
    }

    public static IntPtr BestWindowForProcess(int processId) {
      IntPtr first = IntPtr.Zero;
      IntPtr deviceManager = IntPtr.Zero;
      EnumWindows((hWnd, lParam) => {
        uint owner;
        GetWindowThreadProcessId(hWnd, out owner);
        if (owner != processId || !IsWindowVisible(hWnd)) return true;
        string title = WindowTitle(hWnd);
        if (String.IsNullOrWhiteSpace(title)) return true;
        if (first == IntPtr.Zero) first = hWnd;
        if (title.IndexOf("Device Manager", StringComparison.OrdinalIgnoreCase) >= 0 ||
            title.IndexOf("Virtual Device", StringComparison.OrdinalIgnoreCase) >= 0) {
          deviceManager = hWnd;
        }
        return true;
      }, IntPtr.Zero);
      return deviceManager != IntPtr.Zero ? deviceManager : first;
    }
  }
}
"@
    [NebulaVM.NativeConsoleFrame]::SetProcessDPIAware() | Out-Null
  }
}

function Invoke-AutomationElement {
  param([System.Windows.Automation.AutomationElement]$Element)

  if (-not $Element) { return $false }
  try {
    $pattern = $Element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $pattern.Invoke()
    return $true
  } catch {}
  try {
    $pattern = $Element.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
    $pattern.Select()
    return $true
  } catch {}
  return $false
}

function Find-AutomationElementByName {
  param(
    [System.Windows.Automation.AutomationElement]$Root,
    [string[]]$Names
  )

  if (-not $Root) { return $null }
  try {
    $elements = $Root.FindAll(
      [System.Windows.Automation.TreeScope]::Descendants,
      [System.Windows.Automation.Condition]::TrueCondition
    )
  } catch {
    return $null
  }
  foreach ($element in $elements) {
    $name = [string]$element.Current.Name
    if ($Names | Where-Object { $name -like $_ }) {
      return $element
    }
  }
  return $null
}

function Open-PersonalAvdManager {
  param(
    [object]$Process,
    [string]$Name
  )

  if (-not $OpenDeviceManager) { return }
  [NebulaVM.NativeConsoleFrame]::ShowWindow($Process.MainWindowHandle, 4) | Out-Null
  Start-Sleep -Milliseconds 250
  $window = [System.Windows.Automation.AutomationElement]::FromHandle($Process.MainWindowHandle)
  $moreActions = Find-AutomationElementByName -Root $window -Names @("More Actions", "More actions")
  if ($moreActions -and (Invoke-AutomationElement -Element $moreActions)) {
    Start-Sleep -Milliseconds 450
    $desktop = [System.Windows.Automation.AutomationElement]::RootElement
    $deviceManager = Find-AutomationElementByName -Root $desktop -Names @("*Virtual Device Manager*", "*Device Manager*")
    if ($deviceManager) {
      [void](Invoke-AutomationElement -Element $deviceManager)
      Start-Sleep -Milliseconds 900
    }
  } else {
    try {
      # The Android Studio welcome screen is not exposed through UI Automation.
      # Its More Actions control stays at this stable relative position.
      $rect = New-Object NebulaVM.RECT
      if (-not [NebulaVM.NativeConsoleFrame]::GetWindowRect($Process.MainWindowHandle, [ref]$rect)) {
        throw "The Android Studio welcome screen could not be measured."
      }
      [NebulaVM.NativeConsoleFrame]::SetForegroundWindow($Process.MainWindowHandle) | Out-Null
      $menuX = [int][math]::Round($rect.Left + (($rect.Right - $rect.Left) * 0.55))
      $menuY = [int][math]::Round($rect.Top + (($rect.Bottom - $rect.Top) * 0.43))
      [NebulaVM.NativeConsoleFrame]::SetCursorPos($menuX, $menuY) | Out-Null
      [NebulaVM.NativeConsoleFrame]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 45
      [NebulaVM.NativeConsoleFrame]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 350
      [System.Windows.Forms.SendKeys]::SendWait("v")
      [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
      Start-Sleep -Milliseconds 1400
    } catch {}
  }

  if (-not [string]::IsNullOrWhiteSpace($Name)) {
    $desktop = [System.Windows.Automation.AutomationElement]::RootElement
    $personalAvd = Find-AutomationElementByName -Root $desktop -Names @("*$Name*")
    if ($personalAvd) {
      [void](Invoke-AutomationElement -Element $personalAvd)
    }
  }
}

function Get-TargetConsoleProcesses {
  return @(
    Get-Process -Name "studio64" -ErrorAction SilentlyContinue | ForEach-Object {
      $handle = [NebulaVM.NativeConsoleFrame]::BestWindowForProcess($_.Id)
      if ($handle -ne [IntPtr]::Zero) {
        [pscustomobject]@{
          Id = $_.Id
          MainWindowHandle = $handle
          MainWindowTitle = [NebulaVM.NativeConsoleFrame]::WindowTitle($handle)
        }
      }
    }
  )
}

function Get-ConsoleProcess {
  param([bool]$OpenIfMissing = $true)

  $process = Get-TargetConsoleProcesses |
    Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero -and $_.MainWindowTitle -notin @("", "splash") } |
    Select-Object -First 1

  if ($process -or -not $OpenIfMissing) {
    return $process
  }

  $availableMemoryMb = [math]::Floor(
    (Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1024
  )
  if ($availableMemoryMb -lt 1024) {
    throw "AVD Management needs at least 1 GB of free host memory. Switch to Device mode or close host applications."
  }

  $studioPath = @(
    "$env:ProgramFiles\Android\Android Studio\bin\studio64.exe",
    "${env:ProgramFiles(x86)}\Android\Android Studio\bin\studio64.exe",
    "$env:LOCALAPPDATA\Programs\Android Studio\bin\studio64.exe"
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
  if (-not $studioPath) {
    throw "Android Studio is not installed on this host."
  }

  Start-Process -FilePath $studioPath | Out-Null
  $deadline = (Get-Date).AddSeconds(35)
  do {
    Start-Sleep -Milliseconds 350
    $process = Get-TargetConsoleProcesses |
      Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero -and $_.MainWindowTitle -notin @("", "splash") } |
      Select-Object -First 1
  } while (-not $process -and (Get-Date) -lt $deadline)

  return $process
}

function Get-ConsoleBounds {
  param([object]$Process)

  $rect = New-Object NebulaVM.RECT
  if (-not [NebulaVM.NativeConsoleFrame]::GetWindowRect($Process.MainWindowHandle, [ref]$rect)) {
    throw "The Android Studio window could not be measured."
  }

  $width = [math]::Max(0, [int]($rect.Right - $rect.Left))
  $height = [math]::Max(0, [int]($rect.Bottom - $rect.Top))
  if ($width -lt 64 -or $height -lt 64) {
    [NebulaVM.NativeConsoleFrame]::ShowWindow($Process.MainWindowHandle, 4) | Out-Null
    Start-Sleep -Milliseconds 160
    if (-not [NebulaVM.NativeConsoleFrame]::GetWindowRect($Process.MainWindowHandle, [ref]$rect)) {
      throw "The Android Studio window could not be measured."
    }
    $width = [math]::Max(0, [int]($rect.Right - $rect.Left))
    $height = [math]::Max(0, [int]($rect.Bottom - $rect.Top))
  }
  if ($width -lt 64 -or $height -lt 64) {
    throw "The Android Studio window is too small to mirror."
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
  $process = Get-ConsoleProcess -OpenIfMissing ([bool]$AllowLaunch)
  if (-not $process) {
    throw "Android Studio is not ready. Switch to Device mode and try AVD Management again."
  }

  Open-PersonalAvdManager -Process $process -Name $AvdName
  $process = Get-ConsoleProcess -OpenIfMissing $false
  $bounds = Get-ConsoleBounds -Process $process
  $bitmap = New-Object System.Drawing.Bitmap $bounds.width, $bounds.height
  try {
    Capture-ConsoleBitmap -Process $process -Bitmap $bitmap
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
    avdName = $AvdName
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
