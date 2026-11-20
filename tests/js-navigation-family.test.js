import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createJsNavigationDestructiveHandlers,
  createJsNavigationDestructiveRequestHandler,
  JS_NAVIGATION_DESTRUCTIVE_HANDLER_NAMES,
} from '../src/handlers/js-navigation-family.js';

test('browser_create_tab without a URL opens a blank page, not an external website', async () => {
  const { tabsApi } = createTabApis();
  const handlers = createJsNavigationDestructiveHandlers({ tabsApi });
  for (const url of [undefined, null, '']) {
    const created = await handlers.browser_create_tab({ url, wait_until: 'none' });
    assert.equal(created.url, 'about:blank');
    assert.equal(created.pinned, false);
    assert.equal(created.active, false);
  }
});

function createTabApis() {
  const tabs = new Map([
    [11, { id: 11, url: 'https://example.com/start', title: 'Start', status: 'complete', windowId: 1, active: false }],
    [12, { id: 12, url: 'https://example.com/active', title: 'Active', status: 'complete', windowId: 1, active: true }],
  ]);
  const updatedListeners = new Set();
  const removedListeners = new Set();

  return {
    tabs,
    tabsApi: {
      async get(tabId) {
        const tab = tabs.get(tabId);
        if (!tab) throw new Error(`missing tab ${tabId}`);
        return { ...tab };
      },
      async query(queryInfo) {
        return [...tabs.values()].filter((tab) => (!queryInfo.active || tab.active));
      },
      async create(createProperties) {
        const id = Math.max(...tabs.keys()) + 1;
        const tab = {
          id,
          url: createProperties.url,
          title: 'New tab',
          status: 'loading',
          windowId: createProperties.windowId || 1,
          active: !!createProperties.active,
          pinned: !!createProperties.pinned,
        };
        tabs.set(id, tab);
        queueMicrotask(() => {
          const settled = { ...tab, status: 'complete', title: 'Created page' };
          tabs.set(id, settled);
          for (const listener of updatedListeners) {
            listener(id, { status: 'complete' }, { ...settled });
          }
        });
        return { ...tab };
      },
      async update(tabId, changes) {
        const current = tabs.get(tabId);
        if (!current) throw new Error(`missing tab ${tabId}`);
        const next = { ...current, ...changes };
        if (changes.url) {
          next.status = 'loading';
          tabs.set(tabId, next);
          queueMicrotask(() => {
            const settled = { ...next, status: 'complete', title: 'Loaded page', url: changes.url };
            tabs.set(tabId, settled);
            for (const listener of updatedListeners) {
              listener(tabId, { status: 'complete' }, { ...settled });
            }
          });
        } else {
          tabs.set(tabId, next);
        }
        return { ...next };
      },
      async reload(tabId) {
        const current = tabs.get(tabId);
        if (!current) throw new Error(`missing tab ${tabId}`);
        const loading = { ...current, status: 'loading' };
        tabs.set(tabId, loading);
        queueMicrotask(() => {
          const settled = { ...loading, status: 'complete', title: `${current.title} reloaded` };
          tabs.set(tabId, settled);
          for (const listener of updatedListeners) {
            listener(tabId, { status: 'complete' }, { ...settled });
          }
        });
      },
      async remove(tabId) {
        if (!tabs.has(tabId)) throw new Error(`missing tab ${tabId}`);
        tabs.delete(tabId);
        for (const listener of removedListeners) {
          listener(tabId, { isWindowClosing: false });
        }
      },
      onUpdated: {
        addListener(listener) {
          updatedListeners.add(listener);
        },
        removeListener(listener) {
          updatedListeners.delete(listener);
        },
      },
      onRemoved: {
        addListener(listener) {
          removedListeners.add(listener);
        },
        removeListener(listener) {
          removedListeners.delete(listener);
        },
      },
    },
    windowsApi: {
      focused: [],
      async update(windowId, changes) {
        this.focused.push({ windowId, changes });
      },
    },
  };
}

