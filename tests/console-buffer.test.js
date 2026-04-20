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
