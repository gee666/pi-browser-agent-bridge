const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_BODY_MAX_BYTES = 64 * 1024;
const DEFAULT_BODY_TIMEOUT_MS = 2_000;
const DEFAULT_PERSIST_KEY_PREFIX = 'piBridge.networkBuf.';
const DEFAULT_PERSIST_MAX_BYTES = 512 * 1024;

function safeJsonSize(value) {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return 0;
  }
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function toNumber(value) {
  return Number.isFinite(value) ? Number(value) : undefined;
}

function compileRegex(pattern) {
  if (!pattern) return null;
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return null;
  }
}

function clipText(text, maxBytes) {
  if (typeof text !== 'string') return { text: undefined, truncated: false };
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) {
    return { text, truncated: false };
  }
  let clipped = text;
  while (clipped && new TextEncoder().encode(clipped).length > maxBytes) {
    clipped = clipped.slice(0, Math.max(1, Math.floor(clipped.length * 0.8)));
  }
  return { text: clipped, truncated: true };
}

function createTabState(tabId) {
  return {
    tabId,
    entries: [],
    inFlight: new Map(),
    bytes: 0,
    armed: false,
    hydrated: false,
    armingPromise: null,
    subscriptions: [],
    persistedAt: 0,
    disconnectedAt: undefined,
    disconnectReason: undefined,
    lease: null,
  };
}

function trimState(state, maxEntries, persistMaxBytes) {
  if (state.entries.length > maxEntries) {
    state.entries.splice(0, state.entries.length - maxEntries);
  }
  state.bytes = safeJsonSize(state.entries);
  while (state.entries.length > 1 && state.bytes > persistMaxBytes) {
    const deleteCount = Math.max(1, Math.ceil(state.entries.length / 2));
    state.entries.splice(0, deleteCount);
    state.bytes = safeJsonSize(state.entries);
  }
}

function defaultMethod(value) {
  return typeof value === 'string' && value ? value.toUpperCase() : 'GET';
}

function normalizeRequest(tabId, params) {
  const request = params?.request || {};
  return {
    requestId: params?.requestId,
    tabId,
    url: typeof request.url === 'string' ? request.url : '',
    method: defaultMethod(request.method),
    type: typeof params?.type === 'string' ? params.type : 'other',
    documentURL: typeof params?.documentURL === 'string' ? params.documentURL : undefined,
    initiator: params?.initiator,
    requestHeaders: request.headers && typeof request.headers === 'object' ? request.headers : undefined,
    requestBody: typeof request.postData === 'string' ? request.postData : undefined,
    startTime: Number.isFinite(params?.timestamp) ? params.timestamp * 1000 : Date.now(),
    status: undefined,
    statusText: undefined,
    mimeType: undefined,
    responseHeaders: undefined,
    durationMs: undefined,
    failed: false,
    errorText: undefined,
    timing: undefined,
  };
}

async function withTimeout(factory, timeoutMs) {
  return await Promise.race([
    Promise.resolve().then(factory),
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(Object.assign(new Error('Timed out'), { code: 'E_TIMEOUT' })), timeoutMs);
      timer.unref?.();
    }),
  ]);
}

export class NetworkBufferManager {
  constructor({
    inspector,
    storageArea = null,
    logger = console,
    maxEntries = DEFAULT_MAX_ENTRIES,
    persistKeyPrefix = DEFAULT_PERSIST_KEY_PREFIX,
    persistMaxBytes = DEFAULT_PERSIST_MAX_BYTES,
    bodyTimeoutMs = DEFAULT_BODY_TIMEOUT_MS,
  } = {}) {
    this._inspector = inspector;
    this._storageArea = storageArea;
    this._logger = logger;
    this._maxEntries = maxEntries;
    this._persistKeyPrefix = persistKeyPrefix;
    this._persistMaxBytes = persistMaxBytes;
    this._bodyTimeoutMs = bodyTimeoutMs;
    this._states = new Map();
  }

  _storageKey(tabId) {
    return `${this._persistKeyPrefix}${tabId}`;
  }

  _getState(tabId) {
    let state = this._states.get(tabId);
    if (!state) {
      state = createTabState(tabId);
      this._states.set(tabId, state);
    }
    return state;
  }

