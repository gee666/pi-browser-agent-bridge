export const DEFAULT_PI_BRIDGE_CONFIG = Object.freeze({
  enabled: true,
  url: 'ws://127.0.0.1:7878',
});

export function normalizePiBridgeConfig(rawConfig = {}) {
  const config = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
  const enabled = typeof config.enabled === 'boolean'
    ? config.enabled
    : DEFAULT_PI_BRIDGE_CONFIG.enabled;

  const url = typeof config.url === 'string' && config.url.trim()
    ? config.url.trim()
    : DEFAULT_PI_BRIDGE_CONFIG.url;

  return { enabled, url };
}

export async function readPiBridgeConfig(storageArea) {
  const result = await new Promise((resolve, reject) => {
    storageArea.get(['piBridgeConfig'], (value) => {
      const runtimeError = typeof chrome !== 'undefined' && chrome?.runtime?.lastError
        ? chrome.runtime.lastError
        : null;
      if (runtimeError) {
        reject(runtimeError);
        return;
      }
      resolve(value);
    });
  });

  return normalizePiBridgeConfig(result?.piBridgeConfig);
}
