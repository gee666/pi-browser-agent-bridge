import test from 'node:test';
import assert from 'node:assert/strict';

import { createObservabilityLifecycle } from '../src/buffers/lifecycle.js';
import { createBufferedObservabilityHandlers } from '../src/handlers/observability-family.js';

function createBufferSpy(name) {
  return {
    name,
    armed: [],
    persisted: [],
    released: [],
    disconnected: [],
    flushed: 0,
    disposed: 0,
    async armTab(tabId) { this.armed.push(tabId); },
    async persistTab(tabId) { this.persisted.push(tabId); return true; },
    async releaseTab(tabId) { this.released.push(tabId); },
    disconnectTab(tabId, reason) { this.disconnected.push([tabId, reason]); },
    async flushAll() { this.flushed += 1; },
    async dispose() { this.disposed += 1; },
  };
}

test('observability lifecycle arms existing tabs and flushes both buffers safely', async () => {
  const consoleBuffer = createBufferSpy('console');
  const networkBuffer = createBufferSpy('network');
  const lifecycle = createObservabilityLifecycle({
    tabsApi: {
      async query() {
        return [{ id: 1 }, { id: 2 }, { id: null }];
      },
    },
    consoleBuffer,
    networkBuffer,
  });

  const count = await lifecycle.armExistingTabs();
  assert.equal(count, 3);
  assert.deepEqual(consoleBuffer.armed, [1, 2]);
  assert.deepEqual(networkBuffer.armed, [1, 2]);

  await lifecycle.handleSuspend();
  assert.equal(consoleBuffer.flushed, 1);
  assert.equal(networkBuffer.flushed, 1);

  await lifecycle.handleTabRemoved(2, 'tab_closed');
  assert.deepEqual(consoleBuffer.disconnected, [[2, 'tab_closed']]);
  assert.deepEqual(networkBuffer.released, [2]);
});

test('observability handlers expose browser_get_console_logs and browser_get_network maps', async () => {
  const handlers = createBufferedObservabilityHandlers({
    resolveTabId: async () => 7,
    consoleBuffer: {
      async armTab(tabId) { assert.equal(tabId, 7); },
      getEntries() { return { total: 3, returned: 1, entries: [{ text: 'warn' }], disconnectReason: 'sw_restart', disconnectedAt: 99 }; },
    },
    networkBuffer: {
      async armTab(tabId) { assert.equal(tabId, 7); },
      async getEntries() { return { total: 2, returned: 1, entries: [{ url: 'https://x.test' }], disconnectReason: undefined, disconnectedAt: undefined }; },
    },
  });

  const consoleResult = await handlers.browser_get_console_logs({ substring: 'warn' });
  assert.equal(consoleResult.returned, 1);
  assert.equal(consoleResult.disconnectReason, 'sw_restart');

  const networkResult = await handlers.browser_get_network({ filter: { url_contains: 'x' } });
  assert.equal(networkResult.entries[0].url, 'https://x.test');
});

test('observability handlers convert unexpected failures into structured tool errors', async () => {
  const handlers = createBufferedObservabilityHandlers({
    resolveTabId: () => 4,
    consoleBuffer: {
      async armTab() { throw new Error('boom'); },
    },
    networkBuffer: {
      async armTab() { throw { code: 'E_TIMEOUT', message: 'too slow' }; },
    },
  });

  await assert.rejects(
    () => handlers.browser_get_console_logs({}),
    (error) => {
      assert.equal(error.code, 'E_INTERNAL');
      assert.equal(error.message, 'boom');
      return true;
    },
  );
  await assert.rejects(
    () => handlers.browser_get_network({}),
    (error) => {
      assert.equal(error.code, 'E_TIMEOUT');
      assert.equal(error.message, 'too slow');
      return true;
    },
  );
});
