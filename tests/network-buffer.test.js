import test from 'node:test';
import assert from 'node:assert/strict';

import { NetworkBufferManager } from '../src/buffers/network-buffer.js';

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

test('network buffer trims entries, filters results, and size-caps request/response bodies', async () => {
  const inspector = {
    async sendCommand(_tabId, method, params) {
      assert.equal(method, 'Network.getResponseBody');
      return { body: `${params.requestId}:${'x'.repeat(40)}`, base64Encoded: false };
    },
  };
  const buffer = new NetworkBufferManager({ inspector, maxEntries: 2, logger: { warn() {} } });

  buffer.startRequest(5, { requestId: '1', request: { url: 'https://a.test', method: 'GET' }, type: 'document', timestamp: 1 });
  buffer.updateResponse(5, { requestId: '1', response: { status: 200, mimeType: 'text/html' } });
  buffer.finishRequest(5, { requestId: '1', timestamp: 1.01 });

  buffer.startRequest(5, { requestId: '2', request: { url: 'https://a.test/api', method: 'POST', postData: 'abcdef'.repeat(20) }, type: 'fetch', timestamp: 2, initiator: { type: 'script' } });
  buffer.updateResponse(5, { requestId: '2', response: { status: 500, mimeType: 'application/json', headers: { a: 'b' }, timing: { sendStart: 1 } } });
  buffer.failRequest(5, { requestId: '2', errorText: 'ERR_FAILED', timestamp: 2.4 });

  buffer.startRequest(5, { requestId: '3', request: { url: 'https://b.test/xhr', method: 'GET' }, type: 'xhr', timestamp: 3 });
  buffer.updateResponse(5, { requestId: '3', response: { status: 201, mimeType: 'application/json' } });
  buffer.finishRequest(5, { requestId: '3', timestamp: 3.2 });

  const result = await buffer.getEntries(5, {
    filter: { failed_only: true, status_gte: 400, type: ['fetch'], url_contains: '/api', initiator_contains: 'script', last: 1 },
    include_request_body: true,
    include_response_body: true,
    body_max_bytes: 32,
    include_response_headers: true,
  });

  assert.equal(result.total, 2);
  assert.equal(result.returned, 1);
  assert.equal(result.entries[0].status, 500);
  assert.equal(result.entries[0].requestBodyTruncated, true);
  assert.equal(result.entries[0].responseBodyTruncated, true);
  assert.equal(result.entries[0].responseHeaders.a, 'b');
});

test('network buffer persists metadata-only snapshots and turns response body timeouts into entry-local errors', async () => {
  const storageArea = createStorageArea();
  const buffer = new NetworkBufferManager({
    storageArea,
    bodyTimeoutMs: 5,
    inspector: {
      async sendCommand() {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { body: 'late body', base64Encoded: false };
      },
    },
    logger: { warn() {} },
  });

  buffer.startRequest(11, { requestId: 'slow', request: { url: 'https://slow.test', method: 'POST', postData: 'payload' }, type: 'fetch', timestamp: 1 });
  buffer.updateResponse(11, { requestId: 'slow', response: { status: 202, mimeType: 'application/json' } });
  buffer.finishRequest(11, { requestId: 'slow', timestamp: 2 });
  buffer.disconnectTab(11, 'bridge_drop');
  await buffer.persistTab(11);

  const restored = new NetworkBufferManager({ storageArea, logger: { warn() {} } });
  await restored.hydrateTab(11);
  const hydrated = await restored.getEntries(11, {});
  assert.equal(hydrated.entries[0].requestBody, undefined);
  assert.equal(hydrated.disconnectReason, 'bridge_drop');

  const timeoutResult = await buffer.getEntries(11, { include_response_body: true, body_max_bytes: 64 });
  assert.match(String(timeoutResult.entries[0].responseBodyError), /timed out/i);
});

test('network buffer retries arming after a CDP attach failure', async () => {
  let attempts = 0;
  const inspector = {
    async ensureAttached() {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('attach failed');
      }
    },
    async sendCommand() {},
    on() {
      return () => {};
    },
  };
  const buffer = new NetworkBufferManager({ inspector, logger: { warn() {} } });

  await assert.rejects(() => buffer.armTab(8), (error) => error.code === 'E_CDP_ATTACH');
  await buffer.armTab(8);
  assert.equal(attempts, 2);
});

test('network buffer does not clobber live entries on repeated armTab calls', async () => {
  const storageArea = createStorageArea();
  storageArea.store['piBridge.networkBuf.6'] = { entries: [], persistedAt: 1 };
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
  const buffer = new NetworkBufferManager({ inspector, storageArea, logger: { warn() {} } });

  await buffer.armTab(6);
  listeners.get('Network.requestWillBeSent')({ requestId: 'req-1', request: { url: 'https://x.test', method: 'GET' }, type: 'document', timestamp: 1 });
  listeners.get('Network.responseReceived')({ requestId: 'req-1', response: { status: 200, mimeType: 'text/html' } });
  listeners.get('Network.loadingFinished')({ requestId: 'req-1', timestamp: 1.1 });
  await buffer.armTab(6);

  const result = await buffer.getEntries(6, {});
  assert.equal(result.returned, 1);
  assert.equal(result.entries[0].url, 'https://x.test');
});

