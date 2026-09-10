import { readFile, writeFile } from "node:fs/promises";

const outputPath = process.argv[2];
const workerPath = process.argv[3];

if (!outputPath) {
  throw new Error("Usage: node patch-ffi-call.mjs <out.js>");
}

const source = await readFile(outputPath, "utf8");
const original = "var result = (0, getWasmTableEntry(fn).apply(null, args));";
const replacement = `var target = getWasmTableEntry(fn);
var invokeWithWasmIntegers = function(candidateArgs, depth) {
  try {
    return (0, target.apply(null, candidateArgs));
  } catch (error) {
    if (depth >= 32) throw error;
    var message = String(error && error.message ? error.message : error);
    if (/Cannot convert undefined to a BigInt/.test(message)) {
      return invokeWithWasmIntegers(candidateArgs.concat(0n), depth + 1);
    }
    var match = /Cannot convert (-?[0-9]+) to a BigInt/.exec(message);
    if (!match) throw error;
    var rejectedValue = Number(match[1]);
    var sawCandidate = false;
    var lastError = error;
    for (var argIndex = 0; argIndex < candidateArgs.length; argIndex++) {
      if (typeof candidateArgs[argIndex] === "number" && candidateArgs[argIndex] === rejectedValue) {
        sawCandidate = true;
        var convertedArgs = candidateArgs.slice();
        convertedArgs[argIndex] = BigInt(rejectedValue);
        try {
          return invokeWithWasmIntegers(convertedArgs, depth + 1);
        } catch (candidateError) {
          var candidateMessage = String(candidateError && candidateError.message ? candidateError.message : candidateError);
          if ((candidateError && candidateError.nebulahvAbiMismatch) || /Cannot convert a BigInt value to a number/.test(candidateMessage)) {
            lastError = candidateError;
            continue;
          }
          throw candidateError;
        }
      }
    }
    if (!sawCandidate) throw error;
    var mismatch = new TypeError("Unable to bridge QEMU helper integer arguments");
    mismatch.nebulahvAbiMismatch = true;
    mismatch.cause = lastError;
    throw mismatch;
  }
};
var result = invokeWithWasmIntegers(args, 0);`;

const occurrences = source.split(original).length - 1;
if (occurrences !== 1) {
  throw new Error(`Expected one ffi_call_js call site, found ${occurrences}`);
}

let patchedSource = source.replace(original, replacement);
const helperParserAnchor = `  const wasmBytes = new Uint8Array(HEAP8.slice(wasm_begin, wasm_begin + wasm_size));
  var helper = {};`;
const helperParserReplacement = `  const wasmBytes = new Uint8Array(HEAP8.slice(wasm_begin, wasm_begin + wasm_size));
  const helperResultTypes = (() => {
   let offset = 8;
   const types = [];
   const results = [];
   const readU32 = () => {
    let value = 0;
    let shift = 0;
    while (true) {
     const byte = wasmBytes[offset++];
     value |= (byte & 127) << shift;
     if ((byte & 128) === 0) return value >>> 0;
     shift += 7;
    }
   };
   const readName = () => {
    const length = readU32();
    const start = offset;
    offset += length;
    return String.fromCharCode(...wasmBytes.subarray(start, start + length));
   };
   const skipLimits = () => {
    const flags = readU32();
    readU32();
    if (flags & 1) readU32();
   };
   while (offset < wasmBytes.length) {
    const sectionId = wasmBytes[offset++];
    const sectionSize = readU32();
    const sectionEnd = offset + sectionSize;
    if (sectionId === 1) {
     const count = readU32();
     for (let typeIndex = 0; typeIndex < count; typeIndex++) {
      offset++;
      const parameterCount = readU32();
      offset += parameterCount;
      const resultCount = readU32();
      types.push(resultCount ? wasmBytes[offset] : null);
      offset += resultCount;
     }
    } else if (sectionId === 2) {
     const count = readU32();
     for (let importIndex = 0; importIndex < count; importIndex++) {
      const moduleName = readName();
      const fieldName = readName();
      const kind = wasmBytes[offset++];
      if (kind === 0) {
       const resultType = types[readU32()];
       if (moduleName === "helper") results[Number(fieldName)] = resultType;
      } else if (kind === 1) {
       offset++;
       skipLimits();
      } else if (kind === 2) {
       skipLimits();
      } else if (kind === 3) {
       offset += 2;
      } else if (kind === 4) {
       readU32();
       readU32();
      }
     }
    }
    offset = sectionEnd;
    if (sectionId > 2) break;
   }
   return results;
  })();
  var helper = {};`;
if (!patchedSource.includes(helperParserAnchor)) {
  throw new Error("Expected the generated helper table anchor.");
}
patchedSource = patchedSource.replace(helperParserAnchor, helperParserReplacement);

const helperReturn = "    return invoke(args, 0);";
const helperReturnReplacement = `    const result = invoke(args, 0);
    if (helperResultTypes[i] === 126) {
     return typeof result === "bigint" ? result : BigInt(result || 0);
    }
    return typeof result === "bigint" ? Number(result) : result;`;
if (patchedSource.split(helperReturn).length - 1 !== 1) {
  throw new Error("Expected one generated helper return.");
}
patchedSource = patchedSource.replace(helperReturn, helperReturnReplacement);
const resultConversions = [
  ["HEAPU32[(rvalue >> 2) + 0 >>> 0] = result;", "HEAPU32[(rvalue >> 2) + 0 >>> 0] = Number(result);"],
  ["HEAPF32[(rvalue >> 2) + 0 >>> 0] = result;", "HEAPF32[(rvalue >> 2) + 0 >>> 0] = Number(result);"],
  ["HEAPF64[(rvalue >> 3) + 0 >>> 0] = result;", "HEAPF64[(rvalue >> 3) + 0 >>> 0] = Number(result);"],
  ["HEAPU8[rvalue + 0 >>> 0] = result;", "HEAPU8[rvalue + 0 >>> 0] = Number(result);"],
  ["HEAPU16[(rvalue >> 1) + 0 >>> 0] = result;", "HEAPU16[(rvalue >> 1) + 0 >>> 0] = Number(result);"],
  ["HEAPU64[(rvalue >> 3) + 0] = result;", "HEAPU64[(rvalue >> 3) + 0] = typeof result === 'bigint' ? result : BigInt(result);"],
];
for (const [resultOriginal, resultReplacement] of resultConversions) {
  const resultOccurrences = patchedSource.split(resultOriginal).length - 1;
  if (resultOccurrences !== 1) {
    throw new Error(`Expected one libffi result write, found ${resultOccurrences}: ${resultOriginal}`);
  }
  patchedSource = patchedSource.replace(resultOriginal, resultReplacement);
}
await writeFile(outputPath, patchedSource);

if (workerPath) {
  const workerSource = await readFile(workerPath, "utf8");
  const originalHandler = `self.onunhandledrejection = (e) => {
  throw e.reason || e;
};`;
  const diagnosticHandler = `self.onunhandledrejection = (e) => {
  const reason = e.reason || e;
  const detail = reason && (reason.stack || reason.message) || String(reason);
  postMessage({ cmd: 'callHandler', handler: 'printErr', args: [\`NebulaHV rejection stack: \${detail}\`] });
  throw reason;
};`;
  const handlerOccurrences = workerSource.split(originalHandler).length - 1;
  if (handlerOccurrences !== 1) {
    throw new Error(`Expected one worker rejection handler, found ${handlerOccurrences}`);
  }
  await writeFile(workerPath, workerSource.replace(originalHandler, diagnosticHandler));
}
