import test from 'node:test';
import assert from 'node:assert/strict';

// Minimal chrome globals required by pi-bridge-runtime defaults at import time.
if (typeof globalThis.chrome === 'undefined') {
  globalThis.chrome = {
    storage: { local: { get() {}, set() {}, remove() {} } },
    tabs: {},
    windows: {},
    scripting: {},
    debugger: {},
    browsingData: {},
    runtime: { id: 'test', reload() {}, onSuspend: { addListener() {} } },
  };
}

const { createPiBridgeRuntime } = await import('../../../background/pi-bridge-runtime.js');

function createStorageArea() {
  const store = {};
  return {
    store,
    get(keys, cb) {
      const result = {};
      const list = Array.isArray(keys) ? keys : [keys];
      for (const key of list) result[key] = store[key];
      cb(result);
    },
    set(values, cb) { Object.assign(store, values); cb?.(); },
    remove(keys, cb) {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const key of list) delete store[key];
      cb?.();
    },
  };
}

function createChromeApi(existingTabs) {
  return {
    tabs: {
      async query() { return existingTabs; },
      async get(tabId) { return existingTabs.find((tab) => tab.id === tabId) || null; },
      async update(tabId, changes) { return { id: tabId, ...changes }; },
      async create(info) { return { id: 9999, ...info }; },
      async remove() {},
      async reload() {},
      onUpdated: { addListener() {}, removeListener() {} },
      onRemoved: { addListener() {}, removeListener() {} },
    },
    windows: { async update() {} },
    scripting: { async executeScript() { return []; } },
    debugger: {
      async attach() {}, async detach() {}, async sendCommand() {},
      onDetach: { addListener() {} },
      onEvent: { addListener() {} },
    },
    browsingData: { async remove() {} },
    runtime: {
      id: 'test-extension',
      reload() {},
      onSuspend: { addListener() {} },
    },
  };
}

function stubInspector(runtime, armed) {
  runtime.inspector.acquire = async (tabId) => {
    armed.push(tabId);
    return { leaseId: tabId, tabId, released: false };
  };
  runtime.inspector.release = async () => {};
  runtime.inspector.sendCommand = async () => ({});
  runtime.inspector.on = () => (() => {});
  runtime.inspector.isAttached = () => true;
}

test('warmUp arms existing tabs so service-worker restart resumes CDP subscriptions', async () => {
  const storageArea = createStorageArea();
  const chromeApi = createChromeApi([
    { id: 101, url: 'https://a.test', active: true },
    { id: 102, url: 'https://b.test', active: false },
  ]);
  const runtime = createPiBridgeRuntime({
    chromeApi,
    logger: { warn() {}, error() {}, info() {} },
    storageArea,
  });

  const armed = [];
  stubInspector(runtime, armed);

  await runtime.warmUp();

  assert.ok(armed.includes(101), 'existing tab 101 should be armed on warmUp');
  assert.ok(armed.includes(102), 'existing tab 102 should be armed on warmUp');

  await runtime.dispose();
});

test('setEnabled(true) after a restart also arms existing tabs', async () => {
  const storageArea = createStorageArea();
  const chromeApi = createChromeApi([{ id: 201, url: 'https://c.test', active: true }]);
  const runtime = createPiBridgeRuntime({
    chromeApi,
    logger: { warn() {}, error() {}, info() {} },
    storageArea,
  });

  const armed = [];
  stubInspector(runtime, armed);

  await runtime.setEnabled(true);
  // Both console and network buffer managers each acquire for the tab.
  assert.ok(armed.includes(201), 'setEnabled should arm existing tab 201');
  assert.ok(armed.length >= 1, 'arming should occur at least once via armExistingTabs');

  await runtime.dispose();
});
