$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$keystorePath = Join-Path $projectRoot "nebulavm-release.jks"
$passwordPath = Join-Path $projectRoot ".signing-password"
$javaHome = "C:\Program Files\Android\Android Studio\jbr"

if (-not (Test-Path $passwordPath)) {
    $bytes = New-Object byte[] 24
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    ([BitConverter]::ToString($bytes) -replace "-", "").ToLowerInvariant() |
        Set-Content -NoNewline $passwordPath
}

$password = (Get-Content $passwordPath -Raw).Trim()
if (-not (Test-Path $keystorePath)) {
    & "$javaHome\bin\keytool.exe" `
        -genkeypair `
        -keystore $keystorePath `
        -storepass $password `
        -keypass $password `
        -alias nebulavm `
        -keyalg RSA `
        -keysize 4096 `
        -validity 10000 `
        -dname "CN=NebulaVM, OU=RoBird Studios, O=RoBird Studios, C=US"
}

$env:JAVA_HOME = $javaHome
$env:ANDROID_HOME = Join-Path $env:LOCALAPPDATA "Android\Sdk"
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$env:NEBULAVM_ANDROID_KEYSTORE = $keystorePath
$env:NEBULAVM_ANDROID_KEYSTORE_PASSWORD = $password
$env:NEBULAVM_ANDROID_KEY_PASSWORD = $password

Push-Location $projectRoot
try {
    & .\gradlew.bat assembleRelease
    if ($LASTEXITCODE -ne 0) {
        throw "Android release build failed."
    }
    $downloadDirectory = Join-Path $projectRoot "..\public\downloads"
    New-Item -ItemType Directory -Force $downloadDirectory | Out-Null
    Copy-Item `
        -LiteralPath "app\build\outputs\apk\release\app-release.apk" `
        -Destination (Join-Path $downloadDirectory "NebulaVM.apk") `
        -Force
} finally {
    Pop-Location
}
