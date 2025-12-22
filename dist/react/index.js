'use strict';

var react = require('react');
var zod = require('zod');
var jsxRuntime = require('react/jsx-runtime');

var _documentCurrentScript = typeof document !== 'undefined' ? document.currentScript : null;
// src/react/useNmeshed.tsx

// src/errors.ts
var NMeshedError = class _NMeshedError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
    this.name = "NMeshedError";
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, _NMeshedError);
    }
  }
};
var ConfigurationError = class extends NMeshedError {
  constructor(message) {
    super(message, "CONFIGURATION_ERROR");
    this.name = "ConfigurationError";
  }
};
var ConnectionError = class extends NMeshedError {
  constructor(message, cause, isRetryable = true) {
    super(message, "CONNECTION_ERROR");
    this.cause = cause;
    this.isRetryable = isRetryable;
    this.name = "ConnectionError";
  }
};

// src/codec.ts
var textEncoder = new TextEncoder();
new TextDecoder();
function encodeValue(value) {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (typeof value === "string") {
    return textEncoder.encode(value);
  }
  if (typeof value === "number") {
    const buf = new ArrayBuffer(8);
    new DataView(buf).setFloat64(0, value, true);
    return new Uint8Array(buf);
  }
  if (typeof value === "boolean") {
    return new Uint8Array([value ? 1 : 0]);
  }
  if (value === null || value === void 0) {
    return new Uint8Array(0);
  }
  try {
    const json = JSON.stringify(value);
    return textEncoder.encode(json);
  } catch (error) {
    throw new Error(`Cannot encode value: ${error instanceof Error ? error.message : "JSON serialization failed"}`);
  }
}

// src/wasm/nmeshed_core.js
var wasm;
function addToExternrefTable0(obj) {
  const idx = wasm.__externref_table_alloc();
  wasm.__wbindgen_externrefs.set(idx, obj);
  return idx;
}
function debugString(val) {
  const type = typeof val;
  if (type == "number" || type == "boolean" || val == null) {
    return `${val}`;
  }
  if (type == "string") {
    return `"${val}"`;
  }
  if (type == "symbol") {
    const description = val.description;
    if (description == null) {
      return "Symbol";
    } else {
      return `Symbol(${description})`;
    }
  }
  if (type == "function") {
    const name = val.name;
    if (typeof name == "string" && name.length > 0) {
      return `Function(${name})`;
    } else {
      return "Function";
    }
  }
  if (Array.isArray(val)) {
    const length = val.length;
    let debug = "[";
    if (length > 0) {
      debug += debugString(val[0]);
    }
    for (let i = 1; i < length; i++) {
      debug += ", " + debugString(val[i]);
    }
    debug += "]";
    return debug;
  }
  const builtInMatches = /\[object ([^\]]+)\]/.exec(toString.call(val));
  let className;
  if (builtInMatches && builtInMatches.length > 1) {
    className = builtInMatches[1];
  } else {
    return toString.call(val);
  }
  if (className == "Object") {
    try {
      return "Object(" + JSON.stringify(val) + ")";
    } catch (_) {
      return "Object";
    }
  }
  if (val instanceof Error) {
    return `${val.name}: ${val.message}
${val.stack}`;
  }
  return className;
}
function getArrayU8FromWasm0(ptr, len) {
  ptr = ptr >>> 0;
  return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}
var cachedDataViewMemory0 = null;
function getDataViewMemory0() {
  if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || cachedDataViewMemory0.buffer.detached === void 0 && cachedDataViewMemory0.buffer !== wasm.memory.buffer) {
    cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
  }
  return cachedDataViewMemory0;
}
function getStringFromWasm0(ptr, len) {
  ptr = ptr >>> 0;
  return decodeText(ptr, len);
}
var cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
  if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
    cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
  }
  return cachedUint8ArrayMemory0;
}
function handleError(f, args) {
  try {
    return f.apply(this, args);
  } catch (e) {
    const idx = addToExternrefTable0(e);
    wasm.__wbindgen_exn_store(idx);
  }
}
function isLikeNone(x) {
  return x === void 0 || x === null;
}
function passArray8ToWasm0(arg, malloc) {
  const ptr = malloc(arg.length * 1, 1) >>> 0;
  getUint8ArrayMemory0().set(arg, ptr / 1);
  WASM_VECTOR_LEN = arg.length;
  return ptr;
}
function passStringToWasm0(arg, malloc, realloc) {
  if (realloc === void 0) {
    const buf = cachedTextEncoder.encode(arg);
    const ptr2 = malloc(buf.length, 1) >>> 0;
    getUint8ArrayMemory0().subarray(ptr2, ptr2 + buf.length).set(buf);
    WASM_VECTOR_LEN = buf.length;
    return ptr2;
  }
  let len = arg.length;
  let ptr = malloc(len, 1) >>> 0;
  const mem = getUint8ArrayMemory0();
  let offset = 0;
  for (; offset < len; offset++) {
    const code = arg.charCodeAt(offset);
    if (code > 127) break;
    mem[ptr + offset] = code;
  }
  if (offset !== len) {
    if (offset !== 0) {
      arg = arg.slice(offset);
    }
    ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
    const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
    const ret = cachedTextEncoder.encodeInto(arg, view);
    offset += ret.written;
    ptr = realloc(ptr, len, offset, 1) >>> 0;
  }
  WASM_VECTOR_LEN = offset;
  return ptr;
}
function takeFromExternrefTable0(idx) {
  const value = wasm.__wbindgen_externrefs.get(idx);
  wasm.__externref_table_dealloc(idx);
  return value;
}
var cachedTextDecoder = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
var MAX_SAFARI_DECODE_BYTES = 2146435072;
var numBytesDecoded = 0;
function decodeText(ptr, len) {
  numBytesDecoded += len;
  if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
    cachedTextDecoder = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });
    cachedTextDecoder.decode();
    numBytesDecoded = len;
  }
  return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}
