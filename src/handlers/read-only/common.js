function createProtocolError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) {
    error.details = details;
  }
  return error;
}

function normalizeString(value, name, { required = false } = {}) {
  if (value == null || value === '') {
    if (required) {
      throw createProtocolError('E_VALIDATION', `${name} is required`);
    }
    return undefined;
  }
  if (typeof value !== 'string') {
    throw createProtocolError('E_VALIDATION', `${name} must be a string`);
  }
  return value;
}

function normalizeNumber(value, name, { required = false, minimum, maximum } = {}) {
  if (value == null) {
    if (required) {
      throw createProtocolError('E_VALIDATION', `${name} is required`);
    }
    return undefined;
  }
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw createProtocolError('E_VALIDATION', `${name} must be a number`);
  }
  if (minimum != null && value < minimum) {
    throw createProtocolError('E_VALIDATION', `${name} must be >= ${minimum}`);
  }
  if (maximum != null && value > maximum) {
    throw createProtocolError('E_VALIDATION', `${name} must be <= ${maximum}`);
  }
  return value;
}

function normalizeBoolean(value, name) {
  if (value == null) return undefined;
  if (typeof value !== 'boolean') {
    throw createProtocolError('E_VALIDATION', `${name} must be a boolean`);
  }
  return value;
}

function normalizeStringArray(value, name, { allowed } = {}) {
  if (value == null) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry)) {
    throw createProtocolError('E_VALIDATION', `${name} must be an array of strings`);
  }
  if (allowed) {
    for (const entry of value) {
      if (!allowed.includes(entry)) {
        throw createProtocolError('E_VALIDATION', `${name} includes unsupported value: ${entry}`);
      }
    }
  }
  return value;
}

async function withTimeout(promise, timeoutMs, label) {
  if (!timeoutMs || timeoutMs <= 0) {
    return await promise;
  }

  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(createProtocolError('E_TIMEOUT', `${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function resolveTargetContext(deps, params = {}) {
  if (typeof deps.resolveTarget !== 'function') {
    throw createProtocolError('E_INTERNAL', 'resolveTarget dependency is required');
  }

  return await deps.resolveTarget({
    tabId: typeof params.tab_id === 'number' ? params.tab_id : params.tabId,
    useActiveTab: params.use_active_tab === true || params.useActiveTab === true,
  });
}

async function maybeNavigate(deps, target, params = {}) {
  const url = typeof params.url === 'string' ? params.url : undefined;
  if (!url) {
    return target;
  }

  if (typeof deps.navigate !== 'function') {
    throw createProtocolError('E_INTERNAL', 'navigate dependency is required when url is provided');
  }

  await deps.navigate({
    tabId: target.tabId,
    url,
    waitUntil: typeof params.wait_until === 'string' ? params.wait_until : params.waitUntil,
  });

  return {
    ...target,
    url,
  };
}

function pick(object, keys) {
  const result = {};
  for (const key of keys) {
    if (object[key] !== undefined) {
      result[key] = object[key];
    }
  }
  return result;
}

function normalizeInclude(params, key, allowedValues) {
  return normalizeStringArray(params[key], key, { allowed: allowedValues });
}

export {
  createProtocolError,
  normalizeString,
  normalizeNumber,
  normalizeBoolean,
  normalizeStringArray,
  normalizeInclude,
  resolveTargetContext,
  maybeNavigate,
  pick,
  withTimeout,
};
