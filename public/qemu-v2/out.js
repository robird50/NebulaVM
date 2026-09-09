
var Module = (() => {
  var _scriptDir = import.meta.url;
  
  return (
async function(moduleArg = {}) {

var Module = moduleArg;

var readyPromiseResolve, readyPromiseReject;

Module["ready"] = new Promise((resolve, reject) => {
 readyPromiseResolve = resolve;
 readyPromiseReject = reject;
});

var moduleOverrides = Object.assign({}, Module);

var arguments_ = [];

var thisProgram = "./this.program";

var quit_ = (status, toThrow) => {
 throw toThrow;
};

var ENVIRONMENT_IS_WEB = typeof window == "object";

var ENVIRONMENT_IS_WORKER = typeof importScripts == "function";

var ENVIRONMENT_IS_NODE = typeof process == "object" && typeof process.versions == "object" && typeof process.versions.node == "string";

var ENVIRONMENT_IS_SHELL = !ENVIRONMENT_IS_WEB && !ENVIRONMENT_IS_NODE && !ENVIRONMENT_IS_WORKER;

var ENVIRONMENT_IS_PTHREAD = Module["ENVIRONMENT_IS_PTHREAD"] || false;

var scriptDirectory = "";

function locateFile(path) {
 if (Module["locateFile"]) {
  return Module["locateFile"](path, scriptDirectory);
 }
 return scriptDirectory + path;
}

var read_, readAsync, readBinary;

if (ENVIRONMENT_IS_NODE) {
 const {createRequire: createRequire} = await import("module");
 /** @suppress{duplicate} */ var require = createRequire(import.meta.url);
 var fs = require("fs");
 var nodePath = require("path");
 if (ENVIRONMENT_IS_WORKER) {
  scriptDirectory = nodePath.dirname(scriptDirectory) + "/";
 } else {
  scriptDirectory = require("url").fileURLToPath(new URL("./", import.meta.url));
 }
 read_ = (filename, binary) => {
  filename = isFileURI(filename) ? new URL(filename) : nodePath.normalize(filename);
  return fs.readFileSync(filename, binary ? undefined : "utf8");
 };
 readBinary = filename => {
  var ret = read_(filename, true);
  if (!ret.buffer) {
   ret = new Uint8Array(ret);
  }
  return ret;
 };
 readAsync = (filename, onload, onerror, binary = true) => {
  filename = isFileURI(filename) ? new URL(filename) : nodePath.normalize(filename);
  fs.readFile(filename, binary ? undefined : "utf8", (err, data) => {
   if (err) onerror(err); else onload(binary ? data.buffer : data);
  });
 };
 if (!Module["thisProgram"] && process.argv.length > 1) {
  thisProgram = process.argv[1].replace(/\\/g, "/");
 }
 arguments_ = process.argv.slice(2);
 process.on("uncaughtException", ex => {
  if (ex !== "unwind" && !(ex instanceof ExitStatus) && !(ex.context instanceof ExitStatus)) {
   throw ex;
  }
 });
 quit_ = (status, toThrow) => {
  process.exitCode = status;
  throw toThrow;
 };
 Module["inspect"] = () => "[Emscripten Module object]";
 let nodeWorkerThreads;
 try {
  nodeWorkerThreads = require("worker_threads");
 } catch (e) {
  console.error('The "worker_threads" module is not supported in this node.js build - perhaps a newer version is needed?');
  throw e;
 }
 global.Worker = nodeWorkerThreads.Worker;
} else  if (ENVIRONMENT_IS_WEB || ENVIRONMENT_IS_WORKER) {
 if (ENVIRONMENT_IS_WORKER) {
  scriptDirectory = self.location.href;
 } else if (typeof document != "undefined" && document.currentScript) {
  scriptDirectory = document.currentScript.src;
 }
 if (_scriptDir) {
  scriptDirectory = _scriptDir;
 }
 if (scriptDirectory.indexOf("blob:") !== 0) {
  scriptDirectory = scriptDirectory.substr(0, scriptDirectory.replace(/[?#].*/, "").lastIndexOf("/") + 1);
 } else {
  scriptDirectory = "";
 }
 if (!ENVIRONMENT_IS_NODE) {
  read_ = url => {
   var xhr = new XMLHttpRequest;
   xhr.open("GET", url, false);
   xhr.send(null);
   return xhr.responseText;
  };
  if (ENVIRONMENT_IS_WORKER) {
   readBinary = url => {
    var xhr = new XMLHttpRequest;
    xhr.open("GET", url, false);
    xhr.responseType = "arraybuffer";
    xhr.send(null);
    return new Uint8Array(/** @type{!ArrayBuffer} */ (xhr.response));
   };
  }
  readAsync = (url, onload, onerror) => {
   var xhr = new XMLHttpRequest;
   xhr.open("GET", url, true);
   xhr.responseType = "arraybuffer";
   xhr.onload = () => {
    if (xhr.status == 200 || (xhr.status == 0 && xhr.response)) {
     onload(xhr.response);
     return;
    }
    onerror();
   };
   xhr.onerror = onerror;
   xhr.send(null);
  };
 }
} else  {}

if (ENVIRONMENT_IS_NODE) {
 if (typeof performance == "undefined") {
  global.performance = require("perf_hooks").performance;
 }
}

var defaultPrint = console.log.bind(console);

var defaultPrintErr = console.error.bind(console);

if (ENVIRONMENT_IS_NODE) {
 defaultPrint = (...args) => fs.writeSync(1, args.join(" ") + "\n");
 defaultPrintErr = (...args) => fs.writeSync(2, args.join(" ") + "\n");
}

var out = Module["print"] || defaultPrint;

var err = Module["printErr"] || defaultPrintErr;

Object.assign(Module, moduleOverrides);

moduleOverrides = null;

if (Module["arguments"]) arguments_ = Module["arguments"];

if (Module["thisProgram"]) thisProgram = Module["thisProgram"];

if (Module["quit"]) quit_ = Module["quit"];

var wasmBinary;

if (Module["wasmBinary"]) wasmBinary = Module["wasmBinary"];

if (typeof WebAssembly != "object") {
 abort("no native wasm support detected");
}

function intArrayFromBase64(s) {
 if (typeof ENVIRONMENT_IS_NODE != "undefined" && ENVIRONMENT_IS_NODE) {
  var buf = Buffer.from(s, "base64");
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
 }
 var decoded = atob(s);
 var bytes = new Uint8Array(decoded.length);
 for (var i = 0; i < decoded.length; ++i) {
  bytes[i] = decoded.charCodeAt(i);
 }
 return bytes;
}

function tryParseAsDataURI(filename) {
 if (!isDataURI(filename)) {
  return;
 }
 return intArrayFromBase64(filename.slice(dataURIPrefix.length));
}

var wasmMemory;

var wasmModule;

var ABORT = false;

var EXITSTATUS;

/** @type {function(*, string=)} */ function assert(condition, text) {
 if (!condition) {
  abort(text);
 }
}

var HEAP, /** @type {!Int8Array} */ HEAP8, /** @type {!Uint8Array} */ HEAPU8, /** @type {!Int16Array} */ HEAP16, /** @type {!Uint16Array} */ HEAPU16, /** @type {!Int32Array} */ HEAP32, /** @type {!Uint32Array} */ HEAPU32, /** @type {!Float32Array} */ HEAPF32, /* BigInt64Array type is not correctly defined in closure
/** not-@type {!BigInt64Array} */ HEAP64, /* BigUInt64Array type is not correctly defined in closure
/** not-t@type {!BigUint64Array} */ HEAPU64, /** @type {!Float64Array} */ HEAPF64;

function updateMemoryViews() {
 var b = wasmMemory.buffer;
 Module["HEAP8"] = HEAP8 = new Int8Array(b);
 Module["HEAP16"] = HEAP16 = new Int16Array(b);
 Module["HEAPU8"] = HEAPU8 = new Uint8Array(b);
 Module["HEAPU16"] = HEAPU16 = new Uint16Array(b);
 Module["HEAP32"] = HEAP32 = new Int32Array(b);
 Module["HEAPU32"] = HEAPU32 = new Uint32Array(b);
 Module["HEAPF32"] = HEAPF32 = new Float32Array(b);
 Module["HEAPF64"] = HEAPF64 = new Float64Array(b);
 Module["HEAP64"] = HEAP64 = new BigInt64Array(b);
 Module["HEAPU64"] = HEAPU64 = new BigUint64Array(b);
}

var INITIAL_MEMORY = Module["INITIAL_MEMORY"] || 2411724800;

if (ENVIRONMENT_IS_PTHREAD) {
 wasmMemory = Module["wasmMemory"];
} else {
 if (Module["wasmMemory"]) {
  wasmMemory = Module["wasmMemory"];
 } else {
  wasmMemory = new WebAssembly.Memory({
   "initial": INITIAL_MEMORY / 65536,
   "maximum": INITIAL_MEMORY / 65536,
   "shared": true
  });
  if (!(wasmMemory.buffer instanceof SharedArrayBuffer)) {
   err("requested a shared WebAssembly.Memory but the returned buffer is not a SharedArrayBuffer, indicating that while the browser has SharedArrayBuffer it does not have WebAssembly threads support - you may need to set a flag");
   if (ENVIRONMENT_IS_NODE) {
    err("(on node you may need: --experimental-wasm-threads --experimental-wasm-bulk-memory and/or recent version)");
   }
   throw Error("bad memory");
  }
 }
}

updateMemoryViews();

INITIAL_MEMORY = wasmMemory.buffer.byteLength;

var __ATPRERUN__ = [];

var __ATINIT__ = [];

var __ATMAIN__ = [];

var __ATEXIT__ = [];

var __ATPOSTRUN__ = [];

var runtimeInitialized = false;

function preRun() {
 if (Module["preRun"]) {
  if (typeof Module["preRun"] == "function") Module["preRun"] = [ Module["preRun"] ];
  while (Module["preRun"].length) {
   addOnPreRun(Module["preRun"].shift());
  }
 }
 callRuntimeCallbacks(__ATPRERUN__);
}

function initRuntime() {
 runtimeInitialized = true;
 if (ENVIRONMENT_IS_PTHREAD) return;
 callRuntimeCallbacks(__ATINIT__);
}

function preMain() {
 if (ENVIRONMENT_IS_PTHREAD) return;
 callRuntimeCallbacks(__ATMAIN__);
}

function postRun() {
 if (ENVIRONMENT_IS_PTHREAD) return;
 if (Module["postRun"]) {
  if (typeof Module["postRun"] == "function") Module["postRun"] = [ Module["postRun"] ];
  while (Module["postRun"].length) {
   addOnPostRun(Module["postRun"].shift());
  }
 }
 callRuntimeCallbacks(__ATPOSTRUN__);
}

function addOnPreRun(cb) {
 __ATPRERUN__.unshift(cb);
}

function addOnInit(cb) {
 __ATINIT__.unshift(cb);
}

function addOnPreMain(cb) {
 __ATMAIN__.unshift(cb);
}

function addOnExit(cb) {}

function addOnPostRun(cb) {
 __ATPOSTRUN__.unshift(cb);
}

var runDependencies = 0;

var runDependencyWatcher = null;

var dependenciesFulfilled = null;

function getUniqueRunDependency(id) {
 return id;
}

function addRunDependency(id) {
 runDependencies++;
 if (Module["monitorRunDependencies"]) {
  Module["monitorRunDependencies"](runDependencies);
 }
}

function removeRunDependency(id) {
 runDependencies--;
 if (Module["monitorRunDependencies"]) {
  Module["monitorRunDependencies"](runDependencies);
 }
 if (runDependencies == 0) {
  if (runDependencyWatcher !== null) {
   clearInterval(runDependencyWatcher);
   runDependencyWatcher = null;
  }
  if (dependenciesFulfilled) {
   var callback = dependenciesFulfilled;
   dependenciesFulfilled = null;
   callback();
  }
 }
}

/** @param {string|number=} what */ function abort(what) {
 if (Module["onAbort"]) {
  Module["onAbort"](what);
 }
 what = "Aborted(" + what + ")";
 err(what);
 ABORT = true;
 EXITSTATUS = 1;
 what += ". Build with -sASSERTIONS for more info.";
 /** @suppress {checkTypes} */ var e = new WebAssembly.RuntimeError(what);
 readyPromiseReject(e);
 throw e;
}

var dataURIPrefix = "data:application/octet-stream;base64,";

/**
 * Indicates whether filename is a base64 data URI.
 * @noinline
 */ var isDataURI = filename => filename.startsWith(dataURIPrefix);

/**
 * Indicates whether filename is delivered via file protocol (as opposed to http/https)
 * @noinline
 */ var isFileURI = filename => filename.startsWith("file://");

var wasmBinaryFile;

if (Module["locateFile"]) {
 wasmBinaryFile = "qemu-system-x86_64.wasm";
 if (!isDataURI(wasmBinaryFile)) {
  wasmBinaryFile = locateFile(wasmBinaryFile);
 }
} else {
 wasmBinaryFile = new URL("qemu-system-x86_64.wasm", import.meta.url).href;
}

function getBinarySync(file) {
 if (file == wasmBinaryFile && wasmBinary) {
  return new Uint8Array(wasmBinary);
 }
 if (readBinary) {
  return readBinary(file);
 }
 throw "both async and sync fetching of the wasm failed";
}

function getBinaryPromise(binaryFile) {
 if (!wasmBinary && (ENVIRONMENT_IS_WEB || ENVIRONMENT_IS_WORKER)) {
  if (typeof fetch == "function" && !isFileURI(binaryFile)) {
   return fetch(binaryFile, {
    credentials: "same-origin"
   }).then(response => {
    if (!response["ok"]) {
     throw "failed to load wasm binary file at '" + binaryFile + "'";
    }
    return response["arrayBuffer"]();
   }).catch(() => getBinarySync(binaryFile));
  } else if (readAsync) {
   return new Promise((resolve, reject) => {
    readAsync(binaryFile, response => resolve(new Uint8Array(/** @type{!ArrayBuffer} */ (response))), reject);
   });
  }
 }
 return Promise.resolve().then(() => getBinarySync(binaryFile));
}

function instantiateArrayBuffer(binaryFile, imports, receiver) {
 return getBinaryPromise(binaryFile).then(binary => WebAssembly.instantiate(binary, imports)).then(instance => instance).then(receiver, reason => {
  err(`failed to asynchronously prepare wasm: ${reason}`);
  abort(reason);
 });
}

function instantiateAsync(binary, binaryFile, imports, callback) {
 if (!binary && typeof WebAssembly.instantiateStreaming == "function" && !isDataURI(binaryFile) &&  !isFileURI(binaryFile) &&  !ENVIRONMENT_IS_NODE && typeof fetch == "function") {
  return fetch(binaryFile, {
   credentials: "same-origin"
  }).then(response => {
   /** @suppress {checkTypes} */ var result = WebAssembly.instantiateStreaming(response, imports);
   return result.then(callback, function(reason) {
    err(`wasm streaming compile failed: ${reason}`);
    err("falling back to ArrayBuffer instantiation");
    return instantiateArrayBuffer(binaryFile, imports, callback);
   });
  });
 }
 return instantiateArrayBuffer(binaryFile, imports, callback);
}

function createWasm() {
 var info = {
  "env": wasmImports,
  "wasi_snapshot_preview1": wasmImports
 };
 /** @param {WebAssembly.Module=} module*/ function receiveInstance(instance, module) {
  wasmExports = instance.exports;
  wasmExports = Asyncify.instrumentWasmExports(wasmExports);
  wasmExports = applySignatureConversions(wasmExports);
  registerTLSInit(wasmExports["_emscripten_tls_init"]);
  wasmTable = wasmExports["__indirect_function_table"];
  addOnInit(wasmExports["__wasm_call_ctors"]);
  wasmModule = module;
  removeRunDependency("wasm-instantiate");
  return wasmExports;
 }
 addRunDependency("wasm-instantiate");
 function receiveInstantiationResult(result) {
  receiveInstance(result["instance"], result["module"]);
 }
 if (Module["instantiateWasm"]) {
  try {
   return Module["instantiateWasm"](info, receiveInstance);
  } catch (e) {
   err(`Module.instantiateWasm callback failed with error: ${e}`);
   readyPromiseReject(e);
  }
 }
 instantiateAsync(wasmBinary, wasmBinaryFile, info, receiveInstantiationResult).catch(readyPromiseReject);
 return {};
}

function nebulahv_canvas_resize(width, height) {
 if (Module.nebulahvDisplayResize) {
  Module.nebulahvDisplayResize(width, height);
 }
}

function nebulahv_canvas_update(pixels, width, height, stride, x, y, update_width, update_height) {
 if (Module.nebulahvDisplayUpdate) {
  Module.nebulahvDisplayUpdate(pixels, width, height, stride, x, y, update_width, update_height);
 }
}

function instantiate_wasm() {
 const memory_v = new DataView(HEAP8.buffer);
 const tb_ptr = memory_v.getInt32(Module.__wasm32_tb.tb_ptr_ptr, true);
 const export_vec_size = memory_v.getInt32(tb_ptr + 4, true);
 const export_vec_begin = tb_ptr + 4 + 4;
 const counter_vec_size = memory_v.getInt32(export_vec_begin + export_vec_size, true);
 const counter_vec_begin = export_vec_begin + export_vec_size + 4;
 const tmp_body_size = memory_v.getInt32(counter_vec_begin + counter_vec_size, true);
 const tmp_body_begin = counter_vec_begin + counter_vec_size + 4;
 const wasm_size = memory_v.getInt32(tmp_body_begin + tmp_body_size, true);
 const wasm_begin = tmp_body_begin + tmp_body_size + 4;
 const import_vec_size = memory_v.getInt32(wasm_begin + wasm_size, true);
 const import_vec_begin = wasm_begin + wasm_size + 4;
 const wasmBytes = new Uint8Array(HEAP8.slice(wasm_begin, wasm_begin + wasm_size));
 var helper = {};
 for (let i = 0; i < import_vec_size / 4; i++) {
  const target = wasmTable.get(memory_v.getInt32(import_vec_begin + i * 4, true));
  helper[i] = (...args) => {
   let converted = args;
   for (let attempt = 0; attempt <= args.length; attempt++) {
    try {
     return target(...converted);
    } catch (error) {
     const match = /Cannot convert (-?[0-9]+) to a BigInt/.exec(String(error && error.message ? error.message : error));
     if (!match) {
      throw error;
     }
     const value = Number(match[1]);
     const argumentIndex = converted.findIndex(argument => argument === value);
     if (argumentIndex < 0) {
      throw error;
     }
     converted = converted.slice();
     converted[argumentIndex] = BigInt(value);
    }
   }
   throw new TypeError("Unable to bridge QEMU helper integer arguments");
  };
 }
 const mod = new WebAssembly.Module(wasmBytes);
 const inst = new WebAssembly.Instance(mod, {
  "env": {
   "buffer": wasmMemory
  },
  "helper": helper
 });
 Module.__wasm32_tb.inst_gc_registry.register(inst, "instance");
 const fidx = addFunction(inst.exports.start, "ii");
 return fidx;
}

function remove_module_js() {
 const memory_v = new DataView(HEAP8.buffer);
 const remove_n = memory_v.getInt32(Module.__wasm32_tb.to_remove_instance_idx_ptr, true);
 for (var i = 0; i < remove_n * 4; i += 4) {
  removeFunction(memory_v.getInt32(Module.__wasm32_tb.to_remove_instance_ptr + i, true));
 }
 memory_v.setInt32(Module.__wasm32_tb.to_remove_instance_idx_ptr, 0, true);
}

function init_wasm32_js(tb_ptr_ptr, cur_core_num, to_remove_instance_ptr, to_remove_instance_idx_ptr, instance_garbage_collected_ptr) {
 Module.__wasm32_tb = {
  tb_ptr_ptr: tb_ptr_ptr,
  cur_core_num: cur_core_num,
  to_remove_instance_ptr: to_remove_instance_ptr,
  to_remove_instance_idx_ptr: to_remove_instance_idx_ptr,
  instance_garbage_collected_ptr: instance_garbage_collected_ptr,
  inst_gc_registry: new FinalizationRegistry(i => {
   if (i == "instance") {
    const memory_v = new DataView(HEAP8.buffer);
    let v = memory_v.getInt32(Module.__wasm32_tb.instance_garbage_collected_ptr, true);
    memory_v.setInt32(Module.__wasm32_tb.instance_garbage_collected_ptr, v + 1, true);
   }
  })
 };
}

function unbox_small_structs(type_ptr) {
 var type_id = HEAPU16[(type_ptr + 6 >> 1) + 0 >>> 0];
 while (type_id === 13) {
  var elements = HEAPU32[(type_ptr + 8 >> 2) + 0 >>> 0];
  var first_element = HEAPU32[(elements >> 2) + 0 >>> 0];
  if (first_element === 0) {
   type_id = 0;
   break;
  } else if (HEAPU32[(elements >> 2) + 1 >>> 0] === 0) {
   type_ptr = first_element;
   type_id = HEAPU16[(first_element + 6 >> 1) + 0 >>> 0];
  } else {
   break;
  }
 }
 return [ type_ptr, type_id ];
}

function ffi_call_js(cif, fn, rvalue, avalue) {
 var abi = HEAPU32[(cif >> 2) + 0 >>> 0];
 var nargs = HEAPU32[(cif >> 2) + 1 >>> 0];
 var nfixedargs = HEAPU32[(cif >> 2) + 6 >>> 0];
 var arg_types_ptr = HEAPU32[(cif >> 2) + 2 >>> 0];
 var rtype_unboxed = unbox_small_structs(HEAPU32[(cif >> 2) + 3 >>> 0]);
 var rtype_ptr = rtype_unboxed[0];
 var rtype_id = rtype_unboxed[1];
 var orig_stack_ptr = stackSave();
 var cur_stack_ptr = orig_stack_ptr;
 var args = [];
 var ret_by_arg = false;
 if (rtype_id === 15) {
  throw new Error("complex ret marshalling nyi");
 }
 if (rtype_id < 0 || rtype_id > 15) {
  throw new Error("Unexpected rtype " + rtype_id);
 }
 if (rtype_id === 4 || rtype_id === 13) {
  args.push(rvalue);
  ret_by_arg = true;
 }
 for (var i = 0; i < nfixedargs; i++) {
  var arg_ptr = HEAPU32[(avalue >> 2) + i >>> 0];
  var arg_unboxed = unbox_small_structs(HEAPU32[(arg_types_ptr >> 2) + i >>> 0]);
  var arg_type_ptr = arg_unboxed[0];
  var arg_type_id = arg_unboxed[1];
  switch (arg_type_id) {
  case 1:
  case 10:
  case 9:
  case 14:
   args.push(HEAPU32[(arg_ptr >> 2) + 0 >>> 0]);
   ;
   break;

  case 2:
   args.push(HEAPF32[(arg_ptr >> 2) + 0 >>> 0]);
   ;
   break;

  case 3:
   args.push(HEAPF64[(arg_ptr >> 3) + 0 >>> 0]);
   ;
   break;

  case 5:
   args.push(HEAPU8[arg_ptr + 0 >>> 0]);
   ;
   break;

  case 6:
   args.push(HEAP8[arg_ptr + 0 >>> 0]);
   ;
   break;

  case 7:
   args.push(HEAPU16[(arg_ptr >> 1) + 0 >>> 0]);
   ;
   break;

  case 8:
   args.push(HEAP16[(arg_ptr >> 1) + 0 >>> 0]);
   ;
   break;

  case 11:
  case 12:
   args.push(HEAPU64[(arg_ptr >> 3) + 0]);
   ;
   break;

  case 4:
   args.push(HEAPU64[(arg_ptr >> 3) + 0]);
   args.push(HEAPU64[(arg_ptr >> 3) + 1]);
   ;
   break;

  case 13:
   var size = HEAPU32[(arg_type_ptr >> 2) + 0 >>> 0];
   var align = HEAPU16[(arg_type_ptr + 4 >> 1) + 0 >>> 0];
   ((cur_stack_ptr -= (size)), (cur_stack_ptr &= (~((align) - 1))));
   HEAP8.subarray(cur_stack_ptr >>> 0, cur_stack_ptr + size >>> 0).set(HEAP8.subarray(arg_ptr >>> 0, arg_ptr + size >>> 0));
   args.push(cur_stack_ptr);
   ;
   break;

  case 15:
   throw new Error("complex marshalling nyi");

  default:
   throw new Error("Unexpected type " + arg_type_id);
  }
 }
 if (nfixedargs != nargs) {
  var struct_arg_info = [];
  for (var i = nargs - 1; i >= nfixedargs; i--) {
   var arg_ptr = HEAPU32[(avalue >> 2) + i >>> 0];
   var arg_unboxed = unbox_small_structs(HEAPU32[(arg_types_ptr >> 2) + i >>> 0]);
   var arg_type_ptr = arg_unboxed[0];
   var arg_type_id = arg_unboxed[1];
   switch (arg_type_id) {
   case 5:
   case 6:
    ((cur_stack_ptr -= (1)), (cur_stack_ptr &= (~((1) - 1))));
    HEAPU8[cur_stack_ptr + 0 >>> 0] = HEAPU8[arg_ptr + 0 >>> 0];
    break;

   case 7:
   case 8:
    ((cur_stack_ptr -= (2)), (cur_stack_ptr &= (~((2) - 1))));
    HEAPU16[(cur_stack_ptr >> 1) + 0 >>> 0] = HEAPU16[(arg_ptr >> 1) + 0 >>> 0];
    break;

   case 1:
   case 9:
   case 10:
   case 14:
   case 2:
    ((cur_stack_ptr -= (4)), (cur_stack_ptr &= (~((4) - 1))));
    HEAPU32[(cur_stack_ptr >> 2) + 0 >>> 0] = HEAPU32[(arg_ptr >> 2) + 0 >>> 0];
    break;

   case 3:
   case 11:
   case 12:
    ((cur_stack_ptr -= (8)), (cur_stack_ptr &= (~((8) - 1))));
    HEAPU32[(cur_stack_ptr >> 2) + 0 >>> 0] = HEAPU32[(arg_ptr >> 2) + 0 >>> 0];
    HEAPU32[(cur_stack_ptr >> 2) + 1 >>> 0] = HEAPU32[(arg_ptr >> 2) + 1 >>> 0];
    break;

   case 4:
    ((cur_stack_ptr -= (16)), (cur_stack_ptr &= (~((8) - 1))));
    HEAPU32[(cur_stack_ptr >> 2) + 0 >>> 0] = HEAPU32[(arg_ptr >> 2) + 0 >>> 0];
    HEAPU32[(cur_stack_ptr >> 2) + 1 >>> 0] = HEAPU32[(arg_ptr >> 2) + 1 >>> 0];
    HEAPU32[(cur_stack_ptr >> 2) + 2 >>> 0] = HEAPU32[(arg_ptr >> 2) + 2 >>> 0];
    HEAPU32[(cur_stack_ptr >> 2) + 3 >>> 0] = HEAPU32[(arg_ptr >> 2) + 3 >>> 0];
    break;

   case 13:
    ((cur_stack_ptr -= (4)), (cur_stack_ptr &= (~((4) - 1))));
    struct_arg_info.push([ cur_stack_ptr, arg_ptr, HEAPU32[(arg_type_ptr >> 2) + 0 >>> 0], HEAPU16[(arg_type_ptr + 4 >> 1) + 0 >>> 0] ]);
    break;

   case 15:
    throw new Error("complex arg marshalling nyi");

   default:
    throw new Error("Unexpected argtype " + arg_type_id);
   }
  }
  args.push(cur_stack_ptr);
  for (var i = 0; i < struct_arg_info.length; i++) {
   var struct_info = struct_arg_info[i];
   var arg_target = struct_info[0];
   var arg_ptr = struct_info[1];
   var size = struct_info[2];
   var align = struct_info[3];
   ((cur_stack_ptr -= (size)), (cur_stack_ptr &= (~((align) - 1))));
   HEAP8.subarray(cur_stack_ptr >>> 0, cur_stack_ptr + size >>> 0).set(HEAP8.subarray(arg_ptr >>> 0, arg_ptr + size >>> 0));
   HEAPU32[(arg_target >> 2) + 0 >>> 0] = cur_stack_ptr;
  }
 }
 stackRestore(cur_stack_ptr);
 stackAlloc(0);
 var target = getWasmTableEntry(fn);
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
var result = invokeWithWasmIntegers(args, 0);
 stackRestore(orig_stack_ptr);
 if (ret_by_arg) {
  return;
 }
 switch (rtype_id) {
 case 0:
  break;

 case 1:
 case 9:
 case 10:
 case 14:
  HEAPU32[(rvalue >> 2) + 0 >>> 0] = Number(result);
  break;

 case 2:
  HEAPF32[(rvalue >> 2) + 0 >>> 0] = Number(result);
  break;

 case 3:
  HEAPF64[(rvalue >> 3) + 0 >>> 0] = Number(result);
  break;

 case 5:
 case 6:
  HEAPU8[rvalue + 0 >>> 0] = Number(result);
  break;

 case 7:
 case 8:
  HEAPU16[(rvalue >> 1) + 0 >>> 0] = Number(result);
  break;

 case 11:
 case 12:
  HEAPU64[(rvalue >> 3) + 0] = typeof result === 'bigint' ? result : BigInt(result);
  break;

 case 15:
  throw new Error("complex ret marshalling nyi");

 default:
  throw new Error("Unexpected rtype " + rtype_id);
 }
}

function ffi_closure_alloc_js(size, code) {
 var closure = _malloc(size);
 var index = getEmptyTableSlot();
 HEAPU32[(code >> 2) + 0 >>> 0] = index;
 HEAPU32[(closure >> 2) + 0 >>> 0] = index;
 return closure;
}

function ffi_closure_free_js(closure) {
 var index = HEAPU32[(closure >> 2) + 0 >>> 0];
 freeTableIndexes.push(index);
 _free(closure);
}

function ffi_prep_closure_loc_js(closure, cif, fun, user_data, codeloc) {
 var abi = HEAPU32[(cif >> 2) + 0 >>> 0];
 var nargs = HEAPU32[(cif >> 2) + 1 >>> 0];
 var nfixedargs = HEAPU32[(cif >> 2) + 6 >>> 0];
 var arg_types_ptr = HEAPU32[(cif >> 2) + 2 >>> 0];
 var rtype_unboxed = unbox_small_structs(HEAPU32[(cif >> 2) + 3 >>> 0]);
 var rtype_ptr = rtype_unboxed[0];
 var rtype_id = rtype_unboxed[1];
 var sig;
 var ret_by_arg = false;
 switch (rtype_id) {
 case 0:
  sig = "v";
  break;

 case 13:
 case 4:
  sig = "vi";
  ret_by_arg = true;
  break;

 case 1:
 case 5:
 case 6:
 case 7:
 case 8:
 case 9:
 case 10:
 case 14:
  sig = "i";
  break;

 case 2:
  sig = "f";
  break;

 case 3:
  sig = "d";
  break;

 case 11:
 case 12:
  sig = "j";
  break;

 case 15:
  throw new Error("complex ret marshalling nyi");

 default:
  throw new Error("Unexpected rtype " + rtype_id);
 }
 var unboxed_arg_type_id_list = [];
 var unboxed_arg_type_info_list = [];
 for (var i = 0; i < nargs; i++) {
  var arg_unboxed = unbox_small_structs(HEAPU32[(arg_types_ptr >> 2) + i >>> 0]);
  var arg_type_ptr = arg_unboxed[0];
  var arg_type_id = arg_unboxed[1];
  unboxed_arg_type_id_list.push(arg_type_id);
  unboxed_arg_type_info_list.push([ HEAPU32[(arg_type_ptr >> 2) + 0 >>> 0], HEAPU16[(arg_type_ptr + 4 >> 1) + 0 >>> 0] ]);
 }
 for (var i = 0; i < nfixedargs; i++) {
  switch (unboxed_arg_type_id_list[i]) {
  case 1:
  case 5:
  case 6:
  case 7:
  case 8:
  case 9:
  case 10:
  case 14:
  case 13:
   sig += "i";
   break;

  case 2:
   sig += "f";
   break;

  case 3:
   sig += "d";
   break;

  case 4:
   sig += "jj";
   break;

  case 11:
  case 12:
   sig += "j";
   break;

  case 15:
   throw new Error("complex marshalling nyi");

  default:
   throw new Error("Unexpected argtype " + arg_type_id);
  }
 }
 if (nfixedargs < nargs) {
  sig += "i";
 }
 0;
 function trampoline() {
  var args = Array.prototype.slice.call(arguments);
  var size = 0;
  var orig_stack_ptr = stackSave();
  var cur_ptr = orig_stack_ptr;
  var ret_ptr;
  var jsarg_idx = 0;
  if (ret_by_arg) {
   ret_ptr = args[jsarg_idx++];
  } else {
   ((cur_ptr -= (8)), (cur_ptr &= (~((8) - 1))));
   ret_ptr = cur_ptr;
  }
  cur_ptr -= 4 * nargs;
  var args_ptr = cur_ptr;
  var carg_idx = 0;
  for (;carg_idx < nfixedargs; carg_idx++) {
   var cur_arg = args[jsarg_idx++];
   var arg_type_info = unboxed_arg_type_info_list[carg_idx];
   var arg_size = arg_type_info[0];
   var arg_align = arg_type_info[1];
   var arg_type_id = unboxed_arg_type_id_list[carg_idx];
   switch (arg_type_id) {
   case 5:
   case 6:
    ((cur_ptr -= (1)), (cur_ptr &= (~((4) - 1))));
    HEAPU32[(args_ptr >> 2) + carg_idx >>> 0] = cur_ptr;
    HEAPU8[cur_ptr + 0 >>> 0] = cur_arg;
    break;

   case 7:
   case 8:
    ((cur_ptr -= (2)), (cur_ptr &= (~((4) - 1))));
    HEAPU32[(args_ptr >> 2) + carg_idx >>> 0] = cur_ptr;
    HEAPU16[(cur_ptr >> 1) + 0 >>> 0] = cur_arg;
    break;

   case 1:
   case 9:
   case 10:
   case 14:
    ((cur_ptr -= (4)), (cur_ptr &= (~((4) - 1))));
    HEAPU32[(args_ptr >> 2) + carg_idx >>> 0] = cur_ptr;
    HEAPU32[(cur_ptr >> 2) + 0 >>> 0] = cur_arg;
    break;

   case 13:
    ((cur_ptr -= (arg_size)), (cur_ptr &= (~((arg_align) - 1))));
    HEAP8.subarray(cur_ptr >>> 0, cur_ptr + arg_size >>> 0).set(HEAP8.subarray(cur_arg >>> 0, cur_arg + arg_size >>> 0));
    HEAPU32[(args_ptr >> 2) + carg_idx >>> 0] = cur_ptr;
    break;

   case 2:
    ((cur_ptr -= (4)), (cur_ptr &= (~((4) - 1))));
    HEAPU32[(args_ptr >> 2) + carg_idx >>> 0] = cur_ptr;
    HEAPF32[(cur_ptr >> 2) + 0 >>> 0] = cur_arg;
    break;

   case 3:
    ((cur_ptr -= (8)), (cur_ptr &= (~((8) - 1))));
    HEAPU32[(args_ptr >> 2) + carg_idx >>> 0] = cur_ptr;
    HEAPF64[(cur_ptr >> 3) + 0 >>> 0] = cur_arg;
    break;

   case 11:
   case 12:
    ((cur_ptr -= (8)), (cur_ptr &= (~((8) - 1))));
    HEAPU32[(args_ptr >> 2) + carg_idx >>> 0] = cur_ptr;
    HEAPU64[(cur_ptr >> 3) + 0] = cur_arg;
    break;

   case 4:
    ((cur_ptr -= (16)), (cur_ptr &= (~((8) - 1))));
    HEAPU32[(args_ptr >> 2) + carg_idx >>> 0] = cur_ptr;
    HEAPU64[(cur_ptr >> 3) + 0] = cur_arg;
    cur_arg = args[jsarg_idx++];
    HEAPU64[(cur_ptr >> 3) + 1] = cur_arg;
    break;
   }
  }
  var varargs = args[args.length - 1];
  for (;carg_idx < nargs; carg_idx++) {
   var arg_type_id = unboxed_arg_type_id_list[carg_idx];
   var arg_type_info = unboxed_arg_type_info_list[carg_idx];
   var arg_size = arg_type_info[0];
   var arg_align = arg_type_info[1];
   if (arg_type_id === 13) {
    var struct_ptr = HEAPU32[(varargs >> 2) + 0 >>> 0];
    ((cur_ptr -= (arg_size)), (cur_ptr &= (~((arg_align) - 1))));
    HEAP8.subarray(cur_ptr >>> 0, cur_ptr + arg_size >>> 0).set(HEAP8.subarray(struct_ptr >>> 0, struct_ptr + arg_size >>> 0));
    HEAPU32[(args_ptr >> 2) + carg_idx >>> 0] = cur_ptr;
   } else {
    HEAPU32[(args_ptr >> 2) + carg_idx >>> 0] = varargs;
   }
   varargs += 4;
  }
  stackRestore(cur_ptr);
  stackAlloc(0);
  0;
  getWasmTableEntry(HEAPU32[(closure >> 2) + 2 >>> 0])(HEAPU32[(closure >> 2) + 1 >>> 0], ret_ptr, args_ptr, HEAPU32[(closure >> 2) + 3 >>> 0]);
  stackRestore(orig_stack_ptr);
  if (!ret_by_arg) {
   switch (sig[0]) {
   case "i":
    return HEAPU32[(ret_ptr >> 2) + 0 >>> 0];

   case "j":
    return HEAPU64[(ret_ptr >> 3) + 0];

   case "d":
    return HEAPF64[(ret_ptr >> 3) + 0 >>> 0];

   case "f":
    return HEAPF32[(ret_ptr >> 2) + 0 >>> 0];
   }
  }
 }
 try {
  var wasm_trampoline = convertJsFunctionToWasm(trampoline, sig);
 } catch (e) {
  return 1;
 }
 setWasmTableEntry(codeloc, wasm_trampoline);
 HEAPU32[(closure >> 2) + 1 >>> 0] = cif;
 HEAPU32[(closure >> 2) + 2 >>> 0] = fun;
 HEAPU32[(closure >> 2) + 3 >>> 0] = user_data;
 return 0;
}

/** @constructor */ function ExitStatus(status) {
 this.name = "ExitStatus";
 this.message = `Program terminated with exit(${status})`;
 this.status = status;
}

var terminateWorker = worker => {
 worker.terminate();
 worker.onmessage = e => {};
};

var killThread = pthread_ptr => {
 var worker = PThread.pthreads[pthread_ptr];
 delete PThread.pthreads[pthread_ptr];
 terminateWorker(worker);
 __emscripten_thread_free_data(pthread_ptr);
 PThread.runningWorkers.splice(PThread.runningWorkers.indexOf(worker), 1);
 worker.pthread_ptr = 0;
};

var cancelThread = pthread_ptr => {
 var worker = PThread.pthreads[pthread_ptr];
 worker.postMessage({
  "cmd": "cancel"
 });
};

var cleanupThread = pthread_ptr => {
 var worker = PThread.pthreads[pthread_ptr];
 PThread.returnWorkerToPool(worker);
};

var zeroMemory = (address, size) => {
 HEAPU8.fill(0, address, address + size);
 return address;
};

var spawnThread = threadParams => {
 var worker = PThread.getNewWorker();
 if (!worker) {
  return 6;
 }
 PThread.runningWorkers.push(worker);
 PThread.pthreads[threadParams.pthread_ptr] = worker;
 worker.pthread_ptr = threadParams.pthread_ptr;
 var msg = {
  "cmd": "run",
  "start_routine": threadParams.startRoutine,
  "arg": threadParams.arg,
  "pthread_ptr": threadParams.pthread_ptr
 };
 if (ENVIRONMENT_IS_NODE) {
  worker.unref();
 }
 worker.postMessage(msg, threadParams.transferList);
 return 0;
};

var runtimeKeepaliveCounter = 0;

var keepRuntimeAlive = () => noExitRuntime || runtimeKeepaliveCounter > 0;

var withStackSave = f => {
 var stack = stackSave();
 var ret = f();
 stackRestore(stack);
 return ret;
};

var MAX_INT53 = 9007199254740992;

var MIN_INT53 = -9007199254740992;

var bigintToI53Checked = num => (num < MIN_INT53 || num > MAX_INT53) ? NaN : Number(num);

/** @type{function(number, (number|boolean), ...(number|boolean))} */ var proxyToMainThread = function(index, sync) {
 var numCallArgs = arguments.length - 2;
 var outerArgs = arguments;
 return withStackSave(() => {
  var serializedNumCallArgs = numCallArgs * 2;
  var args = stackAlloc(serializedNumCallArgs * 8);
  var b = ((args) >>> 3);
  for (var i = 0; i < numCallArgs; i++) {
   var arg = outerArgs[2 + i];
   if (typeof arg == "bigint") {
    HEAP64[b + 2 * i] = 1n;
    HEAP64[b + 2 * i + 1] = arg;
   } else {
    HEAP64[b + 2 * i] = 0n;
    HEAPF64[b + 2 * i + 1 >>> 0] = arg;
   }
  }
  return __emscripten_run_on_main_thread_js(index, serializedNumCallArgs, args, sync);
 });
};

function _proc_exit(code) {
 if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(0, 1, code);
 EXITSTATUS = code;
 if (!keepRuntimeAlive()) {
  PThread.terminateAllThreads();
  if (Module["onExit"]) Module["onExit"](code);
  ABORT = true;
 }
 quit_(code, new ExitStatus(code));
}

/** @param {boolean|number=} implicit */ var exitJS = (status, implicit) => {
 EXITSTATUS = status;
 if (ENVIRONMENT_IS_PTHREAD) {
  exitOnMainThread(status);
  throw "unwind";
 }
 _proc_exit(status);
};

var _exit = exitJS;

var handleException = e => {
 if (e instanceof ExitStatus || e == "unwind") {
  return EXITSTATUS;
 }
 quit_(1, e);
};

var PThread = {
 unusedWorkers: [],
 runningWorkers: [],
 tlsInitFunctions: [],
 pthreads: {},
 init() {
  if (ENVIRONMENT_IS_PTHREAD) {
   PThread.initWorker();
  } else {
   PThread.initMainThread();
  }
 },
 initMainThread() {
  var pthreadPoolSize = 4;
  while (pthreadPoolSize--) {
   PThread.allocateUnusedWorker();
  }
  addOnPreRun(() => {
   addRunDependency("loading-workers");
   PThread.loadWasmModuleToAllWorkers(() => removeRunDependency("loading-workers"));
  });
 },
 initWorker() {
  PThread["receiveObjectTransfer"] = PThread.receiveObjectTransfer;
  PThread["threadInitTLS"] = PThread.threadInitTLS;
  PThread["setExitStatus"] = PThread.setExitStatus;
  noExitRuntime = false;
 },
 setExitStatus: status => {
  EXITSTATUS = status;
 },
 terminateAllThreads__deps: [ "$terminateWorker" ],
 terminateAllThreads: () => {
  for (var worker of PThread.runningWorkers) {
   terminateWorker(worker);
  }
  for (var worker of PThread.unusedWorkers) {
   terminateWorker(worker);
  }
  PThread.unusedWorkers = [];
  PThread.runningWorkers = [];
  PThread.pthreads = [];
 },
 returnWorkerToPool: worker => {
  var pthread_ptr = worker.pthread_ptr;
  delete PThread.pthreads[pthread_ptr];
  PThread.unusedWorkers.push(worker);
  PThread.runningWorkers.splice(PThread.runningWorkers.indexOf(worker), 1);
  worker.pthread_ptr = 0;
  if (ENVIRONMENT_IS_NODE) {
   worker.unref();
  }
  __emscripten_thread_free_data(pthread_ptr);
 },
 receiveObjectTransfer(data) {},
 threadInitTLS() {
  PThread.tlsInitFunctions.forEach(f => f());
 },
 loadWasmModuleToWorker: worker => new Promise(onFinishedLoading => {
  worker.onmessage = e => {
   var d = e["data"];
   var cmd = d["cmd"];
   if (d["targetThread"] && d["targetThread"] != _pthread_self()) {
    var targetWorker = PThread.pthreads[d["targetThread"]];
    if (targetWorker) {
     targetWorker.postMessage(d, d["transferList"]);
    } else {
     err(`Internal error! Worker sent a message "${cmd}" to target pthread ${d["targetThread"]}, but that thread no longer exists!`);
    }
    return;
   }
   if (cmd === "checkMailbox") {
    checkMailbox();
   } else if (cmd === "spawnThread") {
    spawnThread(d);
   } else if (cmd === "cleanupThread") {
    cleanupThread(d["thread"]);
   } else if (cmd === "killThread") {
    killThread(d["thread"]);
   } else if (cmd === "cancelThread") {
    cancelThread(d["thread"]);
   } else if (cmd === "loaded") {
    worker.loaded = true;
    if (ENVIRONMENT_IS_NODE && !worker.pthread_ptr) {
     worker.unref();
    }
    onFinishedLoading(worker);
   } else if (cmd === "alert") {
    alert(`Thread ${d["threadId"]}: ${d["text"]}`);
   } else if (d.target === "setimmediate") {
    worker.postMessage(d);
   } else if (cmd === "callHandler") {
    Module[d["handler"]](...d["args"]);
   } else if (cmd) {
    err(`worker sent an unknown command ${cmd}`);
   }
  };
  worker.onerror = e => {
   var message = "worker sent an error!";
   err(`${message} ${e.filename}:${e.lineno}: ${e.message}`);
   throw e;
  };
  if (ENVIRONMENT_IS_NODE) {
   worker.on("message", data => worker.onmessage({
    data: data
   }));
   worker.on("error", e => worker.onerror(e));
  }
  var handlers = [];
  var knownHandlers = [ "onExit", "onAbort", "print", "printErr" ];
  for (var handler of knownHandlers) {
   if (Module.hasOwnProperty(handler)) {
    handlers.push(handler);
   }
  }
  worker.postMessage({
   "cmd": "load",
   "handlers": handlers,
   "urlOrBlob": Module["mainScriptUrlOrBlob"],
   "wasmMemory": wasmMemory,
   "wasmModule": wasmModule
  });
 }),
 loadWasmModuleToAllWorkers(onMaybeReady) {
  if (ENVIRONMENT_IS_PTHREAD) {
   return onMaybeReady();
  }
  let pthreadPoolReady = Promise.all(PThread.unusedWorkers.map(PThread.loadWasmModuleToWorker));
  pthreadPoolReady.then(onMaybeReady);
 },
 allocateUnusedWorker() {
  var worker;
  if (!Module["locateFile"]) {
   worker = new Worker(new URL("qemu-system-x86_64.worker.js", import.meta.url), {
    type: "module"
   });
  } else {
   var pthreadMainJs = locateFile("qemu-system-x86_64.worker.js");
   worker = new Worker(pthreadMainJs, {
    type: "module"
   });
  }
  PThread.unusedWorkers.push(worker);
 },
 getNewWorker() {
  if (PThread.unusedWorkers.length == 0) {
   PThread.allocateUnusedWorker();
   PThread.loadWasmModuleToWorker(PThread.unusedWorkers[0]);
  }
  return PThread.unusedWorkers.pop();
 }
};

Module["PThread"] = PThread;

var callRuntimeCallbacks = callbacks => {
 while (callbacks.length > 0) {
  callbacks.shift()(Module);
 }
};

var establishStackSpace = () => {
 var pthread_ptr = _pthread_self();
 var stackHigh = HEAPU32[(((pthread_ptr) + (52)) >>> 2) >>> 0];
 var stackSize = HEAPU32[(((pthread_ptr) + (56)) >>> 2) >>> 0];
 var stackLow = stackHigh - stackSize;
 _emscripten_stack_set_limits(stackHigh, stackLow);
 stackRestore(stackHigh);
};

Module["establishStackSpace"] = establishStackSpace;

var runtimeKeepalivePop = () => {
 runtimeKeepaliveCounter -= 1;
};

function exitOnMainThread(returnCode) {
 if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(1, 0, returnCode);
 runtimeKeepalivePop();
 _exit(returnCode);
}

/**
     * @param {number} ptr
     * @param {string} type
     */ function getValue(ptr, type = "i8") {
 if (type.endsWith("*")) type = "*";
 switch (type) {
 case "i1":
  return HEAP8[((ptr) >>> 0) >>> 0];

 case "i8":
  return HEAP8[((ptr) >>> 0) >>> 0];

 case "i16":
  return HEAP16[((ptr) >>> 1) >>> 0];

 case "i32":
  return HEAP32[((ptr) >>> 2) >>> 0];

 case "i64":
  return HEAP64[((ptr) >>> 3)];

 case "float":
  return HEAPF32[((ptr) >>> 2) >>> 0];

 case "double":
  return HEAPF64[((ptr) >>> 3) >>> 0];

 case "*":
  return HEAPU32[((ptr) >>> 2) >>> 0];

 default:
  abort(`invalid type for getValue: ${type}`);
 }
}

var invokeEntryPoint = (ptr, arg) => {
 var result = (a1 => dynCall_ii.apply(null, [ ptr, a1 ]))(arg);
 function finish(result) {
  if (keepRuntimeAlive()) {
   PThread.setExitStatus(result);
  } else {
   __emscripten_thread_exit(result);
  }
 }
 finish(result);
};

Module["invokeEntryPoint"] = invokeEntryPoint;

var noExitRuntime = Module["noExitRuntime"] || true;

var registerTLSInit = tlsInitFunc => {
 PThread.tlsInitFunctions.push(tlsInitFunc);
};

var runtimeKeepalivePush = () => {
 runtimeKeepaliveCounter += 1;
};

/**
     * @param {number} ptr
     * @param {number} value
     * @param {string} type
     */ function setValue(ptr, value, type = "i8") {
 if (type.endsWith("*")) type = "*";
 switch (type) {
 case "i1":
  HEAP8[((ptr) >>> 0) >>> 0] = value;
  break;

 case "i8":
  HEAP8[((ptr) >>> 0) >>> 0] = value;
  break;

 case "i16":
  HEAP16[((ptr) >>> 1) >>> 0] = value;
  break;

 case "i32":
  HEAP32[((ptr) >>> 2) >>> 0] = value;
  break;

 case "i64":
  HEAP64[((ptr) >>> 3)] = BigInt(value);
  break;

 case "float":
  HEAPF32[((ptr) >>> 2) >>> 0] = value;
  break;

 case "double":
  HEAPF64[((ptr) >>> 3) >>> 0] = value;
  break;

 case "*":
  HEAPU32[((ptr) >>> 2) >>> 0] = value;
  break;

 default:
  abort(`invalid type for setValue: ${type}`);
 }
}

var UTF8Decoder = typeof TextDecoder != "undefined" ? new TextDecoder("utf8") : undefined;

/**
     * Given a pointer 'idx' to a null-terminated UTF8-encoded string in the given
     * array that contains uint8 values, returns a copy of that string as a
     * Javascript String object.
     * heapOrArray is either a regular array, or a JavaScript typed array view.
     * @param {number} idx
     * @param {number=} maxBytesToRead
     * @return {string}
     */ var UTF8ArrayToString = (heapOrArray, idx, maxBytesToRead) => {
 idx >>>= 0;
 var endIdx = idx + maxBytesToRead;
 var endPtr = idx;
 while (heapOrArray[endPtr] && !(endPtr >= endIdx)) ++endPtr;
 if (endPtr - idx > 16 && heapOrArray.buffer && UTF8Decoder) {
  return UTF8Decoder.decode(heapOrArray.buffer instanceof SharedArrayBuffer ? heapOrArray.slice(idx, endPtr) : heapOrArray.subarray(idx, endPtr));
 }
 var str = "";
 while (idx < endPtr) {
  var u0 = heapOrArray[idx++];
  if (!(u0 & 128)) {
   str += String.fromCharCode(u0);
   continue;
  }
  var u1 = heapOrArray[idx++] & 63;
  if ((u0 & 224) == 192) {
   str += String.fromCharCode(((u0 & 31) << 6) | u1);
   continue;
  }
  var u2 = heapOrArray[idx++] & 63;
  if ((u0 & 240) == 224) {
   u0 = ((u0 & 15) << 12) | (u1 << 6) | u2;
  } else {
   u0 = ((u0 & 7) << 18) | (u1 << 12) | (u2 << 6) | (heapOrArray[idx++] & 63);
  }
  if (u0 < 65536) {
   str += String.fromCharCode(u0);
  } else {
   var ch = u0 - 65536;
   str += String.fromCharCode(55296 | (ch >> 10), 56320 | (ch & 1023));
  }
 }
 return str;
};

/**
     * Given a pointer 'ptr' to a null-terminated UTF8-encoded string in the
     * emscripten HEAP, returns a copy of that string as a Javascript String object.
     *
     * @param {number} ptr
     * @param {number=} maxBytesToRead - An optional length that specifies the
     *   maximum number of bytes to read. You can omit this parameter to scan the
     *   string until the first 0 byte. If maxBytesToRead is passed, and the string
     *   at [ptr, ptr+maxBytesToReadr[ contains a null byte in the middle, then the
     *   string will cut short at that byte index (i.e. maxBytesToRead will not
     *   produce a string of exact length [ptr, ptr+maxBytesToRead[) N.B. mixing
     *   frequent uses of UTF8ToString() with and without maxBytesToRead may throw
     *   JS JIT optimizations off, so it is worth to consider consistently using one
     * @return {string}
     */ var UTF8ToString = (ptr, maxBytesToRead) => {
 ptr >>>= 0;
 return ptr ? UTF8ArrayToString(HEAPU8, ptr, maxBytesToRead) : "";
};

function ___assert_fail(condition, filename, line, func) {
 condition >>>= 0;
 filename >>>= 0;
 func >>>= 0;
 abort(`Assertion failed: ${UTF8ToString(condition)}, at: ` + [ filename ? UTF8ToString(filename) : "unknown filename", line, func ? UTF8ToString(func) : "unknown function" ]);
}

var ___call_sighandler = function(fp, sig) {
 fp >>>= 0;
 return (a1 => dynCall_vi.apply(null, [ fp, a1 ]))(sig);
};

function ___emscripten_init_main_thread_js(tb) {
 tb >>>= 0;
 __emscripten_thread_init(tb, /*is_main=*/ !ENVIRONMENT_IS_WORKER, /*is_runtime=*/ 1, /*can_block=*/ !ENVIRONMENT_IS_WEB, /*default_stacksize=*/ 65536, /*start_profiling=*/ false);
 PThread.threadInitTLS();
}

function ___emscripten_thread_cleanup(thread) {
 thread >>>= 0;
 if (!ENVIRONMENT_IS_PTHREAD) cleanupThread(thread); else postMessage({
  "cmd": "cleanupThread",
  "thread": thread
 });
}

function pthreadCreateProxied(pthread_ptr, attr, startRoutine, arg) {
 if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(2, 1, pthread_ptr, attr, startRoutine, arg);
 return ___pthread_create_js(pthread_ptr, attr, startRoutine, arg);
}

function ___pthread_create_js(pthread_ptr, attr, startRoutine, arg) {
 pthread_ptr >>>= 0;
 attr >>>= 0;
 startRoutine >>>= 0;
 arg >>>= 0;
 if (typeof SharedArrayBuffer == "undefined") {
  err("Current environment does not support SharedArrayBuffer, pthreads are not available!");
  return 6;
 }
 var transferList = [];
 var error = 0;
 if (ENVIRONMENT_IS_PTHREAD && (transferList.length === 0 || error)) {
  return pthreadCreateProxied(pthread_ptr, attr, startRoutine, arg);
 }
 if (error) return error;
 var threadParams = {
  startRoutine: startRoutine,
  pthread_ptr: pthread_ptr,
  arg: arg,
  transferList: transferList
 };
 if (ENVIRONMENT_IS_PTHREAD) {
  threadParams.cmd = "spawnThread";
  postMessage(threadParams, transferList);
  return 0;
 }
 return spawnThread(threadParams);
}

function ___pthread_kill_js(thread, signal) {
 thread >>>= 0;
 if (signal === 33) {
  if (!ENVIRONMENT_IS_PTHREAD) cancelThread(thread); else postMessage({
   "cmd": "cancelThread",
   "thread": thread
  });
 } else {
  if (!ENVIRONMENT_IS_PTHREAD) killThread(thread); else postMessage({
   "cmd": "killThread",
   "thread": thread
  });
 }
 return 0;
}

var nowIsMonotonic = 1;

var __emscripten_get_now_is_monotonic = () => nowIsMonotonic;

var maybeExit = () => {
 if (!keepRuntimeAlive()) {
  try {
   if (ENVIRONMENT_IS_PTHREAD) __emscripten_thread_exit(EXITSTATUS); else _exit(EXITSTATUS);
  } catch (e) {
   handleException(e);
  }
 }
};

var callUserCallback = func => {
 if (ABORT) {
  return;
 }
 try {
  func();
  maybeExit();
 } catch (e) {
  handleException(e);
 }
};

function __emscripten_thread_mailbox_await(pthread_ptr) {
 pthread_ptr >>>= 0;
 if (typeof Atomics.waitAsync === "function") {
  var wait = Atomics.waitAsync(HEAP32, ((pthread_ptr) >>> 2), pthread_ptr);
  wait.value.then(checkMailbox);
  var waitingAsync = pthread_ptr + 128;
  Atomics.store(HEAP32, ((waitingAsync) >>> 2), 1);
 }
}

Module["__emscripten_thread_mailbox_await"] = __emscripten_thread_mailbox_await;

var checkMailbox = () => {
 var pthread_ptr = _pthread_self();
 if (pthread_ptr) {
  __emscripten_thread_mailbox_await(pthread_ptr);
  callUserCallback(__emscripten_check_mailbox);
 }
};

Module["checkMailbox"] = checkMailbox;

var __emscripten_notify_mailbox_postmessage = function(targetThreadId, currThreadId, mainThreadId) {
 targetThreadId >>>= 0;
 currThreadId >>>= 0;
 mainThreadId >>>= 0;
 if (targetThreadId == currThreadId) {
  setTimeout(() => checkMailbox());
 } else if (ENVIRONMENT_IS_PTHREAD) {
  postMessage({
   "targetThread": targetThreadId,
   "cmd": "checkMailbox"
  });
 } else {
  var worker = PThread.pthreads[targetThreadId];
  if (!worker) {
   return;
  }
  worker.postMessage({
   "cmd": "checkMailbox"
  });
 }
};

var proxiedJSCallArgs = [];

function __emscripten_receive_on_main_thread_js(index, callingThread, numCallArgs, args) {
 callingThread >>>= 0;
 args >>>= 0;
 numCallArgs /= 2;
 proxiedJSCallArgs.length = numCallArgs;
 var b = ((args) >>> 3);
 for (var i = 0; i < numCallArgs; i++) {
  if (HEAP64[b + 2 * i]) {
   proxiedJSCallArgs[i] = HEAP64[b + 2 * i + 1];
  } else {
   proxiedJSCallArgs[i] = HEAPF64[b + 2 * i + 1 >>> 0];
  }
 }
 var func = proxiedFunctionTable[index];
 PThread.currentProxiedOperationCallerThread = callingThread;
 var rtn = func.apply(null, proxiedJSCallArgs);
 PThread.currentProxiedOperationCallerThread = 0;
 return rtn;
}

function __emscripten_runtime_keepalive_clear() {
 if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(3, 1);
 noExitRuntime = false;
 runtimeKeepaliveCounter = 0;
}

function __emscripten_thread_set_strongref(thread) {
 thread >>>= 0;
 if (ENVIRONMENT_IS_NODE) {
  PThread.pthreads[thread].ref();
 }
}

var __emscripten_throw_longjmp = () => {
 throw Infinity;
};

function __gmtime_js(time, tmPtr) {
 time = bigintToI53Checked(time);
 tmPtr >>>= 0;
 var date = new Date(time * 1e3);
 HEAP32[((tmPtr) >>> 2) >>> 0] = date.getUTCSeconds();
 HEAP32[(((tmPtr) + (4)) >>> 2) >>> 0] = date.getUTCMinutes();
 HEAP32[(((tmPtr) + (8)) >>> 2) >>> 0] = date.getUTCHours();
 HEAP32[(((tmPtr) + (12)) >>> 2) >>> 0] = date.getUTCDate();
 HEAP32[(((tmPtr) + (16)) >>> 2) >>> 0] = date.getUTCMonth();
 HEAP32[(((tmPtr) + (20)) >>> 2) >>> 0] = date.getUTCFullYear() - 1900;
 HEAP32[(((tmPtr) + (24)) >>> 2) >>> 0] = date.getUTCDay();
 var start = Date.UTC(date.getUTCFullYear(), 0, 1, 0, 0, 0, 0);
 var yday = ((date.getTime() - start) / (1e3 * 60 * 60 * 24)) | 0;
 HEAP32[(((tmPtr) + (28)) >>> 2) >>> 0] = yday;
}

var isLeapYear = year => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);

var MONTH_DAYS_LEAP_CUMULATIVE = [ 0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335 ];

var MONTH_DAYS_REGULAR_CUMULATIVE = [ 0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334 ];

var ydayFromDate = date => {
 var leap = isLeapYear(date.getFullYear());
 var monthDaysCumulative = (leap ? MONTH_DAYS_LEAP_CUMULATIVE : MONTH_DAYS_REGULAR_CUMULATIVE);
 var yday = monthDaysCumulative[date.getMonth()] + date.getDate() - 1;
 return yday;
};

function __localtime_js(time, tmPtr) {
 time = bigintToI53Checked(time);
 tmPtr >>>= 0;
 var date = new Date(time * 1e3);
 HEAP32[((tmPtr) >>> 2) >>> 0] = date.getSeconds();
 HEAP32[(((tmPtr) + (4)) >>> 2) >>> 0] = date.getMinutes();
 HEAP32[(((tmPtr) + (8)) >>> 2) >>> 0] = date.getHours();
 HEAP32[(((tmPtr) + (12)) >>> 2) >>> 0] = date.getDate();
 HEAP32[(((tmPtr) + (16)) >>> 2) >>> 0] = date.getMonth();
 HEAP32[(((tmPtr) + (20)) >>> 2) >>> 0] = date.getFullYear() - 1900;
 HEAP32[(((tmPtr) + (24)) >>> 2) >>> 0] = date.getDay();
 var yday = ydayFromDate(date) | 0;
 HEAP32[(((tmPtr) + (28)) >>> 2) >>> 0] = yday;
 HEAP32[(((tmPtr) + (36)) >>> 2) >>> 0] = -(date.getTimezoneOffset() * 60);
 var start = new Date(date.getFullYear(), 0, 1);
 var summerOffset = new Date(date.getFullYear(), 6, 1).getTimezoneOffset();
 var winterOffset = start.getTimezoneOffset();
 var dst = (summerOffset != winterOffset && date.getTimezoneOffset() == Math.min(winterOffset, summerOffset)) | 0;
 HEAP32[(((tmPtr) + (32)) >>> 2) >>> 0] = dst;
}

var setErrNo = value => {
 HEAP32[((___errno_location()) >>> 2) >>> 0] = value;
 return value;
};

var __mktime_js = function(tmPtr) {
 tmPtr >>>= 0;
 var ret = (() => {
  var date = new Date(HEAP32[(((tmPtr) + (20)) >>> 2) >>> 0] + 1900, HEAP32[(((tmPtr) + (16)) >>> 2) >>> 0], HEAP32[(((tmPtr) + (12)) >>> 2) >>> 0], HEAP32[(((tmPtr) + (8)) >>> 2) >>> 0], HEAP32[(((tmPtr) + (4)) >>> 2) >>> 0], HEAP32[((tmPtr) >>> 2) >>> 0], 0);
  var dst = HEAP32[(((tmPtr) + (32)) >>> 2) >>> 0];
  var guessedOffset = date.getTimezoneOffset();
  var start = new Date(date.getFullYear(), 0, 1);
  var summerOffset = new Date(date.getFullYear(), 6, 1).getTimezoneOffset();
  var winterOffset = start.getTimezoneOffset();
  var dstOffset = Math.min(winterOffset, summerOffset);
  if (dst < 0) {
   HEAP32[(((tmPtr) + (32)) >>> 2) >>> 0] = Number(summerOffset != winterOffset && dstOffset == guessedOffset);
  } else if ((dst > 0) != (dstOffset == guessedOffset)) {
   var nonDstOffset = Math.max(winterOffset, summerOffset);
   var trueOffset = dst > 0 ? dstOffset : nonDstOffset;
   date.setTime(date.getTime() + (trueOffset - guessedOffset) * 6e4);
  }
  HEAP32[(((tmPtr) + (24)) >>> 2) >>> 0] = date.getDay();
  var yday = ydayFromDate(date) | 0;
  HEAP32[(((tmPtr) + (28)) >>> 2) >>> 0] = yday;
  HEAP32[((tmPtr) >>> 2) >>> 0] = date.getSeconds();
  HEAP32[(((tmPtr) + (4)) >>> 2) >>> 0] = date.getMinutes();
  HEAP32[(((tmPtr) + (8)) >>> 2) >>> 0] = date.getHours();
  HEAP32[(((tmPtr) + (12)) >>> 2) >>> 0] = date.getDate();
  HEAP32[(((tmPtr) + (16)) >>> 2) >>> 0] = date.getMonth();
  HEAP32[(((tmPtr) + (20)) >>> 2) >>> 0] = date.getYear();
  var timeMs = date.getTime();
  if (isNaN(timeMs)) {
   setErrNo(61);
   return -1;
  }
  return timeMs / 1e3;
 })();
 return BigInt(ret);
};

var lengthBytesUTF8 = str => {
 var len = 0;
 for (var i = 0; i < str.length; ++i) {
  var c = str.charCodeAt(i);
  if (c <= 127) {
   len++;
  } else if (c <= 2047) {
   len += 2;
  } else if (c >= 55296 && c <= 57343) {
   len += 4;
   ++i;
  } else {
   len += 3;
  }
 }
 return len;
};

var stringToUTF8Array = (str, heap, outIdx, maxBytesToWrite) => {
 outIdx >>>= 0;
 if (!(maxBytesToWrite > 0)) return 0;
 var startIdx = outIdx;
 var endIdx = outIdx + maxBytesToWrite - 1;
 for (var i = 0; i < str.length; ++i) {
  var u = str.charCodeAt(i);
  if (u >= 55296 && u <= 57343) {
   var u1 = str.charCodeAt(++i);
   u = 65536 + ((u & 1023) << 10) | (u1 & 1023);
  }
  if (u <= 127) {
   if (outIdx >= endIdx) break;
   heap[outIdx++ >>> 0] = u;
  } else if (u <= 2047) {
   if (outIdx + 1 >= endIdx) break;
   heap[outIdx++ >>> 0] = 192 | (u >> 6);
   heap[outIdx++ >>> 0] = 128 | (u & 63);
  } else if (u <= 65535) {
   if (outIdx + 2 >= endIdx) break;
   heap[outIdx++ >>> 0] = 224 | (u >> 12);
   heap[outIdx++ >>> 0] = 128 | ((u >> 6) & 63);
   heap[outIdx++ >>> 0] = 128 | (u & 63);
  } else {
   if (outIdx + 3 >= endIdx) break;
   heap[outIdx++ >>> 0] = 240 | (u >> 18);
   heap[outIdx++ >>> 0] = 128 | ((u >> 12) & 63);
   heap[outIdx++ >>> 0] = 128 | ((u >> 6) & 63);
   heap[outIdx++ >>> 0] = 128 | (u & 63);
  }
 }
 heap[outIdx >>> 0] = 0;
 return outIdx - startIdx;
};

var stringToUTF8 = (str, outPtr, maxBytesToWrite) => stringToUTF8Array(str, HEAPU8, outPtr, maxBytesToWrite);

var stringToNewUTF8 = str => {
 var size = lengthBytesUTF8(str) + 1;
 var ret = _malloc(size);
 if (ret) stringToUTF8(str, ret, size);
 return ret;
};

function __tzset_js(timezone, daylight, tzname) {
 timezone >>>= 0;
 daylight >>>= 0;
 tzname >>>= 0;
 var currentYear = (new Date).getFullYear();
 var winter = new Date(currentYear, 0, 1);
 var summer = new Date(currentYear, 6, 1);
 var winterOffset = winter.getTimezoneOffset();
 var summerOffset = summer.getTimezoneOffset();
 var stdTimezoneOffset = Math.max(winterOffset, summerOffset);
 HEAPU32[((timezone) >>> 2) >>> 0] = stdTimezoneOffset * 60;
 HEAP32[((daylight) >>> 2) >>> 0] = Number(winterOffset != summerOffset);
 function extractZone(date) {
  var match = date.toTimeString().match(/\(([A-Za-z ]+)\)$/);
  return match ? match[1] : "GMT";
 }
 var winterName = extractZone(winter);
 var summerName = extractZone(summer);
 var winterNamePtr = stringToNewUTF8(winterName);
 var summerNamePtr = stringToNewUTF8(summerName);
 if (summerOffset < winterOffset) {
  HEAPU32[((tzname) >>> 2) >>> 0] = winterNamePtr;
  HEAPU32[(((tzname) + (4)) >>> 2) >>> 0] = summerNamePtr;
 } else {
  HEAPU32[((tzname) >>> 2) >>> 0] = summerNamePtr;
  HEAPU32[(((tzname) + (4)) >>> 2) >>> 0] = winterNamePtr;
 }
}

function __wasmfs_copy_preloaded_file_data(index, buffer) {
 buffer >>>= 0;
 return HEAPU8.set(wasmFSPreloadedFiles[index].fileData, buffer >>> 0);
}

var wasmFSPreloadedDirs = [];

var __wasmfs_get_num_preloaded_dirs = () => wasmFSPreloadedDirs.length;

var wasmFSPreloadedFiles = [];

var wasmFSPreloadingFlushed = false;

var __wasmfs_get_num_preloaded_files = () => {
 wasmFSPreloadingFlushed = true;
 return wasmFSPreloadedFiles.length;
};

function __wasmfs_get_preloaded_child_path(index, childNameBuffer) {
 childNameBuffer >>>= 0;
 var s = wasmFSPreloadedDirs[index].childName;
 var len = lengthBytesUTF8(s) + 1;
 stringToUTF8(s, childNameBuffer, len);
}

var __wasmfs_get_preloaded_file_mode = index => wasmFSPreloadedFiles[index].mode;

function __wasmfs_get_preloaded_file_size(index) {
 return wasmFSPreloadedFiles[index].fileData.length;
}

function __wasmfs_get_preloaded_parent_path(index, parentPathBuffer) {
 parentPathBuffer >>>= 0;
 var s = wasmFSPreloadedDirs[index].parentPath;
 var len = lengthBytesUTF8(s) + 1;
 stringToUTF8(s, parentPathBuffer, len);
}

function __wasmfs_get_preloaded_path_name(index, fileNameBuffer) {
 fileNameBuffer >>>= 0;
 var s = wasmFSPreloadedFiles[index].pathName;
 var len = lengthBytesUTF8(s) + 1;
 stringToUTF8(s, fileNameBuffer, len);
}

function __wasmfs_jsimpl_alloc_file(backend, file) {
 backend >>>= 0;
 file >>>= 0;
 return wasmFS$backends[backend].allocFile(file);
}

function __wasmfs_jsimpl_free_file(backend, file) {
 backend >>>= 0;
 file >>>= 0;
 return wasmFS$backends[backend].freeFile(file);
}

function __wasmfs_jsimpl_get_size(backend, file) {
 backend >>>= 0;
 file >>>= 0;
 return wasmFS$backends[backend].getSize(file);
}

function __wasmfs_jsimpl_read(backend, file, buffer, length, offset) {
 backend >>>= 0;
 file >>>= 0;
 buffer >>>= 0;
 length >>>= 0;
 offset = bigintToI53Checked(offset);
 if (!wasmFS$backends[backend].read) {
  return -28;
 }
 return wasmFS$backends[backend].read(file, buffer, length, offset);
}

function __wasmfs_jsimpl_write(backend, file, buffer, length, offset) {
 backend >>>= 0;
 file >>>= 0;
 buffer >>>= 0;
 length >>>= 0;
 offset = bigintToI53Checked(offset);
 if (!wasmFS$backends[backend].write) {
  return -28;
 }
 return wasmFS$backends[backend].write(file, buffer, length, offset);
}

function handleAllocatorInit() {
 Object.assign(HandleAllocator.prototype, /** @lends {HandleAllocator.prototype} */ {
  get(id) {
   return this.allocated[id];
  },
  has(id) {
   return this.allocated[id] !== undefined;
  },
  allocate(handle) {
   var id = this.freelist.pop() || this.allocated.length;
   this.allocated[id] = handle;
   return id;
  },
  free(id) {
   this.allocated[id] = undefined;
   this.freelist.push(id);
  }
 });
}

/** @constructor */ function HandleAllocator() {
 this.allocated = [ undefined ];
 this.freelist = [];
}

var wasmfsOPFSAccessHandles = new HandleAllocator;

var wasmfsOPFSProxyFinish = ctx => {
 _emscripten_proxy_finish(ctx);
};

async function __wasmfs_opfs_close_access(ctx, accessID, errPtr) {
 ctx >>>= 0;
 errPtr >>>= 0;
 let accessHandle = wasmfsOPFSAccessHandles.get(accessID);
 try {
  await accessHandle.close();
 } catch {
  let err = -29;
  HEAP32[((errPtr) >>> 2) >>> 0] = err;
 }
 wasmfsOPFSAccessHandles.free(accessID);
 wasmfsOPFSProxyFinish(ctx);
}

__wasmfs_opfs_close_access.isAsync = true;

var wasmfsOPFSBlobs = new HandleAllocator;

var __wasmfs_opfs_close_blob = blobID => {
 wasmfsOPFSBlobs.free(blobID);
};

async function __wasmfs_opfs_flush_access(ctx, accessID, errPtr) {
 ctx >>>= 0;
 errPtr >>>= 0;
 let accessHandle = wasmfsOPFSAccessHandles.get(accessID);
 try {
  await accessHandle.flush();
 } catch {
  let err = -29;
  HEAP32[((errPtr) >>> 2) >>> 0] = err;
 }
 wasmfsOPFSProxyFinish(ctx);
}

__wasmfs_opfs_flush_access.isAsync = true;

var wasmfsOPFSDirectoryHandles = new HandleAllocator;

var __wasmfs_opfs_free_directory = dirID => {
 wasmfsOPFSDirectoryHandles.free(dirID);
};

var wasmfsOPFSFileHandles = new HandleAllocator;

var __wasmfs_opfs_free_file = fileID => {
 wasmfsOPFSFileHandles.free(fileID);
};

async function wasmfsOPFSGetOrCreateFile(parent, name, create) {
 let parentHandle = wasmfsOPFSDirectoryHandles.get(parent);
 let fileHandle;
 try {
  fileHandle = await parentHandle.getFileHandle(name, {
   create: create
  });
 } catch (e) {
  if (e.name === "NotFoundError") {
   return -20;
  }
  if (e.name === "TypeMismatchError") {
   return -31;
  }
  return -29;
 }
 return wasmfsOPFSFileHandles.allocate(fileHandle);
}

wasmfsOPFSGetOrCreateFile.isAsync = true;

async function wasmfsOPFSGetOrCreateDir(parent, name, create) {
 let parentHandle = wasmfsOPFSDirectoryHandles.get(parent);
 let childHandle;
 try {
  childHandle = await parentHandle.getDirectoryHandle(name, {
   create: create
  });
 } catch (e) {
  if (e.name === "NotFoundError") {
   return -20;
  }
  if (e.name === "TypeMismatchError") {
   return -54;
  }
  return -29;
 }
 return wasmfsOPFSDirectoryHandles.allocate(childHandle);
}

wasmfsOPFSGetOrCreateDir.isAsync = true;

async function __wasmfs_opfs_get_child(ctx, parent, namePtr, childTypePtr, childIDPtr) {
 ctx >>>= 0;
 namePtr >>>= 0;
 childTypePtr >>>= 0;
 childIDPtr >>>= 0;
 let name = UTF8ToString(namePtr);
 let childType = 1;
 let childID = await wasmfsOPFSGetOrCreateFile(parent, name, false);
 if (childID == -31) {
  childType = 2;
  childID = await wasmfsOPFSGetOrCreateDir(parent, name, false);
 }
 HEAP32[((childTypePtr) >>> 2) >>> 0] = childType;
 HEAP32[((childIDPtr) >>> 2) >>> 0] = childID;
 wasmfsOPFSProxyFinish(ctx);
}

__wasmfs_opfs_get_child.isAsync = true;

var __wasmfs_opfs_get_entries = async function(ctx, dirID, entriesPtr, errPtr) {
 ctx >>>= 0;
 entriesPtr >>>= 0;
 errPtr >>>= 0;
 let dirHandle = wasmfsOPFSDirectoryHandles.get(dirID);
 try {
  let iter = dirHandle.entries();
  for (let entry; entry = await iter.next(), !entry.done; ) {
   let [name, child] = entry.value;
   withStackSave(() => {
    let namePtr = stringToUTF8OnStack(name);
    let type = child.kind == "file" ? 1 : 2;
    __wasmfs_opfs_record_entry(entriesPtr, namePtr, type);
   });
  }
 } catch {
  let err = -29;
  HEAP32[((errPtr) >>> 2) >>> 0] = err;
 }
 wasmfsOPFSProxyFinish(ctx);
};

__wasmfs_opfs_get_entries.isAsync = true;

async function __wasmfs_opfs_get_size_access(ctx, accessID, sizePtr) {
 ctx >>>= 0;
 sizePtr >>>= 0;
 let accessHandle = wasmfsOPFSAccessHandles.get(accessID);
 let size;
 try {
  size = await accessHandle.getSize();
 } catch {
  size = -29;
 }
 HEAP64[((sizePtr) >>> 3)] = BigInt(size);
 wasmfsOPFSProxyFinish(ctx);
}

__wasmfs_opfs_get_size_access.isAsync = true;

var __wasmfs_opfs_get_size_blob = blobID => wasmfsOPFSBlobs.get(blobID).size;

async function __wasmfs_opfs_get_size_file(ctx, fileID, sizePtr) {
 ctx >>>= 0;
 sizePtr >>>= 0;
 let fileHandle = wasmfsOPFSFileHandles.get(fileID);
 let size;
 try {
  size = (await fileHandle.getFile()).size;
 } catch {
  size = -29;
 }
 HEAP64[((sizePtr) >>> 3)] = BigInt(size);
 wasmfsOPFSProxyFinish(ctx);
}

__wasmfs_opfs_get_size_file.isAsync = true;

async function __wasmfs_opfs_init_root_directory(ctx) {
 ctx >>>= 0;
 if (wasmfsOPFSDirectoryHandles.allocated.length == 1) {
  /** @suppress {checkTypes} */ let root = await navigator.storage.getDirectory();
  wasmfsOPFSDirectoryHandles.allocated.push(root);
 }
 wasmfsOPFSProxyFinish(ctx);
}

__wasmfs_opfs_init_root_directory.isAsync = true;

async function __wasmfs_opfs_insert_directory(ctx, parent, namePtr, childIDPtr) {
 ctx >>>= 0;
 namePtr >>>= 0;
 childIDPtr >>>= 0;
 let name = UTF8ToString(namePtr);
 let childID = await wasmfsOPFSGetOrCreateDir(parent, name, true);
 HEAP32[((childIDPtr) >>> 2) >>> 0] = childID;
 wasmfsOPFSProxyFinish(ctx);
}

__wasmfs_opfs_insert_directory.isAsync = true;

async function __wasmfs_opfs_insert_file(ctx, parent, namePtr, childIDPtr) {
 ctx >>>= 0;
 namePtr >>>= 0;
 childIDPtr >>>= 0;
 let name = UTF8ToString(namePtr);
 let childID = await wasmfsOPFSGetOrCreateFile(parent, name, true);
 HEAP32[((childIDPtr) >>> 2) >>> 0] = childID;
 wasmfsOPFSProxyFinish(ctx);
}

__wasmfs_opfs_insert_file.isAsync = true;

async function __wasmfs_opfs_move_file(ctx, fileID, newParentID, namePtr, errPtr) {
 ctx >>>= 0;
 namePtr >>>= 0;
 errPtr >>>= 0;
 let name = UTF8ToString(namePtr);
 let fileHandle = wasmfsOPFSFileHandles.get(fileID);
 let newDirHandle = wasmfsOPFSDirectoryHandles.get(newParentID);
 try {
  await fileHandle.move(newDirHandle, name);
 } catch {
  let err = -29;
  HEAP32[((errPtr) >>> 2) >>> 0] = err;
 }
 wasmfsOPFSProxyFinish(ctx);
}

__wasmfs_opfs_move_file.isAsync = true;

async function __wasmfs_opfs_open_access(ctx, fileID, accessIDPtr) {
 ctx >>>= 0;
 accessIDPtr >>>= 0;
 let fileHandle = wasmfsOPFSFileHandles.get(fileID);
 let accessID;
 try {
  let accessHandle;
  /** @suppress {checkTypes} */ var len = FileSystemFileHandle.prototype.createSyncAccessHandle.length;
  if (len == 0) {
   accessHandle = await fileHandle.createSyncAccessHandle();
  } else {
   accessHandle = await fileHandle.createSyncAccessHandle({
    mode: "in-place"
   });
  }
  accessID = wasmfsOPFSAccessHandles.allocate(accessHandle);
 } catch (e) {
  if (e.name === "InvalidStateError" || e.name === "NoModificationAllowedError") {
   accessID = -2;
  } else {
   accessID = -29;
  }
 }
 HEAP32[((accessIDPtr) >>> 2) >>> 0] = accessID;
 wasmfsOPFSProxyFinish(ctx);
}

__wasmfs_opfs_open_access.isAsync = true;

async function __wasmfs_opfs_open_blob(ctx, fileID, blobIDPtr) {
 ctx >>>= 0;
 blobIDPtr >>>= 0;
 let fileHandle = wasmfsOPFSFileHandles.get(fileID);
 let blobID;
 try {
  let blob = await fileHandle.getFile();
  blobID = wasmfsOPFSBlobs.allocate(blob);
 } catch (e) {
  if (e.name === "NotAllowedError") {
   blobID = -2;
  } else {
   blobID = -29;
  }
 }
 HEAP32[((blobIDPtr) >>> 2) >>> 0] = blobID;
 wasmfsOPFSProxyFinish(ctx);
}

__wasmfs_opfs_open_blob.isAsync = true;

function __wasmfs_opfs_read_access(accessID, bufPtr, len, pos) {
 bufPtr >>>= 0;
 let accessHandle = wasmfsOPFSAccessHandles.get(accessID);
 let data = HEAPU8.subarray(bufPtr >>> 0, bufPtr + len >>> 0);
 try {
  return accessHandle.read(data, {
   at: pos
  });
 } catch (e) {
  if (e.name == "TypeError") {
   return -28;
  }
  return -29;
 }
}

async function __wasmfs_opfs_read_blob(ctx, blobID, bufPtr, len, pos, nreadPtr) {
 ctx >>>= 0;
 bufPtr >>>= 0;
 nreadPtr >>>= 0;
 let blob = wasmfsOPFSBlobs.get(blobID);
 let slice = blob.slice(pos, pos + len);
 let nread = 0;
 try {
  let buf = await slice.arrayBuffer();
  let data = new Uint8Array(buf);
  HEAPU8.set(data, bufPtr >>> 0);
  nread += data.length;
 } catch (e) {
  if (e instanceof RangeError) {
   nread = -21;
  } else {
   nread = -29;
  }
 }
 HEAP32[((nreadPtr) >>> 2) >>> 0] = nread;
 wasmfsOPFSProxyFinish(ctx);
}

__wasmfs_opfs_read_blob.isAsync = true;

async function __wasmfs_opfs_remove_child(ctx, dirID, namePtr, errPtr) {
 ctx >>>= 0;
 namePtr >>>= 0;
 errPtr >>>= 0;
 let name = UTF8ToString(namePtr);
 let dirHandle = wasmfsOPFSDirectoryHandles.get(dirID);
 try {
  await dirHandle.removeEntry(name);
 } catch {
  let err = -29;
  HEAP32[((errPtr) >>> 2) >>> 0] = err;
 }
 wasmfsOPFSProxyFinish(ctx);
}

__wasmfs_opfs_remove_child.isAsync = true;

async function __wasmfs_opfs_set_size_access(ctx, accessID, size, errPtr) {
 ctx >>>= 0;
 size = bigintToI53Checked(size);
 errPtr >>>= 0;
 let accessHandle = wasmfsOPFSAccessHandles.get(accessID);
 try {
  await accessHandle.truncate(size);
 } catch {
  let err = -29;
  HEAP32[((errPtr) >>> 2) >>> 0] = err;
 }
 wasmfsOPFSProxyFinish(ctx);
}

__wasmfs_opfs_set_size_access.isAsync = true;

async function __wasmfs_opfs_set_size_file(ctx, fileID, size, errPtr) {
 ctx >>>= 0;
 size = bigintToI53Checked(size);
 errPtr >>>= 0;
 let fileHandle = wasmfsOPFSFileHandles.get(fileID);
 try {
  let writable = await fileHandle.createWritable({
   keepExistingData: true
  });
  await writable.truncate(size);
  await writable.close();
 } catch {
  let err = -29;
  HEAP32[((errPtr) >>> 2) >>> 0] = err;
 }
 wasmfsOPFSProxyFinish(ctx);
}

__wasmfs_opfs_set_size_file.isAsync = true;

function __wasmfs_opfs_write_access(accessID, bufPtr, len, pos) {
 bufPtr >>>= 0;
 let accessHandle = wasmfsOPFSAccessHandles.get(accessID);
 let data = HEAPU8.subarray(bufPtr >>> 0, bufPtr + len >>> 0);
 try {
  return accessHandle.write(data, {
   at: pos
  });
 } catch (e) {
  if (e.name == "TypeError") {
   return -28;
  }
  return -29;
 }
}

var FS_stdin_getChar_buffer = [];

/** @type {function(string, boolean=, number=)} */ function intArrayFromString(stringy, dontAddNull, length) {
 var len = length > 0 ? length : lengthBytesUTF8(stringy) + 1;
 var u8array = new Array(len);
 var numBytesWritten = stringToUTF8Array(stringy, u8array, 0, u8array.length);
 if (dontAddNull) u8array.length = numBytesWritten;
 return u8array;
}

var FS_stdin_getChar = () => {
 if (!FS_stdin_getChar_buffer.length) {
  var result = null;
  if (ENVIRONMENT_IS_NODE) {
   var BUFSIZE = 256;
   var buf = Buffer.alloc(BUFSIZE);
   var bytesRead = 0;
   /** @suppress {missingProperties} */ var fd = process.stdin.fd;
   try {
    bytesRead = fs.readSync(fd, buf);
   } catch (e) {
    if (e.toString().includes("EOF")) bytesRead = 0; else throw e;
   }
   if (bytesRead > 0) {
    result = buf.slice(0, bytesRead).toString("utf-8");
   } else {
    result = null;
   }
  } else if (typeof window != "undefined" && typeof window.prompt == "function") {
   result = window.prompt("Input: ");
   if (result !== null) {
    result += "\n";
   }
  } else if (typeof readline == "function") {
   result = readline();
   if (result !== null) {
    result += "\n";
   }
  }
  if (!result) {
   return null;
  }
  FS_stdin_getChar_buffer = intArrayFromString(result, true);
 }
 return FS_stdin_getChar_buffer.shift();
};

var __wasmfs_stdin_get_char = () => {
 var c = FS_stdin_getChar();
 if (typeof c === "number") {
  return c;
 }
 return -1;
};

var __wasmfs_thread_utils_heartbeat = function(queue) {
 queue >>>= 0;
 var intervalID = setInterval(() => {
  if (ABORT) {
   clearInterval(intervalID);
  } else {
   _emscripten_proxy_execute_queue(queue);
  }
 }, 50);
};

var _abort = () => {
 abort("");
};

var warnOnce = text => {
 if (!warnOnce.shown) warnOnce.shown = {};
 if (!warnOnce.shown[text]) {
  warnOnce.shown[text] = 1;
  if (ENVIRONMENT_IS_NODE) text = "warning: " + text;
  err(text);
 }
};

var _emscripten_check_blocking_allowed = () => {};

function _emscripten_console_error(str) {
 str >>>= 0;
 console.error(UTF8ToString(str));
}

var _emscripten_date_now = () => Date.now();

function _emscripten_err(str) {
 str >>>= 0;
 return err(UTF8ToString(str));
}

var _emscripten_exit_with_live_runtime = () => {
 runtimeKeepalivePush();
 throw "unwind";
};

var runAndAbortIfError = func => {
 try {
  return func();
 } catch (e) {
  abort(e);
 }
};

var sigToWasmTypes = sig => {
 var typeNames = {
  "i": "i32",
  "j": "i64",
  "f": "f32",
  "d": "f64",
  "e": "externref",
  "p": "i32"
 };
 var type = {
  parameters: [],
  results: sig[0] == "v" ? [] : [ typeNames[sig[0]] ]
 };
 for (var i = 1; i < sig.length; ++i) {
  type.parameters.push(typeNames[sig[i]]);
 }
 return type;
};

var Asyncify = {
 instrumentWasmImports(imports) {
  var importPattern = /^(ffi_call_js|invoke_.*|__asyncjs__.*)$/;
  for (var x in imports) {
   (function(x) {
    var original = imports[x];
    var sig = original.sig;
    if (typeof original == "function") {
     var isAsyncifyImport = original.isAsync || importPattern.test(x);
    }
   })(x);
  }
 },
 instrumentWasmExports(exports) {
  var ret = {};
  for (var x in exports) {
   (function(x) {
    var original = exports[x];
    if (typeof original == "function") {
     ret[x] = function() {
      Asyncify.exportCallStack.push(x);
      try {
       return original.apply(null, arguments);
      } finally {
       if (!ABORT) {
        var y = Asyncify.exportCallStack.pop();
        Asyncify.maybeStopUnwind();
       }
      }
     };
    } else {
     ret[x] = original;
    }
   })(x);
  }
  return ret;
 },
 State: {
  Normal: 0,
  Unwinding: 1,
  Rewinding: 2,
  Disabled: 3
 },
 state: 0,
 StackSize: 4096,
 currData: null,
 handleSleepReturnValue: 0,
 exportCallStack: [],
 callStackNameToId: {},
 callStackIdToName: {},
 callStackId: 0,
 asyncPromiseHandlers: null,
 sleepCallbacks: [],
 getCallStackId(funcName) {
  var id = Asyncify.callStackNameToId[funcName];
  if (id === undefined) {
   id = Asyncify.callStackId++;
   Asyncify.callStackNameToId[funcName] = id;
   Asyncify.callStackIdToName[id] = funcName;
  }
  return id;
 },
 maybeStopUnwind() {
  if (Asyncify.currData && Asyncify.state === Asyncify.State.Unwinding && Asyncify.exportCallStack.length === 0) {
   Asyncify.state = Asyncify.State.Normal;
   runtimeKeepalivePush();
   runAndAbortIfError(_asyncify_stop_unwind);
   if (typeof Fibers != "undefined") {
    Fibers.trampoline();
   }
  }
 },
 whenDone() {
  return new Promise((resolve, reject) => {
   Asyncify.asyncPromiseHandlers = {
    resolve: resolve,
    reject: reject
   };
  });
 },
 allocateData() {
  var ptr = _malloc(12 + Asyncify.StackSize);
  Asyncify.setDataHeader(ptr, ptr + 12, Asyncify.StackSize);
  Asyncify.setDataRewindFunc(ptr);
  return ptr;
 },
 setDataHeader(ptr, stack, stackSize) {
  HEAPU32[((ptr) >>> 2) >>> 0] = stack;
  HEAPU32[(((ptr) + (4)) >>> 2) >>> 0] = stack + stackSize;
 },
 setDataRewindFunc(ptr) {
  var bottomOfCallStack = Asyncify.exportCallStack[0];
  var rewindId = Asyncify.getCallStackId(bottomOfCallStack);
  HEAP32[(((ptr) + (8)) >>> 2) >>> 0] = rewindId;
 },
 getDataRewindFunc(ptr) {
  var id = HEAP32[(((ptr) + (8)) >>> 2) >>> 0];
  var name = Asyncify.callStackIdToName[id];
  var func = wasmExports[name];
  return func;
 },
 doRewind(ptr) {
  var start = Asyncify.getDataRewindFunc(ptr);
  runtimeKeepalivePop();
  return start();
 },
 handleSleep(startAsync) {
  if (ABORT) return;
  if (Asyncify.state === Asyncify.State.Normal) {
   var reachedCallback = false;
   var reachedAfterCallback = false;
   startAsync((handleSleepReturnValue = 0) => {
    if (ABORT) return;
    Asyncify.handleSleepReturnValue = handleSleepReturnValue;
    reachedCallback = true;
    if (!reachedAfterCallback) {
     return;
    }
    Asyncify.state = Asyncify.State.Rewinding;
    runAndAbortIfError(() => _asyncify_start_rewind(Asyncify.currData));
    if (typeof Browser != "undefined" && Browser.mainLoop.func) {
     Browser.mainLoop.resume();
    }
    var asyncWasmReturnValue, isError = false;
    try {
     asyncWasmReturnValue = Asyncify.doRewind(Asyncify.currData);
    } catch (err) {
     asyncWasmReturnValue = err;
     isError = true;
    }
    var handled = false;
    if (!Asyncify.currData) {
     var asyncPromiseHandlers = Asyncify.asyncPromiseHandlers;
     if (asyncPromiseHandlers) {
      Asyncify.asyncPromiseHandlers = null;
      (isError ? asyncPromiseHandlers.reject : asyncPromiseHandlers.resolve)(asyncWasmReturnValue);
      handled = true;
     }
    }
    if (isError && !handled) {
     throw asyncWasmReturnValue;
    }
   });
   reachedAfterCallback = true;
   if (!reachedCallback) {
    Asyncify.state = Asyncify.State.Unwinding;
    Asyncify.currData = Asyncify.allocateData();
    if (typeof Browser != "undefined" && Browser.mainLoop.func) {
     Browser.mainLoop.pause();
    }
    runAndAbortIfError(() => _asyncify_start_unwind(Asyncify.currData));
   }
  } else if (Asyncify.state === Asyncify.State.Rewinding) {
   Asyncify.state = Asyncify.State.Normal;
   runAndAbortIfError(_asyncify_stop_rewind);
   _free(Asyncify.currData);
   Asyncify.currData = null;
   Asyncify.sleepCallbacks.forEach(func => callUserCallback(func));
  } else {
   abort(`invalid state: ${Asyncify.state}`);
  }
  return Asyncify.handleSleepReturnValue;
 },
 handleAsync(startAsync) {
  return Asyncify.handleSleep(wakeUp => {
   startAsync().then(wakeUp);
  });
 }
};

var Fibers = {
 nextFiber: 0,
 trampolineRunning: false,
 trampoline() {
  if (!Fibers.trampolineRunning && Fibers.nextFiber) {
   Fibers.trampolineRunning = true;
   do {
    var fiber = Fibers.nextFiber;
    Fibers.nextFiber = 0;
    Fibers.finishContextSwitch(fiber);
   } while (Fibers.nextFiber);
   Fibers.trampolineRunning = false;
  }
 },
 finishContextSwitch(newFiber) {
  var stack_base = HEAPU32[((newFiber) >>> 2) >>> 0];
  var stack_max = HEAPU32[(((newFiber) + (4)) >>> 2) >>> 0];
  _emscripten_stack_set_limits(stack_base, stack_max);
  stackRestore(HEAPU32[(((newFiber) + (8)) >>> 2) >>> 0]);
  var entryPoint = HEAPU32[(((newFiber) + (12)) >>> 2) >>> 0];
  if (entryPoint !== 0) {
   Asyncify.currData = null;
   HEAPU32[(((newFiber) + (12)) >>> 2) >>> 0] = 0;
   var userData = HEAPU32[(((newFiber) + (16)) >>> 2) >>> 0];
   (a1 => dynCall_vi.apply(null, [ entryPoint, a1 ]))(userData);
  } else {
   var asyncifyData = newFiber + 20;
   Asyncify.currData = asyncifyData;
   Asyncify.state = Asyncify.State.Rewinding;
   _asyncify_start_rewind(asyncifyData);
   Asyncify.doRewind(asyncifyData);
  }
 }
};

function _emscripten_fiber_swap(oldFiber, newFiber) {
 oldFiber >>>= 0;
 newFiber >>>= 0;
 if (ABORT) return;
 if (Asyncify.state === Asyncify.State.Normal) {
  Asyncify.state = Asyncify.State.Unwinding;
  var asyncifyData = oldFiber + 20;
  Asyncify.setDataRewindFunc(asyncifyData);
  Asyncify.currData = asyncifyData;
  _asyncify_start_unwind(asyncifyData);
  var stackTop = stackSave();
  HEAPU32[(((oldFiber) + (8)) >>> 2) >>> 0] = stackTop;
  Fibers.nextFiber = newFiber;
 } else {
  Asyncify.state = Asyncify.State.Normal;
  _asyncify_stop_rewind();
  Asyncify.currData = null;
 }
}

_emscripten_fiber_swap.isAsync = true;

var getHeapMax = () => HEAPU8.length;

function _emscripten_get_heap_max() {
 return getHeapMax();
}

var _emscripten_get_now;

_emscripten_get_now = () => performance.timeOrigin + performance.now();

var _emscripten_num_logical_cores = () => {
 if (ENVIRONMENT_IS_NODE) return require("os").cpus().length;
 return navigator["hardwareConcurrency"];
};

function _emscripten_out(str) {
 str >>>= 0;
 return out(UTF8ToString(str));
}

var abortOnCannotGrowMemory = requestedSize => {
 abort("OOM");
};

function _emscripten_resize_heap(requestedSize) {
 requestedSize >>>= 0;
 var oldSize = HEAPU8.length;
 abortOnCannotGrowMemory(requestedSize);
}

var _emscripten_runtime_keepalive_check = keepRuntimeAlive;

/** @param {number=} timeout */ var safeSetTimeout = (func, timeout) => {
 runtimeKeepalivePush();
 return setTimeout(() => {
  runtimeKeepalivePop();
  callUserCallback(func);
 }, timeout);
};

var _emscripten_sleep = ms => Asyncify.handleSleep(wakeUp => safeSetTimeout(wakeUp, ms));

_emscripten_sleep.isAsync = true;

var _emscripten_unwind_to_js_event_loop = () => {
 throw "unwind";
};

var ENV = {};

var getExecutableName = () => thisProgram || "./this.program";

var getEnvStrings = () => {
 if (!getEnvStrings.strings) {
  var lang = ((typeof navigator == "object" && navigator.languages && navigator.languages[0]) || "C").replace("-", "_") + ".UTF-8";
  var env = {
   "USER": "web_user",
   "LOGNAME": "web_user",
   "PATH": "/",
   "PWD": "/",
   "HOME": "/home/web_user",
   "LANG": lang,
   "_": getExecutableName()
  };
  for (var x in ENV) {
   if (ENV[x] === undefined) delete env[x]; else env[x] = ENV[x];
  }
  var strings = [];
  for (var x in env) {
   strings.push(`${x}=${env[x]}`);
  }
  getEnvStrings.strings = strings;
 }
 return getEnvStrings.strings;
};

var stringToAscii = (str, buffer) => {
 for (var i = 0; i < str.length; ++i) {
  HEAP8[((buffer++) >>> 0) >>> 0] = str.charCodeAt(i);
 }
 HEAP8[((buffer) >>> 0) >>> 0] = 0;
};

var _environ_get = function(__environ, environ_buf) {
 if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(4, 1, __environ, environ_buf);
 __environ >>>= 0;
 environ_buf >>>= 0;
 var bufSize = 0;
 getEnvStrings().forEach((string, i) => {
  var ptr = environ_buf + bufSize;
  HEAPU32[(((__environ) + (i * 4)) >>> 2) >>> 0] = ptr;
  stringToAscii(string, ptr);
  bufSize += string.length + 1;
 });
 return 0;
};

var _environ_sizes_get = function(penviron_count, penviron_buf_size) {
 if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(5, 1, penviron_count, penviron_buf_size);
 penviron_count >>>= 0;
 penviron_buf_size >>>= 0;
 var strings = getEnvStrings();
 HEAPU32[((penviron_count) >>> 2) >>> 0] = strings.length;
 var bufSize = 0;
 strings.forEach(string => bufSize += string.length + 1);
 HEAPU32[((penviron_buf_size) >>> 2) >>> 0] = bufSize;
 return 0;
};

var Sockets = {
 BUFFER_SIZE: 10240,
 MAX_BUFFER_SIZE: 10485760,
 nextFd: 1,
 fds: {},
 nextport: 1,
 maxport: 65535,
 peer: null,
 connections: {},
 portmap: {},
 localAddr: 4261412874,
 addrPool: [ 33554442, 50331658, 67108874, 83886090, 100663306, 117440522, 134217738, 150994954, 167772170, 184549386, 201326602, 218103818, 234881034 ]
};

var inetPton4 = str => {
 var b = str.split(".");
 for (var i = 0; i < 4; i++) {
  var tmp = Number(b[i]);
  if (isNaN(tmp)) return null;
  b[i] = tmp;
 }
 return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
};

/** @suppress {checkTypes} */ var jstoi_q = str => parseInt(str);

var inetPton6 = str => {
 var words;
 var w, offset, z, i;
 /* http://home.deds.nl/~aeron/regex/ */ var valid6regx = /^((?=.*::)(?!.*::.+::)(::)?([\dA-F]{1,4}:(:|\b)|){5}|([\dA-F]{1,4}:){6})((([\dA-F]{1,4}((?!\3)::|:\b|$))|(?!\2\3)){2}|(((2[0-4]|1\d|[1-9])?\d|25[0-5])\.?\b){4})$/i;
 var parts = [];
 if (!valid6regx.test(str)) {
  return null;
 }
 if (str === "::") {
  return [ 0, 0, 0, 0, 0, 0, 0, 0 ];
 }
 if (str.startsWith("::")) {
  str = str.replace("::", "Z:");
 } else  {
  str = str.replace("::", ":Z:");
 }
 if (str.indexOf(".") > 0) {
  str = str.replace(new RegExp("[.]", "g"), ":");
  words = str.split(":");
  words[words.length - 4] = jstoi_q(words[words.length - 4]) + jstoi_q(words[words.length - 3]) * 256;
  words[words.length - 3] = jstoi_q(words[words.length - 2]) + jstoi_q(words[words.length - 1]) * 256;
  words = words.slice(0, words.length - 2);
 } else {
  words = str.split(":");
 }
 offset = 0;
 z = 0;
 for (w = 0; w < words.length; w++) {
  if (typeof words[w] == "string") {
   if (words[w] === "Z") {
    for (z = 0; z < (8 - words.length + 1); z++) {
     parts[w + z] = 0;
    }
    offset = z - 1;
   } else {
    parts[w + offset] = _htons(parseInt(words[w], 16));
   }
  } else {
   parts[w + offset] = words[w];
  }
 }
 return [ (parts[1] << 16) | parts[0], (parts[3] << 16) | parts[2], (parts[5] << 16) | parts[4], (parts[7] << 16) | parts[6] ];
};

var DNS = {
 address_map: {
  id: 1,
  addrs: {},
  names: {}
 },
 lookup_name(name) {
  var res = inetPton4(name);
  if (res !== null) {
   return name;
  }
  res = inetPton6(name);
  if (res !== null) {
   return name;
  }
  var addr;
  if (DNS.address_map.addrs[name]) {
   addr = DNS.address_map.addrs[name];
  } else {
   var id = DNS.address_map.id++;
   assert(id < 65535, "exceeded max address mappings of 65535");
   addr = "172.29." + (id & 255) + "." + (id & 65280);
   DNS.address_map.names[addr] = name;
   DNS.address_map.addrs[name] = addr;
  }
  return addr;
 },
 lookup_addr(addr) {
  if (DNS.address_map.names[addr]) {
   return DNS.address_map.names[addr];
  }
  return null;
 }
};

var inetNtop4 = addr => (addr & 255) + "." + ((addr >> 8) & 255) + "." + ((addr >> 16) & 255) + "." + ((addr >> 24) & 255);

var inetNtop6 = ints => {
 var str = "";
 var word = 0;
 var longest = 0;
 var lastzero = 0;
 var zstart = 0;
 var len = 0;
 var i = 0;
 var parts = [ ints[0] & 65535, (ints[0] >> 16), ints[1] & 65535, (ints[1] >> 16), ints[2] & 65535, (ints[2] >> 16), ints[3] & 65535, (ints[3] >> 16) ];
 var hasipv4 = true;
 var v4part = "";
 for (i = 0; i < 5; i++) {
  if (parts[i] !== 0) {
   hasipv4 = false;
   break;
  }
 }
 if (hasipv4) {
  v4part = inetNtop4(parts[6] | (parts[7] << 16));
  if (parts[5] === -1) {
   str = "::ffff:";
   str += v4part;
   return str;
  }
  if (parts[5] === 0) {
   str = "::";
   if (v4part === "0.0.0.0") v4part = "";
   if (v4part === "0.0.0.1") v4part = "1";
   str += v4part;
   return str;
  }
 }
 for (word = 0; word < 8; word++) {
  if (parts[word] === 0) {
   if (word - lastzero > 1) {
    len = 0;
   }
   lastzero = word;
   len++;
  }
  if (len > longest) {
   longest = len;
   zstart = word - longest + 1;
  }
 }
 for (word = 0; word < 8; word++) {
  if (longest > 1) {
   if (parts[word] === 0 && word >= zstart && word < (zstart + longest)) {
    if (word === zstart) {
     str += ":";
     if (zstart === 0) str += ":";
    }
    continue;
   }
  }
  str += Number(_ntohs(parts[word] & 65535)).toString(16);
  str += word < 7 ? ":" : "";
 }
 return str;
};

/** @param {number=} addrlen */ var writeSockaddr = (sa, family, addr, port, addrlen) => {
 switch (family) {
 case 2:
  addr = inetPton4(addr);
  zeroMemory(sa, 16);
  if (addrlen) {
   HEAP32[((addrlen) >>> 2) >>> 0] = 16;
  }
  HEAP16[((sa) >>> 1) >>> 0] = family;
  HEAP32[(((sa) + (4)) >>> 2) >>> 0] = addr;
  HEAP16[(((sa) + (2)) >>> 1) >>> 0] = _htons(port);
  break;

 case 10:
  addr = inetPton6(addr);
  zeroMemory(sa, 28);
  if (addrlen) {
   HEAP32[((addrlen) >>> 2) >>> 0] = 28;
  }
  HEAP32[((sa) >>> 2) >>> 0] = family;
  HEAP32[(((sa) + (8)) >>> 2) >>> 0] = addr[0];
  HEAP32[(((sa) + (12)) >>> 2) >>> 0] = addr[1];
  HEAP32[(((sa) + (16)) >>> 2) >>> 0] = addr[2];
  HEAP32[(((sa) + (20)) >>> 2) >>> 0] = addr[3];
  HEAP16[(((sa) + (2)) >>> 1) >>> 0] = _htons(port);
  break;

 default:
  return 5;
 }
 return 0;
};

function _getaddrinfo(node, service, hint, out) {
 if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(6, 1, node, service, hint, out);
 node >>>= 0;
 service >>>= 0;
 hint >>>= 0;
 out >>>= 0;
 var addrs = [];
 var canon = null;
 var addr = 0;
 var port = 0;
 var flags = 0;
 var family = 0;
 var type = 0;
 var proto = 0;
 var ai, last;
 function allocaddrinfo(family, type, proto, canon, addr, port) {
  var sa, salen, ai;
  var errno;
  salen = family === 10 ? 28 : 16;
  addr = family === 10 ? inetNtop6(addr) : inetNtop4(addr);
  sa = _malloc(salen);
  errno = writeSockaddr(sa, family, addr, port);
  assert(!errno);
  ai = _malloc(32);
  HEAP32[(((ai) + (4)) >>> 2) >>> 0] = family;
  HEAP32[(((ai) + (8)) >>> 2) >>> 0] = type;
  HEAP32[(((ai) + (12)) >>> 2) >>> 0] = proto;
  HEAPU32[(((ai) + (24)) >>> 2) >>> 0] = canon;
  HEAPU32[(((ai) + (20)) >>> 2) >>> 0] = sa;
  if (family === 10) {
   HEAP32[(((ai) + (16)) >>> 2) >>> 0] = 28;
  } else {
   HEAP32[(((ai) + (16)) >>> 2) >>> 0] = 16;
  }
  HEAP32[(((ai) + (28)) >>> 2) >>> 0] = 0;
  return ai;
 }
 if (hint) {
  flags = HEAP32[((hint) >>> 2) >>> 0];
  family = HEAP32[(((hint) + (4)) >>> 2) >>> 0];
  type = HEAP32[(((hint) + (8)) >>> 2) >>> 0];
  proto = HEAP32[(((hint) + (12)) >>> 2) >>> 0];
 }
 if (type && !proto) {
  proto = type === 2 ? 17 : 6;
 }
 if (!type && proto) {
  type = proto === 17 ? 2 : 1;
 }
 if (proto === 0) {
  proto = 6;
 }
 if (type === 0) {
  type = 1;
 }
 if (!node && !service) {
  return -2;
 }
 if (flags & ~(1 | 2 | 4 | 1024 | 8 | 16 | 32)) {
  return -1;
 }
 if (hint !== 0 && (HEAP32[((hint) >>> 2) >>> 0] & 2) && !node) {
  return -1;
 }
 if (flags & 32) {
  return -2;
 }
 if (type !== 0 && type !== 1 && type !== 2) {
  return -7;
 }
 if (family !== 0 && family !== 2 && family !== 10) {
  return -6;
 }
 if (service) {
  service = UTF8ToString(service);
  port = parseInt(service, 10);
  if (isNaN(port)) {
   if (flags & 1024) {
    return -2;
   }
   return -8;
  }
 }
 if (!node) {
  if (family === 0) {
   family = 2;
  }
  if ((flags & 1) === 0) {
   if (family === 2) {
    addr = _htonl(2130706433);
   } else {
    addr = [ 0, 0, 0, 1 ];
   }
  }
  ai = allocaddrinfo(family, type, proto, null, addr, port);
  HEAPU32[((out) >>> 2) >>> 0] = ai;
  return 0;
 }
 node = UTF8ToString(node);
 addr = inetPton4(node);
 if (addr !== null) {
  if (family === 0 || family === 2) {
   family = 2;
  } else if (family === 10 && (flags & 8)) {
   addr = [ 0, 0, _htonl(65535), addr ];
   family = 10;
  } else {
   return -2;
  }
 } else {
  addr = inetPton6(node);
  if (addr !== null) {
   if (family === 0 || family === 10) {
    family = 10;
   } else {
    return -2;
   }
  }
 }
 if (addr != null) {
  ai = allocaddrinfo(family, type, proto, node, addr, port);
  HEAPU32[((out) >>> 2) >>> 0] = ai;
  return 0;
 }
 if (flags & 4) {
  return -2;
 }
 node = DNS.lookup_name(node);
 addr = inetPton4(node);
 if (family === 0) {
  family = 2;
 } else if (family === 10) {
  addr = [ 0, 0, _htonl(65535), addr ];
 }
 ai = allocaddrinfo(family, type, proto, null, addr, port);
 HEAPU32[((out) >>> 2) >>> 0] = ai;
 return 0;
}

var initRandomFill = () => {
 if (typeof crypto == "object" && typeof crypto["getRandomValues"] == "function") {
  return view => (view.set(crypto.getRandomValues(new Uint8Array(view.byteLength))), 
  view);
 } else if (ENVIRONMENT_IS_NODE) {
  try {
   var crypto_module = require("crypto");
   var randomFillSync = crypto_module["randomFillSync"];
   if (randomFillSync) {
    return view => crypto_module["randomFillSync"](view);
   }
   var randomBytes = crypto_module["randomBytes"];
   return view => (view.set(randomBytes(view.byteLength)),  view);
  } catch (e) {}
 }
 abort("initRandomDevice");
};

var randomFill = view => (randomFill = initRandomFill())(view);

function _getentropy(buffer, size) {
 buffer >>>= 0;
 size >>>= 0;
 randomFill(HEAPU8.subarray(buffer >>> 0, buffer + size >>> 0));
 return 0;
}

var getHostByName = name => {
 var ret = _malloc(20);
 var nameBuf = stringToNewUTF8(name);
 HEAPU32[((ret) >>> 2) >>> 0] = nameBuf;
 var aliasesBuf = _malloc(4);
 HEAPU32[((aliasesBuf) >>> 2) >>> 0] = 0;
 HEAPU32[(((ret) + (4)) >>> 2) >>> 0] = aliasesBuf;
 var afinet = 2;
 HEAP32[(((ret) + (8)) >>> 2) >>> 0] = afinet;
 HEAP32[(((ret) + (12)) >>> 2) >>> 0] = 4;
 var addrListBuf = _malloc(12);
 HEAPU32[((addrListBuf) >>> 2) >>> 0] = addrListBuf + 8;
 HEAPU32[(((addrListBuf) + (4)) >>> 2) >>> 0] = 0;
 HEAP32[(((addrListBuf) + (8)) >>> 2) >>> 0] = inetPton4(DNS.lookup_name(name));
 HEAPU32[(((ret) + (16)) >>> 2) >>> 0] = addrListBuf;
 return ret;
};

function _gethostbyname(name) {
 if (ENVIRONMENT_IS_PTHREAD) return proxyToMainThread(7, 1, name);
 name >>>= 0;
 return getHostByName(UTF8ToString(name));
}

var readSockaddr = (sa, salen) => {
 var family = HEAP16[((sa) >>> 1) >>> 0];
 var port = _ntohs(HEAPU16[(((sa) + (2)) >>> 1) >>> 0]);
 var addr;
 switch (family) {
 case 2:
  if (salen !== 16) {
   return {
    errno: 28
   };
  }
  addr = HEAP32[(((sa) + (4)) >>> 2) >>> 0];
  addr = inetNtop4(addr);
  break;

 case 10:
  if (salen !== 28) {
   return {
    errno: 28
   };
  }
  addr = [ HEAP32[(((sa) + (8)) >>> 2) >>> 0], HEAP32[(((sa) + (12)) >>> 2) >>> 0], HEAP32[(((sa) + (16)) >>> 2) >>> 0], HEAP32[(((sa) + (20)) >>> 2) >>> 0] ];
  addr = inetNtop6(addr);
  break;

 default:
  return {
   errno: 5
  };
 }
 return {
  family: family,
  addr: addr,
  port: port
 };
};

function _getnameinfo(sa, salen, node, nodelen, serv, servlen, flags) {
 sa >>>= 0;
 node >>>= 0;
 serv >>>= 0;
 var info = readSockaddr(sa, salen);
 if (info.errno) {
  return -6;
 }
 var port = info.port;
 var addr = info.addr;
 var overflowed = false;
 if (node && nodelen) {
  var lookup;
  if ((flags & 1) || !(lookup = DNS.lookup_addr(addr))) {
   if (flags & 8) {
    return -2;
   }
  } else {
   addr = lookup;
  }
  var numBytesWrittenExclNull = stringToUTF8(addr, node, nodelen);
  if (numBytesWrittenExclNull + 1 >= nodelen) {
   overflowed = true;
  }
 }
 if (serv && servlen) {
  port = "" + port;
  var numBytesWrittenExclNull = stringToUTF8(port, serv, servlen);
  if (numBytesWrittenExclNull + 1 >= servlen) {
   overflowed = true;
  }
 }
 if (overflowed) {
  return -12;
 }
 return 0;
}

var arraySum = (array, index) => {
 var sum = 0;
 for (var i = 0; i <= index; sum += array[i++]) {}
 return sum;
};

var MONTH_DAYS_LEAP = [ 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 ];

var MONTH_DAYS_REGULAR = [ 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 ];

var addDays = (date, days) => {
 var newDate = new Date(date.getTime());
 while (days > 0) {
  var leap = isLeapYear(newDate.getFullYear());
  var currentMonth = newDate.getMonth();
  var daysInCurrentMonth = (leap ? MONTH_DAYS_LEAP : MONTH_DAYS_REGULAR)[currentMonth];
  if (days > daysInCurrentMonth - newDate.getDate()) {
   days -= (daysInCurrentMonth - newDate.getDate() + 1);
   newDate.setDate(1);
   if (currentMonth < 11) {
    newDate.setMonth(currentMonth + 1);
   } else {
    newDate.setMonth(0);
    newDate.setFullYear(newDate.getFullYear() + 1);
   }
  } else {
   newDate.setDate(newDate.getDate() + days);
   return newDate;
  }
 }
 return newDate;
};

var writeArrayToMemory = (array, buffer) => {
 HEAP8.set(array, buffer >>> 0);
};

function _strftime(s, maxsize, format, tm) {
 s >>>= 0;
 maxsize >>>= 0;
 format >>>= 0;
 tm >>>= 0;
 var tm_zone = HEAPU32[(((tm) + (40)) >>> 2) >>> 0];
 var date = {
  tm_sec: HEAP32[((tm) >>> 2) >>> 0],
  tm_min: HEAP32[(((tm) + (4)) >>> 2) >>> 0],
  tm_hour: HEAP32[(((tm) + (8)) >>> 2) >>> 0],
  tm_mday: HEAP32[(((tm) + (12)) >>> 2) >>> 0],
  tm_mon: HEAP32[(((tm) + (16)) >>> 2) >>> 0],
  tm_year: HEAP32[(((tm) + (20)) >>> 2) >>> 0],
  tm_wday: HEAP32[(((tm) + (24)) >>> 2) >>> 0],
  tm_yday: HEAP32[(((tm) + (28)) >>> 2) >>> 0],
  tm_isdst: HEAP32[(((tm) + (32)) >>> 2) >>> 0],
  tm_gmtoff: HEAP32[(((tm) + (36)) >>> 2) >>> 0],
  tm_zone: tm_zone ? UTF8ToString(tm_zone) : ""
 };
 var pattern = UTF8ToString(format);
 var EXPANSION_RULES_1 = {
  "%c": "%a %b %d %H:%M:%S %Y",
  "%D": "%m/%d/%y",
  "%F": "%Y-%m-%d",
  "%h": "%b",
  "%r": "%I:%M:%S %p",
  "%R": "%H:%M",
  "%T": "%H:%M:%S",
  "%x": "%m/%d/%y",
  "%X": "%H:%M:%S",
  "%Ec": "%c",
  "%EC": "%C",
  "%Ex": "%m/%d/%y",
  "%EX": "%H:%M:%S",
  "%Ey": "%y",
  "%EY": "%Y",
  "%Od": "%d",
  "%Oe": "%e",
  "%OH": "%H",
  "%OI": "%I",
  "%Om": "%m",
  "%OM": "%M",
  "%OS": "%S",
  "%Ou": "%u",
  "%OU": "%U",
  "%OV": "%V",
  "%Ow": "%w",
  "%OW": "%W",
  "%Oy": "%y"
 };
 for (var rule in EXPANSION_RULES_1) {
  pattern = pattern.replace(new RegExp(rule, "g"), EXPANSION_RULES_1[rule]);
 }
 var WEEKDAYS = [ "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday" ];
 var MONTHS = [ "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December" ];
 function leadingSomething(value, digits, character) {
  var str = typeof value == "number" ? value.toString() : (value || "");
  while (str.length < digits) {
   str = character[0] + str;
  }
  return str;
 }
 function leadingNulls(value, digits) {
  return leadingSomething(value, digits, "0");
 }
 function compareByDay(date1, date2) {
  function sgn(value) {
   return value < 0 ? -1 : (value > 0 ? 1 : 0);
  }
  var compare;
  if ((compare = sgn(date1.getFullYear() - date2.getFullYear())) === 0) {
   if ((compare = sgn(date1.getMonth() - date2.getMonth())) === 0) {
    compare = sgn(date1.getDate() - date2.getDate());
   }
  }
  return compare;
 }
 function getFirstWeekStartDate(janFourth) {
  switch (janFourth.getDay()) {
  case 0:
   return new Date(janFourth.getFullYear() - 1, 11, 29);

  case 1:
   return janFourth;

  case 2:
   return new Date(janFourth.getFullYear(), 0, 3);

  case 3:
   return new Date(janFourth.getFullYear(), 0, 2);

  case 4:
   return new Date(janFourth.getFullYear(), 0, 1);

  case 5:
   return new Date(janFourth.getFullYear() - 1, 11, 31);

  case 6:
   return new Date(janFourth.getFullYear() - 1, 11, 30);
  }
 }
 function getWeekBasedYear(date) {
  var thisDate = addDays(new Date(date.tm_year + 1900, 0, 1), date.tm_yday);
  var janFourthThisYear = new Date(thisDate.getFullYear(), 0, 4);
  var janFourthNextYear = new Date(thisDate.getFullYear() + 1, 0, 4);
  var firstWeekStartThisYear = getFirstWeekStartDate(janFourthThisYear);
  var firstWeekStartNextYear = getFirstWeekStartDate(janFourthNextYear);
  if (compareByDay(firstWeekStartThisYear, thisDate) <= 0) {
   if (compareByDay(firstWeekStartNextYear, thisDate) <= 0) {
    return thisDate.getFullYear() + 1;
   }
   return thisDate.getFullYear();
  }
  return thisDate.getFullYear() - 1;
 }
 var EXPANSION_RULES_2 = {
  "%a": date => WEEKDAYS[date.tm_wday].substring(0, 3),
  "%A": date => WEEKDAYS[date.tm_wday],
  "%b": date => MONTHS[date.tm_mon].substring(0, 3),
  "%B": date => MONTHS[date.tm_mon],
  "%C": date => {
   var year = date.tm_year + 1900;
   return leadingNulls((year / 100) | 0, 2);
  },
  "%d": date => leadingNulls(date.tm_mday, 2),
  "%e": date => leadingSomething(date.tm_mday, 2, " "),
  "%g": date => getWeekBasedYear(date).toString().substring(2),
  "%G": date => getWeekBasedYear(date),
  "%H": date => leadingNulls(date.tm_hour, 2),
  "%I": date => {
   var twelveHour = date.tm_hour;
   if (twelveHour == 0) twelveHour = 12; else if (twelveHour > 12) twelveHour -= 12;
   return leadingNulls(twelveHour, 2);
  },
  "%j": date => leadingNulls(date.tm_mday + arraySum(isLeapYear(date.tm_year + 1900) ? MONTH_DAYS_LEAP : MONTH_DAYS_REGULAR, date.tm_mon - 1), 3),
  "%m": date => leadingNulls(date.tm_mon + 1, 2),
  "%M": date => leadingNulls(date.tm_min, 2),
  "%n": () => "\n",
  "%p": date => {
   if (date.tm_hour >= 0 && date.tm_hour < 12) {
    return "AM";
   }
   return "PM";
  },
  "%S": date => leadingNulls(date.tm_sec, 2),
  "%t": () => "\t",
  "%u": date => date.tm_wday || 7,
  "%U": date => {
   var days = date.tm_yday + 7 - date.tm_wday;
   return leadingNulls(Math.floor(days / 7), 2);
  },
  "%V": date => {
   var val = Math.floor((date.tm_yday + 7 - (date.tm_wday + 6) % 7) / 7);
   if ((date.tm_wday + 371 - date.tm_yday - 2) % 7 <= 2) {
    val++;
   }
   if (!val) {
    val = 52;
    var dec31 = (date.tm_wday + 7 - date.tm_yday - 1) % 7;
    if (dec31 == 4 || (dec31 == 5 && isLeapYear(date.tm_year % 400 - 1))) {
     val++;
    }
   } else if (val == 53) {
    var jan1 = (date.tm_wday + 371 - date.tm_yday) % 7;
    if (jan1 != 4 && (jan1 != 3 || !isLeapYear(date.tm_year))) val = 1;
   }
   return leadingNulls(val, 2);
  },
  "%w": date => date.tm_wday,
  "%W": date => {
   var days = date.tm_yday + 7 - ((date.tm_wday + 6) % 7);
   return leadingNulls(Math.floor(days / 7), 2);
  },
  "%y": date => (date.tm_year + 1900).toString().substring(2),
  "%Y": date => date.tm_year + 1900,
  "%z": date => {
   var off = date.tm_gmtoff;
   var ahead = off >= 0;
   off = Math.abs(off) / 60;
   off = (off / 60) * 100 + (off % 60);
   return (ahead ? "+" : "-") + String("0000" + off).slice(-4);
  },
  "%Z": date => date.tm_zone,
  "%%": () => "%"
 };
 pattern = pattern.replace(/%%/g, "\0\0");
 for (var rule in EXPANSION_RULES_2) {
  if (pattern.includes(rule)) {
   pattern = pattern.replace(new RegExp(rule, "g"), EXPANSION_RULES_2[rule](date));
  }
 }
 pattern = pattern.replace(/\0\0/g, "%");
 var bytes = intArrayFromString(pattern, false);
 if (bytes.length > maxsize) {
  return 0;
 }
 writeArrayToMemory(bytes, s);
 return bytes.length - 1;
}

var stringToUTF8OnStack = str => {
 var size = lengthBytesUTF8(str) + 1;
 var ret = stackAlloc(size);
 stringToUTF8(str, ret, size);
 return ret;
};

var wasmTableMirror = [];

var wasmTable;

var getWasmTableEntry = funcPtr => {
 var func = wasmTableMirror[funcPtr];
 if (!func) {
  if (funcPtr >= wasmTableMirror.length) wasmTableMirror.length = funcPtr + 1;
  wasmTableMirror[funcPtr] = func = wasmTable.get(funcPtr);
 }
 return func;
};

var setWasmTableEntry = (idx, func) => {
 wasmTable.set(idx, func);
 wasmTableMirror[idx] = wasmTable.get(idx);
};

var freeTableIndexes = [];

var getEmptyTableSlot = () => {
 if (freeTableIndexes.length) {
  return freeTableIndexes.pop();
 }
 try {
  wasmTable.grow(1);
 } catch (err) {
  if (!(err instanceof RangeError)) {
   throw err;
  }
  throw "Unable to grow wasm table. Set ALLOW_TABLE_GROWTH.";
 }
 return wasmTable.length - 1;
};

var uleb128Encode = (n, target) => {
 if (n < 128) {
  target.push(n);
 } else {
  target.push((n % 128) | 128, n >> 7);
 }
};

var generateFuncType = (sig, target) => {
 var sigRet = sig.slice(0, 1);
 var sigParam = sig.slice(1);
 var typeCodes = {
  "i": 127,
  "p": 127,
  "j": 126,
  "f": 125,
  "d": 124,
  "e": 111
 };
 target.push(96);
 /* form: func */ uleb128Encode(sigParam.length, target);
 for (var i = 0; i < sigParam.length; ++i) {
  target.push(typeCodes[sigParam[i]]);
 }
 if (sigRet == "v") {
  target.push(0);
 } else {
  target.push(1, typeCodes[sigRet]);
 }
};

var convertJsFunctionToWasm = (func, sig) => {
 if (typeof WebAssembly.Function == "function") {
  return new WebAssembly.Function(sigToWasmTypes(sig), func);
 }
 var typeSectionBody = [ 1 ];
 generateFuncType(sig, typeSectionBody);
 var bytes = [ 0, 97, 115, 109,  1, 0, 0, 0,  1 ];
 uleb128Encode(typeSectionBody.length, bytes);
 bytes.push.apply(bytes, typeSectionBody);
 bytes.push(2, 7,  1, 1, 101, 1, 102, 0, 0, 7, 5,  1, 1, 102, 0, 0);
 var module = new WebAssembly.Module(new Uint8Array(bytes));
 var instance = new WebAssembly.Instance(module, {
  "e": {
   "f": func
  }
 });
 var wrappedFunc = instance.exports["f"];
 return wrappedFunc;
};

var MEMFS = {
 createBackend(opts) {
  return _wasmfs_create_memory_backend();
 }
};

var PATH = {
 isAbs: path => path.charAt(0) === "/",
 splitPath: filename => {
  var splitPathRe = /^(\/?|)([\s\S]*?)((?:\.{1,2}|[^\/]+?|)(\.[^.\/]*|))(?:[\/]*)$/;
  return splitPathRe.exec(filename).slice(1);
 },
 normalizeArray: (parts, allowAboveRoot) => {
  var up = 0;
  for (var i = parts.length - 1; i >= 0; i--) {
   var last = parts[i];
   if (last === ".") {
    parts.splice(i, 1);
   } else if (last === "..") {
    parts.splice(i, 1);
    up++;
   } else if (up) {
    parts.splice(i, 1);
    up--;
   }
  }
  if (allowAboveRoot) {
   for (;up; up--) {
    parts.unshift("..");
   }
  }
  return parts;
 },
 normalize: path => {
  var isAbsolute = PATH.isAbs(path), trailingSlash = path.substr(-1) === "/";
  path = PATH.normalizeArray(path.split("/").filter(p => !!p), !isAbsolute).join("/");
  if (!path && !isAbsolute) {
   path = ".";
  }
  if (path && trailingSlash) {
   path += "/";
  }
  return (isAbsolute ? "/" : "") + path;
 },
 dirname: path => {
  var result = PATH.splitPath(path), root = result[0], dir = result[1];
  if (!root && !dir) {
   return ".";
  }
  if (dir) {
   dir = dir.substr(0, dir.length - 1);
  }
  return root + dir;
 },
 basename: path => {
  if (path === "/") return "/";
  path = PATH.normalize(path);
  path = path.replace(/\/$/, "");
  var lastSlash = path.lastIndexOf("/");
  if (lastSlash === -1) return path;
  return path.substr(lastSlash + 1);
 },
 join: function() {
  var paths = Array.prototype.slice.call(arguments);
  return PATH.normalize(paths.join("/"));
 },
 join2: (l, r) => PATH.normalize(l + "/" + r)
};

var readI53FromI64 = ptr => HEAPU32[((ptr) >>> 2) >>> 0] + HEAP32[(((ptr) + (4)) >>> 2) >>> 0] * 4294967296;

var readI53FromU64 = ptr => HEAPU32[((ptr) >>> 2) >>> 0] + HEAPU32[(((ptr) + (4)) >>> 2) >>> 0] * 4294967296;

var FS_mknod = (path, mode, dev) => FS.handleError(withStackSave(() => {
 var pathBuffer = stringToUTF8OnStack(path);
 return __wasmfs_mknod(pathBuffer, mode, dev);
}));

var FS_create = (path, mode) => {
 mode = mode !== undefined ? mode : 438;
 /* 0666 */ mode &= 4095;
 mode |= 32768;
 return FS_mknod(path, mode, 0);
};

var FS_writeFile = (path, data) => withStackSave(() => {
 var pathBuffer = stringToUTF8OnStack(path);
 if (typeof data == "string") {
  var buf = new Uint8Array(lengthBytesUTF8(data) + 1);
  var actualNumBytes = stringToUTF8Array(data, buf, 0, buf.length);
  data = buf.slice(0, actualNumBytes);
 }
 var dataBuffer = _malloc(data.length);
 for (var i = 0; i < data.length; i++) {
  HEAP8[(((dataBuffer) + (i)) >>> 0) >>> 0] = data[i];
 }
 var ret = __wasmfs_write_file(pathBuffer, dataBuffer, data.length);
 _free(dataBuffer);
 return ret;
});

var FS_createDataFile = (parent, name, fileData, canRead, canWrite, canOwn) => {
 var pathName = name ? parent + "/" + name : parent;
 var mode = FS_getMode(canRead, canWrite);
 if (!wasmFSPreloadingFlushed) {
  wasmFSPreloadedFiles.push({
   pathName: pathName,
   fileData: fileData,
   mode: mode
  });
 } else {
  FS_create(pathName, mode);
  FS_writeFile(pathName, fileData);
 }
};

/** @param {boolean=} noRunDep */ var asyncLoad = (url, onload, onerror, noRunDep) => {
 var dep = !noRunDep ? getUniqueRunDependency(`al ${url}`) : "";
 readAsync(url, arrayBuffer => {
  assert(arrayBuffer, `Loading data file "${url}" failed (no arrayBuffer).`);
  onload(new Uint8Array(arrayBuffer));
  if (dep) removeRunDependency(dep);
 }, event => {
  if (onerror) {
   onerror();
  } else {
   throw `Loading data file "${url}" failed.`;
  }
 });
 if (dep) addRunDependency(dep);
};

var PATH_FS = {
 resolve: function() {
  var resolvedPath = "", resolvedAbsolute = false;
  for (var i = arguments.length - 1; i >= -1 && !resolvedAbsolute; i--) {
   var path = (i >= 0) ? arguments[i] : FS.cwd();
   if (typeof path != "string") {
    throw new TypeError("Arguments to path.resolve must be strings");
   } else if (!path) {
    return "";
   }
   resolvedPath = path + "/" + resolvedPath;
   resolvedAbsolute = PATH.isAbs(path);
  }
  resolvedPath = PATH.normalizeArray(resolvedPath.split("/").filter(p => !!p), !resolvedAbsolute).join("/");
  return ((resolvedAbsolute ? "/" : "") + resolvedPath) || ".";
 },
 relative: (from, to) => {
  from = PATH_FS.resolve(from).substr(1);
  to = PATH_FS.resolve(to).substr(1);
  function trim(arr) {
   var start = 0;
   for (;start < arr.length; start++) {
    if (arr[start] !== "") break;
   }
   var end = arr.length - 1;
   for (;end >= 0; end--) {
    if (arr[end] !== "") break;
   }
   if (start > end) return [];
   return arr.slice(start, end - start + 1);
  }
  var fromParts = trim(from.split("/"));
  var toParts = trim(to.split("/"));
  var length = Math.min(fromParts.length, toParts.length);
  var samePartsLength = length;
  for (var i = 0; i < length; i++) {
   if (fromParts[i] !== toParts[i]) {
    samePartsLength = i;
    break;
   }
  }
  var outputParts = [];
  for (var i = samePartsLength; i < fromParts.length; i++) {
   outputParts.push("..");
  }
  outputParts = outputParts.concat(toParts.slice(samePartsLength));
  return outputParts.join("/");
 }
};

var preloadPlugins = Module["preloadPlugins"] || [];

var FS_handledByPreloadPlugin = (byteArray, fullname, finish, onerror) => {
 if (typeof Browser != "undefined") Browser.init();
 var handled = false;
 preloadPlugins.forEach(plugin => {
  if (handled) return;
  if (plugin["canHandle"](fullname)) {
   plugin["handle"](byteArray, fullname, finish, onerror);
   handled = true;
  }
 });
 return handled;
};

var FS_createPreloadedFile = (parent, name, url, canRead, canWrite, onload, onerror, dontCreateFile, canOwn, preFinish) => {
 var fullname = name ? PATH_FS.resolve(PATH.join2(parent, name)) : parent;
 var dep = getUniqueRunDependency(`cp ${fullname}`);
 function processData(byteArray) {
  function finish(byteArray) {
   if (preFinish) preFinish();
   if (!dontCreateFile) {
    FS_createDataFile(parent, name, byteArray, canRead, canWrite, canOwn);
   }
   if (onload) onload();
   removeRunDependency(dep);
  }
  if (FS_handledByPreloadPlugin(byteArray, fullname, finish, () => {
   if (onerror) onerror();
   removeRunDependency(dep);
  })) {
   return;
  }
  finish(byteArray);
 }
 addRunDependency(dep);
 if (typeof url == "string") {
  asyncLoad(url, byteArray => processData(byteArray), onerror);
 } else {
  processData(url);
 }
};

var FS_getMode = (canRead, canWrite) => {
 var mode = 0;
 if (canRead) mode |= 292 | 73;
 if (canWrite) mode |= 146;
 return mode;
};

var FS_modeStringToFlags = str => {
 var flagModes = {
  "r": 0,
  "r+": 2,
  "w": 512 | 64 | 1,
  "w+": 512 | 64 | 2,
  "a": 1024 | 64 | 1,
  "a+": 1024 | 64 | 2
 };
 var flags = flagModes[str];
 if (typeof flags == "undefined") {
  throw new Error(`Unknown file open mode: ${str}`);
 }
 return flags;
};

var FS_mkdir = (path, mode) => FS.handleError(withStackSave(() => {
 mode = mode !== undefined ? mode : 511;
 /* 0777 */ var buffer = stringToUTF8OnStack(path);
 return __wasmfs_mkdir(buffer, mode);
}));

/**
     * @param {number=} mode Optionally, the mode to create in. Uses mkdir's
     *                       default if not set.
     */ var FS_mkdirTree = (path, mode) => {
 var dirs = path.split("/");
 var d = "";
 for (var i = 0; i < dirs.length; ++i) {
  if (!dirs[i]) continue;
  d += "/" + dirs[i];
  try {
   FS_mkdir(d, mode);
  } catch (e) {
   if (e.errno != 20) throw e;
  }
 }
};

var FS_unlink = path => withStackSave(() => {
 var buffer = stringToUTF8OnStack(path);
 return __wasmfs_unlink(buffer);
});

var OPFS = {
 createBackend(opts) {
  return _wasmfs_create_opfs_backend();
 }
};

var wasmFS$backends = {};

var wasmFSDevices = {};

var wasmFSDeviceStreams = {};

var FS = {
 init() {
  FS.ensureErrnoError();
 },
 ErrnoError: null,
 handleError(returnValue) {
  if (returnValue < 0) {
   throw new FS.ErrnoError(-returnValue);
  }
  return returnValue;
 },
 ensureErrnoError() {
  if (FS.ErrnoError) return;
  FS.ErrnoError = /** @this{Object} */ function ErrnoError(code) {
   this.errno = code;
   this.message = "FS error";
   this.name = "ErrnoError";
  };
  FS.ErrnoError.prototype = new Error;
  FS.ErrnoError.prototype.constructor = FS.ErrnoError;
 },
 createDataFile(parent, name, fileData, canRead, canWrite, canOwn) {
  FS_createDataFile(parent, name, fileData, canRead, canWrite, canOwn);
 },
 createPath(parent, path, canRead, canWrite) {
  var parts = path.split("/").reverse();
  while (parts.length) {
   var part = parts.pop();
   if (!part) continue;
   var current = PATH.join2(parent, part);
   if (!wasmFSPreloadingFlushed) {
    wasmFSPreloadedDirs.push({
     parentPath: parent,
     childName: part
    });
   } else {
    FS.mkdir(current);
   }
   parent = current;
  }
  return current;
 },
 createPreloadedFile(parent, name, url, canRead, canWrite, onload, onerror, dontCreateFile, canOwn, preFinish) {
  return FS_createPreloadedFile(parent, name, url, canRead, canWrite, onload, onerror, dontCreateFile, canOwn, preFinish);
 },
 readFile(path, opts = {}) {
  opts.encoding = opts.encoding || "binary";
  if (opts.encoding !== "utf8" && opts.encoding !== "binary") {
   throw new Error('Invalid encoding type "' + opts.encoding + '"');
  }
  var buf = withStackSave(() => __wasmfs_read_file(stringToUTF8OnStack(path)));
  var length = readI53FromI64(buf);
  var ret = new Uint8Array(HEAPU8.subarray(buf + 8 >>> 0, buf + 8 + length >>> 0));
  if (opts.encoding === "utf8") {
   ret = UTF8ArrayToString(ret, 0);
  }
  return ret;
 },
 cwd: () => UTF8ToString(__wasmfs_get_cwd()),
 analyzePath(path) {
  var exists = !!FS.findObject(path);
  return {
   exists: exists,
   object: {
    contents: exists ? FS.readFile(path) : null
   }
  };
 },
 mkdir: (path, mode) => FS_mkdir(path, mode),
 mkdirTree: (path, mode) => FS_mkdirTree(path, mode),
 rmdir: path => FS.handleError(withStackSave(() => __wasmfs_rmdir(stringToUTF8OnStack(path)))),
 open: (path, flags, mode) => withStackSave(() => {
  flags = typeof flags == "string" ? FS_modeStringToFlags(flags) : flags;
  mode = typeof mode == "undefined" ? 438 : /* 0666 */ mode;
  var buffer = stringToUTF8OnStack(path);
  var fd = FS.handleError(__wasmfs_open(buffer, flags, mode));
  return {
   fd: fd
  };
 }),
 create: (path, mode) => FS_create(path, mode),
 close: stream => FS.handleError(-__wasmfs_close(stream.fd)),
 unlink: path => FS_unlink(path),
 chdir: path => withStackSave(() => {
  var buffer = stringToUTF8OnStack(path);
  return __wasmfs_chdir(buffer);
 }),
 read(stream, buffer, offset, length, position) {
  var seeking = typeof position != "undefined";
  var dataBuffer = _malloc(length);
  var bytesRead;
  if (seeking) {
   bytesRead = __wasmfs_pread(stream.fd, dataBuffer, length, position);
  } else {
   bytesRead = __wasmfs_read(stream.fd, dataBuffer, length);
  }
  bytesRead = FS.handleError(bytesRead);
  for (var i = 0; i < length; i++) {
   buffer[offset + i] = HEAP8[(((dataBuffer) + (i)) >>> 0) >>> 0];
  }
  _free(dataBuffer);
  return bytesRead;
 },
 write(stream, buffer, offset, length, position, canOwn) {
  var seeking = typeof position != "undefined";
  var dataBuffer = _malloc(length);
  for (var i = 0; i < length; i++) {
   HEAP8[(((dataBuffer) + (i)) >>> 0) >>> 0] = buffer[offset + i];
  }
  var bytesRead;
  if (seeking) {
   bytesRead = __wasmfs_pwrite(stream.fd, dataBuffer, length, position);
  } else {
   bytesRead = __wasmfs_write(stream.fd, dataBuffer, length);
  }
  bytesRead = FS.handleError(bytesRead);
  _free(dataBuffer);
  return bytesRead;
 },
 allocate(stream, offset, length) {
  return FS.handleError(__wasmfs_allocate(stream.fd, BigInt(offset), BigInt(length)));
 },
 writeFile: (path, data) => FS_writeFile(path, data),
 mmap: (stream, length, offset, prot, flags) => {
  var buf = FS.handleError(__wasmfs_mmap(length, prot, flags, stream.fd, BigInt(offset)));
  return {
   ptr: buf,
   allocated: true
  };
 },
 msync: (stream, bufferPtr, offset, length, mmapFlags) => {
  assert(offset === 0);
  return FS.handleError(__wasmfs_msync(bufferPtr, length, mmapFlags));
 },
 munmap: (addr, length) => (FS.handleError(__wasmfs_munmap(addr, length))),
 symlink: (target, linkpath) => withStackSave(() => (__wasmfs_symlink(stringToUTF8OnStack(target), stringToUTF8OnStack(linkpath)))),
 readlink(path) {
  var readBuffer = FS.handleError(withStackSave(() => __wasmfs_readlink(stringToUTF8OnStack(path))));
  return UTF8ToString(readBuffer);
 },
 statBufToObject(statBuf) {
  return {
   dev: HEAPU32[((statBuf) >>> 2) >>> 0],
   mode: HEAPU32[(((statBuf) + (4)) >>> 2) >>> 0],
   nlink: HEAPU32[(((statBuf) + (8)) >>> 2) >>> 0],
   uid: HEAPU32[(((statBuf) + (12)) >>> 2) >>> 0],
   gid: HEAPU32[(((statBuf) + (16)) >>> 2) >>> 0],
   rdev: HEAPU32[(((statBuf) + (20)) >>> 2) >>> 0],
   size: readI53FromI64((statBuf) + (24)),
   blksize: HEAPU32[(((statBuf) + (32)) >>> 2) >>> 0],
   blocks: HEAPU32[(((statBuf) + (36)) >>> 2) >>> 0],
   atime: readI53FromI64((statBuf) + (40)),
   mtime: readI53FromI64((statBuf) + (56)),
   ctime: readI53FromI64((statBuf) + (72)),
   ino: readI53FromU64((statBuf) + (88))
  };
 },
 stat(path) {
  var statBuf = _malloc(96);
  FS.handleError(withStackSave(() => __wasmfs_stat(stringToUTF8OnStack(path), statBuf)));
  var stats = FS.statBufToObject(statBuf);
  _free(statBuf);
  return stats;
 },
 lstat(path) {
  var statBuf = _malloc(96);
  FS.handleError(withStackSave(() => __wasmfs_lstat(stringToUTF8OnStack(path), statBuf)));
  var stats = FS.statBufToObject(statBuf);
  _free(statBuf);
  return stats;
 },
 chmod(path, mode) {
  return FS.handleError(withStackSave(() => {
   var buffer = stringToUTF8OnStack(path);
   return __wasmfs_chmod(buffer, mode);
  }));
 },
 lchmod(path, mode) {
  return FS.handleError(withStackSave(() => {
   var buffer = stringToUTF8OnStack(path);
   return __wasmfs_lchmod(buffer, mode);
  }));
 },
 fchmod(fd, mode) {
  return FS.handleError(__wasmfs_fchmod(fd, mode));
 },
 utime: (path, atime, mtime) => (FS.handleError(withStackSave(() => (__wasmfs_utime(stringToUTF8OnStack(path), atime, mtime))))),
 truncate(path, len) {
  return FS.handleError(withStackSave(() => (__wasmfs_truncate(stringToUTF8OnStack(path), BigInt(len)))));
 },
 ftruncate(fd, len) {
  return FS.handleError(__wasmfs_ftruncate(fd, BigInt(len)));
 },
 findObject(path) {
  var result = withStackSave(() => __wasmfs_identify(stringToUTF8OnStack(path)));
  if (result == 44) {
   return null;
  }
  return {
   isFolder: result == 31,
   isDevice: false
  };
 },
 readdir: path => withStackSave(() => {
  var pathBuffer = stringToUTF8OnStack(path);
  var entries = [];
  var state = __wasmfs_readdir_start(pathBuffer);
  if (!state) {
   throw new Error("No such directory");
  }
  var entry;
  while (entry = __wasmfs_readdir_get(state)) {
   entries.push(UTF8ToString(entry));
  }
  __wasmfs_readdir_finish(state);
  return entries;
 }),
 mount: (type, opts, mountpoint) => {
  var backendPointer = type.createBackend(opts);
  return FS.handleError(withStackSave(() => __wasmfs_mount(stringToUTF8OnStack(mountpoint), backendPointer)));
 },
 unmount: mountpoint => (FS.handleError(withStackSave(() => __wasmfs_unmount(stringToUTF8OnStack(mountpoint))))),
 mknod: (path, mode, dev) => FS_mknod(path, mode, dev),
 makedev: (ma, mi) => ((ma) << 8 | (mi)),
 registerDevice(dev, ops) {
  var backendPointer = _wasmfs_create_jsimpl_backend();
  var definedOps = {
   userRead: ops.read,
   userWrite: ops.write,
   allocFile: file => {
    wasmFSDeviceStreams[file] = {};
   },
   freeFile: file => {
    wasmFSDeviceStreams[file] = undefined;
   },
   getSize: file => {},
   read: (file, buffer, length, offset) => {
    var bufferArray = Module.HEAP8.subarray(buffer, buffer + length);
    try {
     var bytesRead = definedOps.userRead(wasmFSDeviceStreams[file], bufferArray, 0, length, offset);
    } catch (e) {
     return -e.errno;
    }
    Module.HEAP8.set(bufferArray, buffer);
    return bytesRead;
   },
   write: (file, buffer, length, offset) => {
    var bufferArray = Module.HEAP8.subarray(buffer, buffer + length);
    try {
     var bytesWritten = definedOps.userWrite(wasmFSDeviceStreams[file], bufferArray, 0, length, offset);
    } catch (e) {
     return -e.errno;
    }
    Module.HEAP8.set(bufferArray, buffer);
    return bytesWritten;
   }
  };
  wasmFS$backends[backendPointer] = definedOps;
  wasmFSDevices[dev] = backendPointer;
 },
 createDevice(parent, name, input, output) {
  if (typeof parent != "string") {
   throw new Error("Only string paths are accepted");
  }
  var path = PATH.join2(parent, name);
  var mode = FS_getMode(!!input, !!output);
  if (!FS.createDevice.major) FS.createDevice.major = 64;
  var dev = FS.makedev(FS.createDevice.major++, 0);
  FS.registerDevice(dev, {
   read(stream, buffer, offset, length, pos) {
    /* ignored */ var bytesRead = 0;
    for (var i = 0; i < length; i++) {
     var result;
     try {
      result = input();
     } catch (e) {
      throw new FS.ErrnoError(29);
     }
     if (result === undefined && bytesRead === 0) {
      throw new FS.ErrnoError(6);
     }
     if (result === null || result === undefined) break;
     bytesRead++;
     buffer[offset + i] = result;
    }
    return bytesRead;
   },
   write(stream, buffer, offset, length, pos) {
    for (var i = 0; i < length; i++) {
     try {
      output(buffer[offset + i]);
     } catch (e) {
      throw new FS.ErrnoError(29);
     }
    }
    return i;
   }
  });
  return FS.mkdev(path, mode, dev);
 },
 mkdev(path, mode, dev) {
  if (typeof dev === "undefined") {
   dev = mode;
   mode = 438;
  }
  var deviceBackend = wasmFSDevices[dev];
  if (!deviceBackend) {
   throw new Error("Invalid device ID.");
  }
  return FS.handleError(withStackSave(() => (_wasmfs_create_file(stringToUTF8OnStack(path), mode, deviceBackend))));
 },
 rename(oldPath, newPath) {
  return FS.handleError(withStackSave(() => {
   var oldPathBuffer = stringToUTF8OnStack(oldPath);
   var newPathBuffer = stringToUTF8OnStack(newPath);
   return __wasmfs_rename(oldPathBuffer, newPathBuffer);
  }));
 },
 llseek(stream, offset, whence) {
  return FS.handleError(__wasmfs_llseek(stream.fd, BigInt(offset), whence));
 }
};

var updateTableMap = (offset, count) => {
 if (functionsInTableMap) {
  for (var i = offset; i < offset + count; i++) {
   var item = getWasmTableEntry(i);
   if (item) {
    functionsInTableMap.set(item, i);
   }
  }
 }
};

var functionsInTableMap;

var getFunctionAddress = func => {
 if (!functionsInTableMap) {
  functionsInTableMap = new WeakMap;
  updateTableMap(0, wasmTable.length);
 }
 return functionsInTableMap.get(func) || 0;
};

/** @param {string=} sig */ var addFunction = (func, sig) => {
 var rtn = getFunctionAddress(func);
 if (rtn) {
  return rtn;
 }
 var ret = getEmptyTableSlot();
 try {
  setWasmTableEntry(ret, func);
 } catch (err) {
  if (!(err instanceof TypeError)) {
   throw err;
  }
  var wrapped = convertJsFunctionToWasm(func, sig);
  setWasmTableEntry(ret, wrapped);
 }
 functionsInTableMap.set(func, ret);
 return ret;
};

var removeFunction = index => {
 functionsInTableMap.delete(getWasmTableEntry(index));
 setWasmTableEntry(index, null);
 freeTableIndexes.push(index);
};

PThread.init();

handleAllocatorInit();

FS.init();

var proxiedFunctionTable = [ _proc_exit, exitOnMainThread, pthreadCreateProxied, __emscripten_runtime_keepalive_clear, _environ_get, _environ_sizes_get, _getaddrinfo, _gethostbyname ];

var wasmImports = {
 /** @export */ __assert_fail: ___assert_fail,
 /** @export */ __call_sighandler: ___call_sighandler,
 /** @export */ __emscripten_init_main_thread_js: ___emscripten_init_main_thread_js,
 /** @export */ __emscripten_thread_cleanup: ___emscripten_thread_cleanup,
 /** @export */ __pthread_create_js: ___pthread_create_js,
 /** @export */ __pthread_kill_js: ___pthread_kill_js,
 /** @export */ _emscripten_get_now_is_monotonic: __emscripten_get_now_is_monotonic,
 /** @export */ _emscripten_notify_mailbox_postmessage: __emscripten_notify_mailbox_postmessage,
 /** @export */ _emscripten_receive_on_main_thread_js: __emscripten_receive_on_main_thread_js,
 /** @export */ _emscripten_runtime_keepalive_clear: __emscripten_runtime_keepalive_clear,
 /** @export */ _emscripten_thread_mailbox_await: __emscripten_thread_mailbox_await,
 /** @export */ _emscripten_thread_set_strongref: __emscripten_thread_set_strongref,
 /** @export */ _emscripten_throw_longjmp: __emscripten_throw_longjmp,
 /** @export */ _gmtime_js: __gmtime_js,
 /** @export */ _localtime_js: __localtime_js,
 /** @export */ _mktime_js: __mktime_js,
 /** @export */ _tzset_js: __tzset_js,
 /** @export */ _wasmfs_copy_preloaded_file_data: __wasmfs_copy_preloaded_file_data,
 /** @export */ _wasmfs_get_num_preloaded_dirs: __wasmfs_get_num_preloaded_dirs,
 /** @export */ _wasmfs_get_num_preloaded_files: __wasmfs_get_num_preloaded_files,
 /** @export */ _wasmfs_get_preloaded_child_path: __wasmfs_get_preloaded_child_path,
 /** @export */ _wasmfs_get_preloaded_file_mode: __wasmfs_get_preloaded_file_mode,
 /** @export */ _wasmfs_get_preloaded_file_size: __wasmfs_get_preloaded_file_size,
 /** @export */ _wasmfs_get_preloaded_parent_path: __wasmfs_get_preloaded_parent_path,
 /** @export */ _wasmfs_get_preloaded_path_name: __wasmfs_get_preloaded_path_name,
 /** @export */ _wasmfs_jsimpl_alloc_file: __wasmfs_jsimpl_alloc_file,
 /** @export */ _wasmfs_jsimpl_free_file: __wasmfs_jsimpl_free_file,
 /** @export */ _wasmfs_jsimpl_get_size: __wasmfs_jsimpl_get_size,
 /** @export */ _wasmfs_jsimpl_read: __wasmfs_jsimpl_read,
 /** @export */ _wasmfs_jsimpl_write: __wasmfs_jsimpl_write,
 /** @export */ _wasmfs_opfs_close_access: __wasmfs_opfs_close_access,
 /** @export */ _wasmfs_opfs_close_blob: __wasmfs_opfs_close_blob,
 /** @export */ _wasmfs_opfs_flush_access: __wasmfs_opfs_flush_access,
 /** @export */ _wasmfs_opfs_free_directory: __wasmfs_opfs_free_directory,
 /** @export */ _wasmfs_opfs_free_file: __wasmfs_opfs_free_file,
 /** @export */ _wasmfs_opfs_get_child: __wasmfs_opfs_get_child,
 /** @export */ _wasmfs_opfs_get_entries: __wasmfs_opfs_get_entries,
 /** @export */ _wasmfs_opfs_get_size_access: __wasmfs_opfs_get_size_access,
 /** @export */ _wasmfs_opfs_get_size_blob: __wasmfs_opfs_get_size_blob,
 /** @export */ _wasmfs_opfs_get_size_file: __wasmfs_opfs_get_size_file,
 /** @export */ _wasmfs_opfs_init_root_directory: __wasmfs_opfs_init_root_directory,
 /** @export */ _wasmfs_opfs_insert_directory: __wasmfs_opfs_insert_directory,
 /** @export */ _wasmfs_opfs_insert_file: __wasmfs_opfs_insert_file,
 /** @export */ _wasmfs_opfs_move_file: __wasmfs_opfs_move_file,
 /** @export */ _wasmfs_opfs_open_access: __wasmfs_opfs_open_access,
 /** @export */ _wasmfs_opfs_open_blob: __wasmfs_opfs_open_blob,
 /** @export */ _wasmfs_opfs_read_access: __wasmfs_opfs_read_access,
 /** @export */ _wasmfs_opfs_read_blob: __wasmfs_opfs_read_blob,
 /** @export */ _wasmfs_opfs_remove_child: __wasmfs_opfs_remove_child,
 /** @export */ _wasmfs_opfs_set_size_access: __wasmfs_opfs_set_size_access,
 /** @export */ _wasmfs_opfs_set_size_file: __wasmfs_opfs_set_size_file,
 /** @export */ _wasmfs_opfs_write_access: __wasmfs_opfs_write_access,
 /** @export */ _wasmfs_stdin_get_char: __wasmfs_stdin_get_char,
 /** @export */ _wasmfs_thread_utils_heartbeat: __wasmfs_thread_utils_heartbeat,
 /** @export */ abort: _abort,
 /** @export */ emscripten_check_blocking_allowed: _emscripten_check_blocking_allowed,
 /** @export */ emscripten_console_error: _emscripten_console_error,
 /** @export */ emscripten_date_now: _emscripten_date_now,
 /** @export */ emscripten_err: _emscripten_err,
 /** @export */ emscripten_exit_with_live_runtime: _emscripten_exit_with_live_runtime,
 /** @export */ emscripten_fiber_swap: _emscripten_fiber_swap,
 /** @export */ emscripten_get_heap_max: _emscripten_get_heap_max,
 /** @export */ emscripten_get_now: _emscripten_get_now,
 /** @export */ emscripten_num_logical_cores: _emscripten_num_logical_cores,
 /** @export */ emscripten_out: _emscripten_out,
 /** @export */ emscripten_resize_heap: _emscripten_resize_heap,
 /** @export */ emscripten_runtime_keepalive_check: _emscripten_runtime_keepalive_check,
 /** @export */ emscripten_sleep: _emscripten_sleep,
 /** @export */ emscripten_unwind_to_js_event_loop: _emscripten_unwind_to_js_event_loop,
 /** @export */ environ_get: _environ_get,
 /** @export */ environ_sizes_get: _environ_sizes_get,
 /** @export */ exit: _exit,
 /** @export */ ffi_call_js: ffi_call_js,
 /** @export */ getaddrinfo: _getaddrinfo,
 /** @export */ getentropy: _getentropy,
 /** @export */ gethostbyname: _gethostbyname,
 /** @export */ getnameinfo: _getnameinfo,
 /** @export */ init_wasm32_js: init_wasm32_js,
 /** @export */ instantiate_wasm: instantiate_wasm,
 /** @export */ invoke_i: invoke_i,
 /** @export */ invoke_ii: invoke_ii,
 /** @export */ invoke_iii: invoke_iii,
 /** @export */ invoke_iiii: invoke_iiii,
 /** @export */ invoke_iiiiii: invoke_iiiiii,
 /** @export */ invoke_iiij: invoke_iiij,
 /** @export */ invoke_iij: invoke_iij,
 /** @export */ invoke_iijjii: invoke_iijjii,
 /** @export */ invoke_ij: invoke_ij,
 /** @export */ invoke_ji: invoke_ji,
 /** @export */ invoke_jii: invoke_jii,
 /** @export */ invoke_jiii: invoke_jiii,
 /** @export */ invoke_v: invoke_v,
 /** @export */ invoke_vi: invoke_vi,
 /** @export */ invoke_vii: invoke_vii,
 /** @export */ invoke_viii: invoke_viii,
 /** @export */ invoke_viiii: invoke_viiii,
 /** @export */ invoke_viiiii: invoke_viiiii,
 /** @export */ invoke_viiiiii: invoke_viiiiii,
 /** @export */ invoke_viiiiiii: invoke_viiiiiii,
 /** @export */ invoke_viiiijii: invoke_viiiijii,
 /** @export */ invoke_viiiji: invoke_viiiji,
 /** @export */ invoke_viiijii: invoke_viiijii,
 /** @export */ invoke_viij: invoke_viij,
 /** @export */ invoke_viiji: invoke_viiji,
 /** @export */ invoke_viijii: invoke_viijii,
 /** @export */ invoke_vij: invoke_vij,
 /** @export */ invoke_vj: invoke_vj,
 /** @export */ memory: wasmMemory || Module["wasmMemory"],
 /** @export */ nebulahv_canvas_resize: nebulahv_canvas_resize,
 /** @export */ nebulahv_canvas_update: nebulahv_canvas_update,
 /** @export */ proc_exit: _proc_exit,
 /** @export */ remove_module_js: remove_module_js,
 /** @export */ strftime: _strftime
};

var wasmExports = createWasm();

var ___wasm_call_ctors = () => (___wasm_call_ctors = wasmExports["__wasm_call_ctors"])();

var _ntohs = a0 => (_ntohs = wasmExports["ntohs"])(a0);

var _htonl = a0 => (_htonl = wasmExports["htonl"])(a0);

var _htons = a0 => (_htons = wasmExports["htons"])(a0);

var _wasmfs_create_opfs_backend = () => (_wasmfs_create_opfs_backend = wasmExports["wasmfs_create_opfs_backend"])();

var _nebulahv_pointer_move = Module["_nebulahv_pointer_move"] = (a0, a1, a2, a3) => (_nebulahv_pointer_move = Module["_nebulahv_pointer_move"] = wasmExports["nebulahv_pointer_move"])(a0, a1, a2, a3);

var _nebulahv_pointer_button = Module["_nebulahv_pointer_button"] = (a0, a1) => (_nebulahv_pointer_button = Module["_nebulahv_pointer_button"] = wasmExports["nebulahv_pointer_button"])(a0, a1);

var _nebulahv_pointer_wheel = Module["_nebulahv_pointer_wheel"] = a0 => (_nebulahv_pointer_wheel = Module["_nebulahv_pointer_wheel"] = wasmExports["nebulahv_pointer_wheel"])(a0);

var _nebulahv_key_number = Module["_nebulahv_key_number"] = (a0, a1) => (_nebulahv_key_number = Module["_nebulahv_key_number"] = wasmExports["nebulahv_key_number"])(a0, a1);

var ___errno_location = () => (___errno_location = wasmExports["__errno_location"])();

var _malloc = a0 => (_malloc = wasmExports["malloc"])(a0);

var _free = a0 => (_free = wasmExports["free"])(a0);

var _calloc = Module["_calloc"] = (a0, a1) => (_calloc = Module["_calloc"] = wasmExports["calloc"])(a0, a1);

var getTempRet0 = () => (getTempRet0 = wasmExports["getTempRet0"])();

var setTempRet0 = a0 => (setTempRet0 = wasmExports["setTempRet0"])(a0);

var _main = Module["_main"] = (a0, a1) => (_main = Module["_main"] = wasmExports["__main_argc_argv"])(a0, a1);

var _pthread_self = Module["_pthread_self"] = () => (_pthread_self = Module["_pthread_self"] = wasmExports["pthread_self"])();

var _realloc = Module["_realloc"] = (a0, a1) => (_realloc = Module["_realloc"] = wasmExports["realloc"])(a0, a1);

var _emscripten_builtin_free = Module["_emscripten_builtin_free"] = a0 => (_emscripten_builtin_free = Module["_emscripten_builtin_free"] = wasmExports["emscripten_builtin_free"])(a0);

var __emscripten_tls_init = Module["__emscripten_tls_init"] = () => (__emscripten_tls_init = Module["__emscripten_tls_init"] = wasmExports["_emscripten_tls_init"])();

var _emscripten_builtin_memalign = (a0, a1) => (_emscripten_builtin_memalign = wasmExports["emscripten_builtin_memalign"])(a0, a1);

var __emscripten_proxy_main = Module["__emscripten_proxy_main"] = (a0, a1) => (__emscripten_proxy_main = Module["__emscripten_proxy_main"] = wasmExports["_emscripten_proxy_main"])(a0, a1);

var _emscripten_builtin_malloc = Module["_emscripten_builtin_malloc"] = a0 => (_emscripten_builtin_malloc = Module["_emscripten_builtin_malloc"] = wasmExports["emscripten_builtin_malloc"])(a0);

var ___libc_calloc = Module["___libc_calloc"] = (a0, a1) => (___libc_calloc = Module["___libc_calloc"] = wasmExports["__libc_calloc"])(a0, a1);

var ___libc_free = Module["___libc_free"] = a0 => (___libc_free = Module["___libc_free"] = wasmExports["__libc_free"])(a0);

var ___libc_malloc = Module["___libc_malloc"] = a0 => (___libc_malloc = Module["___libc_malloc"] = wasmExports["__libc_malloc"])(a0);

var __emscripten_thread_init = Module["__emscripten_thread_init"] = (a0, a1, a2, a3, a4, a5) => (__emscripten_thread_init = Module["__emscripten_thread_init"] = wasmExports["_emscripten_thread_init"])(a0, a1, a2, a3, a4, a5);

var __emscripten_thread_crashed = Module["__emscripten_thread_crashed"] = () => (__emscripten_thread_crashed = Module["__emscripten_thread_crashed"] = wasmExports["_emscripten_thread_crashed"])();

var _emscripten_main_thread_process_queued_calls = () => (_emscripten_main_thread_process_queued_calls = wasmExports["emscripten_main_thread_process_queued_calls"])();

var _emscripten_proxy_execute_queue = a0 => (_emscripten_proxy_execute_queue = wasmExports["emscripten_proxy_execute_queue"])(a0);

var _emscripten_main_runtime_thread_id = () => (_emscripten_main_runtime_thread_id = wasmExports["emscripten_main_runtime_thread_id"])();

var _emscripten_proxy_finish = a0 => (_emscripten_proxy_finish = wasmExports["emscripten_proxy_finish"])(a0);

var __emscripten_run_on_main_thread_js = (a0, a1, a2, a3) => (__emscripten_run_on_main_thread_js = wasmExports["_emscripten_run_on_main_thread_js"])(a0, a1, a2, a3);

var __emscripten_thread_free_data = a0 => (__emscripten_thread_free_data = wasmExports["_emscripten_thread_free_data"])(a0);

var __emscripten_thread_exit = Module["__emscripten_thread_exit"] = a0 => (__emscripten_thread_exit = Module["__emscripten_thread_exit"] = wasmExports["_emscripten_thread_exit"])(a0);

var __emscripten_check_mailbox = () => (__emscripten_check_mailbox = wasmExports["_emscripten_check_mailbox"])();

var __ZdaPv = Module["__ZdaPv"] = a0 => (__ZdaPv = Module["__ZdaPv"] = wasmExports["_ZdaPv"])(a0);

var __ZdaPvm = Module["__ZdaPvm"] = (a0, a1) => (__ZdaPvm = Module["__ZdaPvm"] = wasmExports["_ZdaPvm"])(a0, a1);

var __ZdlPv = Module["__ZdlPv"] = a0 => (__ZdlPv = Module["__ZdlPv"] = wasmExports["_ZdlPv"])(a0);

var __ZdlPvm = Module["__ZdlPvm"] = (a0, a1) => (__ZdlPvm = Module["__ZdlPvm"] = wasmExports["_ZdlPvm"])(a0, a1);

var __Znaj = Module["__Znaj"] = a0 => (__Znaj = Module["__Znaj"] = wasmExports["_Znaj"])(a0);

var __ZnajSt11align_val_t = Module["__ZnajSt11align_val_t"] = (a0, a1) => (__ZnajSt11align_val_t = Module["__ZnajSt11align_val_t"] = wasmExports["_ZnajSt11align_val_t"])(a0, a1);

var __Znwj = Module["__Znwj"] = a0 => (__Znwj = Module["__Znwj"] = wasmExports["_Znwj"])(a0);

var __ZnwjSt11align_val_t = Module["__ZnwjSt11align_val_t"] = (a0, a1) => (__ZnwjSt11align_val_t = Module["__ZnwjSt11align_val_t"] = wasmExports["_ZnwjSt11align_val_t"])(a0, a1);

var ___libc_realloc = Module["___libc_realloc"] = (a0, a1) => (___libc_realloc = Module["___libc_realloc"] = wasmExports["__libc_realloc"])(a0, a1);

var _malloc_size = Module["_malloc_size"] = a0 => (_malloc_size = Module["_malloc_size"] = wasmExports["malloc_size"])(a0);

var _malloc_usable_size = Module["_malloc_usable_size"] = a0 => (_malloc_usable_size = Module["_malloc_usable_size"] = wasmExports["malloc_usable_size"])(a0);

var _reallocf = Module["_reallocf"] = (a0, a1) => (_reallocf = Module["_reallocf"] = wasmExports["reallocf"])(a0, a1);

var _setThrew = (a0, a1) => (_setThrew = wasmExports["setThrew"])(a0, a1);

var _emscripten_stack_set_limits = (a0, a1) => (_emscripten_stack_set_limits = wasmExports["emscripten_stack_set_limits"])(a0, a1);

var stackSave = () => (stackSave = wasmExports["stackSave"])();

var stackRestore = a0 => (stackRestore = wasmExports["stackRestore"])(a0);

var stackAlloc = a0 => (stackAlloc = wasmExports["stackAlloc"])(a0);

var __wasmfs_read_file = a0 => (__wasmfs_read_file = wasmExports["_wasmfs_read_file"])(a0);

var __wasmfs_write_file = (a0, a1, a2) => (__wasmfs_write_file = wasmExports["_wasmfs_write_file"])(a0, a1, a2);

var __wasmfs_mkdir = (a0, a1) => (__wasmfs_mkdir = wasmExports["_wasmfs_mkdir"])(a0, a1);

var __wasmfs_rmdir = a0 => (__wasmfs_rmdir = wasmExports["_wasmfs_rmdir"])(a0);

var __wasmfs_open = (a0, a1, a2) => (__wasmfs_open = wasmExports["_wasmfs_open"])(a0, a1, a2);

var __wasmfs_allocate = (a0, a1, a2) => (__wasmfs_allocate = wasmExports["_wasmfs_allocate"])(a0, a1, a2);

var __wasmfs_mknod = (a0, a1, a2) => (__wasmfs_mknod = wasmExports["_wasmfs_mknod"])(a0, a1, a2);

var __wasmfs_unlink = a0 => (__wasmfs_unlink = wasmExports["_wasmfs_unlink"])(a0);

var __wasmfs_chdir = a0 => (__wasmfs_chdir = wasmExports["_wasmfs_chdir"])(a0);

var __wasmfs_symlink = (a0, a1) => (__wasmfs_symlink = wasmExports["_wasmfs_symlink"])(a0, a1);

var __wasmfs_readlink = a0 => (__wasmfs_readlink = wasmExports["_wasmfs_readlink"])(a0);

var __wasmfs_write = (a0, a1, a2) => (__wasmfs_write = wasmExports["_wasmfs_write"])(a0, a1, a2);

var __wasmfs_pwrite = (a0, a1, a2, a3) => (__wasmfs_pwrite = wasmExports["_wasmfs_pwrite"])(a0, a1, a2, a3);

var __wasmfs_chmod = (a0, a1) => (__wasmfs_chmod = wasmExports["_wasmfs_chmod"])(a0, a1);

var __wasmfs_fchmod = (a0, a1) => (__wasmfs_fchmod = wasmExports["_wasmfs_fchmod"])(a0, a1);

var __wasmfs_lchmod = (a0, a1) => (__wasmfs_lchmod = wasmExports["_wasmfs_lchmod"])(a0, a1);

var __wasmfs_llseek = (a0, a1, a2) => (__wasmfs_llseek = wasmExports["_wasmfs_llseek"])(a0, a1, a2);

var __wasmfs_rename = (a0, a1) => (__wasmfs_rename = wasmExports["_wasmfs_rename"])(a0, a1);

var __wasmfs_read = (a0, a1, a2) => (__wasmfs_read = wasmExports["_wasmfs_read"])(a0, a1, a2);

var __wasmfs_pread = (a0, a1, a2, a3) => (__wasmfs_pread = wasmExports["_wasmfs_pread"])(a0, a1, a2, a3);

var __wasmfs_truncate = (a0, a1) => (__wasmfs_truncate = wasmExports["_wasmfs_truncate"])(a0, a1);

var __wasmfs_ftruncate = (a0, a1) => (__wasmfs_ftruncate = wasmExports["_wasmfs_ftruncate"])(a0, a1);

var __wasmfs_close = a0 => (__wasmfs_close = wasmExports["_wasmfs_close"])(a0);

var __wasmfs_mmap = (a0, a1, a2, a3, a4) => (__wasmfs_mmap = wasmExports["_wasmfs_mmap"])(a0, a1, a2, a3, a4);

var __wasmfs_msync = (a0, a1, a2) => (__wasmfs_msync = wasmExports["_wasmfs_msync"])(a0, a1, a2);

var __wasmfs_munmap = (a0, a1) => (__wasmfs_munmap = wasmExports["_wasmfs_munmap"])(a0, a1);

var __wasmfs_utime = (a0, a1, a2) => (__wasmfs_utime = wasmExports["_wasmfs_utime"])(a0, a1, a2);

var __wasmfs_stat = (a0, a1) => (__wasmfs_stat = wasmExports["_wasmfs_stat"])(a0, a1);

var __wasmfs_lstat = (a0, a1) => (__wasmfs_lstat = wasmExports["_wasmfs_lstat"])(a0, a1);

var __wasmfs_mount = (a0, a1) => (__wasmfs_mount = wasmExports["_wasmfs_mount"])(a0, a1);

var __wasmfs_unmount = a0 => (__wasmfs_unmount = wasmExports["_wasmfs_unmount"])(a0);

var __wasmfs_identify = a0 => (__wasmfs_identify = wasmExports["_wasmfs_identify"])(a0);

var __wasmfs_readdir_start = a0 => (__wasmfs_readdir_start = wasmExports["_wasmfs_readdir_start"])(a0);

var __wasmfs_readdir_get = a0 => (__wasmfs_readdir_get = wasmExports["_wasmfs_readdir_get"])(a0);

var __wasmfs_readdir_finish = a0 => (__wasmfs_readdir_finish = wasmExports["_wasmfs_readdir_finish"])(a0);

var __wasmfs_get_cwd = () => (__wasmfs_get_cwd = wasmExports["_wasmfs_get_cwd"])();

var _wasmfs_create_jsimpl_backend = () => (_wasmfs_create_jsimpl_backend = wasmExports["wasmfs_create_jsimpl_backend"])();

var _wasmfs_create_memory_backend = () => (_wasmfs_create_memory_backend = wasmExports["wasmfs_create_memory_backend"])();

var __wasmfs_opfs_record_entry = (a0, a1, a2) => (__wasmfs_opfs_record_entry = wasmExports["_wasmfs_opfs_record_entry"])(a0, a1, a2);

var _wasmfs_create_file = (a0, a1, a2) => (_wasmfs_create_file = wasmExports["wasmfs_create_file"])(a0, a1, a2);

var dynCall_v = Module["dynCall_v"] = a0 => (dynCall_v = Module["dynCall_v"] = wasmExports["dynCall_v"])(a0);

var dynCall_ji = Module["dynCall_ji"] = (a0, a1) => (dynCall_ji = Module["dynCall_ji"] = wasmExports["dynCall_ji"])(a0, a1);

var dynCall_viii = Module["dynCall_viii"] = (a0, a1, a2, a3) => (dynCall_viii = Module["dynCall_viii"] = wasmExports["dynCall_viii"])(a0, a1, a2, a3);

var dynCall_iiii = Module["dynCall_iiii"] = (a0, a1, a2, a3) => (dynCall_iiii = Module["dynCall_iiii"] = wasmExports["dynCall_iiii"])(a0, a1, a2, a3);

var dynCall_ii = Module["dynCall_ii"] = (a0, a1) => (dynCall_ii = Module["dynCall_ii"] = wasmExports["dynCall_ii"])(a0, a1);

var dynCall_vi = Module["dynCall_vi"] = (a0, a1) => (dynCall_vi = Module["dynCall_vi"] = wasmExports["dynCall_vi"])(a0, a1);

var dynCall_vii = Module["dynCall_vii"] = (a0, a1, a2) => (dynCall_vii = Module["dynCall_vii"] = wasmExports["dynCall_vii"])(a0, a1, a2);

var dynCall_iji = Module["dynCall_iji"] = (a0, a1, a2) => (dynCall_iji = Module["dynCall_iji"] = wasmExports["dynCall_iji"])(a0, a1, a2);

var dynCall_viji = Module["dynCall_viji"] = (a0, a1, a2, a3) => (dynCall_viji = Module["dynCall_viji"] = wasmExports["dynCall_viji"])(a0, a1, a2, a3);

var dynCall_vji = Module["dynCall_vji"] = (a0, a1, a2) => (dynCall_vji = Module["dynCall_vji"] = wasmExports["dynCall_vji"])(a0, a1, a2);

var dynCall_ijiii = Module["dynCall_ijiii"] = (a0, a1, a2, a3, a4) => (dynCall_ijiii = Module["dynCall_ijiii"] = wasmExports["dynCall_ijiii"])(a0, a1, a2, a3, a4);

var dynCall_iii = Module["dynCall_iii"] = (a0, a1, a2) => (dynCall_iii = Module["dynCall_iii"] = wasmExports["dynCall_iii"])(a0, a1, a2);

var dynCall_viiii = Module["dynCall_viiii"] = (a0, a1, a2, a3, a4) => (dynCall_viiii = Module["dynCall_viiii"] = wasmExports["dynCall_viiii"])(a0, a1, a2, a3, a4);

var dynCall_viiiii = Module["dynCall_viiiii"] = (a0, a1, a2, a3, a4, a5) => (dynCall_viiiii = Module["dynCall_viiiii"] = wasmExports["dynCall_viiiii"])(a0, a1, a2, a3, a4, a5);

var dynCall_iiiii = Module["dynCall_iiiii"] = (a0, a1, a2, a3, a4) => (dynCall_iiiii = Module["dynCall_iiiii"] = wasmExports["dynCall_iiiii"])(a0, a1, a2, a3, a4);

var dynCall_ij = Module["dynCall_ij"] = (a0, a1) => (dynCall_ij = Module["dynCall_ij"] = wasmExports["dynCall_ij"])(a0, a1);

var dynCall_iiiiii = Module["dynCall_iiiiii"] = (a0, a1, a2, a3, a4, a5) => (dynCall_iiiiii = Module["dynCall_iiiiii"] = wasmExports["dynCall_iiiiii"])(a0, a1, a2, a3, a4, a5);

var dynCall_iiiiiii = Module["dynCall_iiiiiii"] = (a0, a1, a2, a3, a4, a5, a6) => (dynCall_iiiiiii = Module["dynCall_iiiiiii"] = wasmExports["dynCall_iiiiiii"])(a0, a1, a2, a3, a4, a5, a6);

var dynCall_jii = Module["dynCall_jii"] = (a0, a1, a2) => (dynCall_jii = Module["dynCall_jii"] = wasmExports["dynCall_jii"])(a0, a1, a2);

var dynCall_viij = Module["dynCall_viij"] = (a0, a1, a2, a3) => (dynCall_viij = Module["dynCall_viij"] = wasmExports["dynCall_viij"])(a0, a1, a2, a3);

var dynCall_iiiiij = Module["dynCall_iiiiij"] = (a0, a1, a2, a3, a4, a5) => (dynCall_iiiiij = Module["dynCall_iiiiij"] = wasmExports["dynCall_iiiiij"])(a0, a1, a2, a3, a4, a5);

var dynCall_iiij = Module["dynCall_iiij"] = (a0, a1, a2, a3) => (dynCall_iiij = Module["dynCall_iiij"] = wasmExports["dynCall_iiij"])(a0, a1, a2, a3);

var dynCall_iiiji = Module["dynCall_iiiji"] = (a0, a1, a2, a3, a4) => (dynCall_iiiji = Module["dynCall_iiiji"] = wasmExports["dynCall_iiiji"])(a0, a1, a2, a3, a4);

var dynCall_jiji = Module["dynCall_jiji"] = (a0, a1, a2, a3) => (dynCall_jiji = Module["dynCall_jiji"] = wasmExports["dynCall_jiji"])(a0, a1, a2, a3);

var dynCall_vijji = Module["dynCall_vijji"] = (a0, a1, a2, a3, a4) => (dynCall_vijji = Module["dynCall_vijji"] = wasmExports["dynCall_vijji"])(a0, a1, a2, a3, a4);

var dynCall_viid = Module["dynCall_viid"] = (a0, a1, a2, a3) => (dynCall_viid = Module["dynCall_viid"] = wasmExports["dynCall_viid"])(a0, a1, a2, a3);

var dynCall_iijiii = Module["dynCall_iijiii"] = (a0, a1, a2, a3, a4, a5) => (dynCall_iijiii = Module["dynCall_iijiii"] = wasmExports["dynCall_iijiii"])(a0, a1, a2, a3, a4, a5);

var dynCall_iijjii = Module["dynCall_iijjii"] = (a0, a1, a2, a3, a4, a5) => (dynCall_iijjii = Module["dynCall_iijjii"] = wasmExports["dynCall_iijjii"])(a0, a1, a2, a3, a4, a5);

var dynCall_iij = Module["dynCall_iij"] = (a0, a1, a2) => (dynCall_iij = Module["dynCall_iij"] = wasmExports["dynCall_iij"])(a0, a1, a2);

var dynCall_viiiiiii = Module["dynCall_viiiiiii"] = (a0, a1, a2, a3, a4, a5, a6, a7) => (dynCall_viiiiiii = Module["dynCall_viiiiiii"] = wasmExports["dynCall_viiiiiii"])(a0, a1, a2, a3, a4, a5, a6, a7);

var dynCall_ijiiii = Module["dynCall_ijiiii"] = (a0, a1, a2, a3, a4, a5) => (dynCall_ijiiii = Module["dynCall_ijiiii"] = wasmExports["dynCall_ijiiii"])(a0, a1, a2, a3, a4, a5);

var dynCall_viijj = Module["dynCall_viijj"] = (a0, a1, a2, a3, a4) => (dynCall_viijj = Module["dynCall_viijj"] = wasmExports["dynCall_viijj"])(a0, a1, a2, a3, a4);

var dynCall_iiji = Module["dynCall_iiji"] = (a0, a1, a2, a3) => (dynCall_iiji = Module["dynCall_iiji"] = wasmExports["dynCall_iiji"])(a0, a1, a2, a3);

var dynCall_jiijj = Module["dynCall_jiijj"] = (a0, a1, a2, a3, a4) => (dynCall_jiijj = Module["dynCall_jiijj"] = wasmExports["dynCall_jiijj"])(a0, a1, a2, a3, a4);

var dynCall_vijiii = Module["dynCall_vijiii"] = (a0, a1, a2, a3, a4, a5) => (dynCall_vijiii = Module["dynCall_vijiii"] = wasmExports["dynCall_vijiii"])(a0, a1, a2, a3, a4, a5);

var dynCall_i = Module["dynCall_i"] = a0 => (dynCall_i = Module["dynCall_i"] = wasmExports["dynCall_i"])(a0);

var dynCall_vjiii = Module["dynCall_vjiii"] = (a0, a1, a2, a3, a4) => (dynCall_vjiii = Module["dynCall_vjiii"] = wasmExports["dynCall_vjiii"])(a0, a1, a2, a3, a4);

var dynCall_viijii = Module["dynCall_viijii"] = (a0, a1, a2, a3, a4, a5) => (dynCall_viijii = Module["dynCall_viijii"] = wasmExports["dynCall_viijii"])(a0, a1, a2, a3, a4, a5);

var dynCall_viiiijjii = Module["dynCall_viiiijjii"] = (a0, a1, a2, a3, a4, a5, a6, a7, a8) => (dynCall_viiiijjii = Module["dynCall_viiiijjii"] = wasmExports["dynCall_viiiijjii"])(a0, a1, a2, a3, a4, a5, a6, a7, a8);

var dynCall_iijji = Module["dynCall_iijji"] = (a0, a1, a2, a3, a4) => (dynCall_iijji = Module["dynCall_iijji"] = wasmExports["dynCall_iijji"])(a0, a1, a2, a3, a4);

var dynCall_iijj = Module["dynCall_iijj"] = (a0, a1, a2, a3) => (dynCall_iijj = Module["dynCall_iijj"] = wasmExports["dynCall_iijj"])(a0, a1, a2, a3);

var dynCall_jijii = Module["dynCall_jijii"] = (a0, a1, a2, a3, a4) => (dynCall_jijii = Module["dynCall_jijii"] = wasmExports["dynCall_jijii"])(a0, a1, a2, a3, a4);

var dynCall_iiiiiiii = Module["dynCall_iiiiiiii"] = (a0, a1, a2, a3, a4, a5, a6, a7) => (dynCall_iiiiiiii = Module["dynCall_iiiiiiii"] = wasmExports["dynCall_iiiiiiii"])(a0, a1, a2, a3, a4, a5, a6, a7);

var dynCall_viiiiii = Module["dynCall_viiiiii"] = (a0, a1, a2, a3, a4, a5, a6) => (dynCall_viiiiii = Module["dynCall_viiiiii"] = wasmExports["dynCall_viiiiii"])(a0, a1, a2, a3, a4, a5, a6);

var dynCall_viiiiiiii = Module["dynCall_viiiiiiii"] = (a0, a1, a2, a3, a4, a5, a6, a7, a8) => (dynCall_viiiiiiii = Module["dynCall_viiiiiiii"] = wasmExports["dynCall_viiiiiiii"])(a0, a1, a2, a3, a4, a5, a6, a7, a8);

var dynCall_vij = Module["dynCall_vij"] = (a0, a1, a2) => (dynCall_vij = Module["dynCall_vij"] = wasmExports["dynCall_vij"])(a0, a1, a2);

var dynCall_jiii = Module["dynCall_jiii"] = (a0, a1, a2, a3) => (dynCall_jiii = Module["dynCall_jiii"] = wasmExports["dynCall_jiii"])(a0, a1, a2, a3);

var dynCall_iijiiiii = Module["dynCall_iijiiiii"] = (a0, a1, a2, a3, a4, a5, a6, a7) => (dynCall_iijiiiii = Module["dynCall_iijiiiii"] = wasmExports["dynCall_iijiiiii"])(a0, a1, a2, a3, a4, a5, a6, a7);

var dynCall_vj = Module["dynCall_vj"] = (a0, a1) => (dynCall_vj = Module["dynCall_vj"] = wasmExports["dynCall_vj"])(a0, a1);

var dynCall_viiji = Module["dynCall_viiji"] = (a0, a1, a2, a3, a4) => (dynCall_viiji = Module["dynCall_viiji"] = wasmExports["dynCall_viiji"])(a0, a1, a2, a3, a4);

var dynCall_viiijii = Module["dynCall_viiijii"] = (a0, a1, a2, a3, a4, a5, a6) => (dynCall_viiijii = Module["dynCall_viiijii"] = wasmExports["dynCall_viiijii"])(a0, a1, a2, a3, a4, a5, a6);

var dynCall_viiiijii = Module["dynCall_viiiijii"] = (a0, a1, a2, a3, a4, a5, a6, a7) => (dynCall_viiiijii = Module["dynCall_viiiijii"] = wasmExports["dynCall_viiiijii"])(a0, a1, a2, a3, a4, a5, a6, a7);

var dynCall_jjjji = Module["dynCall_jjjji"] = (a0, a1, a2, a3, a4) => (dynCall_jjjji = Module["dynCall_jjjji"] = wasmExports["dynCall_jjjji"])(a0, a1, a2, a3, a4);

var dynCall_jijj = Module["dynCall_jijj"] = (a0, a1, a2, a3) => (dynCall_jijj = Module["dynCall_jijj"] = wasmExports["dynCall_jijj"])(a0, a1, a2, a3);

var dynCall_vijjjj = Module["dynCall_vijjjj"] = (a0, a1, a2, a3, a4, a5) => (dynCall_vijjjj = Module["dynCall_vijjjj"] = wasmExports["dynCall_vijjjj"])(a0, a1, a2, a3, a4, a5);

var dynCall_jij = Module["dynCall_jij"] = (a0, a1, a2) => (dynCall_jij = Module["dynCall_jij"] = wasmExports["dynCall_jij"])(a0, a1, a2);

var dynCall_viijij = Module["dynCall_viijij"] = (a0, a1, a2, a3, a4, a5) => (dynCall_viijij = Module["dynCall_viijij"] = wasmExports["dynCall_viijij"])(a0, a1, a2, a3, a4, a5);

var dynCall_viiij = Module["dynCall_viiij"] = (a0, a1, a2, a3, a4) => (dynCall_viiij = Module["dynCall_viiij"] = wasmExports["dynCall_viiij"])(a0, a1, a2, a3, a4);

var dynCall_vijj = Module["dynCall_vijj"] = (a0, a1, a2, a3) => (dynCall_vijj = Module["dynCall_vijj"] = wasmExports["dynCall_vijj"])(a0, a1, a2, a3);

var dynCall_jjj = Module["dynCall_jjj"] = (a0, a1, a2) => (dynCall_jjj = Module["dynCall_jjj"] = wasmExports["dynCall_jjj"])(a0, a1, a2);

var dynCall_viiiiji = Module["dynCall_viiiiji"] = (a0, a1, a2, a3, a4, a5, a6) => (dynCall_viiiiji = Module["dynCall_viiiiji"] = wasmExports["dynCall_viiiiji"])(a0, a1, a2, a3, a4, a5, a6);

var dynCall_iijiiiji = Module["dynCall_iijiiiji"] = (a0, a1, a2, a3, a4, a5, a6, a7) => (dynCall_iijiiiji = Module["dynCall_iijiiiji"] = wasmExports["dynCall_iijiiiji"])(a0, a1, a2, a3, a4, a5, a6, a7);

var dynCall_vijii = Module["dynCall_vijii"] = (a0, a1, a2, a3, a4) => (dynCall_vijii = Module["dynCall_vijii"] = wasmExports["dynCall_vijii"])(a0, a1, a2, a3, a4);

var dynCall_iijii = Module["dynCall_iijii"] = (a0, a1, a2, a3, a4) => (dynCall_iijii = Module["dynCall_iijii"] = wasmExports["dynCall_iijii"])(a0, a1, a2, a3, a4);

var dynCall_viiiji = Module["dynCall_viiiji"] = (a0, a1, a2, a3, a4, a5) => (dynCall_viiiji = Module["dynCall_viiiji"] = wasmExports["dynCall_viiiji"])(a0, a1, a2, a3, a4, a5);

var dynCall_j = Module["dynCall_j"] = a0 => (dynCall_j = Module["dynCall_j"] = wasmExports["dynCall_j"])(a0);

var dynCall_iiijj = Module["dynCall_iiijj"] = (a0, a1, a2, a3, a4) => (dynCall_iiijj = Module["dynCall_iiijj"] = wasmExports["dynCall_iiijj"])(a0, a1, a2, a3, a4);

var dynCall_iiiiiiiii = Module["dynCall_iiiiiiiii"] = (a0, a1, a2, a3, a4, a5, a6, a7, a8) => (dynCall_iiiiiiiii = Module["dynCall_iiiiiiiii"] = wasmExports["dynCall_iiiiiiiii"])(a0, a1, a2, a3, a4, a5, a6, a7, a8);

var dynCall_iiijjiii = Module["dynCall_iiijjiii"] = (a0, a1, a2, a3, a4, a5, a6, a7) => (dynCall_iiijjiii = Module["dynCall_iiijjiii"] = wasmExports["dynCall_iiijjiii"])(a0, a1, a2, a3, a4, a5, a6, a7);

var dynCall_iijjiii = Module["dynCall_iijjiii"] = (a0, a1, a2, a3, a4, a5, a6) => (dynCall_iijjiii = Module["dynCall_iijjiii"] = wasmExports["dynCall_iijjiii"])(a0, a1, a2, a3, a4, a5, a6);

var dynCall_iijiiii = Module["dynCall_iijiiii"] = (a0, a1, a2, a3, a4, a5, a6) => (dynCall_iijiiii = Module["dynCall_iijiiii"] = wasmExports["dynCall_iijiiii"])(a0, a1, a2, a3, a4, a5, a6);

var dynCall_iijjiiii = Module["dynCall_iijjiiii"] = (a0, a1, a2, a3, a4, a5, a6, a7) => (dynCall_iijjiiii = Module["dynCall_iijjiiii"] = wasmExports["dynCall_iijjiiii"])(a0, a1, a2, a3, a4, a5, a6, a7);

var dynCall_iiijijjii = Module["dynCall_iiijijjii"] = (a0, a1, a2, a3, a4, a5, a6, a7, a8) => (dynCall_iiijijjii = Module["dynCall_iiijijjii"] = wasmExports["dynCall_iiijijjii"])(a0, a1, a2, a3, a4, a5, a6, a7, a8);

var dynCall_iiijiiiii = Module["dynCall_iiijiiiii"] = (a0, a1, a2, a3, a4, a5, a6, a7, a8) => (dynCall_iiijiiiii = Module["dynCall_iiijiiiii"] = wasmExports["dynCall_iiijiiiii"])(a0, a1, a2, a3, a4, a5, a6, a7, a8);

var dynCall_vijjii = Module["dynCall_vijjii"] = (a0, a1, a2, a3, a4, a5) => (dynCall_vijjii = Module["dynCall_vijjii"] = wasmExports["dynCall_vijjii"])(a0, a1, a2, a3, a4, a5);

var dynCall_iiiiiiiiii = Module["dynCall_iiiiiiiiii"] = (a0, a1, a2, a3, a4, a5, a6, a7, a8, a9) => (dynCall_iiiiiiiiii = Module["dynCall_iiiiiiiiii"] = wasmExports["dynCall_iiiiiiiiii"])(a0, a1, a2, a3, a4, a5, a6, a7, a8, a9);

var dynCall_iidiiii = Module["dynCall_iidiiii"] = (a0, a1, a2, a3, a4, a5, a6) => (dynCall_iidiiii = Module["dynCall_iidiiii"] = wasmExports["dynCall_iidiiii"])(a0, a1, a2, a3, a4, a5, a6);

var dynCall_iiiij = Module["dynCall_iiiij"] = (a0, a1, a2, a3, a4) => (dynCall_iiiij = Module["dynCall_iiiij"] = wasmExports["dynCall_iiiij"])(a0, a1, a2, a3, a4);

var _asyncify_start_unwind = a0 => (_asyncify_start_unwind = wasmExports["asyncify_start_unwind"])(a0);

var _asyncify_stop_unwind = () => (_asyncify_stop_unwind = wasmExports["asyncify_stop_unwind"])();

var _asyncify_start_rewind = a0 => (_asyncify_start_rewind = wasmExports["asyncify_start_rewind"])(a0);

var _asyncify_stop_rewind = () => (_asyncify_stop_rewind = wasmExports["asyncify_stop_rewind"])();

var ___start_em_js = Module["___start_em_js"] = 7908940;

var ___stop_em_js = Module["___stop_em_js"] = 7922616;

function invoke_ii(index, a1) {
 var sp = stackSave();
 try {
  return dynCall_ii(index, a1);
 } catch (e) {
  stackRestore(sp);
  if (e !== e + 0) throw e;
  _setThrew(1, 0);
 }
}

function invoke_ji(index, a1) {
 var sp = stackSave();
 try {
  return dynCall_ji(index, a1);
 } catch (e) {
  stackRestore(sp);
  if (e !== e + 0) throw e;
  _setThrew(1, 0);
  return 0n;
 }
}

function invoke_vii(index, a1, a2) {
 var sp = stackSave();
 try {
  dynCall_vii(index, a1, a2);
 } catch (e) {
  stackRestore(sp);
  if (e !== e + 0) throw e;
  _setThrew(1, 0);
 }
}

function invoke_vi(index, a1) {
 var sp = stackSave();
 try {
  dynCall_vi(index, a1);
 } catch (e) {
  stackRestore(sp);
  if (e !== e + 0) throw e;
  _setThrew(1, 0);
 }
}

function invoke_iij(index, a1, a2) {
 var sp = stackSave();
 try {
  return dynCall_iij(index, a1, a2);
 } catch (e) {
  stackRestore(sp);
  if (e !== e + 0) throw e;
  _setThrew(1, 0);
 }
}

function invoke_iiij(index, a1, a2, a3) {
 var sp = stackSave();
 try {
  return dynCall_iiij(index, a1, a2, a3);
 } catch (e) {
  stackRestore(sp);
  if (e !== e + 0) throw e;
  _setThrew(1, 0);
 }
}

function invoke_iii(index, a1, a2) {
 var sp = stackSave();
 try {
  return dynCall_iii(index, a1, a2);
 } catch (e) {
  stackRestore(sp);
  if (e !== e + 0) throw e;
  _setThrew(1, 0);
 }
}

function invoke_viii(index, a1, a2, a3) {
 var sp = stackSave();
 try {
  dynCall_viii(index, a1, a2, a3);
 } catch (e) {
  stackRestore(sp);
  if (e !== e + 0) throw e;
  _setThrew(1, 0);
 }
}

function invoke_iiii(index, a1, a2, a3) {
 var sp = stackSave();
 try {
  return dynCall_iiii(index, a1, a2, a3);
 } catch (e) {
  stackRestore(sp);
  if (e !== e + 0) throw e;
  _setThrew(1, 0);
 }
}

function invoke_viiii(index, a1, a2, a3, a4) {
 var sp = stackSave();
 try {
  dynCall_viiii(index, a1, a2, a3, a4);
 } catch (e) {
  stackRestore(sp);
  if (e !== e + 0) throw e;
  _setThrew(1, 0);
 }
}

function invoke_viij(index, a1, a2, a3) {
 var sp = stackSave();
 try {
  dynCall_viij(index, a1, a2, a3);
 } catch (e) {
  stackRestore(sp);
  if (e !== e + 0) throw e;
  _setThrew(1, 0);
 }
}

function invoke_jiii(index, a1, a2, a3) {
 var sp = stackSave();
 try {
  return dynCall_jiii(index, a1, a2, a3);
 } catch (e) {
  stackRestore(sp);
  if (e !== e + 0) throw e;
  _setThrew(1, 0);
  return 0n;
 }
}

function invoke_jii(index, a1, a2) {
 var sp = stackSave();
 try {
  return dynCall_jii(index, a1, a2);
 } catch (e) {
  stackRestore(sp);
  if (e !== e + 0) throw e;
  _setThrew(1, 0);
  return 0n;
 }
}

function invoke_vj(index, a1) {
 var sp = stackSave();
 try {
  dynCall_vj(index, a1);
 } catch (e) {
  stackRestore(sp);
  if (e !== e + 0) throw e;
  _setThrew(1, 0);
 }
}

function invoke_viijii(index, a1, a2, a3, a4, a5) {
 var sp = stackSave();
 try {
  dynCall_viijii(index, a1, a2, a3, a4, a5);
 } catch (e) {
  stackRestore(sp);
  if (e !== e + 0) throw e;
  _setThrew(1, 0);
 }
}

function invoke_viiiiii(index, a1, a2, a3, a4, a5, a6) {
 var sp = stackSave();
 try {
  dynCall_viiiiii(index, a1, a2, a3, a4, a5, a6);
 } catch (e) {
  stackRestore(sp);
  if (e !== e + 0) throw e;
  _setThrew(1, 0);
 }
}

function invoke_viiiii(index, a1, a2, a3, a4, a5) {
 var sp = stackSave();
 try {
  dynCall_viiiii(index, a1, a2, a3, a4, a5);
 } catch (e) {
  stackRestore(sp);
  if (e !== e + 0) throw e;
  _setThrew(1, 0);
 }
}

function invoke_iiiiii(index, a1, a2, a3, a4, a5) {
 var sp = stackSave();
 try {
  return dynCall_iiiiii(index, a1, a2, a3, a4, a5);
 } catch (e) {
  stackRestore(sp);
  if (e !== e + 0) throw e;
  _setThrew(1, 0);
 }
}

function invoke_i(index) {
 var sp = stackSave();
 try {
  return dynCall_i(index);
 } catch (e) {
  stackRestore(sp);
  if (e !== e + 0) throw e;
  _setThrew(1, 0);
 }
}

function invoke_vij(index, a1, a2) {
 var sp = stackSave();
 try {
  dynCall_vij(index, a1, a2);
 } catch (e) {
  stackRestore(sp);
  if (e !== e + 0) throw e;
  _setThrew(1, 0);
 }
}

function invoke_viiji(index, a1, a2, a3, a4) {
 var sp = stackSave();
 try {
  dynCall_viiji(index, a1, a2, a3, a4);
 } catch (e) {
  stackRestore(sp);
  if (e !== e + 0) throw e;
  _setThrew(1, 0);
 }
}

function invoke_viiiiiii(index, a1, a2, a3, a4, a5, a6, a7) {
 var sp = stackSave();
 try {
  dynCall_viiiiiii(index, a1, a2, a3, a4, a5, a6, a7);
 } catch (e) {
  stackRestore(sp);
  if (e !== e + 0) throw e;
  _setThrew(1, 0);
 }
}

function invoke_viiijii(index, a1, a2, a3, a4, a5, a6) {
 var sp = stackSave();
 try {
  dynCall_viiijii(index, a1, a2, a3, a4, a5, a6);
 } catch (e) {
  stackRestore(sp);
  if (e !== e + 0) throw e;
  _setThrew(1, 0);
 }
}

function invoke_ij(index, a1) {
 var sp = stackSave();
 try {
  return dynCall_ij(index, a1);
 } catch (e) {
  stackRestore(sp);
  if (e !== e + 0) throw e;
  _setThrew(1, 0);
 }
}

function invoke_viiiijii(index, a1, a2, a3, a4, a5, a6, a7) {
 var sp = stackSave();
 try {
  dynCall_viiiijii(index, a1, a2, a3, a4, a5, a6, a7);
 } catch (e) {
  stackRestore(sp);
  if (e !== e + 0) throw e;
  _setThrew(1, 0);
 }
}

function invoke_v(index) {
 var sp = stackSave();
 try {
  dynCall_v(index);
 } catch (e) {
  stackRestore(sp);
  if (e !== e + 0) throw e;
  _setThrew(1, 0);
 }
}

function invoke_iijjii(index, a1, a2, a3, a4, a5) {
 var sp = stackSave();
 try {
  return dynCall_iijjii(index, a1, a2, a3, a4, a5);
 } catch (e) {
  stackRestore(sp);
  if (e !== e + 0) throw e;
  _setThrew(1, 0);
 }
}

function invoke_viiiji(index, a1, a2, a3, a4, a5) {
 var sp = stackSave();
 try {
  dynCall_viiiji(index, a1, a2, a3, a4, a5);
 } catch (e) {
  stackRestore(sp);
  if (e !== e + 0) throw e;
  _setThrew(1, 0);
 }
}

function applySignatureConversions(wasmExports) {
 wasmExports = Object.assign({}, wasmExports);
 var makeWrapper_p = f => () => f() >>> 0;
 var makeWrapper_pp = f => a0 => f(a0) >>> 0;
 var makeWrapper_ppp = f => (a0, a1) => f(a0, a1) >>> 0;
 var makeWrapper_p_ = f => a0 => f(a0) >>> 0;
 wasmExports["__errno_location"] = makeWrapper_p(wasmExports["__errno_location"]);
 wasmExports["malloc"] = makeWrapper_pp(wasmExports["malloc"]);
 wasmExports["pthread_self"] = makeWrapper_p(wasmExports["pthread_self"]);
 wasmExports["emscripten_builtin_memalign"] = makeWrapper_ppp(wasmExports["emscripten_builtin_memalign"]);
 wasmExports["emscripten_builtin_malloc"] = makeWrapper_pp(wasmExports["emscripten_builtin_malloc"]);
 wasmExports["emscripten_main_runtime_thread_id"] = makeWrapper_p(wasmExports["emscripten_main_runtime_thread_id"]);
 wasmExports["stackSave"] = makeWrapper_p(wasmExports["stackSave"]);
 wasmExports["stackAlloc"] = makeWrapper_pp(wasmExports["stackAlloc"]);
 wasmExports["_wasmfs_read_file"] = makeWrapper_pp(wasmExports["_wasmfs_read_file"]);
 wasmExports["_wasmfs_get_cwd"] = makeWrapper_p_(wasmExports["_wasmfs_get_cwd"]);
 return wasmExports;
}

Module["addRunDependency"] = addRunDependency;

Module["removeRunDependency"] = removeRunDependency;

Module["FS_createPath"] = FS.createPath;

Module["callMain"] = callMain;

Module["wasmMemory"] = wasmMemory;

Module["getTempRet0"] = getTempRet0;

Module["setTempRet0"] = setTempRet0;

Module["keepRuntimeAlive"] = keepRuntimeAlive;

Module["addFunction"] = addFunction;

Module["removeFunction"] = removeFunction;

Module["ExitStatus"] = ExitStatus;

Module["FS_createPreloadedFile"] = FS.createPreloadedFile;

Module["FS"] = FS;

Module["FS_createDataFile"] = FS.createDataFile;

Module["FS_unlink"] = FS.unlink;

var calledRun;

dependenciesFulfilled = function runCaller() {
 if (!calledRun) run();
 if (!calledRun) dependenciesFulfilled = runCaller;
};

function callMain(args = []) {
 var entryFunction = __emscripten_proxy_main;
 runtimeKeepalivePush();
 args.unshift(thisProgram);
 var argc = args.length;
 var argv = stackAlloc((argc + 1) * 4);
 var argv_ptr = argv;
 args.forEach(arg => {
  HEAPU32[((argv_ptr) >>> 2) >>> 0] = stringToUTF8OnStack(arg);
  argv_ptr += 4;
 });
 HEAPU32[((argv_ptr) >>> 2) >>> 0] = 0;
 try {
  var ret = entryFunction(argc, argv);
  exitJS(ret, /* implicit = */ true);
  return ret;
 } catch (e) {
  return handleException(e);
 }
}

function run(args = arguments_) {
 if (runDependencies > 0) {
  return;
 }
 if (ENVIRONMENT_IS_PTHREAD) {
  readyPromiseResolve(Module);
  initRuntime();
  startWorker(Module);
  return;
 }
 preRun();
 if (runDependencies > 0) {
  return;
 }
 function doRun() {
  if (calledRun) return;
  calledRun = true;
  Module["calledRun"] = true;
  if (ABORT) return;
  initRuntime();
  preMain();
  readyPromiseResolve(Module);
  if (Module["onRuntimeInitialized"]) Module["onRuntimeInitialized"]();
  if (shouldRunNow) callMain(args);
  postRun();
 }
 if (Module["setStatus"]) {
  Module["setStatus"]("Running...");
  setTimeout(function() {
   setTimeout(function() {
    Module["setStatus"]("");
   }, 1);
   doRun();
  }, 1);
 } else {
  doRun();
 }
}

if (Module["preInit"]) {
 if (typeof Module["preInit"] == "function") Module["preInit"] = [ Module["preInit"] ];
 while (Module["preInit"].length > 0) {
  Module["preInit"].pop()();
 }
}

var shouldRunNow = true;

if (Module["noInitialRun"]) shouldRunNow = false;

run();


  return moduleArg.ready
}
);
})();
;
export default Module;