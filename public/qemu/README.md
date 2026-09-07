# NebulaHV V1 Runtime

This directory contains the pinned browser build used by NebulaHV V1.

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

The current artifact uses a fixed 2.30 GB Wasm heap, threaded TCG, and a serial
console. It is suitable for small x86-64 boot images. It does not yet provide a
graphical Windows 11 display, Secure Boot, TPM 2.0, or direct OPFS block I/O.

V1 always runs in the visitor's desktop browser. Media is never uploaded to the
NebulaVM host by this runtime.
