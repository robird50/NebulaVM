export const NEBULAHV_RUNTIME_HEAP_BYTES = 2_411_724_800;
export const NEBULAHV_RUNTIME_RESERVE_BYTES = 256 * 1024 * 1024;
export const NEBULAHV_MAX_GUEST_MEMORY_BYTES = 2 * 1024 * 1024 * 1024;

export const nebulahvMediaBudget = (guestMemoryBytes) =>
  Math.max(
    0,
    NEBULAHV_RUNTIME_HEAP_BYTES -
      Math.max(128 * 1024 * 1024, Number(guestMemoryBytes) || 0) -
      NEBULAHV_RUNTIME_RESERVE_BYTES,
  );

export const inspectNebulaHVCapabilities = (environment = globalThis) => {
  const navigatorObject = environment.navigator || {};
  const required = {
    webAssembly: typeof environment.WebAssembly === "object",
    workers: typeof environment.Worker === "function",
    sharedArrayBuffer: typeof environment.SharedArrayBuffer === "function",
    atomics: typeof environment.Atomics === "object",
    crossOriginIsolated: environment.crossOriginIsolated === true,
  };

  return {
    required,
    ready: Object.values(required).every(Boolean),
    optional: {
      opfs: typeof navigatorObject.storage?.getDirectory === "function",
      webGpu: Boolean(navigatorObject.gpu),
    },
  };
};

export const describeNebulaHVMissingCapabilities = (report) => {
  const labels = {
    webAssembly: "WebAssembly",
    workers: "Web Workers",
    sharedArrayBuffer: "SharedArrayBuffer",
    atomics: "threaded Atomics",
    crossOriginIsolated: "cross-origin isolation",
  };

  return Object.entries(report.required)
    .filter(([, available]) => !available)
    .map(([name]) => labels[name] || name);
};