var cachedTextEncoder = new TextEncoder();
if (!("encodeInto" in cachedTextEncoder)) {
  cachedTextEncoder.encodeInto = function(arg, view) {
    const buf = cachedTextEncoder.encode(arg);
    view.set(buf);
    return {
      read: arg.length,
      written: buf.length
    };
  };
}
var WASM_VECTOR_LEN = 0;
var NMeshedClientCoreFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {
}, unregister: () => {
} } : new FinalizationRegistry((ptr) => wasm.__wbg_nmeshedclientcore_free(ptr >>> 0, 1));
var NMeshedClientCore = class {
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr;
    this.__wbg_ptr = 0;
    NMeshedClientCoreFinalization.unregister(this);
    return ptr;
  }
  free() {
    const ptr = this.__destroy_into_raw();
    wasm.__wbg_nmeshedclientcore_free(ptr, 0);
  }
  /**
   * @param {string} key
   * @param {Uint8Array} value
   * @param {bigint} timestamp
   * @returns {Uint8Array}
   */
  apply_local_op(key, value, timestamp) {
    const ptr0 = passStringToWasm0(key, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(value, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.nmeshedclientcore_apply_local_op(this.__wbg_ptr, ptr0, len0, ptr1, len1, timestamp);
    if (ret[3]) {
      throw takeFromExternrefTable0(ret[2]);
    }
    var v3 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v3;
  }
  /**
   * @param {Uint8Array} packet_data
   * @returns {any}
   */
  merge_remote_delta(packet_data) {
    const ptr0 = passArray8ToWasm0(packet_data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.nmeshedclientcore_merge_remote_delta(this.__wbg_ptr, ptr0, len0);
    if (ret[2]) {
      throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
  }
  /**
   * @returns {Uint8Array}
   */
  get_binary_snapshot() {
    const ret = wasm.nmeshedclientcore_get_binary_snapshot(this.__wbg_ptr);
    var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v1;
  }
  /**
   * Initializes the client.
   * `sync_mode`: "collaborative" (default) or "realtime" (fast, lossy).
   * @param {string} workspace_uuid_str
   * @param {string | null} [sync_mode]
   */
  constructor(workspace_uuid_str, sync_mode) {
    const ptr0 = passStringToWasm0(workspace_uuid_str, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    var ptr1 = isLikeNone(sync_mode) ? 0 : passStringToWasm0(sync_mode, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    var len1 = WASM_VECTOR_LEN;
    const ret = wasm.nmeshedclientcore_new(ptr0, len0, ptr1, len1);
    if (ret[2]) {
      throw takeFromExternrefTable0(ret[1]);
    }
    this.__wbg_ptr = ret[0] >>> 0;
    NMeshedClientCoreFinalization.register(this, this.__wbg_ptr, this);
    return this;
  }
  /**
   * @returns {any}
   */
  get_state() {
    const ret = wasm.nmeshedclientcore_get_state(this.__wbg_ptr);
    if (ret[2]) {
      throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
  }
};
if (Symbol.dispose) NMeshedClientCore.prototype[Symbol.dispose] = NMeshedClientCore.prototype.free;
var EXPECTED_RESPONSE_TYPES = /* @__PURE__ */ new Set(["basic", "cors", "default"]);
async function __wbg_load(module, imports) {
  if (typeof Response === "function" && module instanceof Response) {
    if (typeof WebAssembly.instantiateStreaming === "function") {
      try {
        return await WebAssembly.instantiateStreaming(module, imports);
      } catch (e) {
        const validResponse = module.ok && EXPECTED_RESPONSE_TYPES.has(module.type);
        if (validResponse && module.headers.get("Content-Type") !== "application/wasm") {
          console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);
        } else {
          throw e;
        }
      }
    }
    const bytes = await module.arrayBuffer();
    return await WebAssembly.instantiate(bytes, imports);
  } else {
    const instance = await WebAssembly.instantiate(module, imports);
    if (instance instanceof WebAssembly.Instance) {
      return { instance, module };
    } else {
      return instance;
    }
  }
}
function __wbg_get_imports() {
  const imports = {};
  imports.wbg = {};
  imports.wbg.__wbg_Error_52673b7de5a0ca89 = function(arg0, arg1) {
    const ret = Error(getStringFromWasm0(arg0, arg1));
    return ret;
  };
  imports.wbg.__wbg_String_8f0eb39a4a4c2f66 = function(arg0, arg1) {
    const ret = String(arg1);
    const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
  };
  imports.wbg.__wbg___wbindgen_debug_string_adfb662ae34724b6 = function(arg0, arg1) {
    const ret = debugString(arg1);
    const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
  };
  imports.wbg.__wbg___wbindgen_is_string_704ef9c8fc131030 = function(arg0) {
    const ret = typeof arg0 === "string";
    return ret;
  };
  imports.wbg.__wbg___wbindgen_throw_dd24417ed36fc46e = function(arg0, arg1) {
    throw new Error(getStringFromWasm0(arg0, arg1));
  };
  imports.wbg.__wbg_getRandomValues_9b655bdd369112f2 = function() {
    return handleError(function(arg0, arg1) {
      globalThis.crypto.getRandomValues(getArrayU8FromWasm0(arg0, arg1));
    }, arguments);
  };
  imports.wbg.__wbg_new_1ba21ce319a06297 = function() {
    const ret = new Object();
    return ret;
  };
  imports.wbg.__wbg_new_25f239778d6112b9 = function() {
    const ret = new Array();
    return ret;
  };
  imports.wbg.__wbg_new_b546ae120718850e = function() {
    const ret = /* @__PURE__ */ new Map();
    return ret;
  };
  imports.wbg.__wbg_new_from_slice_f9c22b9153b26992 = function(arg0, arg1) {
    const ret = new Uint8Array(getArrayU8FromWasm0(arg0, arg1));
    return ret;
  };
  imports.wbg.__wbg_set_3f1d0b984ed272ed = function(arg0, arg1, arg2) {
    arg0[arg1] = arg2;
  };
  imports.wbg.__wbg_set_781438a03c0c3c81 = function() {
    return handleError(function(arg0, arg1, arg2) {
      const ret = Reflect.set(arg0, arg1, arg2);
      return ret;
    }, arguments);
  };
  imports.wbg.__wbg_set_7df433eea03a5c14 = function(arg0, arg1, arg2) {
    arg0[arg1 >>> 0] = arg2;
  };
  imports.wbg.__wbg_set_efaaf145b9377369 = function(arg0, arg1, arg2) {
    const ret = arg0.set(arg1, arg2);
    return ret;
  };
  imports.wbg.__wbindgen_cast_2241b6af4c4b2941 = function(arg0, arg1) {
    const ret = getStringFromWasm0(arg0, arg1);
    return ret;
  };
  imports.wbg.__wbindgen_cast_4625c577ab2ec9ee = function(arg0) {
    const ret = BigInt.asUintN(64, arg0);
    return ret;
  };
  imports.wbg.__wbindgen_cast_9ae0607507abb057 = function(arg0) {
    const ret = arg0;
    return ret;
  };
  imports.wbg.__wbindgen_cast_d6cd19b81560fd6e = function(arg0) {
    const ret = arg0;
    return ret;
  };
  imports.wbg.__wbindgen_init_externref_table = function() {
    const table = wasm.__wbindgen_externrefs;
    const offset = table.grow(4);
    table.set(0, void 0);
    table.set(offset + 0, void 0);
    table.set(offset + 1, null);
    table.set(offset + 2, true);
    table.set(offset + 3, false);
  };
  return imports;
}
function __wbg_finalize_init(instance, module) {
  wasm = instance.exports;
  __wbg_init.__wbindgen_wasm_module = module;
  cachedDataViewMemory0 = null;
  cachedUint8ArrayMemory0 = null;
  wasm.__wbindgen_start();
  return wasm;
}
async function __wbg_init(module_or_path) {
  if (wasm !== void 0) return wasm;
  if (typeof module_or_path !== "undefined") {
    if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
      ({ module_or_path } = module_or_path);
    } else {
      console.warn("using deprecated parameters for the initialization function; pass a single object instead");
    }
  }
  if (typeof module_or_path === "undefined") {
    module_or_path = new URL("nmeshed_core_bg.wasm", (typeof document === 'undefined' ? require('u' + 'rl').pathToFileURL(__filename).href : (_documentCurrentScript && _documentCurrentScript.tagName.toUpperCase() === 'SCRIPT' && _documentCurrentScript.src || new URL('index.js', document.baseURI).href)));
  }
  const imports = __wbg_get_imports();
  if (typeof module_or_path === "string" || typeof Request === "function" && module_or_path instanceof Request || typeof URL === "function" && module_or_path instanceof URL) {
    module_or_path = fetch(module_or_path);
  }
  const { instance, module } = await __wbg_load(await module_or_path, imports);
  return __wbg_finalize_init(instance, module);
}
var nmeshed_core_default = __wbg_init;

// src/persistence.ts
var DB_NAME = "nmeshed_db";
var STORE_NAME = "operation_queue";
var DB_VERSION = 1;
function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
  });
}
async function saveQueue(workspaceId, queue) {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      if (queue.length === 0) {
        store.delete(workspaceId);
      } else {
        store.put(queue, workspaceId);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (error) {
    console.warn("[nMeshed] Failed to save queue to IndexedDB:", error);
  }
}
async function loadQueue(workspaceId) {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(workspaceId);
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.warn("[nMeshed] Failed to load queue from IndexedDB:", error);
    return [];
  }
}

// src/client.ts
var ConfigSchema = zod.z.object({
  workspaceId: zod.z.string().min(1, "workspaceId is required and must be a non-empty string"),
  token: zod.z.string().min(1, "token is required and must be a non-empty string"),
  syncMode: zod.z.enum(["crdt", "crdt_performance", "crdt_strict", "lww"]).optional(),
  userId: zod.z.string().optional(),
  serverUrl: zod.z.string().optional(),
  autoReconnect: zod.z.boolean().optional(),
  maxReconnectAttempts: zod.z.number().nonnegative().optional(),
  reconnectBaseDelay: zod.z.number().nonnegative().optional(),
  maxReconnectDelay: zod.z.number().nonnegative().optional(),
  connectionTimeout: zod.z.number().nonnegative().optional(),
  heartbeatInterval: zod.z.number().nonnegative().optional(),
  maxQueueSize: zod.z.number().nonnegative().optional(),
  debug: zod.z.boolean().optional()
});
var DEFAULT_CONFIG = {
  serverUrl: "wss://api.nmeshed.com",
  autoReconnect: true,
  maxReconnectAttempts: 10,
  reconnectBaseDelay: 1e3,
  maxReconnectDelay: 3e4,
  connectionTimeout: 1e4,
  heartbeatInterval: 3e4,
  maxQueueSize: 1e3,
  debug: false
};
var NMeshedClient = class {
  /**
   * Creates a new nMeshed client instance.
   *
   * @param config - Configuration options
   * @throws {ConfigurationError} If workspaceId or token is missing
   */
  constructor(config) {
    this.ws = null;
    this.status = "IDLE";
    this.messageListeners = /* @__PURE__ */ new Set();
    this.statusListeners = /* @__PURE__ */ new Set();
    this.ephemeralListeners = /* @__PURE__ */ new Set();
    this.presenceListeners = /* @__PURE__ */ new Set();
    this.queueListeners = /* @__PURE__ */ new Set();
    this.reconnectAttempts = 0;
    this.reconnectTimeout = null;
    this.connectionTimeout = null;
    this.heartbeatInterval = null;
    this.operationQueue = [];
    this.core = null;
    this.preConnectState = {};
    this.isDestroyed = false;
    const result = ConfigSchema.safeParse(config);
    if (!result.success) {
      const errorMessages = result.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ");
      throw new ConfigurationError(`nMeshed: ${errorMessages}`);
    }
    const validConfig = result.data;
    this.config = {
      ...DEFAULT_CONFIG,
      workspaceId: validConfig.workspaceId.trim(),
      token: validConfig.token,
      syncMode: validConfig.syncMode || "crdt",
      userId: validConfig.userId?.trim() || this.generateUserId(),
      ...validConfig.serverUrl && { serverUrl: validConfig.serverUrl },
      ...validConfig.autoReconnect !== void 0 && { autoReconnect: validConfig.autoReconnect },
      ...validConfig.maxReconnectAttempts !== void 0 && { maxReconnectAttempts: validConfig.maxReconnectAttempts },
      ...validConfig.reconnectBaseDelay !== void 0 && { reconnectBaseDelay: validConfig.reconnectBaseDelay },
      ...validConfig.maxReconnectDelay !== void 0 && { maxReconnectDelay: validConfig.maxReconnectDelay },
      ...validConfig.connectionTimeout !== void 0 && { connectionTimeout: validConfig.connectionTimeout },
      ...validConfig.heartbeatInterval !== void 0 && { heartbeatInterval: validConfig.heartbeatInterval },
      ...validConfig.maxQueueSize !== void 0 && { maxQueueSize: validConfig.maxQueueSize },
      ...validConfig.debug !== void 0 && { debug: validConfig.debug }
    };
    this.loadQueue();
  }
  /**
   * Generates a random user ID using crypto if available, falling back to Math.random.
   */
  generateUserId() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return `user-${crypto.randomUUID().substring(0, 8)}`;
    }
    return "user-" + Math.random().toString(36).substring(2, 11);
  }
  /**
   * Logs a debug message if debug mode is enabled.
   */
  log(message, ...args) {
    if (this.config.debug) {
      const timestamp = (/* @__PURE__ */ new Date()).toISOString();
      console.log(`[nMeshed ${timestamp}] ${message} `, ...args);
    }
  }
  /**
   * Logs a warning message (always shown).
   */
  warn(message, ...args) {
    console.warn(`[nMeshed] ${message} `, ...args);
  }
  /**
   * Updates the connection status and notifies listeners.
   */
  setStatus(newStatus) {
    if (this.status !== newStatus) {
      this.log(`Status: ${this.status} -> ${newStatus} `);
      this.status = newStatus;
      const listeners = Array.from(this.statusListeners);
      for (const listener of listeners) {
        try {
          listener(newStatus);
        } catch (error) {
          this.warn("Status listener threw an error:", error);
        }
      }
    }
  }
  /**
   * Builds the WebSocket URL with query parameters.
   */
  buildUrl() {
    const base = this.config.serverUrl.replace(/\/+$/, "");
    const params = new URLSearchParams({
      token: this.config.token,
      userId: this.config.userId,
      sync_mode: this.config.syncMode
    });
    const encodedWorkspace = encodeURIComponent(this.config.workspaceId);
    return `${base}/v1/sync/${encodedWorkspace}?${params.toString()}`;
  }
  /**
   * Connects to the nMeshed server.
   *
   * @returns A promise that resolves when connected, or rejects on error.
   * @throws {ConnectionError} If connection fails or times out
   */
  connect() {
    if (this.isDestroyed) {
      return Promise.reject(new ConnectionError("Client has been destroyed", void 0, false));
    }
    if (this.status === "CONNECTED") {
      this.log("Already connected");
      return Promise.resolve();
    }
    if (this.status === "CONNECTING") {
      this.log("Connection already in progress");
      return Promise.resolve();
    }
    return new Promise(async (resolve, reject) => {
      this.setStatus("CONNECTING");
      try {
        if (!this.core) {
          await nmeshed_core_default();
          const coreMode = this.config.syncMode === "lww" ? "lww" : "crdt";
          this.core = new NMeshedClientCore(this.config.workspaceId, coreMode);
          for (const [key, value] of Object.entries(this.preConnectState)) {
            try {
              const valBytes = encodeValue(value);
              this.core.apply_local_op(key, valBytes, BigInt(Date.now() * 1e3));
            } catch (e) {
              this.warn("Failed to merge preConnectState for key:", key, e);
            }
          }
          this.preConnectState = {};
        }
      } catch (error) {
        this.setStatus("ERROR");
        reject(new ConnectionError(
          "Failed to initialize WASM core",
          error instanceof Error ? error : new Error(String(error)),
          false
        ));
        return;
      }
      this.setStatus("CONNECTING");
      const url = this.buildUrl();
      this.log("Connecting to", url.replace(this.config.token, "[REDACTED]"));
      if (this.config.connectionTimeout > 0) {
        this.connectionTimeout = setTimeout(() => {
          this.log("Connection timeout");
          this.cleanupConnection();
          this.setStatus("ERROR");
          reject(new ConnectionError(
            `Connection timed out after ${this.config.connectionTimeout} ms`,
            void 0,
            true
          ));
        }, this.config.connectionTimeout);
      }
      try {
        this.ws = new WebSocket(url);
      } catch (error) {
        this.clearConnectionTimeout();
        this.setStatus("ERROR");
        reject(new ConnectionError(
          "Failed to create WebSocket",
          error instanceof Error ? error : void 0,
          false
        ));
        return;
      }
      this.ws.onopen = () => {
        this.clearConnectionTimeout();
        this.log("WebSocket connected");
        this.setStatus("CONNECTED");
        this.reconnectAttempts = 0;
        this.startHeartbeat();
        this.flushOperationQueue();
        resolve();
      };
      this.ws.onclose = (event) => {
        this.clearConnectionTimeout();
        this.log("WebSocket closed", { code: event.code, reason: event.reason });
        this.handleDisconnect(event.code);
      };
      this.ws.onerror = () => {
        this.log("WebSocket error");
        if (this.status === "CONNECTING") {
          this.clearConnectionTimeout();
          this.setStatus("ERROR");
          reject(new ConnectionError("WebSocket connection failed", void 0, true));
        }
      };
      this.ws.binaryType = "arraybuffer";
      this.ws.onmessage = (event) => {
        const isBinaryData = event.data instanceof ArrayBuffer || event.data && typeof event.data === "object" && "byteLength" in event.data && !("length" in event.data);
        if (isBinaryData) {
          try {
            const result = this.core?.merge_remote_delta(new Uint8Array(event.data));
            if (result) {
              if (result.type === "op") {
                const syntheticMsg = {
                  type: "op",
                  payload: {
                    key: result.key,
                    value: result.value,
                    timestamp: 0
                  }
                };
                const listeners2 = Array.from(this.messageListeners);
                for (const listener of listeners2) {
                  try {
                    listener(syntheticMsg);
                  } catch (error) {
                    this.warn("Message listener threw an error:", error);
                  }
                }
              } else if (result.type === "init") {
                const syntheticInit = {
                  type: "init",
                  data: result.data || {}
                };
                const listeners2 = Array.from(this.messageListeners);
                for (const listener of listeners2) {
                  try {
                    listener(syntheticInit);
                  } catch (error) {
                    this.warn("Message listener threw an error:", error);
                  }
                }
              }
            }
            this.log("Received Binary Update");
          } catch (error) {
            this.warn("Failed to merge remote delta:", error);
          }
          const listeners = Array.from(this.ephemeralListeners);
          for (const listener of listeners) {
            try {
              listener(event.data);
            } catch (error) {
              this.warn("Binary listener threw error:", error);
            }
          }
        } else {
          this.handleControlMessage(event.data);
        }
      };
    });
  }
  /**
   * Clears the connection timeout timer.
   */
  clearConnectionTimeout() {
    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
      this.connectionTimeout = null;
    }
  }
  /**
   * Starts the heartbeat interval to detect dead connections.
   */
  startHeartbeat() {
    this.stopHeartbeat();
    if (this.config.heartbeatInterval <= 0) {
      return;
    }
    this.heartbeatInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(new Uint8Array([0]));
          this.log("Heartbeat sent");
        } catch (error) {
          this.warn("Failed to send heartbeat:", error);
        }
      }
    }, this.config.heartbeatInterval);
  }
  /**
   * Stops the heartbeat interval.
   */
  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }
  /**
   * Handles text control messages (ephemeral, presence, errors).
   * NOTE: CRDT operations use binary Flatbuffers, not this path.
   */
  handleControlMessage(data) {
    try {
      const parsed = JSON.parse(data);
      const type = parsed.type;
      switch (type) {
        case "presence":
          const presencePayload = parsed.payload || parsed;
          for (const handler of this.presenceListeners) {
            try {
              handler(presencePayload);
            } catch (error) {
              this.warn("Presence handler threw error:", error);
            }
          }
          break;
        case "ephemeral":
          const ephemeralPayload = parsed.payload || parsed;
          for (const listener of this.ephemeralListeners) {
            try {
              listener(ephemeralPayload);
            } catch (error) {
              this.warn("Ephemeral listener threw error:", error);
            }
          }
          break;
        case "error":
          this.warn("Server error:", parsed.error || parsed.message || data);
          break;
        default:
          this.log("Ignoring unknown control message type:", type);
      }
    } catch {
      this.log("Ignoring non-JSON text message");
    }
  }
  /**
   * Handles disconnection and initiates reconnection if configured.
   */
  handleDisconnect(closeCode) {
    this.cleanupConnection();
    if (closeCode && closeCode >= 4e3 && closeCode < 4100) {
      this.warn("Authentication error, not reconnecting");
      this.setStatus("ERROR");
      return;
    }
    if (!this.config.autoReconnect) {
      this.setStatus("DISCONNECTED");
      return;
    }
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      this.log("Max reconnect attempts reached");
      this.setStatus("ERROR");
      return;
    }
    this.setStatus("RECONNECTING");
    this.scheduleReconnect();
  }
  /**
   * Cleans up the current connection without changing status.
   */
  cleanupConnection() {
    this.stopHeartbeat();
    this.clearConnectionTimeout();
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      try {
        this.ws.close();
      } catch {
      }
      this.ws = null;
    }
  }
  /**
   * Schedules a reconnection attempt with capped exponential backoff.
   */
  scheduleReconnect() {
    const rawDelay = this.config.reconnectBaseDelay * Math.pow(2, this.reconnectAttempts);
    const delay = Math.min(rawDelay, this.config.maxReconnectDelay);
    const jitter = delay * 0.1 * (Math.random() * 2 - 1);
    const finalDelay = Math.round(delay + jitter);
    this.log(`Reconnecting in ${finalDelay} ms(attempt ${this.reconnectAttempts + 1} / ${this.config.maxReconnectAttempts})`);
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectAttempts++;
      this.connect().catch((error) => {
        this.log("Reconnect failed:", error);
      });
    }, finalDelay);
  }
  /**
   * Flushes any operations queued while disconnected.
   */
  flushOperationQueue() {
    if (this.operationQueue.length === 0) {
      return;
    }
    this.log(`Flushing ${this.operationQueue.length} queued operations`);
    const queueToProcess = [...this.operationQueue];
    this.operationQueue = [];
    this.saveQueue();
    this.notifyQueueListeners();
    for (const op of queueToProcess) {
      this.sendOperationInternal(op.key, op.value, op.timestamp);
    }
  }
  /**
   * Sets a key-value pair in the workspace.
   *
   * @param key - The key to set (must be non-empty string)
   * @param value - The value to set
   * @throws {ConfigurationError} If key is invalid
   */
  set(key, value) {
    if (!key || typeof key !== "string") {
      throw new ConfigurationError("Key must be a non-empty string");
    }
    this.sendOperation(key, value);
  }
  get(key) {
    if (!this.core) {
      return this.preConnectState[key];
    }
    const state = this.getState();
    return state[key];
  }
  /**
   * Gets the entire current state of the workspace.
   *
   * @returns The current state from the WASM core
   */
  getState() {
    if (!this.core) return { ...this.preConnectState };
    try {
      return this.core.get_state();
    } catch (error) {
      this.warn("Failed to get state from WASM core:", error);
      return {};
    }
  }
  /**
   * Sends an operation to update a key-value pair.
   *
   * If not connected, the operation is queued and sent when reconnected.
   *
   * @param key - The key to update
   * @param value - The new value
   */
  sendOperation(key, value) {
    const timestamp = Date.now() * 1e3;
    if (!this.core) {
      this.preConnectState[key] = value;
    }
    if (this.ws?.readyState !== WebSocket.OPEN) {
      this.queueOperation(key, value, timestamp);
      return;
    }
    this.sendOperationInternal(key, value, timestamp);
  }
  /**
   * Broadcasts an ephemeral message to all other connected clients.
   * 
   * @param payload - The data to broadcast (JSON object or Binary ArrayBuffer)
   */
  broadcast(payload) {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      this.warn("Cannot broadcast: not connected");
      return;
    }
    try {
      if (payload instanceof ArrayBuffer || payload instanceof Uint8Array) {
        this.ws.send(payload);
        return;
      }
      const encoded = encodeValue(payload);
      this.ws.send(encoded);
    } catch (error) {
      this.warn("Failed to broadcast message:", error);
    }
  }
  /**
   * Internal method to send an operation (assumes connection is open).
   */
  sendOperationInternal(key, value, timestamp) {
    if (!this.core) {
      this.warn("WASM core not initialized, queuing operation");
      this.queueOperation(key, value, timestamp);
      return;
    }
    let valBytes;
    try {
      valBytes = encodeValue(value);
    } catch (error) {
      this.warn("Failed to encode value, dropping operation:", key, error);
      return;
    }
    try {
      const binaryOp = this.core.apply_local_op(key, valBytes, BigInt(timestamp));
      if (this.ws) {
        this.ws.send(binaryOp);
      }
      this.log("Sent binary operation (WASM-packed):", key);
    } catch (error) {
      this.warn("Failed to send binary operation via WASM core:", error);
      this.queueOperation(key, value, timestamp);
    }
  }
  /**
   * Queues an operation for later sending.
   */
  queueOperation(key, value, timestamp) {
    if (this.config.maxQueueSize > 0 && this.operationQueue.length >= this.config.maxQueueSize) {
      const dropped = this.operationQueue.shift();
      this.warn(`Queue full, dropping oldest operation: ${dropped?.key} `);
    }
    this.operationQueue.push({ key, value, timestamp });
    this.saveQueue();
    this.notifyQueueListeners();
    this.log(`Queued operation: ${key} (queue size: ${this.operationQueue.length})`);
  }
  /**
   * Subscribes to incoming messages.
   *
   * @param handler - Function to call when a message is received
   * @returns A cleanup function to unsubscribe
   */
  onMessage(handler) {
    if (typeof handler !== "function") {
      throw new ConfigurationError("Message handler must be a function");
    }
    this.messageListeners.add(handler);
    return () => {
      this.messageListeners.delete(handler);
    };
  }
  /**
   * Subscribes to connection status changes.
   *
   * The handler is called immediately with the current status.
   *
   * @param handler - Function to call when status changes
   * @returns A cleanup function to unsubscribe
   */
  /**
   * Subscribes to ephemeral broadcasts.
   */
  onBroadcast(handler) {
    if (typeof handler !== "function") {
      throw new ConfigurationError("Broadcast handler must be a function");
    }
    this.ephemeralListeners.add(handler);
    return () => {
      this.ephemeralListeners.delete(handler);
    };
  }
  /**
   * Subscribes to presence updates.
   */
  onPresence(handler) {
    if (typeof handler !== "function") {
      throw new ConfigurationError("Presence handler must be a function");
    }
    this.presenceListeners.add(handler);
    return () => {
      this.presenceListeners.delete(handler);
    };
  }
  onStatusChange(handler) {
    if (typeof handler !== "function") {
      throw new ConfigurationError("Status handler must be a function");
    }
    this.statusListeners.add(handler);
    try {
      handler(this.status);
    } catch (error) {
      this.warn("Status handler threw an error:", error);
    }
    return () => {
      this.statusListeners.delete(handler);
    };
  }
  /**
   * Gets the current connection status.
   */
  getStatus() {
    return this.status;
  }
  /**
   * Gets the number of operations in the queue.
   */
  getQueueSize() {
    return this.operationQueue.length;
  }
  /**
   * Disconnects from the server.
   *
   * After calling this, you can call `connect()` again to reconnect.
   */
  disconnect() {
    this.log("Disconnecting");
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    this.cleanupConnection();
    this.setStatus("DISCONNECTED");
  }
  /**
   * Alias for disconnect() for API consistency.
   */
  close() {
    this.disconnect();
  }
  /**
   * Subscribe to queue size changes.
   */
  onQueueChange(handler) {
    this.queueListeners.add(handler);
    handler(this.operationQueue.length);
    return () => {
      this.queueListeners.delete(handler);
    };
  }
  notifyQueueListeners() {
    const size = this.operationQueue.length;
    for (const handler of this.queueListeners) {
      try {
        handler(size);
      } catch (e) {
        this.warn("Queue listener error", e);
      }
    }
  }
  async loadQueue() {
    try {
      const items = await loadQueue(this.config.workspaceId);
      if (items && items.length > 0) {
        this.operationQueue = [...items, ...this.operationQueue];
        this.notifyQueueListeners();
        this.log(`Loaded ${items.length} operations from IndexedDB`);
      }
    } catch (e) {
      this.warn("Failed to load queue from IndexedDB", e);
    }
  }
  saveQueue() {
    saveQueue(this.config.workspaceId, this.operationQueue).catch((e) => {
      this.warn("Failed to save queue to IndexedDB", e);
    });
  }
  destroy() {
    this.disconnect();
    this.isDestroyed = true;
    this.preConnectState = {};
    this.operationQueue = [];
    this.core = null;
  }
  async getPresence() {
    const base = this.config.serverUrl.replace(/\/+$/, "").replace(/^ws/, "http");
    const encodedWorkspace = encodeURIComponent(this.config.workspaceId);
    const url = `${base}/v1/presence/${encodedWorkspace}`;
    const response = await fetch(url, {
      headers: {
        "Authorization": `Bearer ${this.config.token}`
      }
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch presence: ${response.statusText}`);
    }
    return response.json();
  }
};

// src/react/useNmeshed.tsx
function useNmeshed(options) {
  const { onConnect, onDisconnect, onError, ...config } = options;
  const clientRef = react.useRef(null);
  if (!clientRef.current) {
    clientRef.current = new NMeshedClient(config);
  }
  const client = clientRef.current;
  const [state, setState] = react.useState({});
  const [status, setStatus] = react.useState("IDLE");
  const [queueSize, setQueueSize] = react.useState(0);
  react.useEffect(() => {
    const currentClient = client;
    const unsubscribeStatus = currentClient.onStatusChange((newStatus) => {
      setStatus(newStatus);
      if (newStatus === "CONNECTED") {
        onConnect?.();
      } else if (newStatus === "DISCONNECTED") {
        onDisconnect?.();
      } else if (newStatus === "ERROR") {
        onError?.(new Error("Connection error"));
      }
    });
    const unsubscribeQueue = currentClient.onQueueChange((size) => {
      setQueueSize(size);
    });
    const unsubscribeMessage = currentClient.onMessage((message) => {
      if (message.type === "init") {
        setState(message.data);
      } else if (message.type === "op") {
        setState((prev) => ({
          ...prev,
          [message.payload.key]: message.payload.value
        }));
      }
    });
    currentClient.connect().catch((error) => {
      onError?.(error);
    });
    return () => {
      unsubscribeStatus();
      unsubscribeQueue();
      unsubscribeMessage();
      currentClient.disconnect();
    };
  }, []);
  const set = react.useCallback((key, value) => {
    client.set(key, value);
    setState((prev) => ({ ...prev, [key]: value }));
  }, [client]);
  const get = react.useCallback((key) => {
    return state[key];
  }, [state]);
  const connect = react.useCallback(() => client.connect(), [client]);
  const disconnect = react.useCallback(() => client.disconnect(), [client]);
  return {
    state,
    set,
    get,
    status,
    isConnected: status === "CONNECTED",
    client,
    connect,
    disconnect,
    queueSize
  };
}
var NMeshedContext = react.createContext(null);
function NMeshedProvider({
  config,
  children,
  autoConnect = true
}) {
  const clientRef = react.useRef(null);
  if (!clientRef.current) {
    clientRef.current = new NMeshedClient(config);
  }
  react.useEffect(() => {
    const client = clientRef.current;
    if (!client) return;
    if (autoConnect) {
      client.connect().catch((error) => {
        console.error("[nMeshed] Auto-connect failed:", error);
      });
    }
    return () => {
      client.disconnect();
    };
  }, [autoConnect]);
  return /* @__PURE__ */ jsxRuntime.jsx(NMeshedContext.Provider, { value: clientRef.current, children });
}
function useNmeshedContext() {
  const client = react.useContext(NMeshedContext);
  if (!client) {
    throw new Error(
      "useNmeshedContext must be used within an NMeshedProvider. Wrap your component tree with <NMeshedProvider>."
    );
  }
  return client;
}

// src/react/useDocument.tsx
function useDocument(options) {
  const { key, initialValue } = options;
  const client = useNmeshedContext();
  const [value, setLocalValue] = react.useState(initialValue);
  const [isLoaded, setIsLoaded] = react.useState(false);
  react.useEffect(() => {
    const existing = client.get(key);
    if (existing !== void 0) {
      setLocalValue(existing);
      setIsLoaded(true);
    }
    const unsubscribe = client.onMessage((message) => {
      if (message.type === "init" && key in message.data) {
        setLocalValue(message.data[key]);
        setIsLoaded(true);
      } else if (message.type === "op" && message.payload.key === key) {
        setLocalValue(message.payload.value);
        setIsLoaded(true);
      }
    });
    return unsubscribe;
  }, [client, key]);
  const setValue = react.useCallback((newValue) => {
    client.set(key, newValue);
    setLocalValue(newValue);
  }, [client, key]);
  return {
    value,
    setValue,
    isLoaded
  };
}
function usePresence(options = {}) {
  const client = useNmeshedContext();
  const [users, setUsers] = react.useState([]);
  react.useEffect(() => {
    let mounted = true;
    const fetchInitial = async () => {
      if (client.getStatus() === "CONNECTED") {
        try {
          const initialUsers = await client.getPresence();
          if (mounted) {
            setUsers(initialUsers);
          }
        } catch (e) {
          console.warn("Failed to fetch initial presence:", e);
        }
      }
    };
    fetchInitial();
    const unsubscribe = client.onPresence((eventPayload) => {
      setUsers((current) => {
        if (eventPayload.status === "offline") {
          return current.filter((u) => u.userId !== eventPayload.userId);
        }
        const index = current.findIndex((u) => u.userId === eventPayload.userId);
        if (index !== -1) {
          const newUsers = [...current];
          newUsers[index] = { ...newUsers[index], ...eventPayload };
          return newUsers;
        } else {
          return [...current, eventPayload];
        }
      });
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [client]);
  return users;
}
function useBroadcast(handler) {
  const client = useNmeshedContext();
  const handlerRef = react.useRef(handler);
  react.useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);
  react.useEffect(() => {
    if (!handlerRef.current) return;
    const unsubscribe = client.onBroadcast((payload) => {
      if (handlerRef.current) {
        handlerRef.current(payload);
      }
    });
    return () => {
      unsubscribe();
    };
  }, [client]);
  const broadcast = react.useCallback((payload) => {
    client.broadcast(payload);
  }, [client]);
  return broadcast;
}

// src/sync/binary.ts
new TextEncoder();
new TextDecoder();
var MSG_TYPE_CURSOR = 3;
function packCursor(userId, x, y) {
  const userIdBytes = new TextEncoder().encode(userId);
  const buffer = new ArrayBuffer(1 + 2 + 2 + 1 + userIdBytes.length);
  const view = new DataView(buffer);
  let offset = 0;
  view.setUint8(offset++, MSG_TYPE_CURSOR);
  view.setUint16(offset, Math.max(0, Math.min(65535, x)), false);
  offset += 2;
  view.setUint16(offset, Math.max(0, Math.min(65535, y)), false);
  offset += 2;
  view.setUint8(offset++, userIdBytes.length);
  new Uint8Array(buffer).set(userIdBytes, offset);
  return buffer;
}
function unpackCursor(buffer) {
  const view = new DataView(buffer);
  if (view.byteLength < 6) return null;
  let offset = 0;
  const op = view.getUint8(offset++);
  if (op !== MSG_TYPE_CURSOR) return null;
  const x = view.getUint16(offset, false);
  offset += 2;
  const y = view.getUint16(offset, false);
  offset += 2;
  const idLen = view.getUint8(offset++);
  const idBytes = new Uint8Array(buffer, offset, idLen);
  const userId = new TextDecoder().decode(idBytes);
  return { x, y, userId };
}
function isBinaryCursor(data) {
  if (!(data instanceof ArrayBuffer) && !(data instanceof Uint8Array)) return false;
  const view = new DataView(data instanceof Uint8Array ? data.buffer : data);
  return view.byteLength > 0 && view.getUint8(0) === MSG_TYPE_CURSOR;
}
var START_COLORS = ["#f87171", "#fb923c", "#fbbf24", "#a3e635", "#34d399", "#22d3ee", "#818cf8", "#e879f9"];
function getColor(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = id.charCodeAt(i) + ((hash << 5) - hash);
  return START_COLORS[Math.abs(hash) % START_COLORS.length];
}
function CursorIcon({ color }) {
  return /* @__PURE__ */ jsxRuntime.jsx(
    "svg",
    {
      className: "w-5 h-5 drop-shadow-sm",
      viewBox: "0 0 24 24",
      fill: color,
      xmlns: "http://www.w3.org/2000/svg",
      children: /* @__PURE__ */ jsxRuntime.jsx("path", { d: "M5.65376 12.3673H5.46026L5.31717 12.4976L0.500002 16.8829L0.500002 1.19138L11.7841 12.3673H5.65376Z" })
    }
  );
}
function LiveCursors({ selfId }) {
  const cursorState = react.useRef({});
  const domRefs = react.useRef({});
  const requestRef = react.useRef(0);
  const [activeIds, setActiveIds] = react.useState([]);
  const animate = react.useCallback(() => {
    const LERP_FACTOR = 0.2;
    for (const id of activeIds) {
      const cursor = cursorState.current[id];
      const el = domRefs.current[id];
      if (cursor && el) {
        const dx = cursor.targetX - cursor.x;
        const dy = cursor.targetY - cursor.y;
        if (Math.abs(dx) < 0.1 && Math.abs(dy) < 0.1) {
          cursor.x = cursor.targetX;
          cursor.y = cursor.targetY;
        } else {
          cursor.x += dx * LERP_FACTOR;
          cursor.y += dy * LERP_FACTOR;
        }
        el.style.transform = `translate3d(${cursor.x}px, ${cursor.y}px, 0)`;
      }
    }
    requestRef.current = requestAnimationFrame(animate);
  }, [activeIds]);
  react.useEffect(() => {
    requestRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(requestRef.current);
  }, [animate]);
  const handleBroadcast = react.useCallback((payload) => {
    let x, y, userId;
    if (isBinaryCursor(payload)) {
      const decoded = unpackCursor(payload);
      if (!decoded) return;
      x = decoded.x;
      y = decoded.y;
      userId = decoded.userId;
    } else {
      const data = payload;
      if (data.type !== "cursor") return;
      x = data.x;
      y = data.y;
      userId = data.userId;
    }
    if (userId === selfId) return;
    const now = Date.now();
    if (!cursorState.current[userId]) {
      cursorState.current[userId] = {
        x,
        y,
        targetX: x,
        targetY: y,
        lastUpdate: now,
        color: getColor(userId)
      };
      setActiveIds((prev) => [...prev, userId]);
    } else {
      const c = cursorState.current[userId];
      c.targetX = x;
      c.targetY = y;
      c.lastUpdate = now;
    }
  }, [selfId]);
  const broadcast = useBroadcast(handleBroadcast);
  react.useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      let changed = false;
      Object.entries(cursorState.current).forEach(([id, c]) => {
        if (now - c.lastUpdate > 5e3) {
          delete cursorState.current[id];
          delete domRefs.current[id];
          changed = true;
        }
      });
      if (changed) {
        setActiveIds(Object.keys(cursorState.current));
      }
    }, 1e3);
    return () => clearInterval(interval);
  }, []);
  react.useEffect(() => {
    let lastSent = 0;
    const THROTTLE_MS = 30;
    const handleMouseMove = (e) => {
      const now = Date.now();
      if (now - lastSent < THROTTLE_MS) return;
      lastSent = now;
      if (selfId) {
        const buffer = packCursor(selfId, e.clientX, e.clientY);
        broadcast(buffer);
      }
    };
    window.addEventListener("mousemove", handleMouseMove);
    return () => window.removeEventListener("mousemove", handleMouseMove);
  }, [broadcast, selfId]);
  return /* @__PURE__ */ jsxRuntime.jsx("div", { className: "pointer-events-none fixed inset-0 overflow-hidden z-[9999]", children: activeIds.map((id) => {
    const state = cursorState.current[id];
    if (!state) return null;
    return /* @__PURE__ */ jsxRuntime.jsxs(
      "div",
      {
        ref: (el) => {
          domRefs.current[id] = el;
        },
        className: "absolute will-change-transform",
        style: {
          // Start position, implementation handles the rest
          transform: `translate3d(${state.x}px, ${state.y}px, 0)`
        },
        children: [
          /* @__PURE__ */ jsxRuntime.jsx(CursorIcon, { color: state.color }),
          /* @__PURE__ */ jsxRuntime.jsx(
            "div",
            {
              className: "ml-2 px-2 py-1 rounded-full text-xs font-semibold text-white shadow-md",
              style: { backgroundColor: state.color },
              children: id
            }
          )
        ]
      },
      id
    );
  }) });
}
function AvatarStack() {
  const users = usePresence();
  if (users.length === 0) return null;
  return /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "flex -space-x-2 overflow-hidden items-center", children: [
    users.map((user) => /* @__PURE__ */ jsxRuntime.jsxs(
      "div",
      {
        className: "inline-block h-8 w-8 rounded-full ring-2 ring-white dark:ring-gray-800 bg-gray-200 flex items-center justify-center text-xs font-medium text-gray-600 relative",
        title: `${user.userId} (${user.status})`,
        children: [
          user.userId.slice(0, 2).toUpperCase(),
          user.status === "online" && /* @__PURE__ */ jsxRuntime.jsx("span", { className: "absolute bottom-0 right-0 block h-2 w-2 rounded-full ring-2 ring-white bg-green-400" })
        ]
      },
      user.userId
    )),
    /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "ml-4 text-xs text-gray-500", children: [
      users.length,
      " active"
    ] })
  ] });
}

exports.AvatarStack = AvatarStack;
exports.LiveCursors = LiveCursors;
exports.NMeshedProvider = NMeshedProvider;
exports.useBroadcast = useBroadcast;
exports.useDocument = useDocument;
exports.useNmeshed = useNmeshed;
exports.useNmeshedContext = useNmeshedContext;
exports.usePresence = usePresence;
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map