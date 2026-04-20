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