test('network buffer armTab abandons work if releaseTab wins the race', async () => {
  let resolveAcquire;
  const acquireGate = new Promise((resolve) => { resolveAcquire = resolve; });
  let releaseCount = 0;
  const inspector = {
    isAttached() { return true; },
    async acquire() { await acquireGate; return { leaseId: 1 }; },
    async release() { releaseCount += 1; },
    async sendCommand() {},
    on() { return () => {}; },
  };
  const buffer = new NetworkBufferManager({ inspector, logger: { warn() {} } });

  const arming = buffer.armTab(30);
  await buffer.releaseTab(30);
  resolveAcquire();
  await arming;

  const state = buffer._states.get(30);
  assert.equal(state.armed, false);
  assert.equal(state.subscriptions.length, 0);
  assert.equal(state.lease, null);
  assert.equal(releaseCount, 1);
});

test('network buffer armTab abandons work if disconnectTab wins the race', async () => {
  let resolveAcquire;
  const acquireGate = new Promise((resolve) => { resolveAcquire = resolve; });
  let releaseCount = 0;
  const inspector = {
    isAttached() { return true; },
    async acquire() { await acquireGate; return { leaseId: 1 }; },
    async release() { releaseCount += 1; },
    async sendCommand() {},
    on() { return () => {}; },
  };
  const buffer = new NetworkBufferManager({ inspector, logger: { warn() {} } });

  const arming = buffer.armTab(31);
  buffer.disconnectTab(31, 'debugger_detach');
  resolveAcquire();
  await arming;

  const state = buffer._states.get(31);
  assert.equal(state.armed, false);
  assert.equal(state.subscriptions.length, 0);
  assert.equal(state.lease, null);
  assert.equal(releaseCount, 1);
});

test('network buffer hydrate rejects on chrome.runtime.lastError and warns', async () => {
  const originalChrome = globalThis.chrome;
  globalThis.chrome = { runtime: { lastError: { message: 'storage broken' } } };
  const warnings = [];
  const buffer = new NetworkBufferManager({
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
  assert.match(String(warnings[0][0]), /failed to hydrate network buffer/);
});

test('network buffer persist returns false when chrome.runtime.lastError fires', async () => {
  const originalChrome = globalThis.chrome;
  const warnings = [];
  const buffer = new NetworkBufferManager({
    storageArea: {
      get(_keys, cb) { cb({}); },
      set(_values, cb) {
        globalThis.chrome = { runtime: { lastError: { message: 'quota exceeded' } } };
        cb?.();
        globalThis.chrome = originalChrome;
      },
    },
    logger: { warn(...args) { warnings.push(args); } },
  });
  buffer.startRequest(70, { requestId: 'a', request: { url: 'https://t.test', method: 'GET' }, type: 'document', timestamp: 1 });
  buffer.finishRequest(70, { requestId: 'a', timestamp: 1.1 });
  const ok = await buffer.persistTab(70);
  assert.equal(ok, false);
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0][0]), /failed to persist network buffer/);
});

test('network buffer removeTab drops in-memory state and persisted storage key', async () => {
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
  const buffer = new NetworkBufferManager({ storageArea: wrappedStorage, logger: { warn() {} } });
  buffer.startRequest(88, { requestId: 'x', request: { url: 'https://y.test', method: 'GET' }, type: 'document', timestamp: 1 });
  buffer.finishRequest(88, { requestId: 'x', timestamp: 1.1 });
  await buffer.persistTab(88);
  assert.ok(storageArea.store['piBridge.networkBuf.88']);

  await buffer.removeTab(88, { persist: false });

  assert.equal(buffer._states.has(88), false);
  assert.deepEqual(removedKeys, ['piBridge.networkBuf.88']);
  assert.equal(storageArea.store['piBridge.networkBuf.88'], undefined);
});

test('network buffer finalizes in-flight requests as interrupted on disconnect', async () => {
  const buffer = new NetworkBufferManager({ logger: { warn() {} } });
  buffer.startRequest(40, { requestId: 'r1', request: { url: 'https://z.test', method: 'GET' }, type: 'fetch', timestamp: 1 });
  buffer.updateResponse(40, { requestId: 'r1', response: { status: 200, mimeType: 'application/json' } });
  // Do NOT finish -> request is still in-flight.
  assert.equal(buffer._states.get(40).inFlight.size, 1);

  buffer.disconnectTab(40, 'sw_restart');

  const state = buffer._states.get(40);
  assert.equal(state.inFlight.size, 0);
  assert.equal(state.entries.length, 1);
  assert.equal(state.entries[0].interrupted, true);
  assert.equal(state.entries[0].interruptedReason, 'interrupted:sw_restart');
  assert.equal(state.entries[0].failed, true);
});

test('network buffer finalizes in-flight requests when flushAll is asked to do so (suspend)', async () => {
  const storageArea = createStorageArea();
  const buffer = new NetworkBufferManager({ storageArea, logger: { warn() {} } });
  buffer.startRequest(41, { requestId: 's1', request: { url: 'https://zz.test', method: 'POST' }, type: 'fetch', timestamp: 1 });

  await buffer.flushAll({ finalizeInFlight: true, reason: 'suspend' });

  const state = buffer._states.get(41);
  assert.equal(state.inFlight.size, 0);
  assert.equal(state.entries[0].interrupted, true);
  assert.match(state.entries[0].interruptedReason, /suspend/);
  assert.ok(storageArea.store['piBridge.networkBuf.41']);
});

test('network buffer re-arms after debugger disconnect', async () => {
  let attached = false;
  let acquireCount = 0;
  let releaseCount = 0;
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
    on() {
      return () => {};
    },
  };
  const buffer = new NetworkBufferManager({ inspector, logger: { warn() {} } });

  await buffer.armTab(9);
  buffer.disconnectTab(9, 'manual_detach');
  await buffer.armTab(9);

  assert.equal(acquireCount, 2);
  assert.equal(releaseCount, 1);
});
