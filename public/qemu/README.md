# Nebula x64 QEMU Wasm Artifacts

Put a browser build of `qemu-system-x86_64` here.

NebulaVM expects:

```text
public/qemu/out.js
public/qemu/qemu-system-x86_64.wasm
public/qemu/qemu-system-x86_64.worker.js
```

Most QEMU Wasm builds also need:

```text
public/qemu/load.js
public/qemu/qemu-system-x86_64.data
```

Build these from the QEMU Wasm project, then restart the Vite dev server so
the required cross-origin isolation headers are active.
