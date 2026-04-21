import { storageAreaGet, storageAreaRemove, storageAreaSet } from './storage.js';

const DEFAULT_MAX_ENTRIES = 2000;
const DEFAULT_PERSIST_KEY_PREFIX = 'piBridge.consoleBuf.';
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

function normalizeTimestamp(value) {
  return Number.isFinite(value) ? Number(value) : Date.now();
}

function toText(args) {
  return safeArray(args)
    .map((arg) => {
      if (typeof arg === 'string') return arg;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(' ')
    .trim();
}

function normalizeLevel(level, source) {
  const raw = typeof level === 'string' ? level.toLowerCase() : '';
  if (['log', 'info', 'warn', 'error', 'debug'].includes(raw)) {
    return raw;
  }
  if (source === 'javascript') return 'log';
  return raw || 'log';
}

function normalizeStackTrace(stackTrace) {
  const callFrames = safeArray(stackTrace?.callFrames).map((frame) => ({
    functionName: typeof frame?.functionName === 'string' ? frame.functionName : '',
    url: typeof frame?.url === 'string' ? frame.url : '',
    lineNumber: Number.isFinite(frame?.lineNumber) ? frame.lineNumber : 0,
    columnNumber: Number.isFinite(frame?.columnNumber) ? frame.columnNumber : 0,
  }));
  return callFrames.length > 0 ? { callFrames } : undefined;
}

function normalizeConsoleEntry(tabId, payload) {
  const timestamp = normalizeTimestamp(payload?.timestamp);
  const level = normalizeLevel(payload?.level ?? payload?.type, payload?.source);
  return {
    id: payload?.id || `${tabId}:${timestamp}:${Math.random().toString(16).slice(2, 8)}`,
    tabId,
    timestamp,
    level,
    source: typeof payload?.source === 'string' ? payload.source : 'console',
    text: typeof payload?.text === 'string' && payload.text ? payload.text : toText(payload?.args),
    url: typeof payload?.url === 'string' ? payload.url : undefined,
    lineNumber: Number.isFinite(payload?.lineNumber) ? payload.lineNumber : undefined,
    columnNumber: Number.isFinite(payload?.columnNumber) ? payload.columnNumber : undefined,
    type: typeof payload?.type === 'string' ? payload.type : undefined,
    args: safeArray(payload?.args),
    stackTrace: normalizeStackTrace(payload?.stackTrace),
    exception: payload?.exception ? payload.exception : undefined,
  };
}

function createTabState(tabId, persistedEntries = []) {
  return {
    tabId,
    entries: persistedEntries.slice(-DEFAULT_MAX_ENTRIES),
    bytes: safeJsonSize(persistedEntries.slice(-DEFAULT_MAX_ENTRIES)),
    armed: false,
    hydrated: false,
    armingPromise: null,
    subscriptions: [],
    persistedAt: 0,
    disconnectedAt: undefined,
    disconnectReason: undefined,
    lease: null,
    armGeneration: 0,
  };
}

function trimByCaps(state, maxEntries, persistMaxBytes) {
  if (!state || !Array.isArray(state.entries)) return;
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

function compileRegex(pattern) {
  if (!pattern) return null;
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return null;
  }
}

export class ConsoleBufferManager {
  constructor({
    inspector,
    storageArea = null,
    logger = console,
    maxEntries = DEFAULT_MAX_ENTRIES,
    persistKeyPrefix = DEFAULT_PERSIST_KEY_PREFIX,
    persistMaxBytes = DEFAULT_PERSIST_MAX_BYTES,
  } = {}) {
    this._inspector = inspector;
    this._storageArea = storageArea;
    this._logger = logger;
    this._maxEntries = maxEntries;
    this._persistKeyPrefix = persistKeyPrefix;
    this._persistMaxBytes = persistMaxBytes;
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
      const stored = await storageAreaGet(this._storageArea, [this._storageKey(tabId)]);
      const payload = stored?.[this._storageKey(tabId)] || {};
      state.entries = safeArray(payload.entries).slice(-this._maxEntries);
      state.bytes = safeJsonSize(state.entries);
      state.persistedAt = Number.isFinite(payload.persistedAt) ? payload.persistedAt : 0;
      state.disconnectedAt = Number.isFinite(payload.disconnectedAt) ? payload.disconnectedAt : undefined;
      state.disconnectReason = typeof payload.disconnectReason === 'string' ? payload.disconnectReason : undefined;
      trimByCaps(state, this._maxEntries, this._persistMaxBytes);
    } catch (error) {
      this._logger.warn?.('[pi-bridge] failed to hydrate console buffer', { tabId, error });
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
      trimByCaps(state, this._maxEntries, this._persistMaxBytes);
      const payload = {
        entries: state.entries,
        persistedAt: Date.now(),
        disconnectedAt: state.disconnectedAt,
        disconnectReason: state.disconnectReason,
      };
      await storageAreaSet(this._storageArea, { [this._storageKey(tabId)]: payload });
      state.persistedAt = payload.persistedAt;
      return true;
    } catch (error) {
      this._logger.warn?.('[pi-bridge] failed to persist console buffer', { tabId, error });
      return false;
    }
  }

  async clearPersistedTab(tabId) {
    if (!this._storageArea) return false;
    try {
      await storageAreaRemove(this._storageArea, [this._storageKey(tabId)]);
      return true;
    } catch (error) {
      this._logger.warn?.('[pi-bridge] failed to remove persisted console buffer', { tabId, error });
      return false;
    }
  }

  append(tabId, payload) {
    const state = this._getState(tabId);
    state.entries.push(normalizeConsoleEntry(tabId, payload));
    state.disconnectedAt = undefined;
    state.disconnectReason = undefined;
    trimByCaps(state, this._maxEntries, this._persistMaxBytes);
    return state.entries[state.entries.length - 1];
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
    state.armGeneration = (state.armGeneration || 0) + 1;
    const lease = state.lease;
    state.lease = null;
    if (releaseLease && lease) {
      void Promise.resolve(this._inspector?.release?.(lease)).catch(() => {});
    }
  }

  async armTab(tabId) {
    const state = this._getState(tabId);
    // Capture the arm generation BEFORE any await so that a concurrent
    // disconnectTab / releaseTab (which runs synchronously up to its first
    // real await and bumps armGeneration) is visible to this arming attempt.
    const myGeneration = state.armGeneration;
    const isStale = () => state.armGeneration !== myGeneration;

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
        if (isStale()) return state;
        state.armed = true;
        return state;
      }

      const subscriptions = [];
      let lease = null;
      const teardownSubscriptions = () => {
        for (const off of subscriptions) {
          try { off?.(); } catch { /* noop */ }
        }
        subscriptions.length = 0;
      };
      const releaseAcquiredLease = async () => {
        if (lease) {
          try { await this._inspector.release?.(lease); } catch { /* noop */ }
          lease = null;
        }
      };
      try {
        if (typeof this._inspector.acquire === 'function') {
          lease = await this._inspector.acquire(tabId);
        } else {
          await this._inspector.ensureAttached?.(tabId, { requireLease: false });
        }

        if (isStale()) {
          await releaseAcquiredLease();
          return state;
        }

        subscriptions.push(this._inspector?.on?.(tabId, 'Runtime.consoleAPICalled', (params) => {
          try {
            this.append(tabId, {
              timestamp: Number.isFinite(params?.timestamp) ? params.timestamp : Date.now(),
              type: params?.type,
              args: safeArray(params?.args).map((arg) => arg?.value ?? arg?.description ?? arg),
              stackTrace: params?.stackTrace,
            });
          } catch (error) {
            this._logger.warn?.('[pi-bridge] failed to record Runtime.consoleAPICalled', { tabId, error });
          }
        }));

        subscriptions.push(this._inspector?.on?.(tabId, 'Log.entryAdded', (params) => {
          try {
            const entry = params?.entry || {};
            this.append(tabId, {
              timestamp: entry.timestamp,
              level: entry.level,
              source: entry.source,
              text: entry.text,
              url: entry.url,
              lineNumber: entry.lineNumber,
              stackTrace: entry.stackTrace,
            });
          } catch (error) {
            this._logger.warn?.('[pi-bridge] failed to record Log.entryAdded', { tabId, error });
          }
        }));

        subscriptions.push(this._inspector?.on?.(tabId, 'Runtime.exceptionThrown', (params) => {
          try {
            const details = params?.exceptionDetails || {};
            this.append(tabId, {
              timestamp: details.timestamp,
              level: 'error',
              source: 'exception',
              text: details.text || details.exception?.description || 'Unhandled exception',
              url: details.url,
              lineNumber: details.lineNumber,
              columnNumber: details.columnNumber,
              stackTrace: details.stackTrace,
              exception: details.exception,
            });
          } catch (error) {
            this._logger.warn?.('[pi-bridge] failed to record Runtime.exceptionThrown', { tabId, error });
          }
        }));

        if (isStale()) {
          teardownSubscriptions();
          await releaseAcquiredLease();
          return state;
        }

        await this._inspector.sendCommand?.(tabId, 'Runtime.enable', {}, { requireLease: !!lease });
        if (isStale()) {
          teardownSubscriptions();
          await releaseAcquiredLease();
          return state;
        }
        await this._inspector.sendCommand?.(tabId, 'Log.enable', {}, { requireLease: !!lease });
        if (isStale()) {
          teardownSubscriptions();
          await releaseAcquiredLease();
          return state;
        }

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
        this._logger.warn?.('[pi-bridge] failed to arm console buffer', { tabId, error });
        throw { code: 'E_CDP_ATTACH', message: `Failed to arm console observability for tab ${tabId}`, details: error };
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

  async removeTab(tabId, { persist = true } = {}) {
    const state = this._states.get(tabId);
    if (!state) return;
    this._clearSubscriptions(state);
    state.armed = false;
    state.armGeneration = (state.armGeneration || 0) + 1;
    const lease = state.lease;
    state.lease = null;
    if (persist) {
      await this.persistTab(tabId).catch(() => {});
    }
    if (lease) {
      try { await this._inspector?.release?.(lease); } catch { /* noop */ }
    }
    await this.clearPersistedTab(tabId).catch(() => {});
    this._states.delete(tabId);
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
    state.armGeneration = (state.armGeneration || 0) + 1;
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

  getEntries(tabId, filters = {}) {
    const state = this._getState(tabId);
    const levels = Array.isArray(filters.levels) && filters.levels.length > 0
      ? new Set(filters.levels.map((value) => String(value).toLowerCase()))
      : null;
    const substring = typeof filters.substring === 'string' && filters.substring ? filters.substring.toLowerCase() : null;
    const regex = compileRegex(filters.regex);
    const since = Number.isFinite(filters.since) ? Number(filters.since) : null;
    const last = Number.isFinite(filters.last) && filters.last > 0 ? Number(filters.last) : null;
    const includeExceptions = filters.include_exceptions !== false;
    const includeStack = filters.include_stack !== false;

    let entries = state.entries.filter((entry) => {
      if (levels && !levels.has(String(entry.level).toLowerCase())) return false;
      if (!includeExceptions && entry.source === 'exception') return false;
      if (since !== null && entry.timestamp < since) return false;
      if (substring && !String(entry.text || '').toLowerCase().includes(substring)) return false;
      if (regex && !regex.test(String(entry.text || ''))) return false;
      return true;
    });

    if (last !== null && entries.length > last) {
      entries = entries.slice(-last);
    }

    const projected = entries.map((entry) => includeStack ? entry : { ...entry, stackTrace: undefined });

    return {
      tabId,
      total: state.entries.length,
      returned: projected.length,
      disconnectedAt: state.disconnectedAt,
      disconnectReason: state.disconnectReason,
      entries: projected,
    };
  }
}

export {
  DEFAULT_MAX_ENTRIES as DEFAULT_CONSOLE_BUFFER_MAX_ENTRIES,
  DEFAULT_PERSIST_KEY_PREFIX as DEFAULT_CONSOLE_BUFFER_PERSIST_KEY_PREFIX,
  DEFAULT_PERSIST_MAX_BYTES as DEFAULT_CONSOLE_BUFFER_PERSIST_MAX_BYTES,
};
