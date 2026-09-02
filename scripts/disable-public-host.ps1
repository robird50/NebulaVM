$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$taskNames = @("NebulaVM Host", "NebulaVM Host Watchdog")

foreach ($taskName in $taskNames) {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Disable-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue | Out-Null
}

$processes = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  ($_.Name -eq "node.exe" -and $_.CommandLine -like "*$projectRoot*" -and $_.CommandLine -like "*5174*") -or
  ($_.Name -eq "cloudflared.exe" -and $_.CommandLine -like "*127.0.0.1:5174*") -or
  ($_.Name -eq "powershell.exe" -and $_.ProcessId -ne $PID -and
    ($_.CommandLine -like "*$projectRoot*start-public-host.ps1*" -or
      $_.CommandLine -like "*$projectRoot*watch-public-host.ps1*"))
}
foreach ($process in $processes) {
  Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
}

try {
  Import-Module Hyper-V -ErrorAction Stop
  $vm = Get-VM -Name "NebulaVM-EMUSTAR" -ErrorAction SilentlyContinue
  if ($vm -and $vm.State -eq "Running") {
    Save-VM -VM $vm -ErrorAction Stop
  }
} catch {
  Write-Warning "The old VM could not be saved automatically: $($_.Exception.Message)"
}

Remove-Item -LiteralPath (Join-Path $projectRoot ".nebulavm-public-url") -Force -ErrorAction SilentlyContinue
Write-Host "This computer is no longer serving NebulaVM visitors." -ForegroundColor Green
