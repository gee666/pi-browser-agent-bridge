import test from 'node:test';
import assert from 'node:assert/strict';

import { createReadOnlyHandlers, READ_ONLY_HANDLER_NAMES } from '../src/handlers/read-only/index.js';

function createDeps(overrides = {}) {
  const calls = [];
  const deps = {
    calls,
    async resolveTarget(input) {
      calls.push(['resolveTarget', input]);
      return { tabId: input.tabId ?? 99, url: 'https://current.test' };
    },
    async navigate(input) {
      calls.push(['navigate', input]);
      return { ok: true };
    },
    async captureScreenshot(input) {
      calls.push(['captureScreenshot', input]);
      return { mime: 'image/jpeg', data_base64: 'abc', width: 100, height: 50 };
    },
    async getHtml(input) {
      calls.push(['getHtml', input]);
      return { html: '<div>Hello</div>', url: 'https://example.test' };
    },
    async getDomInfo(input) {
      calls.push(['getDomInfo', input]);
      return { selector: input.selector, count: 1, elements: [{ textContent: 'Hi' }] };
    },
    async getComputedStyles(input) {
      calls.push(['getComputedStyles', input]);
      return { selector: input.selector, properties: { color: 'red' } };
    },
    async listTabs() {
      calls.push(['listTabs']);
      return [
        { id: 1, title: 'A', url: 'https://a.test', active: false, pinned: false, isAgentTab: false },
        { tabId: 2, title: 'Agent', url: 'chrome://newtab/', active: true, pinned: true, is_agent_tab: true },
      ];
    },
    async waitFor(input) {
      calls.push(['waitFor', input]);
      return { status: 'matched', matched: { selector: input.selector }, elapsedMs: 25 };
    },
    async getAccessibilityTree(input) {
      calls.push(['getAccessibilityTree', input]);
      return { root: { role: 'document', children: [] }, include: input.include };
    },
    async getPerformanceMetrics(input) {
      calls.push(['getPerformanceMetrics', input]);
      return {
        metrics: { JSHeapUsedSize: 123 },
        timing: { domComplete: 456 },
        web_vitals: { lcp: 789 },
        ignored: true,
      };
    },
    ...overrides,
  };
  return deps;
}

test('read-only bridge family exports the planned handler names', () => {
  assert.deepEqual(READ_ONLY_HANDLER_NAMES, [
    'browser_get_screenshot',
    'browser_get_html',
    'browser_get_dom_info',
    'browser_get_computed_styles',
    'browser_list_tabs',
    'browser_wait_for',
    'browser_get_accessibility_tree',
    'browser_get_performance_metrics',
  ]);
});

test('browser_get_screenshot resolves target, navigates when needed, and forwards normalized options', async () => {
  const deps = createDeps();
  const handlers = createReadOnlyHandlers(deps);

  const result = await handlers.browser_get_screenshot({
    url: 'https://example.test',
    full_page: true,
    selector: '#hero',
    quality: 0.5,
    max_width: 900,
    wait_until: 'load',
  });

  assert.equal(result.mime, 'image/jpeg');
  assert.deepEqual(deps.calls, [
    ['resolveTarget', { tabId: undefined, useActiveTab: false }],
    ['navigate', { tabId: 99, url: 'https://example.test', waitUntil: 'load' }],
    ['captureScreenshot', {
      tabId: 99,
      selector: '#hero',
      fullPage: true,
      waitUntil: 'load',
      format: 'jpeg',
      quality: 0.5,
      maxWidth: 900,
    }],
  ]);
});

test('browser_get_dom_info requires a selector', async () => {
  const handlers = createReadOnlyHandlers(createDeps());
  await assert.rejects(() => handlers.browser_get_dom_info({}), { code: 'E_VALIDATION' });
});

test('browser_get_html forwards strip options and render defaults', async () => {
  const deps = createDeps();
  const handlers = createReadOnlyHandlers(deps);

  const result = await handlers.browser_get_html({ selector: 'main', strip: ['script', 'comments'] });
  assert.equal(result.html, '<div>Hello</div>');
  assert.deepEqual(deps.calls[1], ['getHtml', {
    tabId: 99,
    selector: 'main',
    selectorAll: false,
    rendered: true,
    waitUntil: 'settle',
    strip: ['script', 'comments'],
    maxBytes: 50000,
  }]);
});

test('browser_list_tabs normalizes both id/tabId and agent-tab markers', async () => {
  const handlers = createReadOnlyHandlers(createDeps());
  const tabs = await handlers.browser_list_tabs({});

  assert.deepEqual(tabs, [
    { tabId: 1, title: 'A', url: 'https://a.test', active: false, pinned: false, is_agent_tab: false },
    { tabId: 2, title: 'Agent', url: 'chrome://newtab/', active: true, pinned: true, is_agent_tab: true },
  ]);
});

test('browser_wait_for requires at least one condition and forwards normalized payload', async () => {
  const deps = createDeps();
  const handlers = createReadOnlyHandlers(deps);

  await assert.rejects(() => handlers.browser_wait_for({ timeout_ms: 10 }), { code: 'E_VALIDATION' });

  const result = await handlers.browser_wait_for({ selector: '#ready', timeout_ms: 1500, state: 'attached' });
  assert.equal(result.status, 'matched');
  assert.deepEqual(deps.calls.at(-1), ['waitFor', {
    tabId: 99,
    selector: '#ready',
    text: undefined,
    urlMatches: undefined,
    state: 'attached',
    timeoutMs: 1500,
  }]);
});


test('invalid wait_until is rejected before navigation side effects happen', async () => {
  const deps = createDeps();
  const handlers = createReadOnlyHandlers(deps);

  await assert.rejects(() => handlers.browser_get_screenshot({ url: 'https://example.test', wait_until: 'bogus' }), { code: 'E_VALIDATION' });
  assert.deepEqual(deps.calls, []);
});


test('bridge-side validation rejects unsupported screenshot formats and oversized DOM limits', async () => {
  const handlers = createReadOnlyHandlers(createDeps());
  await assert.rejects(() => handlers.browser_get_screenshot({ format: 'gif' }), { code: 'E_VALIDATION' });
  await assert.rejects(() => handlers.browser_get_dom_info({ selector: '.x', limit: 201 }), { code: 'E_VALIDATION' });
});

test('browser_get_performance_metrics keeps only requested sections and echoes requested include set', async () => {
  const handlers = createReadOnlyHandlers(createDeps());
  const result = await handlers.browser_get_performance_metrics({ include: ['metrics', 'web_vitals'] });

  assert.deepEqual(result, {
    metrics: { JSHeapUsedSize: 123 },
    web_vitals: { lcp: 789 },
    requested_include: ['metrics', 'web_vitals'],
    tabId: 99,
  });
});
