import { DEFAULT_PI_BRIDGE_CONFIG, normalizePiBridgeConfig } from './config.js';
import { createBridgeClient } from './ws-client.js';

export async function startBridge({
  enabled = DEFAULT_PI_BRIDGE_CONFIG.enabled,
  url = DEFAULT_PI_BRIDGE_CONFIG.url,
  autoConnect = true,
  logger = console,
  createClient = createBridgeClient,
  helloPayload,
  handleRequest,
} = {}) {
  const config = normalizePiBridgeConfig({ enabled, url });

  if (!config.enabled) {
    logger.info?.('[pi-bridge] disabled');
    return createDisabledBridge(config);
  }

  try {
    const client = createClient({ url: config.url, logger, helloPayload, handleRequest });

    if (autoConnect) {
      try {
        await client.start();
      } catch (error) {
        logger.error?.('[pi-bridge] failed to start bridge client', error);
      }
    }

    return {
      config,
      client,
      async stop() {
        try {
          await client.stop?.();
        } catch (error) {
          logger.warn?.('[pi-bridge] failed to stop bridge client', error);
        }
      },
    };
  } catch (error) {
    logger.error?.('[pi-bridge] bridge startup failed', error);
    return createDisabledBridge(config, error);
  }
}

function createDisabledBridge(config, error = null) {
  return {
    config,
    error,
    client: null,
    async stop() {},
  };
}