  async hydrateTab(tabId) {
    const state = this._getState(tabId);
    if (state.hydrated) {
      return state;
    }
    if (!this._storageArea || typeof this._storageArea.get !== 'function') {
      state.hydrated = true;
      return state;
    }
    try {
      const stored = await new Promise((resolve) => {
        this._storageArea.get([this._storageKey(tabId)], (result) => resolve(result || {}));
      });
      const payload = stored?.[this._storageKey(tabId)] || {};
      state.entries = safeArray(payload.entries).slice(-this._maxEntries);
      state.persistedAt = Number.isFinite(payload.persistedAt) ? payload.persistedAt : 0;
      state.disconnectedAt = Number.isFinite(payload.disconnectedAt) ? payload.disconnectedAt : undefined;
      state.disconnectReason = typeof payload.disconnectReason === 'string' ? payload.disconnectReason : undefined;
      trimState(state, this._maxEntries, this._persistMaxBytes);
    } catch (error) {
      this._logger.warn?.('[pi-bridge] failed to hydrate network buffer', { tabId, error });
    }
    state.hydrated = true;
    return state;
  }

  async persistTab(tabId) {
    const state = this._states.get(tabId);
    if (!state || !this._storageArea || typeof this._storageArea.set !== 'function') {
      return false;
    }
    try {
      trimState(state, this._maxEntries, this._persistMaxBytes);
      const payload = {
        entries: state.entries.map((entry) => ({ ...entry, requestBody: undefined, responseBody: undefined })),
        persistedAt: Date.now(),
        disconnectedAt: state.disconnectedAt,
        disconnectReason: state.disconnectReason,
      };
      await new Promise((resolve) => {
        this._storageArea.set({ [this._storageKey(tabId)]: payload }, () => resolve());
      });
      state.persistedAt = payload.persistedAt;
      return true;
    } catch (error) {
      this._logger.warn?.('[pi-bridge] failed to persist network buffer', { tabId, error });
      return false;
    }
  }

  startRequest(tabId, params) {
    const state = this._getState(tabId);
    const requestId = params?.requestId;
    if (!requestId) return null;
    const entry = normalizeRequest(tabId, params);
    state.inFlight.set(requestId, entry);
    state.disconnectedAt = undefined;
    state.disconnectReason = undefined;
    return entry;
  }

  updateResponse(tabId, params) {
    const state = this._getState(tabId);
    const requestId = params?.requestId;
    const response = params?.response || {};
    const entry = state.inFlight.get(requestId);
    if (!entry) return null;
    entry.status = toNumber(response.status);
    entry.statusText = typeof response.statusText === 'string' ? response.statusText : undefined;
    entry.mimeType = typeof response.mimeType === 'string' ? response.mimeType : undefined;
    entry.responseHeaders = response.headers && typeof response.headers === 'object' ? response.headers : undefined;
    entry.remoteIPAddress = typeof response.remoteIPAddress === 'string' ? response.remoteIPAddress : undefined;
    entry.protocol = typeof response.protocol === 'string' ? response.protocol : undefined;
    entry.timing = response.timing && typeof response.timing === 'object' ? response.timing : undefined;
    return entry;
  }

  finishRequest(tabId, params) {
    const state = this._getState(tabId);
    const requestId = params?.requestId;
    const entry = state.inFlight.get(requestId);
    if (!entry) return null;
    state.inFlight.delete(requestId);
    const endTime = Number.isFinite(params?.timestamp) ? params.timestamp * 1000 : Date.now();
    entry.durationMs = Math.max(0, endTime - entry.startTime);
    state.entries.push(entry);
    trimState(state, this._maxEntries, this._persistMaxBytes);
    return entry;
  }

  failRequest(tabId, params) {
    const state = this._getState(tabId);
    const requestId = params?.requestId;
    const entry = state.inFlight.get(requestId);
    if (!entry) return null;
    entry.failed = true;
    entry.errorText = typeof params?.errorText === 'string' ? params.errorText : 'Network request failed';
    entry.status = entry.status ?? 0;
    return this.finishRequest(tabId, params) || entry;
  }

  _clearSubscriptions(state) {
    for (const off of state.subscriptions) {
      try {
        off?.();
      } catch {
        // noop
      }
    }
    state.subscriptions = [];
  }

  _resetArmState(state, { releaseLease = false } = {}) {
    this._clearSubscriptions(state);
    state.armed = false;
    const lease = state.lease;
    state.lease = null;
    if (releaseLease && lease) {
      void Promise.resolve(this._inspector?.release?.(lease)).catch(() => {});
    }
  }

