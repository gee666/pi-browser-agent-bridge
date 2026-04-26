// Default URL list scans ports 7878..7887 on localhost so the extension can
// discover and bridge multiple concurrent pi-browser-agent broker instances
// without each instance fighting for a single fixed port. The broker walks
// the same range on bind, so any pi process started while another is running
// will land on a port within this list.
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT_BASE = 7878;
const DEFAULT_PORT_COUNT = 10;

function buildDefaultUrls() {
  const urls = [];
  for (let i = 0; i < DEFAULT_PORT_COUNT; i += 1) {
    urls.push(`ws://${DEFAULT_HOST}:${DEFAULT_PORT_BASE + i}`);
  }
  return urls;
}

const DEFAULT_URLS = Object.freeze(buildDefaultUrls());

// The single URL that older versions of this extension stored as `url`. We
// auto-migrate this exact value to the full default range so that users who
// upgrade do not have to re-open the options page just to gain multi-instance
// support — the whole point of the new behaviour.
const LEGACY_DEFAULT_SINGLE_URL = `ws://${DEFAULT_HOST}:${DEFAULT_PORT_BASE}`;

export const DEFAULT_PI_BRIDGE_CONFIG = Object.freeze({
  enabled: true,
  url: DEFAULT_URLS[0],
  urls: DEFAULT_URLS,
});

function dedupePreservingOrder(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function parseUrlsField(value) {
  if (Array.isArray(value)) {
    return dedupePreservingOrder(value);
  }
  if (typeof value === 'string') {
    // Allow newline-, comma-, or whitespace-separated lists when callers pass a
    // single string (e.g. from a textarea in the options page).
    return dedupePreservingOrder(value.split(/[\s,]+/));
  }
  return [];
}

export function normalizePiBridgeConfig(rawConfig = {}) {
  const config = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
  const enabled = typeof config.enabled === 'boolean'
    ? config.enabled
    : DEFAULT_PI_BRIDGE_CONFIG.enabled;

  // Prefer the multi-URL field; fall back to the legacy single `url` field
  // for backward compatibility with existing stored configs.
  let urls = parseUrlsField(config.urls);

  // Migration: users who opened/saved the options page before this fix may
  // have `urls: ["ws://127.0.0.1:7878"]` stored, not just legacy
  // `url: "ws://127.0.0.1:7878"`. Treat either representation of the OLD
  // default single URL as an upgrade candidate and expand it to the whole
  // default range. Custom single URLs remain custom and are not expanded.
  if (urls.length === 1 && urls[0] === LEGACY_DEFAULT_SINGLE_URL) {
    urls = [...DEFAULT_PI_BRIDGE_CONFIG.urls];
  }

  if (urls.length === 0) {
    const legacy = typeof config.url === 'string' ? config.url.trim() : '';
    if (legacy) {
      if (legacy === LEGACY_DEFAULT_SINGLE_URL) {
        urls = [...DEFAULT_PI_BRIDGE_CONFIG.urls];
      } else {
        urls = [legacy];
      }
    }
  }
  if (urls.length === 0) {
    urls = [...DEFAULT_PI_BRIDGE_CONFIG.urls];
  }

  return {
    enabled,
    url: urls[0],
    urls,
  };
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
