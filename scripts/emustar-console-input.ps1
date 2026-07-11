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
    [ordered]@{
      ok = $true
      input = "focus"
      warning = "Click focused the Hyper-V setup console. Use keyboard controls in the browser viewport."
    } | ConvertTo-Json -Depth 4 -Compress
    exit 0
  } else {
    throw "Unsupported Hyper-V setup console input."
  }

  if (-not [string]::IsNullOrEmpty($sequence)) {
    [System.Windows.Forms.SendKeys]::SendWait($sequence)
  }

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
