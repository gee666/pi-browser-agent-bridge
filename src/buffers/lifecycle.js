import { ConsoleBufferManager } from './console-buffer.js';
import { NetworkBufferManager } from './network-buffer.js';

async function safeTabsQuery(tabsApi, queryInfo = {}) {
  if (!tabsApi || typeof tabsApi.query !== 'function') {
    return [];
  }
  try {
    return await tabsApi.query(queryInfo);
  } catch {
    return [];
  }
}

export function createObservabilityLifecycle({
  inspector,
  storageArea = null,
  tabsApi = typeof chrome !== 'undefined' ? chrome.tabs : null,
  logger = console,
  consoleBuffer = new ConsoleBufferManager({ inspector, storageArea, logger }),
  networkBuffer = new NetworkBufferManager({ inspector, storageArea, logger }),
} = {}) {
  let started = false;

  return {
    consoleBuffer,
    networkBuffer,
    async armTab(tabId) {
      await Promise.allSettled([
        consoleBuffer.armTab(tabId),
        networkBuffer.armTab(tabId),
      ]);
      return { tabId, armed: true };
    },
    async armExistingTabs() {
      const tabs = await safeTabsQuery(tabsApi, {});
      await Promise.allSettled(
        tabs
          .map((tab) => tab?.id)
          .filter((tabId) => typeof tabId === 'number')
          .map((tabId) => this.armTab(tabId)),
      );
      started = true;
      return tabs.length;
    },
    async handleSuspend() {
      await Promise.allSettled([
        consoleBuffer.flushAll(),
        networkBuffer.flushAll({ finalizeInFlight: true, reason: 'suspend' }),
      ]);
    },
    async handleTabRemoved(tabId, reason = 'tab_removed') {
      consoleBuffer.disconnectTab(tabId, reason);
      networkBuffer.disconnectTab(tabId, reason);
      // Persist a final snapshot (interrupted in-flight requests get finalized via disconnectTab above),
      // then evict both the in-memory state and the persisted storage key so closed tabs do not leak.
      await Promise.allSettled([
        consoleBuffer.removeTab(tabId, { persist: true }),
        networkBuffer.removeTab(tabId, { persist: true }),
      ]);
    },
    handleDisconnect(tabId, reason = 'debugger_disconnected') {
      consoleBuffer.disconnectTab(tabId, reason);
      networkBuffer.disconnectTab(tabId, reason);
    },
    async stop() {
      await Promise.allSettled([
        consoleBuffer.dispose(),
        networkBuffer.dispose(),
      ]);
      started = false;
    },
    get started() {
      return started;
    },
  };
}
