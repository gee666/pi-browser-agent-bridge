function createProtocolError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) {
    error.details = details;
  }
  return error;
}

function normalizeThrownError(error, fallbackMessage = 'Bridge request failed') {
  if (error && typeof error === 'object' && typeof error.code === 'string' && typeof error.message === 'string') {
    return error;
  }

  return createProtocolError(
    'E_INTERNAL',
    error instanceof Error ? error.message : fallbackMessage,
    error,
  );
}

export function createBridgeDispatcher({
  handlers = {},
  serialRequestTypes = [],
  tabIdResolver = null,
  logger = console,
} = {}) {
  const serialTypes = new Set(serialRequestTypes);
  const tabQueues = new Map();

  const runSerial = async (tabId, callback) => {
    const previous = tabQueues.get(tabId) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const next = previous.catch(() => {}).then(() => gate);
    tabQueues.set(tabId, next);

    try {
      await previous.catch(() => {});
      return await callback();
    } finally {
      release?.();
      if (tabQueues.get(tabId) === next) {
        tabQueues.delete(tabId);
      }
    }
  };

  return {
    async handle(frame) {
      const type = frame?.type;
      const handler = handlers[type];
      if (typeof handler !== 'function') {
        throw createProtocolError('E_UNKNOWN_TYPE', `Unknown request type: ${type}`);
      }

      const invoke = async () => {
        try {
          return await handler(frame?.params || {}, { frame });
        } catch (error) {
          logger.warn?.('[pi-bridge] request handler failed', { type, error });
          throw normalizeThrownError(error, `Bridge request ${type} failed`);
        }
      };

      if (!serialTypes.has(type)) {
        return await invoke();
      }

      const tabId = await Promise.resolve(typeof tabIdResolver === 'function' ? tabIdResolver(frame) : frame?.params?.tab_id);
      if (typeof tabId !== 'number') {
        return await invoke();
      }

      return await runSerial(tabId, invoke);
    },
  };
}
