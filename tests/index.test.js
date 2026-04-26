import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_PI_BRIDGE_CONFIG, startBridge } from '../src/index.js';

test('startBridge returns a disabled bridge when disabled in config', async () => {
  let createClientCalled = false;
  const bridge = await startBridge({
    enabled: false,
    createClient() {
      createClientCalled = true;
      throw new Error('should not be called');
    },
  });

  assert.equal(createClientCalled, false);
  assert.equal(bridge.client, null);
  assert.deepEqual(bridge.config, { ...DEFAULT_PI_BRIDGE_CONFIG, enabled: false });
});

test('startBridge auto-starts the client and exposes stop()', async () => {
  let started = 0;
  let stopped = 0;

  const bridge = await startBridge({
    url: 'ws://localhost:9001',
    createClient({ url }) {
      assert.equal(url, 'ws://localhost:9001');
      return {
        async start() {
          started += 1;
        },
        async stop() {
          stopped += 1;
        },
      };
    },
  });

  assert.equal(started, 1);
  await bridge.stop();
  assert.equal(stopped, 1);
});

test('startBridge catches startup failures instead of throwing', async () => {
  const errors = [];
  const logger = {
    error(...args) {
      errors.push(args);
    },
  };

  const bridge = await startBridge({
    logger,
    urls: ['ws://only-one:1234'],
    createClient() {
      return {
        url: 'ws://only-one:1234',
        async start() {
          throw new Error('boom');
        },
        async stop() {},
      };
    },
  });

  assert.ok(bridge.client);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0][0]), /failed to start bridge client/);
});
