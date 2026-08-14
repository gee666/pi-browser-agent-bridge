import test from 'node:test';
import assert from 'node:assert/strict';

import { createBridgeClient } from '../src/ws-client.js';

class FakeSocket {
  constructor() {
    this.readyState = 0;
    this.listeners = new Map();
    this.sent = [];
    this.closed = 0;
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, []);
    }
    this.listeners.get(type).push(handler);
  }

  emit(type, event = {}) {
    for (const handler of this.listeners.get(type) || []) {
      handler(event);
    }
  }

  send(payload) {
    this.sent.push(payload);
  }

  close() {
    this.closed += 1;
  }
}

test('client connects, sends payloads, and stops cleanly', async () => {
  const socket = new FakeSocket();
  const client = createBridgeClient({
    url: 'ws://localhost:7878',
    webSocketFactory(url) {
      assert.equal(url, 'ws://localhost:7878');
      return socket;
    },
  });

  await client.start();
  socket.readyState = 1;
  socket.emit('open');

  assert.equal(client.isConnected, true);
  assert.equal(client.send({ kind: 'hello' }), true);
  assert.deepEqual(socket.sent, ['{"kind":"hello"}']);

  await client.stop();
  assert.equal(socket.closed, 1);
});

test('client handles websocket factory failures without throwing from start', async () => {
  const errors = [];
  const client = createBridgeClient({
    url: 'ws://localhost:7878',
    logger: {
      error(...args) {
        errors.push(args);
      },
    },
    reconnectDelaysMs: [1],
    webSocketFactory() {
      throw new Error('factory failed');
    },
  });

  await client.start();
  assert.equal(errors.length, 1);
  await client.stop();
});

test('client contains callback failures and logs them', async () => {
  const socket = new FakeSocket();
  const errors = [];
  const client = createBridgeClient({
    url: 'ws://localhost:7878',
    logger: {
      error(...args) {
        errors.push(args);
      },
      info() {},
      warn() {},
    },
    onMessage() {
      throw new Error('handler failed');
    },
    webSocketFactory() {
      return socket;
    },
  });

  await client.start();
  socket.readyState = 1;
  socket.emit('message', { data: '{}' });

  assert.equal(errors.length, 1);
  assert.match(String(errors[0][0]), /message callback failed/);
  await client.stop();
});

