import { createConsoleLogsHandler } from './console_logs.js';
import { createNetworkHandler } from './network.js';

export function createBufferedObservabilityHandlers(deps = {}) {
  return {
    browser_get_console_logs: createConsoleLogsHandler(deps),
    browser_get_network: createNetworkHandler(deps),
  };
}
