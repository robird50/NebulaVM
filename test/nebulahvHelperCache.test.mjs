import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("runtime learns helper integer types once and reuses them", () => {
  const source = readFileSync(new URL("../public/qemu-v2/out.js", import.meta.url), "utf8");
  const start = source.indexOf("  let argumentKinds;");
  const end = source.indexOf("\n }\n const mod =", start);
  assert.ok(start >= 0 && end > start);
  const create = new Function("target", "helper", "i", "helperResultTypes",
    source.slice(start, end) + "\nreturn helper[i];");
  let mismatches = 0;
  const helper = create((env, address) => {
    if (typeof address !== "bigint") {
      mismatches++;
      throw new TypeError(`Cannot convert ${address} to a BigInt`);
    }
    return address + BigInt(env);
  }, [], 0, [126]);
  assert.equal(helper(10, 20), 30n);
  const initialMismatches = mismatches;
  for (let i = 1; i < 1000; i++) assert.equal(helper(10, i), BigInt(i + 10));
  assert.ok(initialMismatches > 0);
  assert.equal(mismatches, initialMismatches);
});
