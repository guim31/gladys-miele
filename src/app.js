// -----------------------------------------------------------------------------
// The integration, wired on a Gladys client: every handler registered before
// connect(). index.js gives it the real client; the tests give it the SDK's
// fake Gladys and a fake Miele (`fetch`), and run it end to end.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { applianceName, parseAppliances } from './appliances.js';
import { hasCredentials, normalizeConfig } from './config.js';
import { createHub } from './hub.js';
import { CONNECTION_TEXT, OAUTH_TEXT, TEST_TEXT, fillAll } from './i18n.js';
import { createAuthStore } from './miele/auth-store.js';
import { MieleApiError, ReauthorizationRequiredError, createMieleClient } from './miele/client.js';
import { createSceneActions } from './scenes.js';
import { createWidgets } from './widgets.js';

const defaultLogger = createLogger({ name: 'miele' });

/**
 * @param {object} options
 * @param {object} options.gladys GladysIntegration, or the SDK's fake Gladys
 * @param {typeof fetch} [options.fetch] the network (a fake Miele in the tests)
 * @param {string} [options.dataDir] where the tokens live (/data)
 * @param {() => number} [options.now]
 * @param {boolean} [options.timers] periodic reads (off in most tests)
 * @param {boolean} [options.stream] event stream (off in most tests)
 * @param {object} [options.streamTiming]
 * @param {object} [options.periods] read periods (tests)
 * @param {object} [options.logger]
 */
export function createApp({
  gladys,
  fetch = globalThis.fetch,
  dataDir,
  now = () => Date.now(),
  timers = true,
  stream = true,
  streamTiming,
  periods,
  logger = defaultLogger,
}) {
  let config = normalizeConfig(gladys.config ?? {});
  const getConfig = () => config;
  const store = createAuthStore({ dir: dataDir, now });
  const client = createMieleClient({ getConfig, store, fetch, now });
  const hub = createHub({
    gladys,
    client,
    getConfig,
    now,
    timers,
    stream,
    streamTiming,
    periods,
    logger,
  });
  const restart = () => hub.start().catch((err) => logger.error(`Start failed (${err.message})`));

  // --- Devices ----------------------------------------------------------------
  gladys.onScanRequest(() => hub.scan());
  gladys.onPoll(() => hub.poll());
  gladys.onSetValue((device, feature, value) => hub.setValue(device, feature, value));
  gladys.onDeviceCreated((device) => hub.deviceCreated(device));
  gladys.onDeviceUpdated((device) => hub.deviceCreated(device));

  // --- Miele sign-in (oauth2 config field, relayed by Gladys) -----------------
  gladys.onOAuthAuthorizeUrl(async (key, redirectUri) => {
    if (!hasCredentials(config)) {
      throw new Error(CONNECTION_TEXT.missingCredentials[config.language]);
    }
    const state = await store.createPendingState();
    return client.buildAuthorizeUrl(redirectUri, state);
  });

  gladys.onOAuthCallback(async (key, { code, state, redirectUri }) => {
    if (!(await store.consumePendingState(state))) {
      throw new Error(OAUTH_TEXT.expired[config.language]);
    }
    try {
      await client.exchangeCode(code, redirectUri);
    } catch (err) {
      logger.warn(`Miele sign-in failed (${err.message})`);
      throw new Error(fillAll(OAUTH_TEXT.refused, { detail: err.message })[config.language], {
        cause: err,
      });
    }
    logger.info('Miele account linked');
    // Ack within the 5 s Gladys waits: the first read runs after.
    setTimeout(restart, 0);
  });

  // --- Configuration action -----------------------------------------------------
  gladys.onAction('test_connection', async () => {
    try {
      const list = parseAppliances(await client.getDevices());
      if (list.length === 0) {
        return TEST_TEXT.none;
      }
      const names = list.map((appliance) => applianceName(appliance, config.language)).join(', ');
      return fillAll(TEST_TEXT.ok, { n: list.length, list: names.slice(0, 120) });
    } catch (err) {
      const detail =
        err instanceof ReauthorizationRequiredError || err instanceof MieleApiError
          ? err.message
          : `network (${err.message})`;
      throw new Error(fillAll(TEST_TEXT.failed, { detail })[config.language], { cause: err });
    }
  });

  // --- Scenes and widgets -------------------------------------------------------
  for (const [key, handler] of Object.entries(createSceneActions({ hub }))) {
    gladys.onSceneAction(key, handler);
  }
  for (const [key, widget] of Object.entries(createWidgets({ gladys, hub }))) {
    gladys.onWidgetGet(key, widget.get);
  }

  // --- Life cycle ---------------------------------------------------------------
  gladys.onConfigUpdated(async (raw) => {
    const next = normalizeConfig(raw);
    const changed = JSON.stringify(next) !== JSON.stringify(config);
    config = next;
    if (changed) {
      logger.info('Configuration updated');
      await restart();
    }
  });

  gladys.on('connected', async () => {
    config = normalizeConfig(gladys.config ?? (await gladys.getConfig()));
    await restart();
  });

  gladys.on('disconnected', () => hub.stop());

  return { hub, client, store, getConfig, stop: () => hub.stop() };
}
