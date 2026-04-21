import test from 'node:test';
import assert from 'node:assert/strict';

import { ConsoleBufferManager } from '../src/buffers/console-buffer.js';

function createStorageArea() {
  const store = {};
  return {
    store,
    get(keys, callback) {
      const result = {};
      for (const key of keys) {
        result[key] = store[key];
      }
      callback(result);
    },
    set(values, callback) {
      Object.assign(store, values);
      callback?.();
    },
  };
}

test('console buffer trims by entry count, filters, and persists disconnect state', async () => {
  const storageArea = createStorageArea();
  const buffer = new ConsoleBufferManager({ storageArea, maxEntries: 3, persistMaxBytes: 50_000, logger: { warn() {} } });

  buffer.append(7, { level: 'log', text: 'alpha', timestamp: 100 });
  buffer.append(7, { level: 'warn', text: 'beta signal', timestamp: 200 });
  buffer.append(7, { level: 'error', text: 'gamma fail', timestamp: 300, source: 'exception' });
  buffer.append(7, { level: 'info', text: 'delta', timestamp: 400 });
  buffer.disconnectTab(7, 'sw_restart');
  await buffer.persistTab(7);

  const restored = new ConsoleBufferManager({ storageArea, maxEntries: 3, persistMaxBytes: 50_000, logger: { warn() {} } });
  await restored.hydrateTab(7);
  const result = restored.getEntries(7, { levels: ['warn', 'error', 'info'], substring: 'a', since: 150, last: 2, include_exceptions: false, include_stack: false });

  assert.equal(result.total, 3);
  assert.equal(result.returned, 2);
  assert.equal(result.disconnectReason, 'sw_restart');
  assert.deepEqual(result.entries.map((entry) => entry.text), ['beta signal', 'delta']);
  assert.equal(result.entries[0].stackTrace, undefined);
});

test('console buffer armTab contains inspector event handling failures', async () => {
  const listeners = new Map();
  const warnings = [];
  const inspector = {
    async ensureAttached() {},
    async sendCommand() {},
    on(_tabId, event, handler) {
      listeners.set(event, handler);
      return () => listeners.delete(event);
    },
  };
  const buffer = new ConsoleBufferManager({ inspector, logger: { warn(...args) { warnings.push(args); } } });

  await buffer.armTab(9);
  listeners.get('Runtime.consoleAPICalled')({ get args() { throw new Error('boom'); } });
  listeners.get('Log.entryAdded')({ entry: { text: 'hello', level: 'info', timestamp: 1 } });

  const result = buffer.getEntries(9, {});
  assert.equal(result.returned, 1);
  assert.equal(result.entries[0].text, 'hello');
  assert.equal(warnings.length, 1);
});

test('console buffer retries arming after a CDP attach failure', async () => {
  let attempts = 0;
  const listeners = new Map();
  const inspector = {
    async ensureAttached() {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('attach failed');
      }
    },
    async sendCommand() {},
    on(_tabId, event, handler) {
      listeners.set(event, handler);
      return () => listeners.delete(event);
    },
  };
  const buffer = new ConsoleBufferManager({ inspector, logger: { warn() {} } });

  await assert.rejects(() => buffer.armTab(12), (error) => error.code === 'E_CDP_ATTACH');
  await buffer.armTab(12);

  assert.equal(attempts, 2);
  assert.equal(buffer.getEntries(12, {}).returned, 0);
});

test('console buffer does not clobber live entries on repeated armTab calls', async () => {
  const storageArea = createStorageArea();
  storageArea.store['piBridge.consoleBuf.3'] = { entries: [], persistedAt: 1 };
  const listeners = new Map();
  const inspector = {
    isAttached() { return true; },
    async ensureAttached() {},
    async sendCommand() {},
    on(_tabId, event, handler) {
      listeners.set(event, handler);
      return () => listeners.delete(event);
    },
  };
  const buffer = new ConsoleBufferManager({ inspector, storageArea, logger: { warn() {} } });

  await buffer.armTab(3);
  listeners.get('Log.entryAdded')({ entry: { text: 'hello', level: 'info', timestamp: 1 } });
  await buffer.armTab(3);

  const result = buffer.getEntries(3, {});
  assert.equal(result.returned, 1);
  assert.equal(result.entries[0].text, 'hello');
});

test('console buffer armTab abandons work if releaseTab wins the race', async () => {
  let resolveAcquire;
  const acquireGate = new Promise((resolve) => { resolveAcquire = resolve; });
  const listeners = new Map();
  let acquireCount = 0;
  let releaseCount = 0;
  const sendCommandCalls = [];
  const inspector = {
    isAttached() { return true; },
    async acquire() {
      acquireCount += 1;
      await acquireGate;
      return { leaseId: acquireCount };
    },
    async release() { releaseCount += 1; },
    async sendCommand(tabId, method) { sendCommandCalls.push(method); },
    on(_tabId, event, handler) {
      listeners.set(event, handler);
      return () => listeners.delete(event);
    },
  };
  const buffer = new ConsoleBufferManager({ inspector, logger: { warn() {} } });

  const arming = buffer.armTab(20);
  // Race: release while acquire is still pending.
  await buffer.releaseTab(20);
  resolveAcquire();
  await arming;

  const state = buffer._states.get(20);
  assert.equal(state.armed, false, 'armed flag must stay false after release-race');
  assert.equal(state.subscriptions.length, 0, 'no subscriptions should be installed after race');
  assert.equal(state.lease, null, 'lease must not be stored on state after race');
  assert.equal(releaseCount, 1, 'the acquired lease should be released once the race is detected');
});

