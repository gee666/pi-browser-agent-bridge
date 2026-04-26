import { DEFAULT_PI_BRIDGE_CONFIG, normalizePiBridgeConfig } from './config.js';
import { createBridgeClient } from './ws-client.js';

/**
 * Start a bridge that maintains an independent WebSocket client for every
 * configured broker URL. Each pi-browser-agent process runs its own broker on
 * its own port (typically discovered via the default port range), so this
 * extension fans out N parallel client connections — one per pi instance.
 *
 * The returned object exposes:
 *   - `config`         : normalized config (always includes `urls`)
 *   - `clients`        : array of per-URL client handles
 *   - `client`         : alias for `clients[0]` (legacy single-bridge callers)
 *   - `isConnected()`  : true if at least one client is connected
 *   - `connectedCount`/`totalCount` (getters)
 *   - `send(payload)`  : broadcast a frame to every connected client; returns
 *                        the number of clients that accepted the send
 *   - `stop()`         : stop every client
 */
export async function startBridge({
  enabled = DEFAULT_PI_BRIDGE_CONFIG.enabled,
  url,
  urls,
  autoConnect = true,
  logger = console,
  createClient = createBridgeClient,
  helloPayload,
  handleRequest,
} = {}) {
  const config = normalizePiBridgeConfig({ enabled, url, urls });

  if (!config.enabled) {
    logger.info?.('[pi-bridge] disabled');
    return createDisabledBridge(config);
  }

  const clients = [];
  for (const targetUrl of config.urls) {
    try {
      const client = createClient({ url: targetUrl, logger, helloPayload, handleRequest });
      clients.push(client);
    } catch (error) {
      logger.error?.('[pi-bridge] failed to create websocket client', { url: targetUrl, error });
    }
  }

  if (clients.length === 0) {
    logger.error?.('[pi-bridge] no clients could be created; disabling bridge');
    return createDisabledBridge(config, new Error('No bridge clients could be created'));
  }

  if (autoConnect) {
    // Start every client in parallel; a failure on any one URL must not
    // prevent the others from connecting. Each client schedules its own
    // reconnect timer internally.
    await Promise.all(clients.map(async (client) => {
      try {
        await client.start();
      } catch (error) {
        logger.error?.('[pi-bridge] failed to start bridge client', { url: client.url, error });
      }
    }));
  }

  return {
    config,
    clients,
    // Backward-compat: older callers expect a single `client`.
    client: clients[0],
    get connectedCount() {
      return clients.reduce((acc, c) => (c.isConnected ? acc + 1 : acc), 0);
    },
    get totalCount() {
      return clients.length;
    },
    isConnected() {
      return clients.some((c) => c.isConnected);
    },
    send(payload) {
      let delivered = 0;
      for (const client of clients) {
        if (client.isConnected && client.send(payload)) {
          delivered += 1;
        }
      }
      return delivered;
    },
    async stop() {
      await Promise.all(clients.map(async (client) => {
        try {
          await client.stop?.();
        } catch (error) {
          logger.warn?.('[pi-bridge] failed to stop bridge client', { url: client.url, error });
        }
      }));
    },
  };
}

function createDisabledBridge(config, error = null) {
  return {
    config,
    error,
    clients: [],
    client: null,
    connectedCount: 0,
    totalCount: 0,
    isConnected() { return false; },
    send() { return 0; },
    async stop() {},
  };
}
