# NebulaHV V2 Runtime Contract

NebulaVM only enables the Windows-oriented V2 launch profile when
`public/qemu/nebulahv-runtime.json` declares all four features as present.
The current shipped artifact remains V1 and therefore cannot be mistaken for
a complete Windows 11 runtime.

## Required runtime work

1. Rebuild `ktock/qemu-wasm` with SDL2 canvas support and verify that
   `-display sdl -device virtio-vga` paints into the supplied Emscripten canvas.
2. Build with `-sWASMFS=1 -lopfs.js`, link `wasmfs-opfs-mount.c`, and verify
   random read/write access to a multi-gigabyte image at `/opfs` without heap
   growth or a full-memory copy.
3. Package signed OVMF code and a per-disk writable variables image. The x86
   launch profile uses Q35 with SMM enabled and pflash-backed firmware.
4. Compile `libtpms` and `swtpm` for the same worker and connect their command
   and control channels to QEMU's TPM emulator backend. `tpm-tis` alone is not
   a TPM implementation.
5. Set all manifest feature flags to `true` only after automated probes verify
   graphics, Secure Boot state, TPM 2.0 presence, and persistent OPFS writes.

The V2 runtime must remain desktop-only and must never upload visitor media.

## Reproducible build

`build-nebulahv-v2.yml` builds the pinned qemu-wasm revision on a GitHub runner,
applies `qemu-nebulahv-display.patch`, and emits a checksummed runtime artifact.
The custom display backend copies QEMU's 32-bit framebuffer into the browser
canvas and exports pointer, wheel, and keyboard entry points. A successful build
does not enable V2 by itself; the artifact must pass the browser boot probes
before the manifest can advertise graphical display support.