function createInspector() {
  const calls = [];
  const apiCalls = [];
  return {
    calls,
    _protocolVersion: '1.3',
    _api: {
      async detach(target) {
        apiCalls.push(['detach', target]);
      },
      async attach(target, version) {
        apiCalls.push(['attach', target, version]);
      },
    },
    async acquire(tabId) {
      calls.push(['acquire', tabId]);
      return { inspector: this, tabId, generation: 1, released: false };
    },
    async release(lease) {
      lease.released = true;
      calls.push(['release', lease.tabId]);
    },
    async send(tabId, method, params) {
      calls.push(['send', tabId, method, params]);
      return {};
    },
    async sendCommand(tabId, method, params) {
      calls.push(['sendCommand', tabId, method, params]);
      if (method === 'Runtime.evaluate') {
        if (params.expression.includes('__piRunner')) {
          return {
            result: {
              type: 'object',
              value: {
                __piValue: 'ran',
                __piConsole: [{ level: 'log', entries: ['hello'] }],
              },
            },
          };
        }

        return {
          result: {
            type: 'number',
            value: 2,
          },
        };
      }
      return {};
    },
    apiCalls,
  };
}

test('handler family exports the expected request names', () => {
  assert.deepEqual(JS_NAVIGATION_DESTRUCTIVE_HANDLER_NAMES, [
    'browser_run_js',
    'browser_create_tab',
    'browser_navigate',
    'browser_switch_tab',
    'browser_close_tab',
    'browser_reload',
    'browser_clear_site_data',
  ]);
});

test('all external JS, including reads and aliases, passes unchanged through the rewrite service', async () => {
  const { tabsApi } = createTabApis();
  const inspector = createInspector();
  const requests = [];
  const handlers = createJsNavigationDestructiveHandlers({
    tabsApi, inspector, resolveDefaultTabId: async () => 11,
    async executeExternalScript(request) {
      requests.push(request);
      return { type: 'number', value: 2, console_entries: [{ level: 'log', entries: ['hello'] }] };
    },
  });

  for (const code of ['return 1 + 1;', 'return document.title;', 'const el = document.querySelector("button"); el["click"]()']) {
    const result = await handlers.browser_run_js({ code, world: 'main', capture_console: false });
    assert.equal(result.tabId, 11);
    assert.equal(result.url, 'https://example.com/start');
    assert.equal(result.value, 2);
    assert.equal(result.console_entries, undefined);
    assert.equal(typeof result.duration_ms, 'number');
    const { signal, ...request } = requests.at(-1);
    assert.equal(signal.aborted, false);
    assert.deepEqual(request, {
      tabId: 11, kind: 'program', source: code, args: [],
      awaitPromise: true, returnByValue: true, captureConsole: false, timeoutMs: 120_000,
    });
  }

  const code = 'console.log(args[0]); return args[0];';
  const run = await handlers.browser_run_js({ code, args: ['done'], tab_id: 12, timeout_ms: 500 });
  assert.equal(run.tabId, 12);
  assert.equal(run.console_entries.length, 1);
  const { signal, ...request } = requests.at(-1);
  assert.deepEqual(request, {
    tabId: 12, kind: 'program', source: code, args: ['done'],
    awaitPromise: true, returnByValue: true, captureConsole: true, timeoutMs: 500,
  });
  assert.equal(signal.aborted, false);
  assert.deepEqual(inspector.calls, [], 'external source must never execute directly through CDP');
});

test('the rewrite service preserves non-JSON numbers and preview semantics', async () => {
  const { tabsApi } = createTabApis();
  const requests = [];
  const handlers = createJsNavigationDestructiveHandlers({
    tabsApi, resolveDefaultTabId: async () => 11,
    async executeExternalScript(request) {
      requests.push(request);
      return { type: 'number', value: Number.NaN, preview: { description: 'number' } };
    },
  });
  const result = await handlers.browser_run_js({ code: 'return Number.NaN;' });
  assert.equal(Number.isNaN(result.value), true);
  const preview = await handlers.browser_run_js({ code: 'return Number.NaN;', return_by_value: false, capture_console: false });
  assert.equal(preview.value, undefined);
  assert.deepEqual(preview.preview, { description: 'number' });
  assert.equal(requests.at(-1).returnByValue, false);
  assert.equal(requests.at(-1).awaitPromise, true);

  const run = await handlers.browser_run_js({ code: 'return 1;', capture_console: false, return_by_value: false });
  assert.equal(run.console_entries, undefined);
  assert.equal(requests.at(-1).captureConsole, false);
  assert.equal(requests.at(-1).timeoutMs, 120_000);
});

