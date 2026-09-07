import test from "node:test";
import assert from "node:assert/strict";
import {
  describeNebulaHVMissingCapabilities,
  inspectNebulaHVCapabilities,
  NEBULAHV_RUNTIME_HEAP_BYTES,
  NEBULAHV_RUNTIME_RESERVE_BYTES,
  nebulahvMediaBudget,
} from "../src/nebulahvCapabilities.js";

const capableEnvironment = () => ({
  WebAssembly: {},
  Worker: function Worker() {},
  SharedArrayBuffer: function SharedArrayBuffer() {},
  Atomics: {},
  crossOriginIsolated: true,
  navigator: {
    gpu: {},
    storage: { getDirectory() {} },
  },
});

test("NebulaHV recognizes the required local browser runtime", () => {
  const report = inspectNebulaHVCapabilities(capableEnvironment());
  assert.equal(report.ready, true);
  assert.deepEqual(report.optional, { opfs: true, webGpu: true });
});

test("NebulaHV names missing isolation and threading capabilities", () => {
  const report = inspectNebulaHVCapabilities({ WebAssembly: {}, navigator: {} });
  assert.equal(report.ready, false);
  assert.deepEqual(describeNebulaHVMissingCapabilities(report), [
    "Web Workers",
    "SharedArrayBuffer",
    "threaded Atomics",
    "cross-origin isolation",
  ]);
});

test("NebulaHV media budget cannot overcommit the fixed Wasm heap", () => {
  const guestMemory = 512 * 1024 * 1024;
  assert.equal(
    nebulahvMediaBudget(guestMemory),
    NEBULAHV_RUNTIME_HEAP_BYTES - guestMemory - NEBULAHV_RUNTIME_RESERVE_BYTES,
  );
  assert.equal(nebulahvMediaBudget(4 * 1024 * 1024 * 1024), 0);
});
