# NebulaVM Android

NebulaVM Android is a native, phone-first client for the restricted Android host runtime. It does
not embed the NebulaVM website in a WebView.

The app discovers the active NebulaVM Host, creates one private Android session, displays the
emulator through a memory-conscious native image surface, and forwards touch, swipe, Back, Home,
and Recents input. Frame polling pauses while the app is in the background.

## Build

Install Android Studio with Android SDK 35, then run:

```powershell
cd android-app
$env:JAVA_HOME="C:\Program Files\Android\Android Studio\jbr"
$env:ANDROID_HOME="$env:LOCALAPPDATA\Android\Sdk"
.\build-release.ps1
```

The first release build creates a private signing key in this directory. Both the key and its
generated password are ignored by Git. Keep them backed up: Android requires the same key for
future in-place updates.

The minified, signed APK is copied to `public/downloads/NebulaVM.apk`.