  async armTab(tabId) {
    const state = this._getState(tabId);
    await this.hydrateTab(tabId);

    if (state.armingPromise) {
      return await state.armingPromise;
    }

    if (state.armed) {
      if (typeof this._inspector?.isAttached !== 'function' || this._inspector.isAttached(tabId)) {
        return state;
      }
      this._resetArmState(state, { releaseLease: true });
    }

    state.armingPromise = (async () => {
      if (!this._inspector) {
        state.armed = true;
        return state;
      }

      const subscriptions = [];
      let lease = null;
      try {
        if (typeof this._inspector.acquire === 'function') {
          lease = await this._inspector.acquire(tabId);
        } else {
          await this._inspector.ensureAttached?.(tabId, { requireLease: false });
        }

        subscriptions.push(this._inspector?.on?.(tabId, 'Network.requestWillBeSent', (params) => {
          try {
            this.startRequest(tabId, params);
          } catch (error) {
            this._logger.warn?.('[pi-bridge] failed to record Network.requestWillBeSent', { tabId, error });
          }
        }));
        subscriptions.push(this._inspector?.on?.(tabId, 'Network.responseReceived', (params) => {
          try {
            this.updateResponse(tabId, params);
          } catch (error) {
            this._logger.warn?.('[pi-bridge] failed to record Network.responseReceived', { tabId, error });
          }
        }));
        subscriptions.push(this._inspector?.on?.(tabId, 'Network.loadingFinished', (params) => {
          try {
            this.finishRequest(tabId, params);
          } catch (error) {
            this._logger.warn?.('[pi-bridge] failed to record Network.loadingFinished', { tabId, error });
          }
        }));
        subscriptions.push(this._inspector?.on?.(tabId, 'Network.loadingFailed', (params) => {
          try {
            this.failRequest(tabId, params);
          } catch (error) {
            this._logger.warn?.('[pi-bridge] failed to record Network.loadingFailed', { tabId, error });
          }
        }));

        await this._inspector.sendCommand?.(tabId, 'Network.enable', {}, { requireLease: !!lease });

        state.subscriptions = subscriptions.filter(Boolean);
        state.lease = lease;
        state.armed = true;
        return state;
      } catch (error) {
        for (const off of subscriptions) {
          try {
            off?.();
          } catch {
            // noop
          }
        }
        state.subscriptions = [];
        state.armed = false;
        if (lease) {
          try {
            await this._inspector.release?.(lease);
          } catch {
            // noop
          }
        }
        state.lease = null;
        this._logger.warn?.('[pi-bridge] failed to arm network buffer', { tabId, error });
        throw { code: 'E_CDP_ATTACH', message: `Failed to arm network observability for tab ${tabId}`, details: error };
      } finally {
        state.armingPromise = null;
      }
    })();

    return await state.armingPromise;
  }

  disconnectTab(tabId, reason = 'disconnected') {
    const state = this._getState(tabId);
    state.disconnectedAt = Date.now();
    state.disconnectReason = reason;
    this._resetArmState(state, { releaseLease: true });
    return state;
  }

  async fetchResponseBody(tabId, requestId, { bodyMaxBytes = DEFAULT_BODY_MAX_BYTES } = {}) {
    if (!this._inspector?.sendCommand) {
      return { responseBody: undefined };
    }
    try {
      const response = await withTimeout(
        () => this._inspector.sendCommand(tabId, 'Network.getResponseBody', { requestId }),
        this._bodyTimeoutMs,
      );
      const rawBody = typeof response?.body === 'string' ? response.body : '';
      const { text, truncated } = clipText(rawBody, bodyMaxBytes);
      return {
        responseBody: text,
        responseBodyBase64Encoded: !!response?.base64Encoded,
        responseBodyTruncated: truncated,
      };
    } catch (error) {
      return {
        responseBody: undefined,
        responseBodyError: error?.code === 'E_TIMEOUT' ? 'Timed out fetching response body' : (error?.message || String(error)),
      };
    }
  }

