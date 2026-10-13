// -----------------------------------------------------------------------------
// A fake Miele cloud behind a `fetch` function: the OAuth token endpoint, the
// REST API (GET /devices, GET/PUT /devices/{id}/actions) and the event stream,
// serving the real answers of the API recorded by Home Assistant's tests
// (test/fixtures/miele/, Apache-2.0). No network, ever.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

export function fixture(name) {
  return JSON.parse(
    readFileSync(new URL(`../fixtures/miele/${name}.json`, import.meta.url), 'utf8'),
  );
}

/** Every appliance of every fixture, by serial (one account with them all). */
export function allAppliances() {
  return {
    ...fixture('5_devices'),
    ...fixture('fridge_freezer'),
    ...fixture('laundry'),
    ...fixture('coffee_system'),
    ...fixture('hob'),
    ...fixture('oven'),
    ...fixture('vacuum_device'),
    ...fixture('fan_devices'),
  };
}

/** Actions of the fixtures, by serial; the others accept nothing in particular. */
export function allActions() {
  return {
    ...fixture('4_actions'),
    DummyWasher: fixture('action_washing_machine'),
    DummyAppliance_Fridge_Freezer: fixture('action_fridge_freezer'),
  };
}

const json = (status, body) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/**
 * @param {object} [options]
 * @param {object} [options.devices] GET /devices answer
 * @param {object} [options.actions] actions by serial
 */
export function createFakeMiele({ devices = allAppliances(), actions = allActions() } = {}) {
  const miele = {
    devices: structuredClone(devices),
    actions: structuredClone(actions),
    requests: [],
    sentActions: [],
    /** The token the API accepts; anything else is a 401. */
    validToken: 'access-1',
    /** Answer of the token endpoint, per grant type. */
    tokenAnswers: {
      authorization_code: () =>
        json(200, { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 2592000 }),
      refresh_token: () => {
        miele.validToken = `access-${miele.requests.length}`;
        return json(200, {
          access_token: miele.validToken,
          refresh_token: 'refresh-2',
          expires_in: 2592000,
        });
      },
    },
    /** Status of PUT actions (200 by default). */
    actionStatus: 200,
    /** Status of GET /devices (200 by default; 0 = network error). */
    devicesStatus: 200,
    /** Open event streams. */
    streams: [],
    /** Status of the event stream request. */
    streamStatus: 200,

    /** Push one frame to every open stream. */
    push(type, data) {
      const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
      for (const stream of miele.streams) {
        stream.enqueue(frame);
      }
    },

    /** Close every open stream (Miele does it from time to time). */
    closeStreams() {
      for (const stream of miele.streams.splice(0)) {
        stream.close();
      }
    },

    async fetch(input, init = {}) {
      const url = new URL(String(input));
      const method = init.method ?? 'GET';
      const headers = init.headers ?? {};
      const entry = { method, path: url.pathname, query: Object.fromEntries(url.searchParams) };
      if (init.body instanceof URLSearchParams) {
        entry.form = Object.fromEntries(init.body);
      } else if (typeof init.body === 'string') {
        entry.body = JSON.parse(init.body);
      }
      miele.requests.push(entry);

      if (url.pathname === '/thirdparty/token') {
        const answer = miele.tokenAnswers[entry.form?.grant_type];
        return answer ? answer(entry) : json(400, { error: 'unsupported_grant_type' });
      }
      if (headers.Authorization !== `Bearer ${miele.validToken}`) {
        return json(401, { message: 'Unauthorized' });
      }
      if (url.pathname === '/v1/devices') {
        if (miele.devicesStatus === 0) {
          throw new TypeError('fetch failed');
        }
        return miele.devicesStatus === 200
          ? json(200, miele.devices)
          : json(miele.devicesStatus, { message: 'down' });
      }
      if (url.pathname === '/v1/devices/all/events') {
        if (miele.streamStatus !== 200) {
          return json(miele.streamStatus, { message: 'refused' });
        }
        const encoder = new TextEncoder();
        let controller;
        const body = new ReadableStream({
          start(c) {
            controller = c;
          },
        });
        const stream = {
          enqueue: (text) => controller.enqueue(encoder.encode(text)),
          close: () => {
            try {
              controller.close();
            } catch {
              // already closed
            }
          },
        };
        init.signal?.addEventListener('abort', () => {
          try {
            controller.error(new Error('aborted'));
          } catch {
            // already closed
          }
        });
        miele.streams.push(stream);
        return new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }
      const actionsMatch = /^\/v1\/devices\/([^/]+)\/actions$/.exec(url.pathname);
      if (actionsMatch) {
        const serial = decodeURIComponent(actionsMatch[1]);
        if (!(serial in miele.devices)) {
          return json(404, { message: 'Not found' });
        }
        if (method === 'PUT') {
          miele.sentActions.push({ serial, body: entry.body });
          return miele.actionStatus === 200
            ? new Response(null, { status: 204 })
            : json(miele.actionStatus, { message: 'Action not allowed' });
        }
        return json(200, miele.actions[serial] ?? fixture('action_offline'));
      }
      return json(404, { message: 'Not found' });
    },
  };
  miele.fetch = miele.fetch.bind(miele);
  return miele;
}
