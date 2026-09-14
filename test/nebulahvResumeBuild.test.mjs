import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("translated CPU execution is declared as an Asyncify suspension boundary", () => {
  const workflow = readFileSync(new URL("../.github/workflows/build-nebulahv-v2.yml", import.meta.url), "utf8");
  const imports = workflow.match(/-sASYNCIFY_IMPORTS=([^\s"]+)/)?.[1].split(",");
  assert.ok(imports?.includes("ffi_call_js"));
  assert.ok(imports?.includes("execute_wasm"));
});
