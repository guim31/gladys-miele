// -----------------------------------------------------------------------------
// The whole integration on the SDK's fake Gladys and a fake Miele: what a
// user sees after installing it, signing in and adding the appliances.
// -----------------------------------------------------------------------------

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { createApp } from '../../src/app.js';
import { createAuthStore } from '../../src/miele/auth-store.js';
import { createFakeMiele } from './fake-miele.js';

export const CONFIG = { client_id: 'client-id-1', client_secret: 's3cr3t-client', language: 'fr' };

/** A logger that keeps every line, by level. */
export function createCaptureLogger() {
  const lines = [];
  const write =
    (level) =>
    (...args) => {
      lines.push({
        level,
        text: args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' '),
      });
    };
  const logger = {
    lines,
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
    at: (level) => lines.filter((line) => line.level === level).map((line) => line.text),
    clear: () => lines.splice(0),
  };
  logger.child = () => logger;
  return logger;
}

/** Wait until `check()` is truthy (polled), or fail. */
export async function waitFor(check, { timeout = 2000, label = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    const result = await check();
    if (result) {
      return result;
    }
    if (Date.now() - start > timeout) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * @param {object} [options]
 * @param {object} [options.config]
 * @param {boolean} [options.linked] tokens already in /data
 * @param {boolean} [options.addAll] the user adds every discovered device
 * @param {object} [options.miele] options of the fake Miele
 * @param {object} [options.app] extra options of createApp
 */
export async function createWorld({
  config = CONFIG,
  linked = true,
  addAll = true,
  miele: mieleOptions,
  app: appOptions = {},
  now,
} = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'gladys-miele-'));
  const miele = createFakeMiele(mieleOptions);
  if (linked) {
    await createAuthStore({ dir: dataDir }).setTokens(config.client_id, {
      access_token: 'access-1',
      refresh_token: 'refresh-1',
      expires_at: Date.now() + 30 * 24 * 3600 * 1000,
    });
  }
  const gladys = createFakeGladys({ config });
  const logger = createCaptureLogger();
  const app = createApp({
    gladys,
    fetch: miele.fetch,
    dataDir,
    timers: false,
    stream: false,
    logger,
    ...(now ? { now } : {}),
    ...appOptions,
  });
  await gladys.connect();
  if (addAll) {
    for (const device of gladys.fake.discoveredDevices) {
      await gladys.fake.deviceCreated(device);
    }
  }
  return {
    gladys,
    app,
    miele,
    logger,
    dataDir,
    /** The fake Gladys' devices by appliance serial. */
    device: (serial) =>
      gladys.fake.discoveredDevices.find((d) => d.external_id.endsWith(`:appliance:${serial}`)),
    async close() {
      app.stop();
      await gladys.disconnect().catch(() => {});
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}
