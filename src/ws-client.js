// Reconnect schedule. Kept short so that when a pi-browser-agent broker comes
// up on one of the URLs we are watching (e.g. a new pi instance bound to a
// port previously unreachable), we connect to it within a few seconds rather
// than sitting idle through a 10s backoff. The list is also the cap — the
// last value repeats forever.
const DEFAULT_RECONNECT_DELAYS_MS = [500, 1000, 2000, 3000, 5000];
const PROTOCOL_VERSION = 1;

function isValidIncomingProtocolFrame(frame) {
  if (!frame || frame.v !== PROTOCOL_VERSION || typeof frame.kind !== 'string') return false;
  switch (frame.kind) {
    case 'welcome':
      return typeof frame.brokerVersion === 'string' && typeof frame.serverTime === 'number';
    case 'request':
      return typeof frame.id === 'string' && typeof frame.type === 'string';
    case 'response': {
      if (typeof frame.id !== 'string' || typeof frame.ok !== 'boolean') return false;
      if (frame.ok) return frame.error === undefined;
      return !!frame.error
        && typeof frame.error === 'object'
        && typeof frame.error.code === 'string'
        && typeof frame.error.message === 'string';
    }
    case 'probe':
      return frame.id === undefined || typeof frame.id === 'string';
    case 'notify':
      return typeof frame.event === 'string';
    default:
      return false;
  }
}

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
  // Force-close a connection attempt that never settles (no open/close/error)
  // so a socket wedged in CONNECTING cannot pin the client open forever with
  // no reconnect scheduled. Set to 0 to disable.
  connectTimeoutMs = 8000,
  helloPayload,
  handleRequest,
  onOpen,
  onClose,
  onError,
  onMessage,
} = {}) {
  let socket = null;
  let reconnectTimer = null;
  let connectTimer = null;
  let reconnectAttempt = 0;
  let manuallyStopped = false;
  // Timestamp of the last frame we RECEIVED. readyState === OPEN is not proof of
  // liveness: a loopback socket whose peer disappeared without a clean FIN (host
  // suspend/resume, killed broker process, Chrome network-service restart) stays
  // OPEN forever and silently swallows everything we send. Without a receive-side
  // watchdog the extension keeps a zombie socket indefinitely while every pi
  // broker correctly reports "bridge disconnected" — the exact state where the
  // browser is running but no agent can reach it.
  let lastReceivedAt = 0;
  let openedAt = 0;
  // Detaches the listeners of the current connect attempt. Four closures are
  // registered per attempt, and a wedged socket that never fires `close` used to
  // keep itself and them reachable forever. That was bounded by the ~30s MV3
  // worker teardown, but the keepalive loop now keeps the worker alive for the
  // whole browser session, so abandoned attempts must be unwired explicitly.
  let listenerAbort = null;

  const abortListeners = () => {
    try {
      listenerAbort?.abort();
    } catch {
      // AbortController.abort() never throws in practice; ignore exotic hosts.
    }
    listenerAbort = null;
  };

  const clearReconnectTimer = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const clearConnectTimer = () => {
    if (connectTimer) {
      clearTimeout(connectTimer);
      connectTimer = null;
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
    reconnectTimer.unref?.();
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
      abortListeners();
      const attemptAbort = typeof AbortController === 'function' ? new AbortController() : null;
      listenerAbort = attemptAbort;
      // Hosts (and the test FakeSocket) may ignore the signal option, so the
      // `socket !== nextSocket` guards below remain the functional protection
      // against a stale socket delivering events; the signal is the memory fix.
      const listenerOptions = attemptAbort ? { signal: attemptAbort.signal } : undefined;

      clearConnectTimer();
      if (connectTimeoutMs > 0) {
        connectTimer = setTimeout(() => {
          connectTimer = null;
          if (socket !== nextSocket) return;
          // readyState 1 === OPEN; anything else means the attempt never
          // completed. Force it closed and let reconnect logic take over.
          if (nextSocket.readyState !== 1) {
            logger.warn?.('[pi-bridge] connect attempt timed out; forcing close', { url });
            try {
              if (typeof nextSocket.close === 'function') nextSocket.close();
            } catch (error) {
              logger.warn?.('[pi-bridge] failed to close stuck socket', error);
            }
            // If close() does not deliver a close event (stuck socket), recover
            // directly so we do not pin the client open with no reconnect.
            if (socket === nextSocket) {
              socket = null;
              abortListeners();
              scheduleReconnect();
            }
          }
        }, connectTimeoutMs);
        connectTimer.unref?.();
      }

      nextSocket.addEventListener('open', () => {
        if (socket !== nextSocket) return;
        clearConnectTimer();
        openedAt = Date.now();
        lastReceivedAt = 0;
        logger.info?.('[pi-bridge] connected', { url });
        if (helloPayload) {
          try {
            nextSocket.send(JSON.stringify(helloPayload));
          } catch (error) {
            logger.warn?.('[pi-bridge] failed to send hello', error);
          }
        }
        safelyInvoke('open', onOpen);
      }, listenerOptions);

      nextSocket.addEventListener('message', (event) => {
        if (socket !== nextSocket) return;
        safelyInvoke('message', onMessage, event);

        let frame;
        try {
          frame = JSON.parse(event?.data);
        } catch {
          return;
        }
        if (!isValidIncomingProtocolFrame(frame)) return;

        // Opening a TCP/WebSocket connection does not prove that the peer
        // speaks our protocol. Only a valid frame restores receive liveness
        // and clears accumulated reconnect backoff.
        lastReceivedAt = Date.now();
        reconnectAttempt = 0;

        if (frame.kind !== 'request' || typeof handleRequest !== 'function') return;

        const sendResponse = (response, { fallbackOnSerializationError = false } = {}) => {
          let payload;
          try {
            payload = JSON.stringify(response);
          } catch (error) {
            logger.warn?.('[pi-bridge] failed to serialize response', error);
            if (!fallbackOnSerializationError) return false;
            // Handler output can contain BigInt, cycles, or throwing toJSON
            // methods. Return a minimal serializable protocol error instead of
            // silently making the broker wait for a response that never comes.
            payload = JSON.stringify({
              v: PROTOCOL_VERSION,
              kind: 'response',
              id: frame.id,
              ok: false,
              error: {
                code: 'E_INTERNAL',
                message: `Failed to serialize response: ${error instanceof Error ? error.message : String(error)}`,
              },
            });
          }

          if (socket !== nextSocket || nextSocket.readyState !== 1) return false;
          try {
            nextSocket.send(payload);
            return true;
          } catch (error) {
            // A close can race the readyState check. Contain send failures here
            // so they cannot reject the request chain and trigger a second
            // response attempt or an unhandled rejection.
            logger.warn?.('[pi-bridge] failed to send response', error);
            return false;
          }
        };

        void Promise.resolve()
          .then(() => handleRequest(frame))
          .then(
            (data) => sendResponse({
              v: PROTOCOL_VERSION,
              kind: 'response',
              id: frame.id,
              ok: true,
              data,
            }, { fallbackOnSerializationError: true }),
            (error) => sendResponse({
              v: PROTOCOL_VERSION,
              kind: 'response',
              id: frame.id,
              ok: false,
              error: toProtocolError(error),
            }),
          );
      }, listenerOptions);

      nextSocket.addEventListener('error', (event) => {
        if (socket !== nextSocket) return;
        logger.warn?.('[pi-bridge] websocket error', event);
        safelyInvoke('error', onError, event);
      }, listenerOptions);

      nextSocket.addEventListener('close', (event) => {
        const isCurrentSocket = socket === nextSocket;
        if (!isCurrentSocket) return;
        clearConnectTimer();
        socket = null;
        abortListeners();
        logger.warn?.('[pi-bridge] disconnected', { code: event?.code, reason: event?.reason || '' });
        safelyInvoke('close', onClose, event);
        scheduleReconnect();
      }, listenerOptions);
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
    get lastReceivedAt() {
      return lastReceivedAt;
    },
    /** ms since the last received frame, or Infinity if never/not connected. */
    get msSinceLastReceive() {
      if (!socket || socket.readyState !== 1 || !lastReceivedAt) return Infinity;
      return Date.now() - lastReceivedAt;
    },
    get connectedForMs() {
      if (!socket || socket.readyState !== 1 || !openedAt) return 0;
      return Date.now() - openedAt;
    },
    /**
     * Drop the current socket (however wedged it looks) and reconnect with a
     * fresh or preserved backoff. This is the escape hatch for a zombie socket:
     * close() alone may never deliver a close event, so we null out our
     * reference first and schedule the retry ourselves.
     */
    forceReconnect(reason = 'forced', { resetBackoff = true } = {}) {
      if (manuallyStopped) return false;
      logger.warn?.('[pi-bridge] forcing reconnect', { url, reason });
      const stale = socket;
      const wasConnected = !!stale;
      socket = null;
      lastReceivedAt = 0;
      openedAt = 0;
      clearConnectTimer();
      clearReconnectTimer();
      abortListeners();
      if (stale) {
        try {
          stale.close();
        } catch (error) {
          logger.warn?.('[pi-bridge] failed to close zombie socket', error);
        }
      }
      if (wasConnected) {
        // The real close handler notifies consumers; a forced drop is just as
        // much a disconnect, and skipping it would leave callers believing the
        // bridge never went down. 4000 is a private-use close code.
        safelyInvoke('close', onClose, { code: 4000, reason });
      }
      // A normal health-driven replacement reconnects immediately with fresh
      // backoff. Escalated replacements preserve the attempt count and use the
      // delayed reconnect schedule so an unresponsive peer cannot churn.
      if (resetBackoff) {
        reconnectAttempt = 0;
        void connect();
      } else {
        scheduleReconnect();
      }
      return true;
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
      clearConnectTimer();
      abortListeners();
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
