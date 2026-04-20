const DEBUGGER_PROTOCOL_VERSION = '1.3';

function cdpInspectorError(message) {
  const err = new Error(message);
  err.name = 'CdpInspectorError';
  return err;
}

/**
 * Shared, refcounted owner of chrome.debugger sessions.
 */
export class CdpInspector {
  /**
   * @param {{ debuggerApi?: object, protocolVersion?: string }} [options]
   */
  constructor(options = {}) {
    this._api = options.debuggerApi || (typeof chrome !== 'undefined' ? chrome.debugger : null);
    this._protocolVersion = options.protocolVersion || DEBUGGER_PROTOCOL_VERSION;
    this._entries = new Map();
    this._generation = 0;
    this._disposed = false;

    this._onEventHandler = null;
    if (this._api && this._api.onEvent && typeof this._api.onEvent.addListener === 'function') {
      this._onEventHandler = (source, method, params) => {
        if (!source || typeof source.tabId !== 'number') return;
        const entry = this._entries.get(source.tabId);
        if (!entry) return;
        const handlers = entry.listeners.get(method);
        if (!handlers || handlers.size === 0) return;
        for (const handler of [...handlers]) {
          handler(params, source);
        }
      };
      this._api.onEvent.addListener(this._onEventHandler);
    }

    this._onDetachHandler = null;
    if (this._api && this._api.onDetach && typeof this._api.onDetach.addListener === 'function') {
      this._onDetachHandler = (source, _reason) => {
        if (!source || typeof source.tabId !== 'number') return;
        const entry = this._entries.get(source.tabId);
        if (!entry) return;
        entry.attached = false;
        entry.attachPromise = null;
      };
      this._api.onDetach.addListener(this._onDetachHandler);
    }
  }

  _assertUsable() {
    if (this._disposed) {
      throw cdpInspectorError('CdpInspector has been disposed');
    }
  }

  _getEntry(tabId) {
    let entry = this._entries.get(tabId);
    if (!entry) {
      entry = {
        refCount: 0,
        attached: false,
        attachPromise: null,
        detachPromise: null,
        listeners: new Map(),
      };
      this._entries.set(tabId, entry);
    }
    return entry;
  }

  _deleteEntryIfUnused(tabId, entry) {
    if (!entry) return;
    if (entry.refCount !== 0) return;
    if (entry.attached) return;
    if (entry.attachPromise) return;
    if (entry.detachPromise) return;
    if (entry.listeners.size !== 0) return;
    this._entries.delete(tabId);
  }

  async _ensureAttached(tabId, entry = this._getEntry(tabId), options = {}) {
    this._assertUsable();
    if (!this._api) {
      throw cdpInspectorError('chrome.debugger API is unavailable');
    }
    if (typeof tabId !== 'number') {
      throw cdpInspectorError('tabId must be a number');
    }
    if (entry.detachPromise) {
      await entry.detachPromise;
      this._assertUsable();
    }
    if (entry.attached) return;
    if (!entry.attachPromise) {
      const generation = this._generation;
      entry.attachPromise = (async () => {
        try {
          await this._api.attach({ tabId }, this._protocolVersion);
          if (this._disposed || generation !== this._generation || (options.requireLease && entry.refCount === 0)) {
            try {
              await this._api.detach({ tabId });
            } catch {
              // ignore cleanup failures during teardown
            }
            if (this._disposed || generation !== this._generation) {
              throw cdpInspectorError('CdpInspector has been disposed');
            }
            throw cdpInspectorError(`Debugger attach to tab ${tabId} was released before it completed`);
          }
          entry.attached = true;
        } catch (err) {
          if (err && err.name === 'CdpInspectorError') {
            throw err;
          }
          throw cdpInspectorError(
            `Failed to attach debugger to tab ${tabId}: ${err && err.message ? err.message : err}`
          );
        } finally {
          entry.attachPromise = null;
        }
      })();
    }
    await entry.attachPromise;
  }

  async ensureAttached(tabId, options = {}) {
    this._assertUsable();
    const entry = this._getEntry(tabId);
    await this._ensureAttached(tabId, entry, options);
  }