test('client ignores duplicate start calls and stale socket closes do not reconnect', async () => {
  const sockets = [];
  const client = createBridgeClient({
    url: 'ws://localhost:7878',
    reconnectDelaysMs: [1],
    logger: { error() {}, info() {}, warn() {} },
    webSocketFactory() {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });

  await client.start();
  await client.start();
  assert.equal(sockets.length, 1);

  const first = sockets[0];
  first.readyState = 1;
  first.emit('open');
  first.emit('close', { code: 1006 });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(sockets.length, 2);

  const second = sockets[1];
  second.readyState = 1;
  second.emit('open');
  first.emit('close', { code: 1006 });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(sockets.length, 2);

  await client.stop();
});

test('manual start clears pending reconnect timers instead of opening a duplicate socket later', async () => {
  const sockets = [];
  const client = createBridgeClient({
    url: 'ws://localhost:7878',
    reconnectDelaysMs: [5],
    logger: { error() {}, info() {}, warn() {} },
    webSocketFactory() {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });

  await client.start();
  const first = sockets[0];
  first.readyState = 1;
  first.emit('open');
  first.emit('close', { code: 1006 });

  await client.start();
  assert.equal(sockets.length, 2);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(sockets.length, 2);

  await client.stop();
});

test('stale sockets do not deliver open/message/error/close callbacks after replacement', async () => {
  const sockets = [];
  let opens = 0;
  let messages = 0;
  let errors = 0;
  let closes = 0;
  const client = createBridgeClient({
    url: 'ws://localhost:7878',
    reconnectDelaysMs: [1],
    logger: { error() {}, info() {}, warn() {} },
    onOpen() {
      opens += 1;
    },
    onMessage() {
      messages += 1;
    },
    onError() {
      errors += 1;
    },
    onClose() {
      closes += 1;
    },
    webSocketFactory() {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });

  await client.start();
  const first = sockets[0];
  first.readyState = 1;
  first.emit('open');
  first.emit('close', { code: 1006 });
  await new Promise((resolve) => setTimeout(resolve, 5));

  const second = sockets[1];
  second.readyState = 1;
  second.emit('open');
  first.emit('message', { data: '{}' });
  first.emit('error', new Error('stale'));
  first.emit('open');
  first.emit('close', { code: 1006 });

  assert.equal(opens, 2);
  assert.equal(messages, 0);
  assert.equal(errors, 0);
  assert.equal(closes, 1);
  await client.stop();
});

test('connect watchdog force-closes a socket wedged in CONNECTING and reconnects', async () => {
  const sockets = [];
  const client = createBridgeClient({
    url: 'ws://localhost:7878',
    reconnectDelaysMs: [1],
    connectTimeoutMs: 10,
    logger: { error() {}, info() {}, warn() {} },
    webSocketFactory() {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });

  await client.start();
  assert.equal(sockets.length, 1);
  // First socket stays in CONNECTING (readyState 0) and never fires any event.
  const first = sockets[0];

  // Give the watchdog time to fire, force-close, and schedule a reconnect.
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal(first.closed, 1, 'stuck socket should be force-closed');
  assert.ok(sockets.length >= 2, 'a reconnect attempt should have been made');
  assert.equal(client.isConnected, false);

  await client.stop();
});

test('send contains onError callback failures and still returns false', async () => {
  const socket = new FakeSocket();
  const errors = [];
  socket.send = () => {
    throw new Error('send failed');
  };
  const client = createBridgeClient({
    url: 'ws://localhost:7878',
    logger: {
      error(...args) {
        errors.push(args);
      },
      info() {},
      warn() {},
    },
    onError() {
      throw new Error('callback failed');
    },
    webSocketFactory() {
      return socket;
    },
  });

  await client.start();
  socket.readyState = 1;
  socket.emit('open');

  assert.equal(client.send({ kind: 'ping' }), false);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0][0]), /error callback failed/);
  await client.stop();
});

// ─── Receive-side liveness ───────────────────────────────────────────────────
// Regression guard for the outage where the extension held an OPEN-but-dead
// socket forever: every pi broker reported "bridge disconnected" while Chrome
// was running and the extension believed it was still connected.

test('client tracks received frames so a silent socket can be detected', async () => {
  const socket = new FakeSocket();
  const client = createBridgeClient({
    url: 'ws://localhost:7878',
    webSocketFactory: () => socket,
  });

  await client.start();
  socket.readyState = 1;
  socket.emit('open');

  // Freshly opened sockets count as just-heard-from.
  assert.ok(client.msSinceLastReceive < 1000);
  const firstStamp = client.lastReceivedAt;
  assert.ok(firstStamp > 0);

  await new Promise((resolve) => setTimeout(resolve, 5));
  socket.emit('message', { data: JSON.stringify({ v: 1, kind: 'response', id: 'x', ok: true, data: {} }) });
  assert.ok(client.lastReceivedAt >= firstStamp);
  assert.ok(client.msSinceLastReceive < 1000);

  await client.stop();
  // A stopped client is never considered "recently heard from".
  assert.equal(client.msSinceLastReceive, Infinity);
});

test('forceReconnect replaces a zombie socket even if it never emits close', async () => {
  const sockets = [];
  const client = createBridgeClient({
    url: 'ws://localhost:7878',
    webSocketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    logger: { info() {}, warn() {}, error() {} },
  });

  await client.start();
  sockets[0].readyState = 1;
  sockets[0].emit('open');
  assert.equal(client.isConnected, true);

  // The peer vanished without a FIN: readyState stays OPEN and no close fires.
  assert.equal(client.forceReconnect('test zombie'), true);

  assert.equal(sockets[0].closed, 1);
  assert.equal(sockets.length, 2, 'a replacement socket must be created immediately');

  sockets[1].readyState = 1;
  sockets[1].emit('open');
  assert.equal(client.isConnected, true);
  assert.ok(client.msSinceLastReceive < 1000);

  // A late close event from the abandoned socket must not tear down the new one.
  sockets[0].emit('close', { code: 1006 });
  assert.equal(client.isConnected, true);

  await client.stop();
});

test('forceReconnect is a no-op after stop() so a stopped bridge stays stopped', async () => {
  const sockets = [];
  const client = createBridgeClient({
    url: 'ws://localhost:7878',
    webSocketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    logger: { info() {}, warn() {}, error() {} },
  });

  await client.start();
  sockets[0].readyState = 1;
  sockets[0].emit('open');
  await client.stop();

  assert.equal(client.forceReconnect('after stop'), false);
  assert.equal(sockets.length, 1);
});

test('forceReconnect notifies onClose so consumers observe the disconnect', async () => {
  const sockets = [];
  const closes = [];
  const client = createBridgeClient({
    url: 'ws://localhost:7878',
    webSocketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    onClose: (event) => closes.push(event),
    logger: { info() {}, warn() {}, error() {} },
  });

  await client.start();
  sockets[0].readyState = 1;
  sockets[0].emit('open');

  client.forceReconnect('zombie socket');

  // Without this a forced drop would silently look like "still connected" to
  // every consumer, unlike a real close event.
  assert.equal(closes.length, 1);
  assert.equal(closes[0].code, 4000);
  assert.equal(closes[0].reason, 'zombie socket');
});

test('forceReconnect accepts resetBackoff:false and still replaces the socket', async () => {
  const sockets = [];
  const client = createBridgeClient({
    url: 'ws://localhost:7878',
    webSocketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    logger: { info() {}, warn() {}, error() {} },
  });

  await client.start();
  sockets[0].readyState = 1;
  sockets[0].emit('open');

  assert.equal(client.forceReconnect('escalating', { resetBackoff: false }), true);
  assert.equal(sockets.length, 2);
  assert.equal(sockets[0].closed, 1);

  await client.stop();
});
