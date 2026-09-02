# NebulaVM

NebulaVM is an open-source, browser-based virtual machine interface built with
Vite, v86, Hyper-V, Android Studio Emulator, and optional QEMU backends.

## What Works

- Lightweight x86 guests can run locally in the browser through v86.
- Optional QEMU backends support additional x64 and ARM64 boot media.
- Android mode creates a private, disposable Android Studio AVD from a genuine
  system image installed on NebulaVM Host.
- Hyper-V serves an installed Windows 11 x64 guest to a browser through
  an authenticated noVNC connection.
- A free Cloudflare Quick Tunnel makes the Hyper-V browser link reachable from
  desktop and laptop browsers on other networks.
- Client devices do not need QEMU, Hyper-V, a VPN, or any NebulaVM software.

Hyper-V mode uses Microsoft Hyper-V on the host. QEMU is not involved in a
Hyper-V session.

## Run Locally

```powershell
npm.cmd install
npm.cmd run dev -- --port 5174 --strictPort
```

Open `http://127.0.0.1:5174/`.

## Mobile Developer Unlock

The mobile testing bypass is validated by the backend, not by browser JavaScript.
Set `NEBULAVM_MOBILE_DEV_CODE_HASH` to the SHA-256 hash of the private 6-digit
developer code in Netlify and in local `.env` files when testing locally.
Set `NEBULAVM_MOBILE_DEV_ALLOWED_IPS` to the permitted public IPv6 address. IPv4
entries are ignored and IPv4 requests are always denied. Multiple IPv6 addresses can
be separated with commas; local development may also include `::1`. The IP check runs
only after the submitted code is correct.

Device-specific IPv6 grants may also be stored as SHA-256 fingerprints in the backend
source. This permits an exact IPv6 address without publishing the raw address. The
developer code is still required, and IPv4 remains denied.

```powershell
node -e "console.log(require('crypto').createHash('sha256').update('your-6-digit-code').digest('hex'))"
```

## Public Hyper-V Host

The Windows host needs Windows 10/11 Pro or Enterprise, Hyper-V, Node.js, and
Cloudflared. Those requirements apply only to the host PC.

Start the supervised host:

```powershell
powershell.exe -ExecutionPolicy Bypass -File scripts\start-public-host.ps1
```

Choose **Hyper-V x64**, then use **Copy browser link**. Anyone with
that private link can open the shared Windows VM from a modern desktop or
laptop browser on any network. The host PC must remain powered on, connected to
the internet, and awake.

The link contains an unguessable access token. Treat it like a password. It
authorizes VM controls and the browser display. The token and Windows guest
credentials are stored only in ignored local files:

```text
.nebulavm-host-token
.nebulavm-guest-credentials.json
```

Cloudflare Quick Tunnel URLs can change when the tunnel restarts. Open NebulaVM
locally and copy the newly displayed browser link after a change.

## Automatic Startup

Install the startup task from an elevated PowerShell window:

```powershell
powershell.exe -ExecutionPolicy Bypass -File scripts\install-host-autostart.ps1
```

The installer creates a host task plus an independent one-minute watchdog. The
host task keeps Vite and the tunnel alive, while the watchdog detects a stale
"Running" task, replaces only failed NebulaVM processes, and republishes the
public registry. Both run in the installing user's interactive Windows session
so hidden Hyper-V and Android Studio windows can be mirrored into the browser.
Keep that Windows user signed in; a Session 0 or `SYSTEM` host cannot capture
interactive application windows.

## Moving To A Dedicated Host

Use a dedicated Windows PC when public visitors should not consume memory on
the development computer. The dedicated host supports one active Hyper-V
visitor at a time; additional visitors receive the existing occupied-session
message instead of starting another VM.

From the current host, export the tracked application, the prepared Windows 11
base disk, and the private administrator credential to an NTFS or exFAT transfer
drive:

```powershell
powershell.exe -ExecutionPolicy Bypass -File scripts\export-dedicated-host.ps1 -DestinationPath "E:\NebulaVM-Dedicated-Host"
```

On the spare PC, open PowerShell as Administrator in the transferred folder and
prepare it. Preparation verifies the Windows edition, CPU virtualization, RAM,
storage, Hyper-V feature, Node.js, and Cloudflare Tunnel. It installs disabled
startup tasks and does not publish the new host yet:

```powershell
powershell.exe -ExecutionPolicy Bypass -File scripts\prepare-dedicated-host.ps1
```

Windows 10 reached end of standard support on October 14, 2025. Keep a Windows
10 public host covered by Extended Security Updates or move it to a supported
Windows edition. The explicit `-AcknowledgeWindows10Risk` switch bypasses the
preparation block but does not make an unpatched host safe.

For cutover, first run `scripts\disable-public-host.ps1` as Administrator on the
old host. Then run `scripts\activate-dedicated-host.ps1` as Administrator on the
spare PC. This order prevents two computers from repeatedly replacing the
single public-host registry entry.

## Windows 11 Guest

The host installer applies Windows 11 Pro directly to the dedicated dynamic
VHDX. This avoids boot-loader compatibility problems between newer Windows 11
media and older Windows 10 Hyper-V firmware.

```powershell
powershell.exe -ExecutionPolicy Bypass -File scripts\prepare-windows-guest.ps1
```

The script creates the VM when needed and only wipes the dedicated Hyper-V
virtual disk inside NebulaVM's `vm-disks` folder. It creates the EFI partitions,
applies image index 6 from the configured x64 ISO, creates the local Nebula
account, installs TightVNC, and prepares a private host-only display network.

The current 8 GB host uses 1 GB startup memory with Hyper-V Dynamic Memory and
can grow the guest to 4 GB when host memory is available.

## Browser Backends

The default v86 backend is best for DOS, hobby operating systems, and older
32-bit Windows/Linux images.

The `Nebula x64 / QEMU Wasm` option needs these artifacts:

```text
public/qemu/out.js
public/qemu/qemu-system-x86_64.wasm
public/qemu/qemu-system-x86_64.worker.js
```

The included browser QEMU build stages media in WebAssembly memory and is
limited to 2 GB images. Large Windows ISOs are not practical in that mode.

Direct `QEMU x64`, `QEMU ARM64 / Windows`, and `QEMU ARM64 / Ubuntu` modes use
the separately installed native QEMU bridge. `Remote VM / browser stream`
embeds an existing browser-compatible remote desktop URL.

## Android

Choose **Android** in the emulator menu. NebulaVM lists Android 1 through 17 but
enables only genuine system images installed in Android Studio. Starting Android
creates a new AVD under `vm-disks/android-sessions/` for that browser session,
launches it headlessly, and streams its display into the viewport. Stopping
Android terminates the emulator and deletes that session's AVD.

The browser can select CPU cores, RAM, storage, and either 9:16 portrait or 16:9
landscape orientation. Touch, keyboard input, Back, Home, and Recent Apps are
forwarded through ADB. A second browser cannot view or control an active private
Android session. Only the Windows host needs Android Studio; client devices use
the normal authenticated NebulaVM host connection.

## Limits

- Hyper-V runs one active Windows VM at a time. Each accepted visitor receives
  a private differencing disk, while concurrent visitors must wait.
- Host CPU, RAM, upload bandwidth, sleep, and internet outages affect clients.
- Mobile and tablet browsers are intentionally blocked for now.
- Netlify serves only the static app; it cannot run Hyper-V or store the VHDX.
- A Windows 11 license is still required where Microsoft requires one.
