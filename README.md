# NebulaVM

NebulaVM is an open-source, browser-based virtual machine interface built with
Vite, v86, EMUSTAR, and optional QEMU backends.

## What Works

- Lightweight x86 guests can run locally in the browser through v86.
- Optional QEMU backends support additional x64 and ARM64 boot media.
- EMUSTAR serves an installed Windows 11 x64 Hyper-V guest to a browser through
  an authenticated noVNC connection.
- A free Cloudflare Quick Tunnel makes the EMUSTAR browser link reachable from
  desktop and laptop browsers on other networks.
- Client devices do not need QEMU, Hyper-V, a VPN, or any NebulaVM software.

EMUSTAR uses Microsoft Hyper-V on the host. QEMU is not involved in an EMUSTAR
session.

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

```powershell
node -e "console.log(require('crypto').createHash('sha256').update('your-6-digit-code').digest('hex'))"
```

## Public EMUSTAR Host

The Windows host needs Windows 10/11 Pro or Enterprise, Hyper-V, Node.js, and
Cloudflared. Those requirements apply only to the host PC.

Start the supervised host:

```powershell
powershell.exe -ExecutionPolicy Bypass -File scripts\start-public-host.ps1
```

Choose **EMUSTAR x64 / Hyper-V**, then use **Copy browser link**. Anyone with
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

The task runs as `SYSTEM` at Windows startup, keeps Vite and the tunnel alive,
and restarts the EMUSTAR VM when it is off.

## Windows 11 Guest

The host installer applies Windows 11 Pro directly to the dedicated dynamic
VHDX. This avoids boot-loader compatibility problems between newer Windows 11
media and older Windows 10 Hyper-V firmware.

```powershell
powershell.exe -ExecutionPolicy Bypass -File scripts\prepare-windows-guest.ps1
```

The script creates the VM when needed and only wipes the dedicated EMUSTAR
virtual disk under `vm-disks/emustar-hyperv/`. It creates the EFI partitions,
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

## Limits

- EMUSTAR exposes one shared Windows VM, not a separate VM per visitor.
- Host CPU, RAM, upload bandwidth, sleep, and internet outages affect clients.
- Mobile and tablet browsers are intentionally blocked for now.
- Netlify serves only the static app; it cannot run Hyper-V or store the VHDX.
- A Windows 11 license is still required where Microsoft requires one.
