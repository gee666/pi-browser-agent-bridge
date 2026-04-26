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
    { enabled: false, url: 'ws://localhost:9000', urls: ['ws://localhost:9000'] },
  );
});

test('normalizePiBridgeConfig accepts a multi-URL list and dedupes/trims it', () => {
  const out = normalizePiBridgeConfig({
    enabled: true,
    urls: [' ws://a:1 ', 'ws://b:2', 'ws://a:1', '', 42],
  });
  assert.equal(out.enabled, true);
  assert.deepEqual(out.urls, ['ws://a:1', 'ws://b:2']);
  assert.equal(out.url, 'ws://a:1');
});

test('normalizePiBridgeConfig parses a string list (newline/comma/whitespace separated)', () => {
  const out = normalizePiBridgeConfig({
    enabled: true,
    urls: 'ws://a:1\nws://b:2 , ws://c:3',
  });
  assert.deepEqual(out.urls, ['ws://a:1', 'ws://b:2', 'ws://c:3']);
});

test('normalizePiBridgeConfig auto-migrates a legacy single-URL default to the full range', () => {
  // Pre-multi-instance configs only stored `url: "ws://127.0.0.1:7878"`. On
  // upgrade we expand that exact value to the new default range so users do
  // not have to manually edit options to regain reachability.
  const out = normalizePiBridgeConfig({ enabled: true, url: 'ws://127.0.0.1:7878' });
  assert.ok(out.urls.length >= 2, `expected migrated range, got ${JSON.stringify(out.urls)}`);
  assert.equal(out.urls[0], 'ws://127.0.0.1:7878');
  assert.ok(out.urls.includes('ws://127.0.0.1:7879'));
});

test('normalizePiBridgeConfig keeps a custom legacy url as a single entry (no migration)', () => {
  const out = normalizePiBridgeConfig({ enabled: true, url: 'ws://my-custom-host:9999' });
  assert.deepEqual(out.urls, ['ws://my-custom-host:9999']);
});

test('normalizePiBridgeConfig falls back to defaults when no urls and no legacy url given', () => {
  const out = normalizePiBridgeConfig({ enabled: true, urls: [] });
  assert.ok(out.urls.length >= 2, 'default range should include multiple ports');
  assert.equal(out.url, out.urls[0]);
});

test('readPiBridgeConfig reads from storage and normalizes the result', async () => {
  const storageArea = {
    get(keys, callback) {
      assert.deepEqual(keys, ['piBridgeConfig']);
      callback({ piBridgeConfig: { enabled: true, url: ' ws://example.test:7777 ' } });
    },
  };

  const config = await readPiBridgeConfig(storageArea);
  assert.deepEqual(config, {
    enabled: true,
    url: 'ws://example.test:7777',
    urls: ['ws://example.test:7777'],
  });
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
