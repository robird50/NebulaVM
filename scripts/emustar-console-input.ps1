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

  public struct POINT {
    public int X;
    public int Y;
  }

  public static class NativeConsoleInput {
    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    public static extern bool GetClientRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    public static extern bool ClientToScreen(IntPtr hWnd, ref POINT lpPoint);

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
  $process = Get-TargetConsoleProcesses |
    Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero -and $_.MainWindowTitle -like "*$VmName*" } |
    Select-Object -First 1

  if ($process) {
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

function Focus-Console {
  param([object]$Process)

  [NebulaVM.NativeConsoleInput]::ShowWindow($Process.MainWindowHandle, 9) | Out-Null
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

function Get-ConsoleClientBounds {
  param([object]$Process)

  $rect = New-Object NebulaVM.RECT
  $origin = New-Object NebulaVM.POINT
  if (
    -not [NebulaVM.NativeConsoleInput]::GetClientRect($Process.MainWindowHandle, [ref]$rect) -or
    -not [NebulaVM.NativeConsoleInput]::ClientToScreen($Process.MainWindowHandle, [ref]$origin)
  ) {
    throw "The Hyper-V setup console content area could not be measured."
  }

  $width = [math]::Max(0, [int]($rect.Right - $rect.Left))
  $height = [math]::Max(0, [int]($rect.Bottom - $rect.Top))
  if ($width -lt 64 -or $height -lt 64) {
    throw "The Hyper-V setup console content area is too small for pointer control."
  }

  return [ordered]@{
    left = [int]$origin.X
    top = [int]$origin.Y
    width = $width
    height = $height
  }
}

function Send-ConsoleClick {
  param(
    [object]$Process,
    [object]$Config
  )

  Focus-Console -Process $Process
  $bounds = if ([bool]$Config.contentOnly) {
    Get-ConsoleClientBounds -Process $Process
  } else {
    Get-ConsoleBounds -Process $Process
  }
  $sourceWidth = [math]::Max(1.0, [double]$Config.width)
  $sourceHeight = [math]::Max(1.0, [double]$Config.height)
  $relativeX = [math]::Min([math]::Max(0.0, [double]$Config.x), $sourceWidth)
  $relativeY = [math]::Min([math]::Max(0.0, [double]$Config.y), $sourceHeight)
  $screenX = [int][math]::Round($bounds.left + (($relativeX / $sourceWidth) * $bounds.width))
  $screenY = [int][math]::Round($bounds.top + (($relativeY / $sourceHeight) * $bounds.height))

  [NebulaVM.NativeConsoleInput]::SetCursorPos($screenX, $screenY) | Out-Null
  Start-Sleep -Milliseconds 85
  [NebulaVM.NativeConsoleInput]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 95
  [NebulaVM.NativeConsoleInput]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 80
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

function ConvertTo-VirtualKeyCode {
  param([string]$Key)

  switch ($Key) {
    "Enter" { return 13 }
    "Escape" { return 27 }
    "Backspace" { return 8 }
    "Delete" { return 46 }
    "Tab" { return 9 }
    "ArrowUp" { return 38 }
    "ArrowDown" { return 40 }
    "ArrowLeft" { return 37 }
    "ArrowRight" { return 39 }
    "Home" { return 36 }
    "End" { return 35 }
    "PageUp" { return 33 }
    "PageDown" { return 34 }
    " " { return 32 }
    default {
      if ($Key -match '^F([1-9]|1[0-2])$') {
        return 111 + [int]$Matches[1]
      }
      if ($Key.Length -eq 1) {
        return [int][char]$Key.ToUpperInvariant()
      }
      return $null
    }
  }
}

function Get-VirtualKeyboard {
  $vm = Get-CimInstance -Namespace root\virtualization\v2 -ClassName Msvm_ComputerSystem -Filter "ElementName='$VmName'" -ErrorAction SilentlyContinue
  if (-not $vm) {
    return $null
  }

  return Get-CimAssociatedInstance -InputObject $vm -ResultClassName Msvm_Keyboard -ErrorAction SilentlyContinue |
    Select-Object -First 1
}

function Send-VirtualKeyboardInput {
  param(
    [object]$Config,
    [string]$Type
  )

  $keyboard = Get-VirtualKeyboard
  if (-not $keyboard) {
    return $false
  }

  if ($Type -eq "text") {
    $text = [string]$Config.text
    if ([string]::IsNullOrEmpty($text)) {
      return $false
    }
    $result = Invoke-CimMethod -InputObject $keyboard -MethodName TypeText -Arguments @{ AsciiText = $text }
    return [int]$result.ReturnValue -eq 0
  }

  if ($Type -eq "key") {
    $keyCode = ConvertTo-VirtualKeyCode -Key ([string]$Config.key)
    if ($null -eq $keyCode) {
      return $false
    }
    $result = Invoke-CimMethod -InputObject $keyboard -MethodName TypeKey -Arguments @{ KeyCode = [uint32]$keyCode }
    return [int]$result.ReturnValue -eq 0
  }

  return $false
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
    if (Send-VirtualKeyboardInput -Config $config -Type $type) {
      Hide-ConsoleFromHost -Process $process
      [ordered]@{
        ok = $true
        input = $type
      } | ConvertTo-Json -Depth 4 -Compress
      exit 0
    }
    $sequence = ConvertTo-SendKeysLiteral -Text ([string]$config.text)
  } elseif ($type -eq "key") {
    if (Send-VirtualKeyboardInput -Config $config -Type $type) {
      Hide-ConsoleFromHost -Process $process
      [ordered]@{
        ok = $true
        input = $type
      } | ConvertTo-Json -Depth 4 -Compress
      exit 0
    }
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
