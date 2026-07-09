$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$temporaryOutput = Join-Path $env:TEMP "NebulaVM-desktop-build"
$releaseDirectory = Join-Path $projectRoot "release"
$artifactName = "NebulaVM-1.0.0-portable.exe"

if (Test-Path -LiteralPath $temporaryOutput) {
  Remove-Item -LiteralPath $temporaryOutput -Recurse -Force
}

Push-Location $projectRoot
try {
  & npm.cmd exec electron-builder -- --win portable "--config.directories.output=$temporaryOutput"
  if ($LASTEXITCODE -ne 0) {
    throw "Electron Builder exited with code $LASTEXITCODE."
  }
} finally {
  Pop-Location
}

$builtArtifact = Join-Path $temporaryOutput $artifactName
if (-not (Test-Path -LiteralPath $builtArtifact)) {
  throw "The portable NebulaVM executable was not created."
}

New-Item -ItemType Directory -Path $releaseDirectory -Force | Out-Null
$releaseArtifact = Join-Path $releaseDirectory $artifactName
Copy-Item -LiteralPath $builtArtifact -Destination $releaseArtifact -Force

Write-Output "Created $releaseArtifact"
