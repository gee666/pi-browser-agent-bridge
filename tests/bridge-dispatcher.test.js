import test from 'node:test';
import assert from 'node:assert/strict';

import { createBridgeDispatcher } from '../src/dispatcher.js';

test('bridge dispatcher serializes configured request types per tab', async () => {
  const events = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });

  const dispatcher = createBridgeDispatcher({
    serialRequestTypes: ['browser_navigate'],
    tabIdResolver: (frame) => frame.params.tab_id,
    logger: { warn() {} },
    handlers: {
      async browser_navigate(params) {
        events.push(`start:${params.name}`);
        if (params.name === 'first') {
          await firstGate;
        }
        events.push(`end:${params.name}`);
        return { ok: true, name: params.name };
      },
    },
  });

  const first = dispatcher.handle({ type: 'browser_navigate', params: { tab_id: 1, name: 'first' } });
  const second = dispatcher.handle({ type: 'browser_navigate', params: { tab_id: 1, name: 'second' } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  events.push('tick');
  releaseFirst();

  const results = await Promise.all([first, second]);
  assert.deepEqual(events, ['start:first', 'tick', 'end:first', 'start:second', 'end:second']);
  assert.deepEqual(results.map((entry) => entry.name), ['first', 'second']);
});

test('bridge dispatcher leaves non-serial requests concurrent and normalizes thrown errors', async () => {
  const dispatcher = createBridgeDispatcher({
    logger: { warn() {} },
    handlers: {
      async browser_list_tabs() {
        return { tabs: [] };
      },
      async browser_reload() {
        throw new Error('boom');
      },
    },
  });

  const tabs = await dispatcher.handle({ type: 'browser_list_tabs', params: {} });
  assert.deepEqual(tabs, { tabs: [] });

  await assert.rejects(
    dispatcher.handle({ type: 'browser_reload', params: {} }),
    (error) => {
      assert.equal(error.code, 'E_INTERNAL');
      assert.equal(error.message, 'boom');
      return true;
    },
  );
});
