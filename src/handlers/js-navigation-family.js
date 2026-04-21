const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000;
const DEFAULT_EVALUATE_TIMEOUT_MS = 15_000;
const DEFAULT_RUN_JS_TIMEOUT_MS = 30_000;
const DEFAULT_SETTLE_QUIET_MS = 500;

function createProtocolError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) {
    error.details = details;
  }
  return error;
}

function normalizeError(error, fallbackCode = 'E_INTERNAL', fallbackMessage = 'Browser bridge request failed') {
  if (error && typeof error === 'object' && typeof error.code === 'string' && typeof error.message === 'string') {
    return {
      code: error.code,
      message: error.message,
      details: error.details,
    };
  }

  return {
    code: fallbackCode,
    message: error instanceof Error ? error.message : fallbackMessage,
    details: error,
  };
}

function withTimeoutLabel(operation, tabId) {
  return `Timed out while ${operation} on tab ${tabId}`;
}

async function withTimeout(promiseFactory, { timeoutMs, onTimeout, timeoutMessage, timeoutCode = 'E_TIMEOUT' }) {
  let timer = null;
  let finished = false;

  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      if (finished) {
        return;
      }
      finished = true;
      reject(createProtocolError(timeoutCode, timeoutMessage, { timeoutMs }));
      void Promise.resolve()
        .then(() => onTimeout?.())
        .catch(() => {
          // Swallow cleanup failures; surface the original timeout instead.
        });
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([promiseFactory(), timeoutPromise]);
    finished = true;
    return result;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function ensureUrl(value, fieldName = 'url') {
  if (typeof value !== 'string' || !value.trim()) {
    throw createProtocolError('E_VALIDATION', `${fieldName} is required`);
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw createProtocolError('E_VALIDATION', `${fieldName} must be a valid URL`, { value });
  }

  return parsed.toString();
}

function toStorageTypeString(types) {
  const requested = Array.isArray(types) && types.length > 0
    ? types
    : ['cookies', 'local_storage', 'indexed_db', 'service_workers', 'cache'];

  const parts = new Set();
  for (const type of requested) {
    switch (type) {
      case 'cookies':
        parts.add('cookies');
        break;
      case 'local_storage':
        parts.add('local_storage');
        break;
      case 'indexed_db':
        parts.add('indexeddb');
        break;
      case 'service_workers':
        parts.add('service_workers');
        break;
      case 'cache':
        parts.add('cache_storage');
        break;
      default:
        throw createProtocolError('E_VALIDATION', `Unsupported site-data type: ${type}`, { type });
    }
  }

  return [...parts].join(',');
}

async function getActiveTab(tabsApi) {
  const tabs = await tabsApi.query({ active: true, currentWindow: true });
  return tabs?.[0] || null;
}

async function resolveTargetTab(params, deps) {
  const { tabsApi, resolveDefaultTabId } = deps;
  let tab = null;

  if (typeof params?.tab_id === 'number') {
    tab = await tabsApi.get(params.tab_id).catch(() => null);
    if (!tab) {
      throw createProtocolError('E_NO_ACTIVE_TAB', `Tab ${params.tab_id} was not found`, { tabId: params.tab_id });
    }
  } else if (params?.use_active_tab) {
    tab = await getActiveTab(tabsApi);
    if (!tab || typeof tab.id !== 'number') {
      throw createProtocolError('E_NO_ACTIVE_TAB', 'No active tab is available');
    }
  } else if (typeof resolveDefaultTabId === 'function') {
    const tabId = await resolveDefaultTabId(params);
    if (typeof tabId === 'number') {
      tab = await tabsApi.get(tabId).catch(() => null);
    }
  }

  if (!tab || typeof tab.id !== 'number') {
    throw createProtocolError('E_NO_ACTIVE_TAB', 'tab_id is required when no default tab resolver is configured');
  }

  if (typeof deps.armObservability === 'function') {
    await Promise.resolve(deps.armObservability(tab.id)).catch(() => {});
  }

  return tab;
}

async function waitForTabSettled(tabId, deps, waitUntil = 'load', timeoutMs = DEFAULT_NAVIGATION_TIMEOUT_MS, options = {}) {
  if (waitUntil === 'none') {
    return await deps.tabsApi.get(tabId);
  }

  if (typeof deps.waitForTabSettled === 'function') {
    return await deps.waitForTabSettled(tabId, { waitUntil, timeoutMs, ...options });
  }

  // networkidle cannot be implemented meaningfully without a CDP-backed custom
  // waiter (tabs.onUpdated carries no network-activity signal). Refuse it here
  // rather than silently degrade to `load` semantics.
  if (waitUntil === 'networkidle') {
    throw createProtocolError(
      'E_VALIDATION',
      'wait_until="networkidle" requires a custom waiter; none is configured for the default fallback',
      { waitUntil },
    );
  }

  const { tabsApi } = deps;
  const quietMs = Number.isFinite(options.settleQuietMs) && options.settleQuietMs >= 0
    ? Number(options.settleQuietMs)
    : DEFAULT_SETTLE_QUIET_MS;
  const wantsSettle = waitUntil === 'settle';

  let cleanup = () => {};

  return await withTimeout(
    () => new Promise((resolve, reject) => {
      let settledTab = null;
      let quietTimer = null;

      const clearQuietTimer = () => {
        if (quietTimer) {
          clearTimeout(quietTimer);
          quietTimer = null;
        }
      };

      const finish = (tab) => {
        cleanup();
        resolve(tab);
      };

      const armQuietTimer = (tab) => {
        clearQuietTimer();
        settledTab = tab;
        quietTimer = setTimeout(() => finish(settledTab), quietMs);
        quietTimer?.unref?.();
      };

      const onUpdated = (updatedTabId, changeInfo, tab) => {
        if (updatedTabId !== tabId) {
          return;
        }
        if (wantsSettle) {
          // Any update resets the quiet window.
          clearQuietTimer();
          if (changeInfo?.status === 'complete') {
            armQuietTimer(tab);
          } else if (settledTab) {
            // previously complete but received a new update -> wait again
            settledTab = null;
          }
          return;
        }
        if (changeInfo?.status === 'complete') {
          finish(tab);
        }
      };

      const onRemoved = (removedTabId) => {
        if (removedTabId !== tabId) {
          return;
        }
        cleanup();
        reject(createProtocolError('E_NO_ACTIVE_TAB', `Tab ${tabId} was closed while waiting for navigation`));
      };

      cleanup = () => {
        clearQuietTimer();
        tabsApi.onUpdated?.removeListener?.(onUpdated);
        tabsApi.onRemoved?.removeListener?.(onRemoved);
      };

      tabsApi.onUpdated?.addListener?.(onUpdated);
      tabsApi.onRemoved?.addListener?.(onRemoved);

      // Kick things off: check the current tab state.
      Promise.resolve(tabsApi.get(tabId))
        .then((immediate) => {
          if (!immediate) return;
          if (!options.skipImmediateComplete && immediate.status === 'complete') {
            if (wantsSettle) {
              armQuietTimer(immediate);
            } else {
              finish(immediate);
            }
          }
        })
        .catch(() => {});
    }),
    {
      timeoutMs,
      timeoutCode: 'E_NAV_TIMEOUT',
      timeoutMessage: withTimeoutLabel('waiting for navigation', tabId),
      onTimeout: async () => {
        cleanup();
      },
    },
  );
}

async function waitForNavigationAfterAction(tabId, deps, action, waitUntil = 'load', timeoutMs = DEFAULT_NAVIGATION_TIMEOUT_MS) {
  if (waitUntil === 'none') {
    await action();
    return await deps.tabsApi.get(tabId);
  }

  if (typeof deps.waitForNavigationAfterAction === 'function') {
    return await deps.waitForNavigationAfterAction(tabId, action, { waitUntil, timeoutMs });
  }

  if (waitUntil === 'networkidle' && typeof deps.waitForTabSettled !== 'function') {
    throw createProtocolError(
      'E_VALIDATION',
      'wait_until="networkidle" requires a custom waiter; none is configured for the default fallback',
      { waitUntil },
    );
  }

  const { tabsApi } = deps;
  let cleanup = () => {};

  return await withTimeout(
    () => new Promise((resolve, reject) => {
      const onUpdated = (updatedTabId, changeInfo, tab) => {
        if (updatedTabId !== tabId || changeInfo?.status !== 'complete') {
          return;
        }
        cleanup();
        resolve(tab);
      };

      const onRemoved = (removedTabId) => {
        if (removedTabId !== tabId) {
          return;
        }
        cleanup();
        reject(createProtocolError('E_NO_ACTIVE_TAB', `Tab ${tabId} was closed while waiting for navigation`));
      };

      cleanup = () => {
        tabsApi.onUpdated?.removeListener?.(onUpdated);
        tabsApi.onRemoved?.removeListener?.(onRemoved);
      };

      tabsApi.onUpdated?.addListener?.(onUpdated);
      tabsApi.onRemoved?.addListener?.(onRemoved);
      Promise.resolve()
        .then(action)
        .catch((error) => {
          cleanup();
          reject(error);
        });
    }),
    {
      timeoutMs,
      timeoutCode: 'E_NAV_TIMEOUT',
      timeoutMessage: withTimeoutLabel('waiting for navigation', tabId),
      onTimeout: async () => {
        cleanup();
      },
    },
  ).then(async (tab) => {
    if (waitUntil === 'settle' || waitUntil === 'networkidle') {
      return await waitForTabSettled(tabId, deps, waitUntil, timeoutMs, { skipImmediateComplete: false });
    }
    return tab;
  });
}

async function withInspectorLease(inspector, tabId, callback) {
  if (!inspector || typeof inspector.acquire !== 'function' || typeof inspector.release !== 'function') {
    throw createProtocolError('E_INTERNAL', 'A CDP inspector is required for this operation');
  }

  const lease = await inspector.acquire(tabId).catch((error) => {
    throw createProtocolError('E_CDP_ATTACH', `Failed to attach debugger to tab ${tabId}`, normalizeError(error));
  });

  try {
    return await callback(lease);
  } finally {
    try {
      await inspector.release(lease);
    } catch {
      // Never let cleanup crash the parent runtime.
    }
  }
}

async function cleanupJsEvaluation(inspector, tabId, objectGroup) {
  try {
    await inspector.sendCommand(tabId, 'Runtime.releaseObjectGroup', { objectGroup }, { requireLease: false });
  } catch {
    // Best-effort cleanup only.
  }
}

function buildRuntimeExpression({ expression, code, args = [], captureConsole = false }) {
  if (typeof expression === 'string') {
    return expression;
  }

  const serializedArgs = JSON.stringify(Array.isArray(args) ? args : []);
  const consolePrelude = captureConsole
    ? `
      const __piConsole = [];
      const __piOriginalConsole = {};
      for (const level of ['log','info','warn','error','debug']) {
        __piOriginalConsole[level] = console[level];
        console[level] = (...entries) => {
          __piConsole.push({ level, entries });
          return __piOriginalConsole[level].apply(console, entries);
        };
      }
    `
    : 'const __piConsole = [];';

  const consoleRestore = captureConsole
    ? `
      for (const level of ['log','info','warn','error','debug']) {
        console[level] = __piOriginalConsole[level];
      }
    `
    : '';

  return `
    (async () => {
      ${consolePrelude}
      try {
        const __piRunner = async (...args) => {
          ${code || ''}
        };
        const __piValue = await __piRunner(...${serializedArgs});
        return { __piValue, __piConsole };
      } finally {
        ${consoleRestore}
      }
    })()
  `;
}

function normalizeRuntimeValue(result) {
  if (result && typeof result === 'object' && 'unserializableValue' in result && typeof result.unserializableValue === 'string') {
    switch (result.unserializableValue) {
      case 'NaN':
        return Number.NaN;
      case 'Infinity':
        return Number.POSITIVE_INFINITY;
      case '-Infinity':
        return Number.NEGATIVE_INFINITY;
      case '-0':
        return -0;
      default:
        return result.unserializableValue;
    }
  }

  return result?.value;
}

function normalizeRuntimeResult(result, { returnByValue = true, captureConsole = false, startedAt }) {
  const response = {
    type: result?.result?.type,
    subtype: result?.result?.subtype,
    value: undefined,
    preview: undefined,
    exception: undefined,
    console_entries: undefined,
    duration_ms: Date.now() - startedAt,
  };

  if (result?.exceptionDetails) {
    response.exception = {
      text: result.exceptionDetails.text,
      lineNumber: result.exceptionDetails.lineNumber,
      columnNumber: result.exceptionDetails.columnNumber,
      exception: result.exceptionDetails.exception,
    };
    return response;
  }

  const runtimeValue = normalizeRuntimeValue(result?.result);
  if (captureConsole && runtimeValue && typeof runtimeValue === 'object' && '__piValue' in runtimeValue) {
    response.value = runtimeValue.__piValue;
    response.console_entries = Array.isArray(runtimeValue.__piConsole) ? runtimeValue.__piConsole : [];
    return response;
  }

  if (returnByValue) {
    response.value = runtimeValue;
  } else {
    response.preview = result?.result?.preview || {
      description: result?.result?.description,
      className: result?.result?.className,
      objectId: result?.result?.objectId,
    };
  }

  return response;
}

async function evaluateRuntime(params, deps, options) {
  const tab = await resolveTargetTab(params, deps);
  const tabId = tab.id;
  const inspector = deps.inspector;
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const objectGroup = `pi-browser-agent-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const startedAt = Date.now();

  return await withInspectorLease(inspector, tabId, async () => {
    try {
      await inspector.sendCommand(tabId, 'Runtime.enable', {}, { requireLease: true });
    } catch {
      // Runtime.enable is best-effort for tests/mocks.
    }

    const evaluateParams = {
      expression: options.expression,
      awaitPromise: options.awaitPromise,
      returnByValue: options.returnByValue,
      includeCommandLineAPI: true,
      userGesture: false,
      objectGroup,
    };

    const result = await withTimeout(
      () => inspector.sendCommand(tabId, 'Runtime.evaluate', evaluateParams, { requireLease: true }),
      {
        timeoutMs,
        timeoutMessage: withTimeoutLabel('evaluating JavaScript', tabId),
        onTimeout: async () => {
          await cleanupJsEvaluation(inspector, tabId, objectGroup);
        },
      },
    );

    const normalized = normalizeRuntimeResult(result, {
      returnByValue: options.returnByValue,
      captureConsole: options.captureConsole,
      startedAt,
    });

    if (normalized.exception) {
      throw createProtocolError('E_INTERNAL', normalized.exception.text || 'JavaScript execution failed', normalized);
    }

    return {
      tabId,
      url: tab.url,
      title: tab.title,
      ...normalized,
    };
  });
}

export function createJsNavigationDestructiveHandlers(deps = {}) {
  const handlers = {
    async browser_evaluate_js(params = {}) {
      if (typeof params.expression !== 'string' || !params.expression.trim()) {
        throw createProtocolError('E_VALIDATION', 'expression is required');
      }
      if (params.world && params.world !== 'main') {
        throw createProtocolError('E_VALIDATION', 'Only world="main" is currently supported');
      }

      return await evaluateRuntime(params, deps, {
        expression: params.expression,
        awaitPromise: params.await_promise !== false,
        returnByValue: params.return_by_value !== false,
        timeoutMs: params.timeout_ms ?? DEFAULT_EVALUATE_TIMEOUT_MS,
        world: params.world || 'main',
        captureConsole: false,
      });
    },

    async browser_run_js(params = {}) {
      if (typeof params.code !== 'string' || !params.code.trim()) {
        throw createProtocolError('E_VALIDATION', 'code is required');
      }
      if (params.world && params.world !== 'main') {
        throw createProtocolError('E_VALIDATION', 'Only world="main" is currently supported');
      }
      if (params.capture_console !== false && params.return_by_value === false) {
        throw createProtocolError('E_VALIDATION', 'capture_console requires return_by_value=true');
      }

      return await evaluateRuntime(params, deps, {
        expression: buildRuntimeExpression({
          code: params.code,
          args: params.args,
          captureConsole: params.capture_console !== false,
        }),
        awaitPromise: true,
        returnByValue: params.return_by_value !== false,
        timeoutMs: params.timeout_ms ?? DEFAULT_RUN_JS_TIMEOUT_MS,
        world: params.world || 'main',
        captureConsole: params.capture_console !== false,
      });
    },

    async browser_navigate(params = {}) {
      const url = ensureUrl(params.url);
      const tab = await resolveTargetTab(params, deps);
      const updated = await deps.tabsApi.get(tab.id).catch(() => null);
      const settled = await waitForNavigationAfterAction(
        tab.id,
        deps,
        async () => {
          await deps.tabsApi.update(tab.id, { url }).catch((error) => {
            throw createProtocolError('E_INTERNAL', `Failed to navigate tab ${tab.id}`, normalizeError(error));
          });
        },
        params.wait_until || 'load',
        params.timeout_ms ?? DEFAULT_NAVIGATION_TIMEOUT_MS,
      );
      return {
        tabId: tab.id,
        requestedUrl: url,
        url: settled?.url || updated?.url || url,
        title: settled?.title || updated?.title,
        status: settled?.status || updated?.status,
      };
    },

    async browser_switch_tab(params = {}) {
      if (typeof params.tab_id !== 'number') {
        throw createProtocolError('E_VALIDATION', 'tab_id is required');
      }

      const tab = await deps.tabsApi.update(params.tab_id, { active: true }).catch((error) => {
        throw createProtocolError('E_NO_ACTIVE_TAB', `Failed to activate tab ${params.tab_id}`, normalizeError(error));
      });

      if (tab?.windowId && deps.windowsApi?.update) {
        try {
          await deps.windowsApi.update(tab.windowId, { focused: true });
        } catch {
          // Focus is best-effort only.
        }
      }

      const settled = await waitForTabSettled(params.tab_id, deps, params.wait_until || 'load', params.timeout_ms ?? DEFAULT_NAVIGATION_TIMEOUT_MS);

      return {
        tabId: params.tab_id,
        url: settled?.url || tab?.url,
        title: settled?.title || tab?.title,
        active: true,
      };
    },

    async browser_close_tab(params = {}) {
      if (typeof params.tab_id !== 'number') {
        throw createProtocolError('E_VALIDATION', 'tab_id is required');
      }

      await deps.tabsApi.remove(params.tab_id).catch((error) => {
        throw createProtocolError('E_NO_ACTIVE_TAB', `Failed to close tab ${params.tab_id}`, normalizeError(error));
      });

      return {
        tabId: params.tab_id,
        closed: true,
      };
    },

    async browser_reload(params = {}) {
      const tab = await resolveTargetTab(params, deps);

      const settled = await waitForNavigationAfterAction(
        tab.id,
        deps,
        async () => {
          if (typeof deps.tabsApi.reload === 'function') {
            await deps.tabsApi.reload(tab.id, { bypassCache: !!params.bypass_cache }).catch((error) => {
              throw createProtocolError('E_INTERNAL', `Failed to reload tab ${tab.id}`, normalizeError(error));
            });
            return;
          }

          if (deps.inspector?.send) {
            await deps.inspector.send(tab.id, 'Page.reload', { ignoreCache: !!params.bypass_cache }).catch((error) => {
              throw createProtocolError('E_INTERNAL', `Failed to reload tab ${tab.id}`, normalizeError(error));
            });
            return;
          }

          throw createProtocolError('E_INTERNAL', `Failed to reload tab ${tab.id}`, { reason: 'No reload implementation available' });
        },
        params.wait_until || 'load',
        params.timeout_ms ?? DEFAULT_NAVIGATION_TIMEOUT_MS,
      );
      return {
        tabId: tab.id,
        url: settled?.url || tab.url,
        title: settled?.title || tab.title,
        status: settled?.status || 'complete',
        bypassCache: !!params.bypass_cache,
      };
    },

    async browser_clear_site_data(params = {}) {
      const tab = await resolveTargetTab(params, deps).catch(() => null);
      if (Array.isArray(params.types) && params.types.length === 0) {
        throw createProtocolError('E_VALIDATION', 'types must not be an empty array');
      }

      const origin = params.origin
        ? ensureUrl(params.origin, 'origin')
        : params.url
          ? ensureUrl(params.url, 'url')
          : tab?.url
            ? ensureUrl(tab.url, 'tab.url')
            : null;

      if (!origin) {
        throw createProtocolError('E_VALIDATION', 'origin or url is required');
      }

      const targetOrigin = new URL(origin).origin;
      const storageTypes = toStorageTypeString(params.types);

      if (deps.inspector?.send && typeof (tab?.id ?? params.tab_id) === 'number') {
        const tabId = tab?.id ?? params.tab_id;

        await deps.inspector.send(tabId, 'Storage.clearDataForOrigin', {
          origin: targetOrigin,
          storageTypes,
        }).catch((error) => {
          throw createProtocolError('E_INTERNAL', `Failed to clear site data for ${targetOrigin}`, normalizeError(error));
        });
      } else if (deps.browsingDataApi?.remove) {
        const removalOptions = { origins: [targetOrigin] };
        const dataToRemove = {
          cookies: storageTypes.includes('cookies'),
          localStorage: storageTypes.includes('local_storage'),
          indexedDB: storageTypes.includes('indexeddb'),
          serviceWorkers: storageTypes.includes('service_workers'),
          cacheStorage: storageTypes.includes('cache_storage'),
        };

        await deps.browsingDataApi.remove(removalOptions, dataToRemove).catch((error) => {
          throw createProtocolError('E_INTERNAL', `Failed to clear site data for ${targetOrigin}`, normalizeError(error));
        });
      } else {
        throw createProtocolError('E_INTERNAL', 'No site-data clearing implementation is available');
      }

      return {
        tabId: tab?.id,
        origin: targetOrigin,
        cleared: true,
        storageTypes: storageTypes.split(','),
      };
    },
  };

  return handlers;
}

export function createJsNavigationDestructiveRequestHandler(deps = {}) {
  const handlers = createJsNavigationDestructiveHandlers(deps);
  return async function handleRequest(frame) {
    const handler = handlers[frame?.type];
    if (!handler) {
      throw createProtocolError('E_UNKNOWN_TYPE', `Unknown request type: ${frame?.type}`);
    }

    try {
      return await handler(frame?.params || {}, { frame });
    } catch (error) {
      throw normalizeError(error);
    }
  };
}

export const JS_NAVIGATION_DESTRUCTIVE_HANDLER_NAMES = Object.freeze([
  'browser_evaluate_js',
  'browser_run_js',
  'browser_navigate',
  'browser_switch_tab',
  'browser_close_tab',
  'browser_reload',
  'browser_clear_site_data',
]);