test('console buffer armTab abandons work if disconnectTab wins the race', async () => {
  let resolveAcquire;
  const acquireGate = new Promise((resolve) => { resolveAcquire = resolve; });
  const listeners = new Map();
  let releaseCount = 0;
  const inspector = {
    isAttached() { return true; },
    async acquire() { await acquireGate; return { leaseId: 1 }; },
    async release() { releaseCount += 1; },
    async sendCommand() {},
    on(_tabId, event, handler) {
      listeners.set(event, handler);
      return () => listeners.delete(event);
    },
  };
  const buffer = new ConsoleBufferManager({ inspector, logger: { warn() {} } });

  const arming = buffer.armTab(21);
  buffer.disconnectTab(21, 'debugger_detach');
  resolveAcquire();
  await arming;

  const state = buffer._states.get(21);
  assert.equal(state.armed, false);
  assert.equal(state.subscriptions.length, 0);
  assert.equal(state.lease, null);
  assert.equal(releaseCount, 1);
});

test('console buffer hydrate rejects when storage signals chrome.runtime.lastError', async () => {
  const originalChrome = globalThis.chrome;
  globalThis.chrome = { runtime: { lastError: { message: 'quota exceeded' } } };
  const warnings = [];
  const buffer = new ConsoleBufferManager({
    storageArea: {
      get(_keys, cb) { cb({}); },
      set(_values, cb) { cb?.(); },
    },
    logger: { warn(...args) { warnings.push(args); } },
  });
  try {
    await buffer.hydrateTab(50);
  } finally {
    globalThis.chrome = originalChrome;
  }
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0][0]), /failed to hydrate console buffer/);
});

test('console buffer persist surfaces storage failures via warn and returns false', async () => {
  const originalChrome = globalThis.chrome;
  const warnings = [];
  const buffer = new ConsoleBufferManager({
    storageArea: {
      get(_keys, cb) { cb({}); },
      set(_values, cb) {
        globalThis.chrome = { runtime: { lastError: { message: 'disk full' } } };
        cb?.();
        globalThis.chrome = originalChrome;
      },
    },
    logger: { warn(...args) { warnings.push(args); } },
  });
  buffer.append(60, { level: 'log', text: 'x', timestamp: 1 });
  const ok = await buffer.persistTab(60);
  assert.equal(ok, false);
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0][0]), /failed to persist console buffer/);
});

test('console buffer removeTab drops in-memory state and persisted storage key', async () => {
  const storageArea = createStorageArea();
  const removedKeys = [];
  const wrappedStorage = {
    ...storageArea,
    get: storageArea.get.bind(storageArea),
    set: storageArea.set.bind(storageArea),
    remove(keys, cb) {
      const list = Array.isArray(keys) ? keys : [keys];
      removedKeys.push(...list);
      for (const key of list) delete storageArea.store[key];
      cb?.();
    },
  };
  const buffer = new ConsoleBufferManager({ storageArea: wrappedStorage, logger: { warn() {} } });
  buffer.append(33, { level: 'log', text: 'hi', timestamp: 1 });
  await buffer.persistTab(33);
  assert.ok(storageArea.store['piBridge.consoleBuf.33']);

  await buffer.removeTab(33, { persist: false });

  assert.equal(buffer._states.has(33), false);
  assert.deepEqual(removedKeys, ['piBridge.consoleBuf.33']);
  assert.equal(storageArea.store['piBridge.consoleBuf.33'], undefined);
});

test('console buffer re-arms after debugger disconnect', async () => {
  let attached = false;
  let acquireCount = 0;
  let releaseCount = 0;
  const listeners = new Map();
  const inspector = {
    isAttached() { return attached; },
    async acquire() {
      acquireCount += 1;
      attached = true;
      return { leaseId: acquireCount };
    },
    async release() {
      releaseCount += 1;
      attached = false;
    },
    async sendCommand() {},
    on(_tabId, event, handler) {
      listeners.set(event, handler);
      return () => listeners.delete(event);
    },
  };
  const buffer = new ConsoleBufferManager({ inspector, logger: { warn() {} } });

  await buffer.armTab(4);
  buffer.disconnectTab(4, 'manual_detach');
  await buffer.armTab(4);

  assert.equal(acquireCount, 2);
  assert.equal(releaseCount, 1);
  assert.equal(buffer.getEntries(4, {}).disconnectReason, 'manual_detach');
});
