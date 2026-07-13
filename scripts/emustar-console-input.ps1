param(
  [string]$ConfigBase64 = "",
  [string]$VmName = "NebulaVM-EMUSTAR"
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
using System.Runtime.InteropServices;

namespace NebulaVM {
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  public static class NativeConsoleInput {
    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int X, int Y);

    [DllImport("user32.dll")]
    public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
  }
}
"@
  }
}

function Get-ConsoleProcess {
  $process = Get-Process vmconnect -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero -and $_.MainWindowTitle -like "*$VmName*" } |
    Select-Object -First 1

  if ($process) {
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
    # Keep the host console out of the user's way after remote input.
    [NebulaVM.NativeConsoleInput]::ShowWindow($Process.MainWindowHandle, 0) | Out-Null
  } catch {
    # Hiding is best-effort; the browser control path still works without it.
  }
}

function Get-ConsoleBounds {
  param([object]$Process)

  $rect = New-Object NebulaVM.RECT
  if (-not [NebulaVM.NativeConsoleInput]::GetWindowRect($Process.MainWindowHandle, [ref]$rect)) {
    throw "The Hyper-V setup console window could not be measured."
  }

  $width = [math]::Max(0, $rect.Right - $rect.Left)
  $height = [math]::Max(0, $rect.Bottom - $rect.Top)
  if ($width -lt 64 -or $height -lt 64) {
    [NebulaVM.NativeConsoleInput]::ShowWindow($Process.MainWindowHandle, 4) | Out-Null
    Start-Sleep -Milliseconds 160
    if (-not [NebulaVM.NativeConsoleInput]::GetWindowRect($Process.MainWindowHandle, [ref]$rect)) {
      throw "The Hyper-V setup console window could not be measured."
    }
    $width = [math]::Max(0, $rect.Right - $rect.Left)
    $height = [math]::Max(0, $rect.Bottom - $rect.Top)
  }
  if ($width -lt 64 -or $height -lt 64) {
    throw "The Hyper-V setup console window is too small for pointer control."
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

  $bounds = Get-ConsoleBounds -Process $Process
  $sourceWidth = [math]::Max(1.0, [double]$Config.width)
  $sourceHeight = [math]::Max(1.0, [double]$Config.height)
  $relativeX = [math]::Min([math]::Max(0.0, [double]$Config.x), $sourceWidth)
  $relativeY = [math]::Min([math]::Max(0.0, [double]$Config.y), $sourceHeight)
  $screenX = [int][math]::Round($bounds.left + (($relativeX / $sourceWidth) * $bounds.width))
  $screenY = [int][math]::Round($bounds.top + (($relativeY / $sourceHeight) * $bounds.height))

  Focus-Console -Process $Process
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
    throw "The Hyper-V setup console could not be opened."
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
    throw "Unsupported Hyper-V setup console input."
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
