// -----------------------------------------------------------------------------
// The live picture of the Miele account, and everything that follows from it.
//
// Sources, in order of preference:
//   1. the event stream (src/miele/events.js): every change within seconds,
//      no request spent;
//   2. a full read (GET /devices + the actions of each appliance) by the
//      container's own timer: every 30 minutes while the stream is up (a
//      safety net, and the heartbeat of the values that never change), every
//      2 minutes while it is down;
//   3. the core's onPoll, a fallback only: Gladys#3198 makes it unreliable,
//      and it is skipped whenever the container read recently.
//
// What follows from a change: the states of the devices the user added
// (only the changes, `publishChangedStates`), their cloud/unreachable badge,
// the scene triggers (`program_finished`, `appliance_failure`, one event per
// transition, never at startup), and a nudge to the dashboard widget.
//
// Logs stay quiet: a normal cycle writes nothing at info level. The life
// cycle does (start, account linked, appliance found, stream lost and back,
// one line per user command), and a repeated failure writes one line when it
// starts and one when it is over (src/issues.js).
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { applianceName, buildDevice, buildStates, idsOf, parseAppliances } from './appliances.js';
import { CommandError, featureCommand, programCommand } from './commands.js';
import { hasCredentials } from './config.js';
import { COMMAND_TEXT, CONNECTION_TEXT, fillAll } from './i18n.js';
import { createIssueLog } from './issues.js';
import { MieleApiError, ReauthorizationRequiredError } from './miele/client.js';
import { RUNNING_STATUSES, STATUS } from './miele/constants.js';
import { startEventStream } from './miele/events.js';

export const READ_PERIOD_STREAMING_MS = 30 * 60 * 1000;
export const READ_PERIOD_FALLBACK_MS = 2 * 60 * 1000;
/** A value that never changes is sent again this often (Gladys flags 48 h). */
export const HEARTBEAT_MS = 6 * 60 * 60 * 1000;
/** Wait before the next attempt when Miele refuses the stream (429, 403…). */
export const STREAM_REFUSED_DELAY_MS = 5 * 60 * 1000;
export const WIDGET_KEY = 'running_appliances';
export const TRIGGERS = { FINISHED: 'program_finished', FAILURE: 'appliance_failure' };

const defaultLogger = createLogger({ name: 'miele' });

/**
 * @param {object} options
 * @param {object} options.gladys GladysIntegration (or the SDK's fake Gladys)
 * @param {ReturnType<import('./miele/client.js').createMieleClient>} options.client
 * @param {() => object} options.getConfig the current normalized config
 * @param {() => number} [options.now]
 * @param {boolean} [options.timers] run the periodic read (tests may turn it off)
 * @param {boolean} [options.stream] open the event stream (tests may turn it off)
 * @param {object} [options.streamTiming] reconnection timing (tests)
 * @param {{ streamingMs?: number, fallbackMs?: number }} [options.periods] read periods (tests)
 * @param {object} [options.logger]
 */
