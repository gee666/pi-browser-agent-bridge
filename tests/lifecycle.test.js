import test from 'node:test';
import assert from 'node:assert/strict';

import { createBridgeController } from '../src/index.js';

test('controller serializes refreshes so only the newest bridge stays active', async () => {
  const calls = [];
  const bridges = [];
  let readCount = 0;
  let releaseFirstStart;
  const firstStartReady = new Promise((resolve) => {
    releaseFirstStart = resolve;
  });

  const controller = createBridgeController({
    storageArea: {},
    logger: { error() {}, warn() {}, info() {} },
    async readConfig() {
      readCount += 1;
      return readCount === 1
        ? { enabled: true, url: 'ws://first.example' }
        : { enabled: true, url: 'ws://second.example' };
    },
    async startBridgeImpl(config) {
      calls.push(config.url);
      if (config.url === 'ws://first.example') {
        await firstStartReady;
      }
      const bridge = {
        config,
        stopped: 0,
        async stop() {
          bridge.stopped += 1;
        },
      };
      bridges.push(bridge);
      return bridge;
    },
  });

  const firstRefresh = controller.refreshFromStorage();
  const secondRefresh = controller.refreshFromStorage();
  releaseFirstStart();

  await Promise.all([firstRefresh, secondRefresh]);

  assert.deepEqual(calls, ['ws://second.example']);
  assert.equal(bridges.length, 1);
  assert.equal(controller.getCurrentBridge(), bridges[0]);
  assert.equal(bridges[0].stopped, 0);
});

test('older config reads do not overwrite newer refreshes when reads resolve out of order', async () => {
  const started = [];
  let resolveFirstRead;
  const firstRead = new Promise((resolve) => {
    resolveFirstRead = resolve;
  });
  let readCount = 0;

  const controller = createBridgeController({
    storageArea: {},
    logger: { error() {}, warn() {}, info() {} },
    async readConfig() {
      readCount += 1;
      if (readCount === 1) {
        await firstRead;
        return { enabled: true, url: 'ws://first-read.example' };
      }
      return { enabled: true, url: 'ws://second-read.example' };
    },
    async startBridgeImpl(config) {
      started.push(config.url);
      return { config, async stop() {} };
    },
  });

  const first = controller.refreshFromStorage();
  const second = controller.refreshFromStorage();
  resolveFirstRead();

  await Promise.all([first, second]);

  assert.deepEqual(started, ['ws://second-read.example']);
  assert.equal(controller.getCurrentBridge().config.url, 'ws://second-read.example');
});

test('stop prevents a pending storage refresh from restarting the bridge', async () => {
  let resolveRead;
  const pendingRead = new Promise((resolve) => {
    resolveRead = resolve;
  });
  let starts = 0;

  const controller = createBridgeController({
    storageArea: {},
    logger: { error() {}, warn() {}, info() {} },
    async readConfig() {
      await pendingRead;
      return { enabled: true, url: 'ws://late.example' };
    },
    async startBridgeImpl(config) {
      starts += 1;
      return { config, async stop() {} };
    },
  });

  const refresh = controller.refreshFromStorage();
  const stop = controller.stop();
  resolveRead();

  await Promise.all([refresh, stop]);

  assert.equal(starts, 0);
  assert.equal(controller.getCurrentBridge(), null);
});
