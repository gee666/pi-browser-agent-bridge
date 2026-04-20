import { readPiBridgeConfig } from './config.js';
import { startBridge } from './start-bridge.js';

export function createBridgeController({
  storageArea,
  logger = console,
  readConfig = readPiBridgeConfig,
  startBridgeImpl = startBridge,
} = {}) {
  let currentBridge = null;
  let latestRun = Promise.resolve();
  let generation = 0;

  const startWithConfig = async (config, myGeneration) => {
    if (currentBridge) {
      try {
        await currentBridge.stop?.();
      } catch (error) {
        logger.warn?.('[pi-bridge] failed to stop previous bridge', error);
      }
      currentBridge = null;
    }

    let nextBridge = null;
    try {
      nextBridge = await startBridgeImpl({
        enabled: config.enabled,
        url: config.url,
        autoConnect: true,
        logger,
      });
    } catch (error) {
      logger.error?.('[pi-bridge] failed to apply bridge config', error);
      return null;
    }

    if (myGeneration !== generation) {
      try {
        await nextBridge?.stop?.();
      } catch (error) {
        logger.warn?.('[pi-bridge] failed to stop stale bridge instance', error);
      }
      return null;
    }

    currentBridge = nextBridge;
    return currentBridge;
  };

  const queueApply = (loadConfig) => {
    const myGeneration = ++generation;
    latestRun = latestRun.then(async () => {
      let config;
      try {
        config = await loadConfig();
      } catch (error) {
        logger.error?.('[pi-bridge] failed to read bridge config', error);
        return null;
      }
      if (myGeneration !== generation) {
        return null;
      }
      return startWithConfig(config, myGeneration);
    });
    return latestRun;
  };

  return {
    async refreshFromStorage() {
      return queueApply(() => readConfig(storageArea));
    },
    async applyConfig(config) {
      return queueApply(() => config);
    },
    async stop() {
      generation += 1;
      await latestRun;
      if (!currentBridge) return;
      try {
        await currentBridge.stop?.();
      } catch (error) {
        logger.warn?.('[pi-bridge] failed to stop bridge', error);
      } finally {
        currentBridge = null;
      }
    },
    getCurrentBridge() {
      return currentBridge;
    },
  };
}
