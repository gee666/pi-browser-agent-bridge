import test from 'node:test';
import assert from 'node:assert/strict';

import { createBridgeClient } from '../src/index.js';

function createFakeSocket() {
  const listeners = new Map();
  const sent = [];
  const socket = {
    readyState: 0,
    sent,
    addEventListener(type, listener) {
      const list = listeners.get(type) || [];
      list.push(listener);
      listeners.set(type, list);
    },
    send(payload) {
      sent.push(payload);
    },
    close() {
      socket.readyState = 3;
    },
    emit(type, event = {}) {
      for (const listener of listeners.get(type) || []) {
        listener(event);
      }
    },
  };
  return socket;
}

test('bridge client sends hello and dispatches broker requests to handlers', async () => {
  const socket = createFakeSocket();
  const client = createBridgeClient({
    url: 'ws://localhost:7878',
    webSocketFactory() {
      return socket;
    },
    helloPayload: { v: 1, kind: 'hello', extensionId: 'ext', version: '1.0.0', capabilities: ['browser_run_task'] },
    async handleRequest(frame) {
      return { echoed: frame.params.task };
    },
  });

  await client.start();
  socket.readyState = 1;
  socket.emit('open');
  assert.equal(JSON.parse(socket.sent[0]).kind, 'hello');

  socket.emit('message', {
    data: JSON.stringify({
      v: 1,
      kind: 'request',
      id: 'req-1',
      type: 'browser_run_task',
      params: { task: 'Do work' },
    }),
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  const response = JSON.parse(socket.sent[1]);
  assert.equal(response.kind, 'response');
  assert.equal(response.ok, true);
  assert.deepEqual(response.data, { echoed: 'Do work' });
});

test('bridge client converts handler exceptions into structured error responses', async () => {
  const socket = createFakeSocket();
  const client = createBridgeClient({
    url: 'ws://localhost:7878',
    webSocketFactory() {
      return socket;
    },
    async handleRequest() {
      throw { code: 'E_BUSY', message: 'Already running', details: { active: true } };
    },
  });

  await client.start();
  socket.readyState = 1;
  socket.emit('open');
  socket.emit('message', {
    data: JSON.stringify({
      v: 1,
      kind: 'request',
      id: 'req-2',
      type: 'browser_run_task',
      params: {},
    }),
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  const response = JSON.parse(socket.sent[0]);
  assert.equal(response.ok, false);
  assert.deepEqual(response.error, { code: 'E_BUSY', message: 'Already running', details: { active: true } });
});
