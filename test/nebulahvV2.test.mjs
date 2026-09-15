import test from "node:test";
import assert from "node:assert/strict";
import {
  buildNebulaHVV2Arguments,
  describeNebulaHVV2Status,
  hasNebulaHVGraphicalRuntime,
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
  assert.match(command, /-m 1024M/);
  assert.match(command, /VGA -display nebulahv/);
  assert.match(command, /-nic none/);
  assert.match(command, /if=pflash/);
  assert.match(command, /nvme,serial=nebulahv,drive=nebulahv-disk/);
  assert.match(command, /tpm-tis/);
  assert.match(command, /format=vhdx,file=\/opfs\/nebulahv\/windows11.vhdx/);
});

test("V2 launch fails closed when any required capability is absent", () => {
  const incomplete = structuredClone(readyManifest);
  incomplete.features.directOpfs = false;
  assert.throws(
    () => buildNebulaHVV2Arguments({ manifest: incomplete, memoryMb: 2048, mediaPath: "/opfs/disk.raw" }),
    /runtime is incomplete: directOpfs/,
  );
});

test("graphical candidate can boot BIOS media while Secure Boot and TPM remain pending", () => {
  const candidate = structuredClone(readyManifest);
  candidate.features.secureBoot = false;
  candidate.features.tpm2 = false;
  candidate.firmware = {};
  candidate.tpm = {};
  assert.equal(hasNebulaHVGraphicalRuntime(candidate), true);
  const command = buildNebulaHVV2Arguments({
    manifest: candidate,
    memoryMb: 1024,
    mediaPath: "/opfs/nebulahv/disks/matthewos.iso",
    mediaType: "cdrom",
  }).join(" ");
  assert.doesNotMatch(command, /if=pflash|tpm-tis/);
  assert.match(command, /-cdrom \/opfs\/nebulahv\/disks\/matthewos.iso/);
});

test("graphical candidate boots floppy diagnostics as a read-only floppy", () => {
  const command = buildNebulaHVV2Arguments({
    manifest: readyManifest,
    memoryMb: 512,
    mediaPath: "/opfs/nebulahv/disks/demo.img",
    mediaType: "floppy",
  }).join(" ");
  assert.match(command, /if=floppy,format=raw,readonly=on,file=\/opfs\/nebulahv\/disks\/demo.img/);
  assert.match(command, /-boot a/);
});

test("OPFS disk names cannot escape NebulaHV private storage", () => {
  assert.equal(safeNebulaHVDiskName("../Windows 11?.vhdx"), "_Windows_11_.vhdx");
  assert.equal(safeNebulaHVDiskName("..."), "disk.raw");
});

test("BIOS floppy diagnostic uses a legacy controller platform and one CPU", () => {
  const candidate = structuredClone(readyManifest);
  candidate.features.secureBoot = false;
  candidate.features.tpm2 = false;
  const command = buildNebulaHVV2Arguments({manifest: candidate, memoryMb: 128,
    mediaPath: "/opfs/demo.img", mediaType: "floppy"}).join(" ");
  assert.match(command, /-machine pc,smm=off/);
  assert.match(command, /-smp 1/);
  assert.match(command, /-m 128M/);
});

test("boot diagnostics are opt-in and CPU model choices are bounded", () => {
  const options = { manifest: readyManifest, memoryMb: 1024, mediaPath: "/opfs/windows.iso", mediaType: "cdrom" };
  const normal = buildNebulaHVV2Arguments(options).join(" ");
  assert.match(normal, /-cpu qemu64/);
  assert.doesNotMatch(normal, /-d cpu_reset|-no-reboot|-trace/);
  const diagnostic = buildNebulaHVV2Arguments({ ...options, diagnostics: true, cpuModel: "max" }).join(" ");
  assert.match(diagnostic, /-cpu max/);
  assert.match(diagnostic, /-d cpu_reset,guest_errors,int -no-reboot -no-shutdown/);
  assert.match(diagnostic, /-trace ide_atapi_cmd_read/);
  assert.throws(() => buildNebulaHVV2Arguments({ ...options, cpuModel: "host" }), /Unsupported/);
});

test("legacy machine comparison cannot disable declared Secure Boot", () => {
  const options = { manifest: readyManifest, mediaPath: "/opfs/windows.iso", mediaType: "cdrom", machineProfile: "pc" };
  assert.throws(() => buildNebulaHVV2Arguments(options), /Unsupported NebulaHV machine/);
  const bios = structuredClone(readyManifest);
  bios.features.secureBoot = false;
  bios.features.tpm2 = false;
  const command = buildNebulaHVV2Arguments({ ...options, manifest: bios }).join(" ");
  assert.match(command, /-machine pc,smm=off/);
  assert.match(command, /-smp 2/);
  const dma = buildNebulaHVV2Arguments({ ...options, manifest: bios, machineProfile: "q35-nosmm" }).join(" ");
  assert.match(dma, /-machine q35,smm=off/);
  assert.throws(() => buildNebulaHVV2Arguments({ ...options, machineProfile: "q35-nosmm" }), /Unsupported/);
});
