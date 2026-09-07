import test from "node:test";
import assert from "node:assert/strict";
import {
  buildNebulaHVV2Arguments,
  describeNebulaHVV2Status,
  missingNebulaHVV2Features,
  normalizeNebulaHVRuntimeManifest,
} from "../src/nebulahvV2.js";
import { safeNebulaHVDiskName } from "../src/nebulahvOpfs.js";

const readyManifest = {
  schemaVersion: 1,
  runtimeVersion: "2.0.0",
  profile: "windows11",
  features: {
    graphicalDisplay: true,
    secureBoot: true,
    tpm2: true,
    directOpfs: true,
  },
  firmware: { code: "/firmware/OVMF_CODE.fd", vars: "/opfs/vars.fd" },
  tpm: { arguments: ["-tpmdev", "emulator,id=tpm0", "-device", "tpm-tis,tpmdev=tpm0"] },
  artifacts: ["/qemu/OVMF_CODE.fd", "/qemu/swtpm.wasm"],
};

test("V1 manifests cannot claim V2 readiness", () => {
  const manifest = normalizeNebulaHVRuntimeManifest({ schemaVersion: 1, features: {} });
  assert.deepEqual(missingNebulaHVV2Features(manifest), [
    "graphicalDisplay",
    "secureBoot",
    "tpm2",
    "directOpfs",
  ]);
  assert.match(describeNebulaHVV2Status(manifest), /V2 runtime pending/);
});

test("V2 arguments include graphics, protected UEFI storage, TPM, and OPFS media", () => {
  const args = buildNebulaHVV2Arguments({
    manifest: readyManifest,
    memoryMb: 4096,
    mediaPath: "/opfs/nebulahv/windows11.vhdx",
    mediaFormat: "vhdx",
  });
  const command = args.join(" ");
  assert.match(command, /q35,smm=on/);
  assert.match(command, /virtio-vga -display sdl/);
  assert.match(command, /if=pflash/);
  assert.match(command, /tpm-tis/);
  assert.match(command, /format=vhdx,file=\/opfs\/nebulahv\/windows11.vhdx/);
});

test("V2 launch fails closed when any required capability is absent", () => {
  const incomplete = structuredClone(readyManifest);
  incomplete.features.tpm2 = false;
  assert.throws(
    () => buildNebulaHVV2Arguments({ manifest: incomplete, memoryMb: 2048, mediaPath: "/opfs/disk.raw" }),
    /runtime is incomplete: tpm2/,
  );
});

test("OPFS disk names cannot escape NebulaHV private storage", () => {
  assert.equal(safeNebulaHVDiskName("../Windows 11?.vhdx"), "_Windows_11_.vhdx");
  assert.equal(safeNebulaHVDiskName("..."), "disk.raw");
});
