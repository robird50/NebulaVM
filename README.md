# NebulaVM

NebulaVM is a browser-based virtual machine launcher built with Vite, v86,
EMUSTAR, and optional QEMU backends.

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

For large x64 ISOs, use `EMUSTAR x64`. For Windows ARM64 ISOs, use
`EMUSTAR ARM64 / Windows`. Both modes need QEMU for Windows installed, then you
paste the full ISO path into the `Local ISO path` field. NebulaVM can create a
qcow2 install disk in `vm-disks/`.

When NebulaVM is hosted on Netlify, EMUSTAR can still work through a local
bridge on the same PC. Start NebulaVM locally with `npm.cmd run dev`, keep that
terminal open, then use the Netlify site. The hosted app will try
`http://127.0.0.1:5174` and `http://localhost:5174` for the native QEMU API.
This is still required because browsers cannot launch desktop programs by
themselves.

## EMUSTAR

EMUSTAR is NebulaVM's viewport-first native runtime layer. It manages QEMU
profiles, virtual disks, persistent UEFI state, boot priority, embedded noVNC
display, and process diagnostics behind a simpler interface. The display choice
is saved, and UEFI settings can be reset without deleting the virtual disk.

EMUSTAR uses the open-source QEMU executable as its CPU and device emulation
engine. It is not presented as an independent rewrite of QEMU. QEMU remains
licensed by and attributed to the QEMU project under its own license.

## Chromebook Workaround

A Chromebook cannot realistically run the Windows 11 ISO locally inside the
browser. Use `Remote VM / browser stream` instead. Run Windows 11 on another PC,
home server, cloud VM, Proxmox host, or EMUSTAR/QEMU machine, expose it through a
browser console such as noVNC or Apache Guacamole, then paste that URL into
NebulaVM. The Chromebook becomes the display and keyboard while the other
machine does the VM work.

## Notes

- The default VM runs in the browser through v86 WebAssembly emulation.
- 32-bit x86 operating systems, DOS, hobby OS images, and older Windows/Linux images work best.
- 64-bit guest operating systems need the optional QEMU Wasm backend.
- Large images may be slow because they are being emulated inside the browser.
- The included demo boot image is a tiny generated floppy image for testing the boot path.
