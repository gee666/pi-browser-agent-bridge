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
