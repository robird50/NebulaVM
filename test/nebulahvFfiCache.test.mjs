import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("FFI learns integer argument types once per target", () => {
  const source = readFileSync(new URL("../runtime/nebulahv-v2/patch-ffi-call.mjs", import.meta.url), "utf8");
  const body = source.split("const replacement = `")[1].split("`;\n")[0];
  const bridge = new Function("Module", "getWasmTableEntry", "fn", "args", `${body}\nreturn result;`);
  const module = {};
  let mismatches = 0;
  const target = (value) => {
    if (typeof value !== "bigint") {
      mismatches++;
      throw new TypeError(`Cannot convert ${value} to a BigInt`);
    }
    return value + 1n;
  };
  for (let value = 0; value < 1000; value++) {
    assert.equal(bridge(module, () => target, 1, [value]), BigInt(value + 1));
  }
  assert.equal(mismatches, 1);
  const numeric = value => value + 1;
  assert.equal(bridge(module, () => numeric, 2, [20]), 21);
  assert.equal(bridge(module, () => numeric, 2, [30]), 31);
});