test('missing, rejecting, or malformed rewrite services fail closed without CDP execution', async () => {
  const { tabsApi } = createTabApis();
  const inspector = createInspector();
  for (const [executeExternalScript, code] of [
    [undefined, 'E_SCRIPT_REWRITE_UNAVAILABLE'],
    [async () => { throw Object.assign(new Error('unsupported script'), { code: 'E_SCRIPT_UNSUPPORTED' }); }, 'E_SCRIPT_UNSUPPORTED'],
    [async () => undefined, 'E_SCRIPT_REWRITE_RESPONSE'],
  ]) {
    const handlers = createJsNavigationDestructiveHandlers({ tabsApi, inspector, executeExternalScript, resolveDefaultTabId: async () => 11 });
    await assert.rejects(handlers.browser_run_js({ code: 'document.querySelector("button").click();' }), { code });
  }
  assert.deepEqual(inspector.calls, []);
});

test('run_js preserves legacy console entries from normalized service logs', async () => {
  const { tabsApi } = createTabApis();
  const handlers = createJsNavigationDestructiveHandlers({
    tabsApi, resolveDefaultTabId: async () => 11,
    async executeExternalScript() {
      return { type: 'undefined', value: undefined, console_entries: [
        { level: 'log', args: ['core log'] },
        { level: 'warn', entries: ['legacy log'] },
      ] };
    },
  });
  const run = await handlers.browser_run_js({ code: 'console.log("core log");' });
  assert.deepEqual(run.console_entries, [
    { level: 'log', entries: ['core log'] },
    { level: 'warn', entries: ['legacy log'] },
  ]);
});

test('run_js timeout synchronously aborts the rewrite service and surfaces a structured error', async () => {
  const { tabsApi } = createTabApis();
  const inspector = createInspector();
  let signal;
  const handlers = createJsNavigationDestructiveHandlers({
    tabsApi, inspector, resolveDefaultTabId: async () => 11,
    executeExternalScript(request) {
      signal = request.signal;
      return new Promise(() => {});
    },
  });

  await assert.rejects(
    handlers.browser_run_js({ code: 'return 1 + 1;', timeout_ms: 10 }),
    (error) => {
      assert.equal(error.code, 'E_TIMEOUT');
      assert.match(error.message, /evaluating JavaScript/);
      assert.equal(signal.aborted, true);
      assert.equal(signal.reason, error);
      return true;
    },
  );
  assert.deepEqual(inspector.calls, []);
});

test('invalid JS options never invoke the rewrite service', async () => {
  const { tabsApi } = createTabApis();
  const handlers = createJsNavigationDestructiveHandlers({
    tabsApi,
    executeExternalScript() { assert.fail('invalid requests must not run'); },
  });
  for (const args of [null, {}, 'text', 1, true]) {
    await assert.rejects(handlers.browser_run_js({ code: 'return args;', args }), { code: 'E_VALIDATION' });
  }
  for (const timeout_ms of [0, -1, Infinity, '10', Number.NaN]) {
    await assert.rejects(handlers.browser_run_js({ code: 'return 1;', timeout_ms }), { code: 'E_VALIDATION' });
  }
  await assert.rejects(handlers.browser_run_js({ code: 'return 1;', world: 'isolated' }), { code: 'E_VALIDATION' });
});

test('navigation family handlers perform tab operations without crashing the caller', async () => {
  const { tabsApi, windowsApi, tabs } = createTabApis();
  const inspector = createInspector();
  const handlers = createJsNavigationDestructiveHandlers({ tabsApi, windowsApi, inspector, resolveDefaultTabId: async () => 11 });

  const created = await handlers.browser_create_tab({ url: 'https://example.com/own', active: false, pinned: true, timeout_ms: 200 });
  assert.equal(created.tabId, 13);
  assert.equal(created.url, 'https://example.com/own');
  assert.equal(created.pinned, true);

  const navigated = await handlers.browser_navigate({ url: 'https://example.com/next', timeout_ms: 200 });
  assert.equal(navigated.url, 'https://example.com/next');

  const switched = await handlers.browser_switch_tab({ tab_id: 12, wait_until: 'none' });
  assert.equal(switched.tabId, 12);
  assert.equal(windowsApi.focused.length, 1);

  const reloaded = await handlers.browser_reload({ tab_id: 11, bypass_cache: true, timeout_ms: 200 });
  assert.equal(reloaded.bypassCache, true);
  assert.equal(reloaded.status, 'complete');

  const cleared = await handlers.browser_clear_site_data({ tab_id: 11, types: ['cookies', 'cache'] });
  assert.equal(cleared.cleared, true);
  assert.deepEqual(cleared.storageTypes, ['cookies', 'cache_storage']);

  const closed = await handlers.browser_close_tab({ tab_id: 11 });
  assert.equal(closed.closed, true);
  assert.equal(tabs.has(11), false);
});

