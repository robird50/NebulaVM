export const NEBULAHV_RUNTIME_MANIFEST = "/qemu/nebulahv-runtime.json";

export const NEBULAHV_V2_FEATURES = [
  "graphicalDisplay",
  "secureBoot",
  "tpm2",
  "directOpfs",
];

const featureLabels = {
  graphicalDisplay: "Windows graphics",
  secureBoot: "Secure Boot",
  tpm2: "TPM 2.0",
  directOpfs: "direct OPFS disks",
};

export const normalizeNebulaHVRuntimeManifest = (value) => {
  const manifest = value && typeof value === "object" ? value : {};
  const features = manifest.features && typeof manifest.features === "object" ? manifest.features : {};
  return {
    schemaVersion: Number(manifest.schemaVersion) || 0,
    runtimeVersion: String(manifest.runtimeVersion || "unknown"),
    profile: String(manifest.profile || "unknown"),
    entrypoint: String(manifest.entrypoint || "/qemu/out.js"),
    runtimeBase: String(manifest.runtimeBase || "/qemu/"),
    heapBytes: Math.max(0, Number(manifest.heapBytes) || 0),
    features: Object.fromEntries(
      NEBULAHV_V2_FEATURES.map((name) => [name, features[name] === true]),
    ),
    artifacts: Array.isArray(manifest.artifacts) ? manifest.artifacts.map(String) : [],
    firmware: manifest.firmware && typeof manifest.firmware === "object" ? manifest.firmware : {},
    tpm: manifest.tpm && typeof manifest.tpm === "object" ? manifest.tpm : {},
  };
};

export const hasNebulaHVGraphicalRuntime = (manifest) => {
  const normalized = normalizeNebulaHVRuntimeManifest(manifest);
  return normalized.features.graphicalDisplay && normalized.features.directOpfs;
};

export const missingNebulaHVV2Features = (manifest) => {
  const normalized = normalizeNebulaHVRuntimeManifest(manifest);
  return NEBULAHV_V2_FEATURES.filter((name) => !normalized.features[name]);
};

export const describeNebulaHVV2Status = (manifest) => {
  const missing = missingNebulaHVV2Features(manifest);
  return missing.length
    ? `V2 runtime pending: ${missing.map((name) => featureLabels[name]).join(", ")}.`
    : "NebulaHV V2 runtime ready: graphics, Secure Boot, TPM 2.0, and direct OPFS disks.";
};

export const loadNebulaHVRuntimeManifest = async (fetcher = fetch) => {
  const response = await fetcher(NEBULAHV_RUNTIME_MANIFEST, { cache: "no-store" });
  if (!response.ok) throw new Error("NebulaHV runtime manifest is missing.");
  const manifest = normalizeNebulaHVRuntimeManifest(await response.json());
  if (manifest.schemaVersion !== 1) throw new Error("NebulaHV runtime manifest is incompatible.");
  return manifest;
};

export const buildNebulaHVV2Arguments = ({
  manifest,
  memoryMb,
  mediaPath,
  mediaFormat = "raw",
  mediaType = "hda",
}) => {
  const normalized = normalizeNebulaHVRuntimeManifest(manifest);
  const missing = ["graphicalDisplay", "directOpfs"].filter((name) => !normalized.features[name]);
  if (missing.length) {
    throw new Error(`NebulaHV V2 runtime is incomplete: ${missing.join(", ")}.`);
  }

  const code = String(normalized.firmware.code || "");
  const vars = String(normalized.firmware.vars || "");
  const tpmArguments = Array.isArray(normalized.tpm.arguments)
    ? normalized.tpm.arguments.map(String)
    : [];
  if (normalized.features.secureBoot && (!code || !vars)) {
    throw new Error("NebulaHV V2 Secure Boot firmware is missing.");
  }
  if (normalized.features.tpm2 && !tpmArguments.length) {
    throw new Error("NebulaHV V2 TPM configuration is missing.");
  }
  if (!normalized.artifacts.length) {
    throw new Error("NebulaHV V2 artifact inventory is missing.");
  }

  const mediaArguments =
    mediaType === "cdrom"
      ? ["-cdrom", mediaPath, "-boot", "d"]
      : ["-drive", `if=virtio,format=${mediaFormat},file=${mediaPath}`, "-boot", "c"];

  const firmwareArguments = normalized.features.secureBoot
    ? [
        "-drive", `if=pflash,format=raw,unit=0,readonly=on,file=${code}`,
        "-drive", `if=pflash,format=raw,unit=1,file=${vars}`,
      ]
    : [];

  return [
    "-machine",
    "q35,smm=on",
    "-cpu",
    "qemu64",
    "-smp",
    "2",
    "-m",
    `${Math.max(512, Math.min(4096, Number(memoryMb) || 512))}M`,
    "-device",
    "VGA",
    "-display",
    "nebulahv",
    ...firmwareArguments,
    ...(normalized.features.tpm2 ? tpmArguments : []),
    ...mediaArguments,
  ];
};