  async getEntries(tabId, options = {}) {
    const state = this._getState(tabId);
    const filter = options.filter && typeof options.filter === 'object' ? options.filter : {};
    const methods = asArray(filter.method).map((value) => String(value).toUpperCase());
    const statuses = asArray(filter.status).map((value) => Number(value)).filter(Number.isFinite);
    const types = asArray(filter.type).map((value) => String(value).toLowerCase());
    const urlRegex = compileRegex(filter.url_matches);
    const since = Number.isFinite(filter.since) ? Number(filter.since) : undefined;
    const until = Number.isFinite(filter.until) ? Number(filter.until) : undefined;
    const last = Number.isFinite(filter.last) && filter.last > 0 ? Number(filter.last) : undefined;

    let entries = state.entries.filter((entry) => {
      if (methods.length > 0 && !methods.includes(String(entry.method).toUpperCase())) return false;
      if (statuses.length > 0 && !statuses.includes(Number(entry.status))) return false;
      if (Number.isFinite(filter.status_gte) && !(Number(entry.status ?? 0) >= Number(filter.status_gte))) return false;
      if (Number.isFinite(filter.status_lt) && !(Number(entry.status ?? 0) < Number(filter.status_lt))) return false;
      if (types.length > 0 && !types.includes(String(entry.type).toLowerCase())) return false;
      if (typeof filter.url_contains === 'string' && filter.url_contains && !String(entry.url).includes(filter.url_contains)) return false;
      if (urlRegex && !urlRegex.test(String(entry.url))) return false;
      if (typeof filter.mime_contains === 'string' && filter.mime_contains && !String(entry.mimeType || '').includes(filter.mime_contains)) return false;
      if (filter.failed_only && !((entry.status ?? 0) === 0 || (entry.status ?? 0) >= 400 || entry.failed)) return false;
      if (since !== undefined && entry.startTime < since) return false;
      if (until !== undefined && entry.startTime > until) return false;
      if (Number.isFinite(filter.duration_gte_ms) && !((entry.durationMs ?? 0) >= Number(filter.duration_gte_ms))) return false;
      if (typeof filter.initiator_contains === 'string' && filter.initiator_contains) {
        const serialised = JSON.stringify(entry.initiator || {});
        if (!serialised.includes(filter.initiator_contains)) return false;
      }
      return true;
    });

    if (last && entries.length > last) {
      entries = entries.slice(-last);
    }

    const includeRequestHeaders = options.include_request_headers === true;
    const includeResponseHeaders = options.include_response_headers === true;
    const includeRequestBody = options.include_request_body === true;
    const includeResponseBody = options.include_response_body === true;
    const includeTiming = options.include_timing !== false;
    const bodyMaxBytes = Number.isFinite(options.body_max_bytes) && options.body_max_bytes > 0
      ? Number(options.body_max_bytes)
      : DEFAULT_BODY_MAX_BYTES;

    const projected = [];
    for (const entry of entries) {
      const next = {
        requestId: entry.requestId,
        tabId: entry.tabId,
        url: entry.url,
        method: entry.method,
        type: entry.type,
        status: entry.status,
        statusText: entry.statusText,
        mimeType: entry.mimeType,
        failed: entry.failed,
        errorText: entry.errorText,
        startTime: entry.startTime,
        durationMs: entry.durationMs,
        documentURL: entry.documentURL,
        initiator: entry.initiator,
        remoteIPAddress: entry.remoteIPAddress,
        protocol: entry.protocol,
        timing: includeTiming ? entry.timing : undefined,
        requestHeaders: includeRequestHeaders ? entry.requestHeaders : undefined,
        responseHeaders: includeResponseHeaders ? entry.responseHeaders : undefined,
      };

      if (includeRequestBody) {
        const clipped = clipText(entry.requestBody, bodyMaxBytes);
        next.requestBody = clipped.text;
        next.requestBodyTruncated = clipped.truncated;
      }

      if (includeResponseBody) {
        Object.assign(next, await this.fetchResponseBody(tabId, entry.requestId, { bodyMaxBytes }));
      }

      projected.push(next);
    }

    return {
      tabId,
      total: state.entries.length,
      returned: projected.length,
      disconnectedAt: state.disconnectedAt,
      disconnectReason: state.disconnectReason,
      entries: projected,
    };
  }

  async flushAll() {
    const results = [];
    for (const tabId of this._states.keys()) {
      results.push(await this.persistTab(tabId));
    }
    return results;
  }

  async releaseTab(tabId) {
    const state = this._states.get(tabId);
    if (!state) return;
    this._clearSubscriptions(state);
    state.armed = false;
    const lease = state.lease;
    state.lease = null;
    await this.persistTab(tabId);
    if (lease) {
      try {
        await this._inspector?.release?.(lease);
      } catch {
        // noop
      }
    }
  }

  async dispose() {
    for (const tabId of [...this._states.keys()]) {
      await this.releaseTab(tabId);
    }
    this._states.clear();
  }
}

export {
  DEFAULT_BODY_MAX_BYTES as DEFAULT_NETWORK_BODY_MAX_BYTES,
  DEFAULT_BODY_TIMEOUT_MS as DEFAULT_NETWORK_BODY_TIMEOUT_MS,
  DEFAULT_MAX_ENTRIES as DEFAULT_NETWORK_BUFFER_MAX_ENTRIES,
  DEFAULT_PERSIST_KEY_PREFIX as DEFAULT_NETWORK_BUFFER_PERSIST_KEY_PREFIX,
  DEFAULT_PERSIST_MAX_BYTES as DEFAULT_NETWORK_BUFFER_PERSIST_MAX_BYTES,
};