test('switch-tab wait failures and validation errors surface instead of being swallowed', async () => {
  const { tabsApi } = createTabApis();
  const handlers = createJsNavigationDestructiveHandlers({
    tabsApi,
    resolveDefaultTabId: async () => 11,
    async waitForTabSettled() {
      throw Object.assign(new Error('too slow'), { code: 'E_NAV_TIMEOUT' });
    },
  });

  await assert.rejects(handlers.browser_switch_tab({ tab_id: 12 }), (error) => {
    assert.equal(error.code, 'E_NAV_TIMEOUT');
    return true;
  });

  await assert.rejects(handlers.browser_run_js({ code: 'return 1;', return_by_value: false }), (error) => {
    assert.equal(error.code, 'E_VALIDATION');
    return true;
  });
});

test('clear-site-data supports origin-only fallback and rejects empty type lists', async () => {
  const { tabsApi } = createTabApis();
  const browsingCalls = [];
  const handlers = createJsNavigationDestructiveHandlers({
    tabsApi,
    browsingDataApi: {
      async remove(options, dataToRemove) {
        browsingCalls.push({ options, dataToRemove });
      },
    },
  });

  const result = await handlers.browser_clear_site_data({ origin: 'https://example.com', types: ['cookies'] });
  assert.equal(result.origin, 'https://example.com');
  assert.equal(browsingCalls.length, 1);

  await assert.rejects(handlers.browser_clear_site_data({ origin: 'https://example.com', types: [] }), (error) => {
    assert.equal(error.code, 'E_VALIDATION');
    return true;
  });
});

test('settle waits for a quiet period after the tab reaches complete', async () => {
  const updatedListeners = new Set();
  const removedListeners = new Set();
  let tab = { id: 77, url: 'https://s.test', title: 'S', status: 'loading', windowId: 1 };
  const tabsApi = {
    async get() { return { ...tab }; },
    async update(_id, changes) { tab = { ...tab, ...changes, status: 'loading' }; return { ...tab }; },
    onUpdated: {
      addListener(fn) { updatedListeners.add(fn); },
      removeListener(fn) { updatedListeners.delete(fn); },
    },
    onRemoved: {
      addListener(fn) { removedListeners.add(fn); },
      removeListener(fn) { removedListeners.delete(fn); },
    },
  };

  const handlers = createJsNavigationDestructiveHandlers({ tabsApi, resolveDefaultTabId: async () => 77 });

  // Arrange: one `complete` update, then another update 50ms later,
  // then no updates for 500ms (the default quiet window).
  const startedAt = Date.now();
  const navigatePromise = handlers.browser_navigate({ url: 'https://s.test/next', wait_until: 'settle', timeout_ms: 5000 });

  await new Promise((resolve) => setTimeout(resolve, 20));
  tab = { ...tab, status: 'complete', url: 'https://s.test/next' };
  for (const fn of updatedListeners) fn(77, { status: 'complete' }, { ...tab });
  // One more mid-flight update inside the quiet window -> resets timer.
  await new Promise((resolve) => setTimeout(resolve, 50));
  for (const fn of updatedListeners) fn(77, { status: 'complete' }, { ...tab });

  const result = await navigatePromise;
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed >= 500, `settle should wait at least the quiet window (elapsed=${elapsed}ms)`);
  assert.equal(result.url, 'https://s.test/next');
});

test('networkidle is rejected by the default fallback when no custom waiter is provided', async () => {
  const { tabsApi } = createTabApis();
  const handlers = createJsNavigationDestructiveHandlers({ tabsApi, resolveDefaultTabId: async () => 11 });

  await assert.rejects(
    handlers.browser_navigate({ url: 'https://example.com/nid', wait_until: 'networkidle', timeout_ms: 500 }),
    (error) => {
      assert.equal(error.code, 'E_VALIDATION');
      assert.match(error.message, /networkidle/);
      return true;
    },
  );
});

test('request handler maps unknown requests and normalizes thrown errors', async () => {
  const { tabsApi } = createTabApis();
  const handler = createJsNavigationDestructiveRequestHandler({ tabsApi, resolveDefaultTabId: async () => 11 });

  await assert.rejects(handler({ type: 'nope' }), (error) => {
    assert.equal(error.code, 'E_UNKNOWN_TYPE');
    return true;
  });

  await assert.rejects(handler({ type: 'browser_navigate', params: {} }), (error) => {
    assert.equal(error.code, 'E_VALIDATION');
    return true;
  });
});
