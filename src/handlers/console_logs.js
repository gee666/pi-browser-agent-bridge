function normalizeToolError(error, fallbackMessage) {
  if (error && typeof error === 'object' && typeof error.code === 'string' && typeof error.message === 'string') {
    return error;
  }
  return {
    code: 'E_INTERNAL',
    message: error instanceof Error ? error.message : fallbackMessage,
  };
}

export function createConsoleLogsHandler({ consoleBuffer, resolveTabId } = {}) {
  return async function browserGetConsoleLogs(params = {}) {
    const tabId = await Promise.resolve(resolveTabId ? resolveTabId(params) : params.tab_id);
    if (typeof tabId !== 'number') {
      throw { code: 'E_NO_ACTIVE_TAB', message: 'No target tab is available for browser_get_console_logs' };
    }

    try {
      await consoleBuffer.armTab(tabId);
      const result = consoleBuffer.getEntries(tabId, params);
      return {
        tabId,
        total: result.total,
        returned: result.returned,
        disconnectedAt: result.disconnectedAt,
        disconnectReason: result.disconnectReason,
        entries: result.entries,
      };
    } catch (error) {
      throw normalizeToolError(error, 'Failed to read console logs');
    }
  };
}
