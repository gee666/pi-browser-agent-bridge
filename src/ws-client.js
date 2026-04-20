const DEFAULT_RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000];
const PROTOCOL_VERSION = 1;

function toProtocolError(error) {
  if (error && typeof error === 'object' && typeof error.code === 'string' && typeof error.message === 'string') {
    return {
      code: error.code,
      message: error.message,
      details: error.details,
    };
  }

  return {
    code: 'E_INTERNAL',
    message: error instanceof Error ? error.message : String(error),
  };
}

export function createBridgeClient({
  url,
  logger = console,
  webSocketFactory = (socketUrl) => new WebSocket(socketUrl),
  reconnectDelaysMs = DEFAULT_RECONNECT_DELAYS_MS,
  helloPayload,
  handleRequest,
  onOpen,
  onClose,
  onError,
  onMessage,
} = {}) {
  let socket = null;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let manuallyStopped = false;

  const clearReconnectTimer = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const scheduleReconnect = () => {
    if (manuallyStopped) return;
    clearReconnectTimer();
    const delay = reconnectDelaysMs[Math.min(reconnectAttempt, reconnectDelaysMs.length - 1)];
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, delay);
  };

  const safelyInvoke = (label, callback, value) => {
    if (!callback) return;
    try {
      callback(value);
    } catch (error) {
      logger.error?.(`[pi-bridge] ${label} callback failed`, error);
    }
  };

  const connect = async () => {
    if (manuallyStopped || !url || socket) return;

    try {
      const nextSocket = webSocketFactory(url);
      socket = nextSocket;

      nextSocket.addEventListener('open', () => {
        if (socket !== nextSocket) return;
        reconnectAttempt = 0;
        logger.info?.('[pi-bridge] connected', { url });
        if (helloPayload) {
          try {
            nextSocket.send(JSON.stringify(helloPayload));
          } catch (error) {
            logger.warn?.('[pi-bridge] failed to send hello', error);
          }
        }
        safelyInvoke('open', onOpen);
      });

      nextSocket.addEventListener('message', (event) => {
        if (socket !== nextSocket) return;
        safelyInvoke('message', onMessage, event);

        let frame;
        try {
          frame = JSON.parse(event?.data);
        } catch {
          return;
        }

        if (frame?.kind !== 'request' || typeof frame.id !== 'string' || typeof frame.type !== 'string' || typeof handleRequest !== 'function') {
          return;
        }

        void Promise.resolve()
          .then(() => handleRequest(frame))
          .then((data) => {
            if (socket !== nextSocket || nextSocket.readyState !== 1) return;
            nextSocket.send(JSON.stringify({
              v: PROTOCOL_VERSION,
              kind: 'response',
              id: frame.id,
              ok: true,
              data,
            }));
          })
          .catch((error) => {
            if (socket !== nextSocket || nextSocket.readyState !== 1) return;
            const protocolError = toProtocolError(error);
            nextSocket.send(JSON.stringify({
              v: PROTOCOL_VERSION,
              kind: 'response',
              id: frame.id,
              ok: false,
              error: protocolError,
            }));
          });
      });

      nextSocket.addEventListener('error', (event) => {
        if (socket !== nextSocket) return;
        logger.warn?.('[pi-bridge] websocket error', event);
        safelyInvoke('error', onError, event);
      });

      nextSocket.addEventListener('close', (event) => {
        const isCurrentSocket = socket === nextSocket;
        if (!isCurrentSocket) return;
        socket = null;
        logger.warn?.('[pi-bridge] disconnected', { code: event?.code, reason: event?.reason || '' });
        safelyInvoke('close', onClose, event);
        scheduleReconnect();
      });
    } catch (error) {
      logger.error?.('[pi-bridge] failed to create websocket client', error);
      safelyInvoke('error', onError, error);
      scheduleReconnect();
    }
  };

  return {
    get url() {
      return url;
    },
    get isConnected() {
      return !!socket && socket.readyState === 1;
    },
    async start() {
      manuallyStopped = false;
      clearReconnectTimer();
      if (socket) return;
      await connect();
    },
    async stop() {
      manuallyStopped = true;
      clearReconnectTimer();
      const activeSocket = socket;
      socket = null;
      if (activeSocket && typeof activeSocket.close === 'function') {
        try {
          activeSocket.close();
        } catch (error) {
          logger.warn?.('[pi-bridge] websocket close failed', error);
        }
      }
    },
    send(payload) {
      if (!socket || socket.readyState !== 1) {
        logger.warn?.('[pi-bridge] send skipped; socket not connected');
        return false;
      }

      try {
        socket.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
        return true;
      } catch (error) {
        logger.warn?.('[pi-bridge] send failed', error);
        safelyInvoke('error', onError, error);
        return false;
      }
    },
  };
}
