import {
  createProtocolError,
  maybeNavigate,
  normalizeBoolean,
  normalizeInclude,
  normalizeNumber,
  normalizeString,
  normalizeStringArray,
  pick,
  resolveTargetContext,
  withTimeout,
} from './common.js';

const HTML_STRIP_OPTIONS = ['script', 'style', 'comments'];
const DOM_INFO_INCLUDE_OPTIONS = ['attributes', 'rect', 'textContent', 'innerHTML', 'accessibility', 'visibility', 'event_listeners', 'outer_html', 'text', 'html', 'boundingBox'];
const AX_INCLUDE_OPTIONS = ['role', 'name', 'value', 'description', 'properties', 'children'];
const PERF_INCLUDE_OPTIONS = ['metrics', 'timing', 'web_vitals', 'layout', 'memory', 'paint'];
const WAIT_STATE_OPTIONS = ['visible', 'hidden', 'detached', 'attached'];

function normalizeWaitUntil(value) {
  if (value == null) return 'settle';
  if (typeof value !== 'string' || !['load', 'networkidle', 'settle'].includes(value)) {
    throw createProtocolError('E_VALIDATION', 'wait_until must be one of: load, networkidle, settle');
  }
  return value;
}

function normalizeScreenshotFormat(value) {
  if (value == null) return 'jpeg';
  if (typeof value !== 'string' || !['jpeg', 'png'].includes(value)) {
    throw createProtocolError('E_VALIDATION', 'format must be one of: jpeg, png');
  }
  return value;
}

function ensureDependency(deps, name) {
  if (typeof deps[name] !== 'function') {
    throw createProtocolError('E_INTERNAL', `${name} dependency is required`);
  }
  return deps[name];
}

async function screenshotHandler(params = {}, deps) {
  const selector = normalizeString(params.selector, 'selector');
  const fullPage = normalizeBoolean(params.full_page, 'full_page') ?? false;
  const waitUntil = normalizeWaitUntil(params.wait_until);
  const format = normalizeScreenshotFormat(params.format);
  const quality = normalizeNumber(params.quality, 'quality', { minimum: 0, maximum: 1 }) ?? 0.7;
  const maxWidth = normalizeNumber(params.max_width, 'max_width', { minimum: 1 }) ?? 1280;
  const target = await maybeNavigate(deps, await resolveTargetContext(deps, params), { ...params, wait_until: waitUntil });
  const captureScreenshot = ensureDependency(deps, 'captureScreenshot');

  return await withTimeout(
    captureScreenshot({
      tabId: target.tabId,
      selector,
      fullPage,
      waitUntil,
      format,
      quality,
      maxWidth,
    }),
    20_000,
    'browser_get_screenshot',
  );
}

async function htmlHandler(params = {}, deps) {
  const selector = normalizeString(params.selector, 'selector');
  const selectorAll = normalizeBoolean(params.selector_all, 'selector_all') ?? false;
  const rendered = normalizeBoolean(params.rendered, 'rendered') ?? true;
  const waitUntil = normalizeWaitUntil(params.wait_until);
  const strip = normalizeInclude(params, 'strip', HTML_STRIP_OPTIONS) ?? [];
  const maxBytes = normalizeNumber(params.max_bytes, 'max_bytes', { minimum: 1 }) ?? 50_000;
  const target = await maybeNavigate(deps, await resolveTargetContext(deps, params), { ...params, wait_until: waitUntil });
  const getHtml = ensureDependency(deps, 'getHtml');

  return await withTimeout(
    getHtml({
      tabId: target.tabId,
      selector,
      selectorAll,
      rendered,
      waitUntil,
      strip,
      maxBytes,
    }),
    15_000,
    'browser_get_html',
  );
}

function normalizeDomInfoInclude(params = {}) {
  const include = normalizeInclude(params, 'include', DOM_INFO_INCLUDE_OPTIONS);
  if (!include) {
    return ['attributes', 'rect', 'textContent', 'accessibility', 'visibility', 'event_listeners'];
  }
  const aliases = new Map([
    ['text', 'textContent'],
    ['html', 'innerHTML'],
    ['boundingBox', 'rect'],
  ]);
  return [...new Set(include.map((entry) => aliases.get(entry) || entry))];
}

async function domInfoHandler(params = {}, deps) {
  const selector = normalizeString(params.selector, 'selector', { required: true });
  const selectorAll = normalizeBoolean(params.selector_all, 'selector_all') ?? false;
  const limit = normalizeNumber(params.limit, 'limit', { minimum: 1, maximum: 200 }) ?? 20;
  const include = normalizeDomInfoInclude(params);
  const target = await maybeNavigate(deps, await resolveTargetContext(deps, params), params);
  const getDomInfo = ensureDependency(deps, 'getDomInfo');

  return await withTimeout(
    getDomInfo({
      tabId: target.tabId,
      selector,
      selectorAll,
      limit,
      include,
    }),
    15_000,
    'browser_get_dom_info',
  );
}

