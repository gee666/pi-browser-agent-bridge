import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_PI_BRIDGE_CONFIG, normalizePiBridgeConfig, readPiBridgeConfig } from '../src/index.js';

test('normalizePiBridgeConfig returns defaults for missing or invalid values', () => {
  assert.deepEqual(normalizePiBridgeConfig(), DEFAULT_PI_BRIDGE_CONFIG);
  assert.deepEqual(normalizePiBridgeConfig(null), DEFAULT_PI_BRIDGE_CONFIG);
  assert.deepEqual(normalizePiBridgeConfig({ enabled: 'yes', url: '   ' }), DEFAULT_PI_BRIDGE_CONFIG);
});

test('normalizePiBridgeConfig trims url and preserves explicit enabled flag', () => {
  assert.deepEqual(
    normalizePiBridgeConfig({ enabled: false, url: ' ws://localhost:9000 ' }),
    { enabled: false, url: 'ws://localhost:9000' },
  );
});

test('readPiBridgeConfig reads from storage and normalizes the result', async () => {
  const storageArea = {
    get(keys, callback) {
      assert.deepEqual(keys, ['piBridgeConfig']);
      callback({ piBridgeConfig: { enabled: true, url: ' ws://example.test:7777 ' } });
    },
  };

  const config = await readPiBridgeConfig(storageArea);
  assert.deepEqual(config, { enabled: true, url: 'ws://example.test:7777' });
});

test('readPiBridgeConfig surfaces storage runtime errors', async () => {
  const originalChrome = globalThis.chrome;
  globalThis.chrome = { runtime: { lastError: new Error('storage failed') } };
  const storageArea = {
    get(_keys, callback) {
      callback({});
    },
  };

  try {
    await assert.rejects(() => readPiBridgeConfig(storageArea), /storage failed/);
  } finally {
    globalThis.chrome = originalChrome;
  }
});
