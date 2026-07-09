# NebulaVM

NebulaVM is an open-source, browser-based virtual machine platform built with
Vite, v86, EMUSTAR, and optional QEMU backends.

## Run

```powershell
npm.cmd install
npm.cmd run dev
```

Open the local URL Vite prints, then drop an `.iso`, `.img`, `.bin`, or `.raw` file into the boot media box.

## x86_64 Backend

Use the `64-bit x86_64 processor` option, or the `Nebula x64 / QEMU Wasm`
emulator mode, for 64-bit images. This mode needs a browser build of
`qemu-system-x86_64` in `public/qemu/`.

Required files:

```text
public/qemu/out.js
public/qemu/qemu-system-x86_64.wasm
public/qemu/qemu-system-x86_64.worker.js
```

Many builds also need BIOS preload files:

```text
public/qemu/load-rom.js
public/qemu/load-rom.data
```

The Vite config sends `Cross-Origin-Opener-Policy` and
`Cross-Origin-Embedder-Policy` headers because Emscripten pthread builds need
cross-origin isolation.

The included QEMU Wasm files are from the public QEMU Wasm demo image repository.
They are enough to start the x86_64 backend. The current browser-staged media
path is limited to 2 GB because uploaded boot media is copied into browser
memory before QEMU starts.

NebulaVM can also use a QEMU Wasm build compiled with Emscripten `WORKERFS`.
With that kind of build, large local files can be mounted from the browser file
object instead of copied into WebAssembly memory. The public demo build included
here only exposes `MEMFS`, so it still uses the 2 GB browser-staged path.

## Windows 11

Windows 11 is not a practical target for this browser VM on an 8 GB PC. Its ISO
is several GB, the browser backend currently stages uploaded media into memory,
and Windows 11 normally expects UEFI/Secure Boot/TPM support. Lightweight
64-bit Linux ISOs are much more realistic.

For a large Windows 11 x64 ISO, use `EMUSTAR x64 / Hyper-V`. EMUSTAR creates a
Generation 2 Hyper-V machine with a dynamic VHDX disk, Secure Boot, virtual TPM,
and configurable memory and boot priority. Paste the full x64 ISO path into the
`Local ISO path` field. The VM is stored under
`vm-disks/emustar-hyperv/`.

EMUSTAR requires Windows 10/11 Pro or Enterprise, hardware virtualization, and
Hyper-V. Enable Hyper-V once and restart Windows:

```powershell
Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V -All
```

The emulator menu also includes direct `QEMU x64`, `QEMU ARM64 / Windows`, and
`QEMU ARM64 / Ubuntu` choices. These use the same native bridge and disk formats
while keeping the original QEMU identity in the interface and process title.

Netlify hosts only the static NebulaVM interface. EMUSTAR runs on a Windows host
because a static web host cannot provide hardware virtualization. Start the host
bridge with `npm.cmd run host` and keep the host powered on.

## EMUSTAR

EMUSTAR is NebulaVM's Windows virtualization runtime. It controls Microsoft
Hyper-V through a dedicated PowerShell backend and manages VM creation, VHDX
storage, ISO mounting, Secure Boot, virtual TPM, boot priority, memory, processor
count, start, stop, reset, and the host setup console.

QEMU is not involved in an EMUSTAR session. QEMU remains available only through
the separately labeled QEMU emulator choices.

## EMUSTAR Host Mode

Host Mode lets another desktop, laptop, or Chromebook control NebulaVM without
installing virtualization software on that client. Hyper-V and the VM files
stay on the Windows host.

Start the host on the Windows computer that has Hyper-V enabled:

```powershell
npm.cmd run host
```

Choose EMUSTAR locally and use **Copy browser link**. Open that link on another
computer connected to the same network. Keep the host computer and bridge
running while the client uses the controls.

The share link contains a private access token. Native VM API requests and the
VNC WebSocket reject remote connections that do not provide that token. The
token is stored locally in `.nebulavm-host-token` and is excluded from Git.

## Chromebook Workaround

A Chromebook cannot realistically run the Windows 11 ISO locally inside the
browser. Use EMUSTAR on the Windows host. After Windows installation, enable
Remote Desktop in the guest and connect it to a browser remote-access gateway.
NetBird provides a free plan and a browser RDP client; client devices need only
a modern browser. `Remote VM / browser stream` remains available for existing
noVNC, Guacamole, cloud-console, and remote-desktop URLs.

## Notes

- The default VM runs in the browser through v86 WebAssembly emulation.
- 32-bit x86 operating systems, DOS, hobby OS images, and older Windows/Linux images work best.
- 64-bit guest operating systems need the optional QEMU Wasm backend.
- Windows 11 x64 can use EMUSTAR with Hyper-V on a compatible Windows host.
- ARM64 guests still require the explicitly labeled native QEMU ARM64 backend on this Intel host.
- Large images may be slow because they are being emulated inside the browser.
- The included demo boot image is a tiny generated floppy image for testing the boot path.