async function computedStylesHandler(params = {}, deps) {
  const selector = normalizeString(params.selector, 'selector', { required: true });
  const properties = normalizeStringArray(params.properties, 'properties');
  const pseudo = normalizeString(params.pseudo, 'pseudo');
  const includeMatchedRules = normalizeBoolean(params.include_matched_rules, 'include_matched_rules') ?? true;
  const includeInherited = normalizeBoolean(params.include_inherited, 'include_inherited') ?? false;
  const includeBoxModel = normalizeBoolean(params.include_box_model, 'include_box_model') ?? true;
  const target = await maybeNavigate(deps, await resolveTargetContext(deps, params), params);
  const getComputedStyles = ensureDependency(deps, 'getComputedStyles');

  return await withTimeout(
    getComputedStyles({
      tabId: target.tabId,
      selector,
      properties,
      pseudo,
      includeMatchedRules,
      includeInherited,
      includeBoxModel,
    }),
    15_000,
    'browser_get_computed_styles',
  );
}

async function listTabsHandler(_params = {}, deps) {
  const listTabs = ensureDependency(deps, 'listTabs');
  const tabs = await withTimeout(listTabs(), 5_000, 'browser_list_tabs');
  return tabs.map((tab) => ({
    tabId: tab.tabId ?? tab.id,
    url: tab.url,
    title: tab.title,
    active: !!tab.active,
    pinned: !!tab.pinned,
    is_agent_tab: !!(tab.is_agent_tab ?? tab.isAgentTab),
  }));
}

async function waitForHandler(params = {}, deps) {
  const selector = normalizeString(params.selector, 'selector');
  const text = normalizeString(params.text, 'text');
  const urlMatches = normalizeString(params.url_matches, 'url_matches');
  if (!selector && !text && !urlMatches) {
    throw createProtocolError('E_VALIDATION', 'selector, text, or url_matches is required');
  }

  const state = normalizeString(params.state, 'state') || 'visible';
  if (!WAIT_STATE_OPTIONS.includes(state)) {
    throw createProtocolError('E_VALIDATION', `state must be one of: ${WAIT_STATE_OPTIONS.join(', ')}`);
  }

  const timeoutMs = normalizeNumber(params.timeout_ms, 'timeout_ms', { minimum: 1 }) ?? 30_000;
  const waitUntil = normalizeWaitUntil(params.wait_until);
  const target = await maybeNavigate(deps, await resolveTargetContext(deps, params), { ...params, wait_until: waitUntil });
  const waitFor = ensureDependency(deps, 'waitFor');
  return await withTimeout(
    waitFor({
      tabId: target.tabId,
      selector,
      text,
      urlMatches,
      state,
      timeoutMs,
    }),
    timeoutMs + 500,
    'browser_wait_for',
  );
}

async function accessibilityTreeHandler(params = {}, deps) {
  const rootSelector = normalizeString(params.root_selector, 'root_selector');
  const interestingOnly = normalizeBoolean(params.interesting_only, 'interesting_only') ?? true;
  const maxDepth = normalizeNumber(params.max_depth, 'max_depth', { minimum: 1 }) ?? 40;
  const include = normalizeInclude(params, 'include', AX_INCLUDE_OPTIONS) ?? AX_INCLUDE_OPTIONS;
  const target = await maybeNavigate(deps, await resolveTargetContext(deps, params), params);
  const getAccessibilityTree = ensureDependency(deps, 'getAccessibilityTree');

  return await withTimeout(
    getAccessibilityTree({
      tabId: target.tabId,
      rootSelector,
      interestingOnly,
      maxDepth,
      include,
    }),
    20_000,
    'browser_get_accessibility_tree',
  );
}

async function performanceMetricsHandler(params = {}, deps) {
  const include = normalizeInclude(params, 'include', PERF_INCLUDE_OPTIONS) ?? PERF_INCLUDE_OPTIONS;
  const target = await maybeNavigate(deps, await resolveTargetContext(deps, params), params);
  const getPerformanceMetrics = ensureDependency(deps, 'getPerformanceMetrics');
  const result = await withTimeout(
    getPerformanceMetrics({
      tabId: target.tabId,
      include,
    }),
    include.includes('web_vitals') ? 25_000 : 15_000,
    'browser_get_performance_metrics',
  );

  return {
    ...pick(result || {}, include),
    requested_include: include,
    tabId: target.tabId,
  };
}

export function createReadOnlyHandlers(deps = {}) {
  return {
    browser_get_screenshot: (params) => screenshotHandler(params, deps),
    browser_get_html: (params) => htmlHandler(params, deps),
    browser_get_dom_info: (params) => domInfoHandler(params, deps),
    browser_get_computed_styles: (params) => computedStylesHandler(params, deps),
    browser_list_tabs: (params) => listTabsHandler(params, deps),
    browser_wait_for: (params) => waitForHandler(params, deps),
    browser_get_accessibility_tree: (params) => accessibilityTreeHandler(params, deps),
    browser_get_performance_metrics: (params) => performanceMetricsHandler(params, deps),
  };
}

export const READ_ONLY_HANDLER_NAMES = Object.freeze([
  'browser_get_screenshot',
  'browser_get_html',
  'browser_get_dom_info',
  'browser_get_computed_styles',
  'browser_list_tabs',
  'browser_wait_for',
  'browser_get_accessibility_tree',
  'browser_get_performance_metrics',
]);
