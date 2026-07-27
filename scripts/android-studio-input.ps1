param(
  [string]$ConfigBase64 = "",
  [string]$AvdName = ""
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Read-Config {
  if ([string]::IsNullOrWhiteSpace($ConfigBase64)) {
    return [pscustomobject]@{}
  }

  $bytes = [Convert]::FromBase64String($ConfigBase64)
  $json = [Text.Encoding]::UTF8.GetString($bytes)
  return $json | ConvertFrom-Json
}

function Ensure-BridgeAssemblies {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes

  if (-not ("NebulaVM.NativeConsoleInput" -as [type])) {
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

  public static class NativeConsoleInput {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

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
    [NebulaVM.NativeConsoleInput]::SetProcessDPIAware() | Out-Null
  }
}

function Get-TargetConsoleProcesses {
  return @(
    Get-Process -Name "studio64" -ErrorAction SilentlyContinue | ForEach-Object {
      $handle = [NebulaVM.NativeConsoleInput]::BestWindowForProcess($_.Id)
      if ($handle -ne [IntPtr]::Zero) {
        [pscustomobject]@{
          Id = $_.Id
          MainWindowHandle = $handle
          MainWindowTitle = [NebulaVM.NativeConsoleInput]::WindowTitle($handle)
        }
      }
    }
  )
}

function Get-ConsoleProcess {
  $process = Get-TargetConsoleProcesses |
    Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero -and $_.MainWindowTitle -notin @("", "splash") } |
    Select-Object -First 1

  if ($process) {
    return $process
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

function Focus-Console {
  param([object]$Process)

  [NebulaVM.NativeConsoleInput]::ShowWindow($Process.MainWindowHandle, 4) | Out-Null
  [NebulaVM.NativeConsoleInput]::SetForegroundWindow($Process.MainWindowHandle) | Out-Null
  $element = [System.Windows.Automation.AutomationElement]::FromHandle($Process.MainWindowHandle)
  if ($element) {
    try {
      $element.SetFocus()
      Start-Sleep -Milliseconds 100
    } catch {
      # The VMConnect surface may already be active enough for keyboard input.
    }
  }
}

function Hide-ConsoleFromHost {
  param([object]$Process)

  try {
    # Keep one reusable input console minimized after browser interaction.
    [NebulaVM.NativeConsoleInput]::ShowWindow($Process.MainWindowHandle, 2) | Out-Null
  } catch {
    # Hiding is best-effort; the browser control path still works without it.
  }
}

function Get-ConsoleBounds {
  param([object]$Process)

  $rect = New-Object NebulaVM.RECT
  if (-not [NebulaVM.NativeConsoleInput]::GetWindowRect($Process.MainWindowHandle, [ref]$rect)) {
    throw "The Android Studio window could not be measured."
  }

  $width = [math]::Max(0, $rect.Right - $rect.Left)
  $height = [math]::Max(0, $rect.Bottom - $rect.Top)
  if ($width -lt 64 -or $height -lt 64) {
    [NebulaVM.NativeConsoleInput]::ShowWindow($Process.MainWindowHandle, 4) | Out-Null
    Start-Sleep -Milliseconds 160
    if (-not [NebulaVM.NativeConsoleInput]::GetWindowRect($Process.MainWindowHandle, [ref]$rect)) {
      throw "The Android Studio window could not be measured."
    }
    $width = [math]::Max(0, $rect.Right - $rect.Left)
    $height = [math]::Max(0, $rect.Bottom - $rect.Top)
  }
  if ($width -lt 64 -or $height -lt 64) {
    throw "The Android Studio window is too small for pointer control."
  }

  return [ordered]@{
    left = [int]$rect.Left
    top = [int]$rect.Top
    width = [int]$width
    height = [int]$height
  }
}

function Send-ConsoleClick {
  param(
    [object]$Process,
    [object]$Config
  )

  Focus-Console -Process $Process
  $bounds = Get-ConsoleBounds -Process $Process
  $sourceWidth = [math]::Max(1.0, [double]$Config.width)
  $sourceHeight = [math]::Max(1.0, [double]$Config.height)
  $relativeX = [math]::Min([math]::Max(0.0, [double]$Config.x), $sourceWidth)
  $relativeY = [math]::Min([math]::Max(0.0, [double]$Config.y), $sourceHeight)
  $screenX = [int][math]::Round($bounds.left + (($relativeX / $sourceWidth) * $bounds.width))
  $screenY = [int][math]::Round($bounds.top + (($relativeY / $sourceHeight) * $bounds.height))

  [NebulaVM.NativeConsoleInput]::SetCursorPos($screenX, $screenY) | Out-Null
  Start-Sleep -Milliseconds 35
  [NebulaVM.NativeConsoleInput]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 45
  [NebulaVM.NativeConsoleInput]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
}

function ConvertTo-SendKeysLiteral {
  param([string]$Text)

  $builder = [System.Text.StringBuilder]::new()
  foreach ($character in $Text.ToCharArray()) {
    switch ($character) {
      "+" { [void]$builder.Append("{+}") }
      "^" { [void]$builder.Append("{^}") }
      "%" { [void]$builder.Append("{%}") }
      "~" { [void]$builder.Append("{~}") }
      "(" { [void]$builder.Append("{(}") }
      ")" { [void]$builder.Append("{)}") }
      "{" { [void]$builder.Append("{{}") }
      "}" { [void]$builder.Append("{}}") }
      "[" { [void]$builder.Append("{[}") }
      "]" { [void]$builder.Append("{]}") }
      "`r" { [void]$builder.Append("{ENTER}") }
      "`n" { [void]$builder.Append("{ENTER}") }
      default { [void]$builder.Append($character) }
    }
  }
  return $builder.ToString()
}

function ConvertTo-SendKeysKey {
  param([string]$Key)

  switch ($Key) {
    "Enter" { return "{ENTER}" }
    "Escape" { return "{ESC}" }
    "Backspace" { return "{BACKSPACE}" }
    "Delete" { return "{DELETE}" }
    "Tab" { return "{TAB}" }
    "ArrowUp" { return "{UP}" }
    "ArrowDown" { return "{DOWN}" }
    "ArrowLeft" { return "{LEFT}" }
    "ArrowRight" { return "{RIGHT}" }
    "Home" { return "{HOME}" }
    "End" { return "{END}" }
    "PageUp" { return "{PGUP}" }
    "PageDown" { return "{PGDN}" }
    " " { return " " }
    default {
      if ($Key -match '^F([1-9]|1[0-2])$') {
        return "{$($Key.ToUpperInvariant())}"
      }
      if ($Key.Length -eq 1) {
        return ConvertTo-SendKeysLiteral -Text $Key
      }
      return ""
    }
  }
}

try {
  Ensure-BridgeAssemblies
  $config = Read-Config
  $process = Get-ConsoleProcess
  if (-not $process) {
    throw "Android Studio could not be opened."
  }

  Focus-Console -Process $process
  $type = [string]$config.type
  $sequence = ""

  if ($type -eq "text") {
    $sequence = ConvertTo-SendKeysLiteral -Text ([string]$config.text)
  } elseif ($type -eq "key") {
    $sequence = ConvertTo-SendKeysKey -Key ([string]$config.key)
    if ([bool]$config.shiftKey -and -not [string]::IsNullOrEmpty($sequence)) {
      $sequence = "+$sequence"
    }
  } elseif ($type -eq "click") {
    Send-ConsoleClick -Process $process -Config $config
    Hide-ConsoleFromHost -Process $process
    [ordered]@{
      ok = $true
      input = "click"
    } | ConvertTo-Json -Depth 4 -Compress
    exit 0
  } else {
    throw "Unsupported Android Studio input."
  }

  if (-not [string]::IsNullOrEmpty($sequence)) {
    [System.Windows.Forms.SendKeys]::SendWait($sequence)
  }

  Hide-ConsoleFromHost -Process $process

  [ordered]@{
    ok = $true
    input = $type
  } | ConvertTo-Json -Depth 4 -Compress
} catch {
  [ordered]@{
    ok = $false
    error = $_.Exception.Message
  } | ConvertTo-Json -Depth 4 -Compress
  exit 1
}
