// -----------------------------------------------------------------------------
// The Miele event stream (Server-Sent Events, GET /devices/all/events).
//
// One long-lived request carries every change of every appliance of the
// account, as frames:
//
//   event: devices            data: the same object as GET /devices
//   event: actions            data: { <serial>: <what it accepts now> }
//   event: ping               every 20 s or so
//
// The stream is preferred to polling: a program that ends is known within
// seconds, with no request spent. It is reopened with a backoff when Miele
// closes it or the network drops, and a watchdog drops a silent one (no ping
// for 2 minutes: a dead socket that looks alive).
//
// Written on `fetch` and its ReadableStream body: Node has no EventSource,
// and the stream needs an Authorization header anyway.
// -----------------------------------------------------------------------------

/** No frame for this long (pings included): the connection is dead. */
export const IDLE_TIMEOUT_MS = 120_000;
export const RECONNECT_BASE_DELAY_MS = 5_000;
export const RECONNECT_MAX_DELAY_MS = 300_000;

/**
 * Turn one raw frame into an event, or null (ping, comment, unreadable).
 * @param {string} frame lines up to (not including) the blank line
 * @returns {{ type: string, data: unknown }|null}
 */
export function parseFrame(frame) {
  let type = 'message';
  const dataLines = [];
  for (const rawLine of frame.split(/\r?\n/)) {
    if (rawLine === '' || rawLine.startsWith(':')) {
      continue;
    }
    const colon = rawLine.indexOf(':');
    const field = colon === -1 ? rawLine : rawLine.slice(0, colon);
    const value = colon === -1 ? '' : rawLine.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') {
      type = value.trim();
    } else if (field === 'data') {
      dataLines.push(value);
    }
  }
  if (type === 'ping' || dataLines.length === 0) {
    return null;
  }
  try {
    return { type, data: JSON.parse(dataLines.join('\n')) };
  } catch {
    return null;
  }
}

/** Index and length of the first blank line (frame separator), or null. */
function findSeparator(buffer) {
  const match = /\r?\n\r?\n/.exec(buffer);
  return match ? { index: match.index, length: match[0].length } : null;
}

/**
 * Keep the stream open for life.
 *
 * @param {object} options
 * @param {(signal: AbortSignal) => Promise<Response>} options.open opens one connection
 * @param {(event: { type: string, data: unknown }) => void} options.onEvent
 * @param {(state: 'connected'|'closed'|'failed', error?: Error) => void} [options.onStatus]
 * @param {(error: Error) => number|null} [options.retryDelay] a delay for this
 *   error (ms), or null for the usual backoff
 * @param {object} [options.timing] overrides for the tests
 * @returns {{ stop: () => void, done: Promise<void> }}
 */
export function startEventStream({
  open,
  onEvent,
  onStatus = () => {},
  retryDelay = () => null,
  timing = {},
}) {
  const idleTimeoutMs = timing.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
  const baseDelayMs = timing.baseDelayMs ?? RECONNECT_BASE_DELAY_MS;
  const maxDelayMs = timing.maxDelayMs ?? RECONNECT_MAX_DELAY_MS;

  let stopped = false;
  let controller = null;
  let retryTimer = null;
  let wakeUp = null;
  let reader = null;
  let failures = 0;

  const sleep = (ms) =>
    new Promise((resolve) => {
      wakeUp = resolve;
      retryTimer = setTimeout(resolve, ms);
      retryTimer.unref?.();
    });

  async function consume(response) {
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let watchdog = null;
    const arm = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => reader.cancel().catch(() => {}), idleTimeoutMs);
      watchdog.unref?.();
    };
    try {
      arm();
      for (;;) {
        const { value, done } = await reader.read();
        if (done || stopped) {
          break;
        }
        arm();
        buffer += decoder.decode(value, { stream: true });
        let separator = findSeparator(buffer);
        while (separator) {
          const event = parseFrame(buffer.slice(0, separator.index));
          buffer = buffer.slice(separator.index + separator.length);
          if (event) {
            onEvent(event);
          }
          separator = findSeparator(buffer);
        }
      }
    } finally {
      clearTimeout(watchdog);
      reader.cancel().catch(() => {});
      reader = null;
    }
  }

  async function run() {
    while (!stopped) {
      controller = new AbortController();
      let delay;
      try {
        const response = await open(controller.signal);
        if (stopped) {
          break;
        }
        failures = 0;
        onStatus('connected');
        await consume(response);
        if (stopped) {
          break;
        }
        // Miele closes the stream from time to time: normal, reopen soon.
        onStatus('closed');
        delay = baseDelayMs;
      } catch (err) {
        if (stopped) {
          break;
        }
        failures += 1;
        onStatus('failed', err);
        delay = retryDelay(err) ?? Math.min(baseDelayMs * 2 ** (failures - 1), maxDelayMs);
      }
      await sleep(delay);
    }
  }

  const done = run();

  return {
    done,
    stop() {
      stopped = true;
      clearTimeout(retryTimer);
      wakeUp?.();
      controller?.abort();
      // A body not tied to the signal still ends: the read loop sees `done`.
      reader?.cancel().catch(() => {});
    },
  };
}
