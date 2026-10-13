// -----------------------------------------------------------------------------
// The event stream: frames cut anywhere by the network, pings, reopening
// after Miele closes it, backoff after a failure, the idle watchdog.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrame, startEventStream } from '../src/miele/events.js';
import { waitFor } from './helpers/world.js';

test('a frame gives its type and its JSON data; pings and junk give nothing', () => {
  assert.deepEqual(parseFrame('event: devices\ndata: {"a":1}'), {
    type: 'devices',
    data: { a: 1 },
  });
  assert.deepEqual(parseFrame('event: actions\r\ndata: {"b":2}'), {
    type: 'actions',
    data: { b: 2 },
  });
  assert.equal(parseFrame('event: ping\ndata: {}'), null);
  assert.equal(parseFrame(': comment'), null);
  assert.equal(parseFrame('event: devices\ndata: {not json'), null);
  assert.deepEqual(parseFrame('event: devices\ndata: {"a":\ndata: 1}'), {
    type: 'devices',
    data: { a: 1 },
  });
});

/** A fake connection whose body the test writes to. */
function connection() {
  const encoder = new TextEncoder();
  let controller;
  const body = new ReadableStream({
    start(c) {
      controller = c;
    },
  });
  return {
    response: new Response(body, { status: 200 }),
    write: (text) => controller.enqueue(encoder.encode(text)),
    close: () => controller.close(),
  };
}

test('frames split across chunks are put back together', async () => {
  const conn = connection();
  const events = [];
  const stream = startEventStream({
    open: async () => conn.response,
    onEvent: (e) => events.push(e),
  });
  conn.write('event: dev');
  conn.write('ices\ndata: {"x"');
  conn.write(':1}\n\nevent: ping\ndata: {}\n\nevent: actions\ndata: {"y":2}\n\n');
  await waitFor(() => events.length === 2, { label: 'two events' });
  assert.deepEqual(events, [
    { type: 'devices', data: { x: 1 } },
    { type: 'actions', data: { y: 2 } },
  ]);
  stream.stop();
  await stream.done;
});

test('the stream is reopened when Miele closes it, and after a failure with a backoff', async () => {
  const statuses = [];
  const connections = [];
  let attempts = 0;
  const stream = startEventStream({
    open: async () => {
      attempts += 1;
      if (attempts === 2) {
        throw new Error('network down');
      }
      const conn = connection();
      connections.push(conn);
      return conn.response;
    },
    onEvent: () => {},
    onStatus: (state) => statuses.push(state),
    timing: { baseDelayMs: 5, maxDelayMs: 20 },
  });
  await waitFor(() => connections.length === 1, { label: 'first connection' });
  connections[0].close();
  await waitFor(() => connections.length === 2, { label: 'reconnection' });
  assert.deepEqual(statuses, ['connected', 'closed', 'failed', 'connected']);
  stream.stop();
  await stream.done;
});

test('a silent connection is dropped by the watchdog and reopened', async () => {
  const connections = [];
  const stream = startEventStream({
    open: async () => {
      const conn = connection();
      connections.push(conn);
      return conn.response;
    },
    onEvent: () => {},
    timing: { idleTimeoutMs: 20, baseDelayMs: 5 },
  });
  await waitFor(() => connections.length >= 2, { label: 'watchdog reconnection' });
  stream.stop();
  await stream.done;
});

test('stop() ends the loop, even while waiting before a retry', async () => {
  let attempts = 0;
  const stream = startEventStream({
    open: async () => {
      attempts += 1;
      throw new Error('refused');
    },
    onEvent: () => {},
    retryDelay: () => 60_000,
  });
  await waitFor(() => attempts === 1, { label: 'first attempt' });
  stream.stop();
  await stream.done;
  assert.equal(attempts, 1);
});