  isAttached(tabId) {
    const entry = this._entries.get(tabId);
    return !!(entry && entry.attached && !entry.detachPromise);
  }

  async acquire(tabId) {
    this._assertUsable();
    const entry = this._getEntry(tabId);
    entry.refCount += 1;
    try {
      await this._ensureAttached(tabId, entry, { requireLease: true });
    } catch (err) {
      entry.refCount -= 1;
      this._deleteEntryIfUnused(tabId, entry);
      throw err;
    }
    return { inspector: this, tabId, generation: this._generation, released: false };
  }

  async release(lease) {
    if (!lease || lease.inspector !== this || lease.released || lease.generation !== this._generation) return;
    lease.released = true;
    const { tabId } = lease;
    const entry = this._entries.get(tabId);
    if (!entry) return;
    if (entry.refCount > 0) entry.refCount -= 1;
    if (entry.refCount > 0) return;
    if (!entry.attached) {
      this._deleteEntryIfUnused(tabId, entry);
      return;
    }
    entry.attached = false;
    const detachPromise = (async () => {
      try {
        await this._api.detach({ tabId });
      } catch {
        // ignore — tab may already be gone
      } finally {
        if (entry.detachPromise === detachPromise) {
          entry.detachPromise = null;
        }
        this._deleteEntryIfUnused(tabId, entry);
      }
    })();
    entry.detachPromise = detachPromise;
    await detachPromise;
  }

  async sendCommand(tabId, method, params = {}, options = {}) {
    this._assertUsable();
    const entry = this._getEntry(tabId);
    try {
      await this._ensureAttached(tabId, entry, options);
      if (typeof options.beforeSend === 'function') {
        await options.beforeSend();
      }
      if (this._disposed) {
        throw cdpInspectorError('CdpInspector has been disposed');
      }
      return await this._api.sendCommand({ tabId }, method, params);
    } catch (err) {
      if (err && (err.name === 'CdpInspectorError' || err.name === 'InputControlError')) {
        throw err;
      }
      throw cdpInspectorError(
        `CDP command ${method} failed: ${err && err.message ? err.message : err}`
      );
    }
  }

  async send(tabId, method, params = {}) {
    this._assertUsable();
    const lease = await this.acquire(tabId);
    try {
      if (this._disposed || lease.generation !== this._generation) {
        throw cdpInspectorError('CdpInspector has been disposed');
      }
      return await this.sendCommand(tabId, method, params);
    } finally {
      await this.release(lease);
    }
  }

  on(tabId, event, handler) {
    this._assertUsable();
    const entry = this._getEntry(tabId);
    let handlers = entry.listeners.get(event);
    if (!handlers) {
      handlers = new Set();
      entry.listeners.set(event, handlers);
    }
    handlers.add(handler);
    return () => {
      const current = this._entries.get(tabId);
      if (!current) return;
      const currentHandlers = current.listeners.get(event);
      if (!currentHandlers) return;
      currentHandlers.delete(handler);
      if (currentHandlers.size === 0) {
        current.listeners.delete(event);
      }
      this._deleteEntryIfUnused(tabId, current);
    };
  }

  async dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._generation += 1;
    if (this._api && this._onEventHandler && this._api.onEvent && typeof this._api.onEvent.removeListener === 'function') {
      this._api.onEvent.removeListener(this._onEventHandler);
    }
    if (this._api && this._onDetachHandler && this._api.onDetach && typeof this._api.onDetach.removeListener === 'function') {
      this._api.onDetach.removeListener(this._onDetachHandler);
    }
    this._onEventHandler = null;
    this._onDetachHandler = null;

    const pending = [...this._entries.entries()].map(([tabId, entry]) => (async () => {
      try {
        if (entry.attachPromise) {
          try { await entry.attachPromise; } catch { return; }
        }
        if (entry.detachPromise) {
          try { await entry.detachPromise; } catch { return; }
          return;
        }
        if (entry.attached && this._api) {
          await this._api.detach({ tabId });
        }
      } catch {
        // ignore cleanup failures during teardown
      }
    })());

    this._entries.clear();
    if (pending.length > 0) {
      await Promise.allSettled(pending);
    }
  }
}

export { DEBUGGER_PROTOCOL_VERSION };
