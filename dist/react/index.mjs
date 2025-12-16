import { createContext, useRef, useState, useEffect, useCallback, useContext } from 'react';
import { z } from 'zod';
import { jsx, jsxs } from 'react/jsx-runtime';

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
var MessageError = class extends NMeshedError {
  constructor(message, rawMessage) {
    super(message, "MESSAGE_ERROR");
    this.rawMessage = rawMessage;
    this.name = "MessageError";
  }
};
var PresenceUserSchema = z.object({
  userId: z.string(),
  // We allow string to handle future status types without crashing, 
  // but we prefer the known union.
  // We strictly enforce the union, but coerce unknown strings to 'offline'
  // to prevent UI crashes ("Happy Path" resilience).
  status: z.preprocess(
    (val) => {
      if (val === "online" || val === "idle" || val === "offline") return val;
      return "offline";
    },
    z.union([
      z.literal("online"),
      z.literal("idle"),
      z.literal("offline")
    ])
  ),
  last_seen: z.string().optional(),
  metadata: z.record(z.unknown()).optional()
});
var OperationSchema = z.object({
  key: z.string().min(1),
  value: z.unknown(),
  timestamp: z.number()
});
var InitMessageSchema = z.object({
  type: z.literal("init"),
  data: z.record(z.unknown())
});
var OperationMessageSchema = z.object({
  type: z.literal("op"),
  payload: OperationSchema
});
var PresenceMessageSchema = z.object({
  type: z.literal("presence"),
  users: z.array(PresenceUserSchema)
});
var MessageSchema = z.discriminatedUnion("type", [
  InitMessageSchema,
  OperationMessageSchema,
  PresenceMessageSchema
]);
function parseMessage(raw) {
  let json;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new MessageError(
      `Failed to parse message as JSON: ${error instanceof Error ? error.message : "Unknown error"}`,
      raw
    );
  }
  const result = MessageSchema.safeParse(json);
  if (!result.success) {
    const errorMessages = result.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ");
    throw new MessageError(
      `Validation failed: ${errorMessages}`,
      raw
    );
  }
  return result.data;
}
function truncate(str, maxLength = 200) {
  if (str.length <= maxLength) return str;
  return str.substring(0, maxLength) + `... (${str.length - maxLength} more chars)`;
}
var ConfigSchema = z.object({
  workspaceId: z.string().min(1, "workspaceId is required and must be a non-empty string"),
  token: z.string().min(1, "token is required and must be a non-empty string"),
  userId: z.string().optional(),
  serverUrl: z.string().optional(),
  autoReconnect: z.boolean().optional(),
  maxReconnectAttempts: z.number().nonnegative().optional(),
  reconnectBaseDelay: z.number().nonnegative().optional(),
  maxReconnectDelay: z.number().nonnegative().optional(),
  connectionTimeout: z.number().nonnegative().optional(),
  heartbeatInterval: z.number().nonnegative().optional(),
  maxQueueSize: z.number().nonnegative().optional(),
  debug: z.boolean().optional()
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
    this.reconnectAttempts = 0;
    this.reconnectTimeout = null;
    this.connectionTimeout = null;
    this.heartbeatInterval = null;
    this.operationQueue = [];
    this.currentState = {};
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
  }
  /**
   * Generates a random user ID using crypto if available, falling back to Math.random.
   */
  generateUserId() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return `user - ${crypto.randomUUID().substring(0, 8)} `;
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
      userId: this.config.userId
    });
    const encodedWorkspace = encodeURIComponent(this.config.workspaceId);
    return `${base} /v1/sync / ${encodedWorkspace}?${params.toString()} `;
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
    return new Promise((resolve, reject) => {
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
        if (event.data instanceof ArrayBuffer) {
          const listeners = Array.from(this.ephemeralListeners);
          for (const listener of listeners) {
            try {
              listener(event.data);
            } catch (error) {
              this.warn("Binary listener threw error:", error);
            }
          }
        } else {
          this.handleMessage(event.data);
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
          this.ws.send(JSON.stringify({ type: "ping", timestamp: Date.now() }));
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
   * Handles incoming messages from the server.
   */
  handleMessage(data) {
    try {
      const message = parseMessage(data);
      this.log("Received:", message.type);
      if (message.type === "init") {
        this.currentState = { ...message.data };
      } else if (message.type === "op") {
        this.currentState[message.payload.key] = message.payload.value;
      } else if (message.type === "ephemeral") {
        const listeners2 = Array.from(this.ephemeralListeners);
        for (const listener of listeners2) {
          try {
            listener(message.payload);
          } catch (error) {
            this.warn("Ephemeral listener threw an error:", error);
          }
        }
      } else if (message.type === "presence") {
        const listeners2 = Array.from(this.presenceListeners);
        for (const listener of listeners2) {
          try {
            listener(message.payload);
          } catch (error) {
            this.warn("Presence listener threw an error:", error);
          }
        }
      }
      const listeners = Array.from(this.messageListeners);
      for (const listener of listeners) {
        try {
          listener(message);
        } catch (error) {
          this.warn("Message listener threw an error:", error);
        }
      }
    } catch (error) {
      this.warn("Failed to parse message:", truncate(data), error);
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
  /**
   * Gets the current value of a key from local state.
   *
   * Note: This returns the locally cached state, which may be
   * momentarily out of sync with the server.
   *
   * @param key - The key to get
   * @returns The value, or undefined if not found
   */
  get(key) {
    return this.currentState[key];
  }
  /**
   * Gets the entire current state of the workspace.
   *
   * @returns A shallow copy of the current state
   */
  getState() {
    return { ...this.currentState };
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
    this.currentState[key] = value;
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
      const message = JSON.stringify({
        type: "ephemeral",
        payload
      });
      this.ws.send(message);
    } catch (error) {
      this.warn("Failed to broadcast message:", error);
    }
  }
  /**
   * Internal method to send an operation (assumes connection is open).
   */
  sendOperationInternal(key, value, timestamp) {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      this.queueOperation(key, value, timestamp);
      return;
    }
    let message;
    try {
      message = JSON.stringify({
        type: "op",
        payload: { key, value, timestamp }
      });
    } catch (error) {
      this.warn("Failed to serialize operation, dropping:", error);
      return;
    }
    try {
      this.ws.send(message);
      this.log("Sent operation:", key);
    } catch (error) {
      this.warn("Failed to send operation:", error);
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
   * Helper to convert WebSocket URL to HTTP URL.
   */
  getHttpUrl(path) {
    try {
      const url = new URL(this.config.serverUrl);
      url.protocol = url.protocol === "wss:" ? "https:" : "http:";
      const base = url.toString().replace(/\/+$/, "");
      return `${base}${path}`;
    } catch (e) {
      const base = this.config.serverUrl.replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://").replace(/\/+$/, "");
      return `${base}${path}`;
    }
  }
  /**
   * Fetches current presence information for the workspace.
   * 
   * @returns A promise resolving to a list of active users.
   */
  // Updated to match PresenceUser type in types.ts (with optional last_seen)
  async getPresence() {
    const url = this.getHttpUrl(`/v1/presence/${this.config.workspaceId}`);
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
  /**
   * Permanently destroys the client, releasing all resources.
   * 
   * After calling this, the client cannot be reconnected.
   * Use this for cleanup in React useEffect or similar.
   */
  destroy() {
    this.log("Destroying client");
    this.disconnect();
    this.messageListeners.clear();
    this.statusListeners.clear();
    this.ephemeralListeners.clear();
    this.presenceListeners.clear();
    this.operationQueue = [];
    this.currentState = {};
    this.isDestroyed = true;
  }
};

// src/react/useNmeshed.tsx
function useNmeshed(options) {
  const { onConnect, onDisconnect, onError, ...config } = options;
  const clientRef = useRef(null);
  if (!clientRef.current) {
    clientRef.current = new NMeshedClient(config);
  }
  const client = clientRef.current;
  const [state, setState] = useState({});
  const [status, setStatus] = useState("IDLE");
  useEffect(() => {
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
      unsubscribeMessage();
      currentClient.disconnect();
    };
  }, []);
  const set = useCallback((key, value) => {
    client.set(key, value);
    setState((prev) => ({ ...prev, [key]: value }));
  }, [client]);
  const get = useCallback((key) => {
    return state[key];
  }, [state]);
  const connect = useCallback(() => client.connect(), [client]);
  const disconnect = useCallback(() => client.disconnect(), [client]);
  return {
    state,
    set,
    get,
    status,
    isConnected: status === "CONNECTED",
    client,
    connect,
    disconnect
  };
}
var NMeshedContext = createContext(null);
function NMeshedProvider({
  config,
  children,
  autoConnect = true
}) {
  const clientRef = useRef(null);
  if (!clientRef.current) {
    clientRef.current = new NMeshedClient(config);
  }
  useEffect(() => {
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
  return /* @__PURE__ */ jsx(NMeshedContext.Provider, { value: clientRef.current, children });
}
function useNmeshedContext() {
  const client = useContext(NMeshedContext);
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
  const [value, setLocalValue] = useState(initialValue);
  const [isLoaded, setIsLoaded] = useState(false);
  useEffect(() => {
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
  const setValue = useCallback((newValue) => {
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
  const [users, setUsers] = useState([]);
  useEffect(() => {
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
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);
  useEffect(() => {
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
  const broadcast = useCallback((payload) => {
    client.broadcast(payload);
  }, [client]);
  return broadcast;
}

// src/sync/binary.ts
var OP_CURSOR = 1;
function packCursor(userId, x, y) {
  const userIdBytes = new TextEncoder().encode(userId);
  const buffer = new ArrayBuffer(1 + 2 + 2 + 1 + userIdBytes.length);
  const view = new DataView(buffer);
  let offset = 0;
  view.setUint8(offset++, OP_CURSOR);
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
  if (op !== OP_CURSOR) return null;
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
  return data instanceof ArrayBuffer || data instanceof Uint8Array;
}
var START_COLORS = ["#f87171", "#fb923c", "#fbbf24", "#a3e635", "#34d399", "#22d3ee", "#818cf8", "#e879f9"];
function getColor(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = id.charCodeAt(i) + ((hash << 5) - hash);
  return START_COLORS[Math.abs(hash) % START_COLORS.length];
}
function CursorIcon({ color }) {
  return /* @__PURE__ */ jsx(
    "svg",
    {
      className: "w-5 h-5 drop-shadow-sm",
      viewBox: "0 0 24 24",
      fill: color,
      xmlns: "http://www.w3.org/2000/svg",
      children: /* @__PURE__ */ jsx("path", { d: "M5.65376 12.3673H5.46026L5.31717 12.4976L0.500002 16.8829L0.500002 1.19138L11.7841 12.3673H5.65376Z" })
    }
  );
}
function LiveCursors({ selfId }) {
  const cursorState = useRef({});
  const domRefs = useRef({});
  const requestRef = useRef(0);
  const [activeIds, setActiveIds] = useState([]);
  const animate = useCallback(() => {
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
  useEffect(() => {
    requestRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(requestRef.current);
  }, [animate]);
  const handleBroadcast = useCallback((payload) => {
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
  useEffect(() => {
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
  useEffect(() => {
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
  return /* @__PURE__ */ jsx("div", { className: "pointer-events-none fixed inset-0 overflow-hidden z-[9999]", children: activeIds.map((id) => {
    const state = cursorState.current[id];
    if (!state) return null;
    return /* @__PURE__ */ jsxs(
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
          /* @__PURE__ */ jsx(CursorIcon, { color: state.color }),
          /* @__PURE__ */ jsx(
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
  return /* @__PURE__ */ jsxs("div", { className: "flex -space-x-2 overflow-hidden items-center", children: [
    users.map((user) => /* @__PURE__ */ jsxs(
      "div",
      {
        className: "inline-block h-8 w-8 rounded-full ring-2 ring-white dark:ring-gray-800 bg-gray-200 flex items-center justify-center text-xs font-medium text-gray-600 relative",
        title: `${user.userId} (${user.status})`,
        children: [
          user.userId.slice(0, 2).toUpperCase(),
          user.status === "online" && /* @__PURE__ */ jsx("span", { className: "absolute bottom-0 right-0 block h-2 w-2 rounded-full ring-2 ring-white bg-green-400" })
        ]
      },
      user.userId
    )),
    /* @__PURE__ */ jsxs("div", { className: "ml-4 text-xs text-gray-500", children: [
      users.length,
      " active"
    ] })
  ] });
}

export { AvatarStack, LiveCursors, NMeshedProvider, useBroadcast, useDocument, useNmeshed, useNmeshedContext, usePresence };
//# sourceMappingURL=index.mjs.map
//# sourceMappingURL=index.mjs.map