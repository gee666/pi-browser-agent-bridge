import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createJsNavigationDestructiveHandlers,
  createJsNavigationDestructiveRequestHandler,
  JS_NAVIGATION_DESTRUCTIVE_HANDLER_NAMES,
} from '../src/handlers/js-navigation-family.js';

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
    'browser_evaluate_js',
    'browser_run_js',
    'browser_navigate',
    'browser_switch_tab',
    'browser_close_tab',
    'browser_reload',
    'browser_clear_site_data',
  ]);
});

test('evaluate_js and run_js execute through the inspector and release leases', async () => {
  const { tabsApi } = createTabApis();
  const inspector = createInspector();
  const handlers = createJsNavigationDestructiveHandlers({ tabsApi, inspector, resolveDefaultTabId: async () => 11 });

  const evaluate = await handlers.browser_evaluate_js({ expression: '1 + 1' });
  assert.equal(evaluate.tabId, 11);
  assert.equal(evaluate.value, 2);
  assert.deepEqual(inspector.calls[0], ['acquire', 11]);
  assert.equal(inspector.calls.at(-1)[0], 'release');

  const run = await handlers.browser_run_js({ code: 'return "done";' });
  assert.equal(run.tabId, 11);
  assert.equal(run.console_entries.length, 1);
});

test('evaluate_js preserves unserializable CDP values returned by runtime evaluation', async () => {
  const { tabsApi } = createTabApis();
  const inspector = createInspector();
  inspector.sendCommand = async (tabId, method, params) => {
    inspector.calls.push(['sendCommand', tabId, method, params]);
    if (method === 'Runtime.evaluate') {
      return {
        result: {
          type: 'number',
          unserializableValue: 'NaN',
        },
      };
    }
    return {};
  };
  const handlers = createJsNavigationDestructiveHandlers({ tabsApi, inspector, resolveDefaultTabId: async () => 11 });

  const result = await handlers.browser_evaluate_js({ expression: 'Number.NaN' });
  assert.equal(Number.isNaN(result.value), true);
});

test('evaluate_js timeout performs best-effort cleanup and surfaces a structured error', async () => {
  const { tabsApi } = createTabApis();
  const inspector = createInspector();
  inspector.sendCommand = async (tabId, method) => {
    inspector.calls.push(['sendCommand', tabId, method]);
    if (method === 'Runtime.evaluate' || method === 'Runtime.releaseObjectGroup') {
      return await new Promise(() => {});
    }
    return {};
  };
  const handlers = createJsNavigationDestructiveHandlers({ tabsApi, inspector, resolveDefaultTabId: async () => 11 });

  await assert.rejects(
    handlers.browser_evaluate_js({ expression: '1 + 1', timeout_ms: 10 }),
    (error) => {
      assert.equal(error.code, 'E_TIMEOUT');
      assert.match(error.message, /evaluating JavaScript/);
      return true;
    },
  );
});

test('navigation family handlers perform tab operations without crashing the caller', async () => {
  const { tabsApi, windowsApi, tabs } = createTabApis();
  const inspector = createInspector();
  const handlers = createJsNavigationDestructiveHandlers({ tabsApi, windowsApi, inspector, resolveDefaultTabId: async () => 11 });

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
