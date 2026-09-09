import { readFile, writeFile } from "node:fs/promises";

const outputPath = process.argv[2];

if (!outputPath) {
  throw new Error("Usage: node patch-ffi-call.mjs <out.js>");
}

const source = await readFile(outputPath, "utf8");
const original = "var result = (0, getWasmTableEntry(fn).apply(null, args));";
const replacement = `var target = getWasmTableEntry(fn);
var callArgs = args;
var result;
for (var bigintFixes = 0; ; bigintFixes++) {
  try {
    result = (0, target.apply(null, callArgs));
    break;
  } catch (error) {
    if (bigintFixes >= 32) throw error;
    var message = String(error && error.message ? error.message : error);
    if (/Cannot convert undefined to a BigInt/.test(message)) {
      callArgs = callArgs.concat(0n);
      continue;
    }
    var match = /Cannot convert (-?[0-9]+) to a BigInt/.exec(message);
    if (!match) throw error;
    var rejectedValue = Number(match[1]);
    var converted = false;
    for (var argIndex = 0; argIndex < callArgs.length; argIndex++) {
      if (typeof callArgs[argIndex] === "number" && callArgs[argIndex] === rejectedValue) {
        callArgs = callArgs.slice();
        callArgs[argIndex] = BigInt(rejectedValue);
        converted = true;
        break;
      }
    }
    if (!converted) throw error;
  }
}`;

const occurrences = source.split(original).length - 1;
if (occurrences !== 1) {
  throw new Error(`Expected one ffi_call_js call site, found ${occurrences}`);
}

await writeFile(outputPath, source.replace(original, replacement));