export function createHub({
  gladys,
  client,
  getConfig,
  now = () => Date.now(),
  timers = true,
  stream: useStream = true,
  streamTiming,
  periods = {},
  logger = defaultLogger,
}) {
  const issues = createIssueLog(logger);
  /** serial → parsed appliance */
  const appliances = new Map();
  /** serial → last actions answer */
  const actions = new Map();
  /** serial → { status, fault, program } seen last, for the triggers */
  const previous = new Map();
  /** serial → last transport published */
  const transports = new Map();
  /** serials already announced in the logs */
  const announced = new Set();
  let published = new Set();
  let lastReadAt = null;
  let reading = null;
  let stream = null;
  let streamUp = false;
  let streamEverUp = false;
  let timer = null;
  let running = false;
  let linked = false;
  let reported = null;
  let widgetSignature = '';

  const language = () => getConfig().language;
  const streamingMs = periods.streamingMs ?? READ_PERIOD_STREAMING_MS;
  const fallbackMs = periods.fallbackMs ?? READ_PERIOD_FALLBACK_MS;
  const period = () => (streamUp ? streamingMs : fallbackMs);
  const createdIds = () => new Set((gladys.devices ?? []).map((device) => device.external_id));

  /** The connection badge of the Configuration screen, sent on change only. */
  async function report(key) {
    if (reported === key) {
      return;
    }
    reported = key;
    try {
      if (key === 'ok') {
        await gladys.setConnectionStatus(true);
      } else {
        await gladys.setConnectionStatus(false, CONNECTION_TEXT[key]);
      }
    } catch (err) {
      reported = null;
      logger.debug(`Connection status not sent (${err.message})`);
    }
  }

  /** A failed exchange with Miele: logged once while it lasts, badge updated. */
  async function handleFailure(key, label, err) {
    if (err instanceof ReauthorizationRequiredError) {
      linked = (await client.isLinked().catch(() => false)) && linked;
      issues.fail(
        'auth',
        `Miele authorization refused, the user must click Connect again (${err.message})`,
      );
      await report('reauthorize');
      return;
    }
    issues.fail(key, `${label} failed (${err.message})`);
    await report('unreachable');
  }

  function findSerial(externalId) {
    for (const serial of appliances.keys()) {
      if (idsOf(gladys, serial).device === externalId) {
        return serial;
      }
    }
    return null;
  }

  /** The name the user sees: the Gladys device name, else ours. */
  function displayName(serial) {
    const ids = idsOf(gladys, serial);
    const created = (gladys.devices ?? []).find((device) => device.external_id === ids.device);
    return created?.name || applianceName(appliances.get(serial), language());
  }

  async function publishDiscovered() {
    const list = [...appliances.values()];
    for (const appliance of list) {
      if (!announced.has(appliance.serial)) {
        announced.add(appliance.serial);
        logger.info(
          `Miele appliance found: ${applianceName(appliance, language())}${appliance.model ? ` (${appliance.model})` : ''}`,
        );
      }
    }
    try {
      await gladys.publishDiscoveredDevices(
        list.map((appliance) =>
          buildDevice(gladys, appliance, actions.get(appliance.serial) ?? null, language()),
        ),
      );
      published = new Set(list.map((appliance) => appliance.serial));
      issues.ok('discovery', 'Appliances published to Gladys again');
    } catch (err) {
      issues.fail('discovery', `Publishing the appliances to Gladys failed (${err.message})`);
    }
  }

  /** States of the given appliances, those the user added only. */
  async function publishStates(list, { onlyIds } = {}) {
    const created = onlyIds ?? createdIds();
    const states = list
      .filter((appliance) => created.has(idsOf(gladys, appliance.serial).device))
      .flatMap((appliance) =>
        buildStates(gladys, appliance, actions.get(appliance.serial) ?? null, {
          language: language(),
          now: now(),
        }),
      );
    if (states.length === 0) {
      return;
    }
    try {
      const result = await gladys.publishChangedStates(states, { heartbeat: HEARTBEAT_MS });
      logger.debug(`${result?.count ?? 0} state(s) sent to Gladys`);
      issues.ok('states', 'States reach Gladys again');
    } catch (err) {
      issues.fail('states', `Sending the states to Gladys failed (${err.message})`);
    }
  }

  async function publishTransports(list, { force = false } = {}) {
    const created = createdIds();
    const entries = [];
    for (const appliance of list) {
      const externalId = idsOf(gladys, appliance.serial).device;
      const transport = appliance.connected ? 'cloud' : 'unreachable';
      if (!created.has(externalId) || (!force && transports.get(appliance.serial) === transport)) {
        continue;
      }
      if (transports.has(appliance.serial) && transports.get(appliance.serial) !== transport) {
        logger.info(
          `${displayName(appliance.serial)}: ${appliance.connected ? 'connected to the Miele cloud again' : 'not connected to the Miele cloud'}`,
        );
      }
      transports.set(appliance.serial, transport);
      entries.push({ external_id: externalId, transport });
    }
    if (entries.length > 0) {
      await gladys.publishTransports(entries).catch((err) => {
        logger.debug(`Transport badges not sent (${err.message})`);
      });
    }
  }

  /** Scene events for the transitions of one appliance. */
  async function fireTriggers(appliance) {
    const before = previous.get(appliance.serial);
    if (appliance.status === null) {
      return;
    }
    const fault = appliance.status === STATUS.FAILURE || appliance.failure;
    const isRunning = RUNNING_STATUSES.includes(appliance.status);
    previous.set(appliance.serial, {
      status: appliance.status,
      fault,
      program: isRunning && appliance.program ? appliance.program : (before?.program ?? null),
    });
    if (!before) {
      // First sight (startup, new appliance): a state, not a transition.
      return;
    }
    const device = idsOf(gladys, appliance.serial).device;
    const name = displayName(appliance.serial);
    const events = [];
    if (
      appliance.status === STATUS.PROGRAM_ENDED &&
      before.status !== STATUS.PROGRAM_ENDED &&
      RUNNING_STATUSES.includes(before.status)
    ) {
      events.push([
        TRIGGERS.FINISHED,
        {
          device,
          device_name: name,
          program: appliance.program ?? before.program ?? '',
          energy_kwh: appliance.energyKwh,
          water_liters: appliance.waterLiters,
        },
      ]);
    }
    if (fault && !before.fault) {
      events.push([TRIGGERS.FAILURE, { device, device_name: name }]);
    }
    for (const [key, data] of events) {
      logger.debug(`Scene trigger ${key} for ${name}`);
      await gladys.publishSceneEvent(key, data).catch((err) => {
        logger.warn(`Scene trigger ${key} not delivered (${err.message})`);
      });
    }
  }

  /** Nudge the widget when what it lists changes (states, not minutes). */
  function nudgeWidget({ force = false } = {}) {
    const signature = JSON.stringify(
      [...appliances.values()].map((appliance) => [
        appliance.serial,
        appliance.status,
        appliance.program,
      ]),
    );
    if (!force && signature === widgetSignature) {
      return;
    }
    widgetSignature = signature;
    try {
      gladys.requestWidgetRefresh(WIDGET_KEY);
    } catch (err) {
      logger.debug(`Widget refresh not requested (${err.message})`);
    }
  }

  /**
   * Take in appliances read from the API or the stream.
   * @param {ReturnType<typeof parseAppliances>} list
   */
  async function apply(list) {
    let unknown = false;
    for (const appliance of list) {
      if (!published.has(appliance.serial)) {
        unknown = true;
      }
      appliances.set(appliance.serial, appliance);
    }
    for (const appliance of list) {
      await fireTriggers(appliance);
    }
    if (unknown) {
      await publishDiscovered();
    }
    await publishStates(list);
    await publishTransports(list);
    nudgeWidget();
  }

  /** The actions of the appliances that accept a command. */
  async function readActions(list) {
    for (const appliance of list) {
      if (['hob', 'robot', 'other'].includes(appliance.family) || !appliance.connected) {
        continue;
      }
      try {
        actions.set(appliance.serial, await client.getActions(appliance.serial));
      } catch (err) {
        if (err instanceof ReauthorizationRequiredError) {
          throw err;
        }
        logger.debug(
          `Actions of ${applianceName(appliance, language())} not read (${err.message})`,
        );
      }
    }
  }

  /**
   * Full read of the account, unless one ran less than `minAgeMs` ago.
   * Concurrent callers share the read in progress. Never throws.
   */
  function refresh({ minAgeMs = 0 } = {}) {
    if (reading) {
      return reading;
    }
    if (!linked || (lastReadAt !== null && now() - lastReadAt < minAgeMs)) {
      return Promise.resolve();
    }
    reading = (async () => {
      try {
        const list = parseAppliances(await client.getDevices());
        lastReadAt = now();
        await readActions(list);
        issues.ok('read', 'Miele cloud reachable again');
        issues.ok('auth', 'Miele authorization accepted again');
        await report('ok');
        await apply(list);
      } catch (err) {
        await handleFailure('read', 'Reading the Miele appliances', err);
      } finally {
        reading = null;
      }
    })();
    return reading;
  }

  function schedule() {
    clearTimeout(timer);
    timer = null;
    if (!timers || !running) {
      return;
    }
    const delay = period();
    timer = setTimeout(async () => {
      timer = null;
      await refresh({ minAgeMs: delay / 2 });
      schedule();
    }, delay);
    timer.unref?.();
  }

  function onStreamEvent({ type, data }) {
    if (type === 'devices') {
      apply(parseAppliances(data)).catch((err) =>
        logger.debug(`Stream update failed (${err.message})`),
      );
    } else if (type === 'actions' && data && typeof data === 'object') {
      for (const [serial, value] of Object.entries(data)) {
        if (value && typeof value === 'object') {
          actions.set(serial, value);
        }
      }
    } else {
      logger.debug(`Stream event "${type}" ignored`);
    }
  }

  function onStreamStatus(state, err) {
    if (state === 'connected') {
      const wasDown = !streamUp;
      streamUp = true;
      if (!streamEverUp) {
        streamEverUp = true;
        logger.info('Miele event stream connected');
      } else {
        issues.ok('stream', 'Miele event stream is back');
      }
      if (wasDown) {
        // What happened while it was down: read once, unless just done.
        refresh({ minAgeMs: 60_000 });
        schedule();
      }
      return;
    }
    const wasUp = streamUp;
    streamUp = false;
    if (state === 'failed') {
      if (err instanceof ReauthorizationRequiredError) {
        handleFailure('stream', 'Miele event stream', err);
      } else {
        issues.fail(
          'stream',
          `Miele event stream lost (${err?.message ?? 'closed'}), reading every 2 minutes meanwhile`,
        );
      }
    } else {
      logger.debug('Miele event stream closed by Miele, reopening');
    }
    if (wasUp) {
      schedule();
    }
  }

  function startStream() {
    stream?.stop();
    stream = null;
    if (!useStream) {
      return;
    }
    stream = startEventStream({
      open: (signal) => client.openEventStream(signal),
      onEvent: onStreamEvent,
      onStatus: onStreamStatus,
      retryDelay: (err) =>
        err instanceof ReauthorizationRequiredError ||
        (err instanceof MieleApiError && [403, 429].includes(err.status))
          ? STREAM_REFUSED_DELAY_MS
          : null,
      timing: streamTiming,
    });
  }

  function stopAll() {
    running = false;
    clearTimeout(timer);
    timer = null;
    stream?.stop();
    stream = null;
    streamUp = false;
  }

  /** Turn a failed command into the message the user reads. */
  function commandFailure(err) {
    if (err instanceof CommandError) {
      return err;
    }
    if (err instanceof ReauthorizationRequiredError) {
      return new CommandError(COMMAND_TEXT.notLinked, language());
    }
    const detail = err instanceof MieleApiError ? `HTTP ${err.status}` : err.message;
    return new CommandError(fillAll(COMMAND_TEXT.failed, { detail }), language());
  }

  /**
   * Check then send a user command: one info line whatever the outcome.
   * @param {string} serial
   * @param {() => object} buildBody throws a CommandError when refused
   * @param {string} what for the log line
   */
  async function send(serial, buildBody, what) {
    const name = displayName(serial);
    try {
      await client.sendAction(serial, buildBody());
    } catch (err) {
      const failure = commandFailure(err);
      logger.info(`${what} on ${name} refused: ${failure.message}`);
      throw failure;
    }
    logger.info(`${what} sent to ${name}`);
    if (!streamUp) {
      // No stream to report the result: read again shortly.
      setTimeout(() => refresh(), 5_000).unref?.();
    }
  }

  return {
    get appliances() {
      return appliances;
    },
    get linked() {
      return linked;
    },
    get streamUp() {
      return streamUp;
    },

    /** (Re)start: on connection to Gladys, a new config, a new sign-in. */
    async start() {
      stopAll();
      running = true;
      appliances.clear();
      actions.clear();
      published = new Set();
      transports.clear();
      lastReadAt = null;
      reported = null;
      gladys.forgetPublishedStates?.();
      const config = getConfig();
      if (!hasCredentials(config)) {
        linked = false;
        await report('missingCredentials');
        nudgeWidget({ force: true });
        return;
      }
      linked = await client.isLinked();
      if (!linked) {
        await report('notLinked');
        nudgeWidget({ force: true });
        return;
      }
      await refresh();
      startStream();
      schedule();
    },

    stop: stopAll,

    refresh,

    /** The core's onPoll (fallback): reads unless the container just did. */
    async poll() {
      await refresh({ minAgeMs: period() * 0.9 });
    },

    /** Gladys asks for the device list (Discover tab). */
    async scan() {
      await refresh();
      await publishDiscovered();
    },

    /** A device was added (or updated) in Gladys: send everything now. */
    async deviceCreated(device) {
      const serial = findSerial(device.external_id);
      if (!serial) {
        return;
      }
      await publishStates([appliances.get(serial)], {
        onlyIds: new Set([device.external_id]),
      });
      transports.delete(serial);
      await publishTransports([appliances.get(serial)], { force: true });
      nudgeWidget({ force: true });
    },

    /** onSetValue: a command on a feature (power, light, setpoint…). */
    async setValue(device, feature, value) {
      const serial = findSerial(device.external_id);
      const appliance = serial ? appliances.get(serial) : null;
      if (!appliance) {
        throw new CommandError(COMMAND_TEXT.unknownDevice, language());
      }
      const key = feature.external_id.slice(device.external_id.length + 1);
      await send(
        serial,
        () => featureCommand(appliance, actions.get(serial) ?? null, key, value, language()),
        `Command ${key}=${value}`,
      );
    },

    /** The `appliance_command` scene action. */
    async runCommand(deviceExternalId, command) {
      const serial = findSerial(deviceExternalId);
      const appliance = serial ? appliances.get(serial) : null;
      if (!appliance) {
        throw new CommandError(COMMAND_TEXT.unknownDevice, language());
      }
      await send(
        serial,
        () => programCommand(appliance, actions.get(serial) ?? null, command, language()),
        `Command ${command}`,
      );
    },

    displayName,
    findSerial,
  };
}
