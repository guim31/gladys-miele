// -----------------------------------------------------------------------------
// The integration end to end, on the SDK's fake Gladys and a fake Miele:
// sign-in, refresh by the container's own timer (without onPoll), the event
// stream, the scene triggers, the commands, quiet logs and no secret in them.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { HEARTBEAT_MS, TRIGGERS, WIDGET_KEY } from '../src/hub.js';
import { CONFIG, createWorld, waitFor } from './helpers/world.js';

const FEATURE = (world, serial, key) => `${world.device(serial).external_id}:${key}`;

/** Make the fixture dishwasher reach the end of its program. */
function finishDishwasher(devices) {
  const state = devices.Dummy_Appliance_5.state;
  state.status = { value_raw: 7, value_localized: 'Finished', key_localized: 'status' };
  state.remainingTime = [0, 0];
  state.programPhase = {
    value_raw: 1800,
    value_localized: 'Finished',
    key_localized: 'Program phase',
  };
}

test('nothing is read nor published before the account is linked', async () => {
  const world = await createWorld({ linked: false });
  try {
    assert.deepEqual(world.gladys.fake.discoveredDevices, []);
    assert.equal(world.miele.requests.length, 0);
    assert.equal(world.gladys.fake.connectionStatus.connected, false);
    assert.match(world.gladys.fake.connectionStatus.message.fr, /Connecter/);
  } finally {
    await world.close();
  }
});

test('missing credentials are reported before anything else', async () => {
  const world = await createWorld({ linked: false, config: { language: 'en' } });
  try {
    assert.match(world.gladys.fake.connectionStatus.message.en, /client ID and client secret/);
  } finally {
    await world.close();
  }
});

test('sign-in: authorization URL, callback, tokens in /data, then the appliances', async () => {
  const world = await createWorld({ linked: false });
  try {
    const REDIRECT = 'https://my.gladysassistant.com/redirect/oauth';
    const ack = await world.gladys.fake.oauthAuthorizeUrl('account', REDIRECT);
    assert.equal(ack.success, true);
    const url = new URL(ack.data.authorize_url);
    const state = url.searchParams.get('state');
    assert.ok(state.length >= 32);

    const forged = await world.gladys.fake.oauthCallback('account', {
      code: 'code-1',
      state: 'forged',
      redirectUri: REDIRECT,
    });
    assert.equal(forged.success, false);
    assert.match(forged.error, /cliquez à nouveau sur Connecter/);

    const ok = await world.gladys.fake.oauthCallback('account', {
      code: 'code-1',
      state,
      redirectUri: REDIRECT,
    });
    assert.deepEqual(ok, { success: true });
    await waitFor(() => world.gladys.fake.discoveredDevices.length > 0, { label: 'discovery' });
    assert.equal(world.gladys.fake.connectionStatus.connected, true);
    const saved = await readFile(world.app.store.file, 'utf8');
    assert.match(saved, /access-1/);
    assert.ok(world.logger.at('info').includes('Miele account linked'));
  } finally {
    await world.close();
  }
});

test('the states of the added devices are published, the others are not', async () => {
  const world = await createWorld({ addAll: false });
  try {
    assert.equal(world.gladys.fake.states.length, 0);
    const dishwasher = world.device('Dummy_Appliance_5');
    await world.gladys.fake.deviceCreated(dishwasher);
    assert.ok(world.gladys.fake.states.length > 0);
    assert.ok(
      world.gladys.fake.states.every((s) =>
        s.device_feature_external_id.startsWith(dishwasher.external_id),
      ),
    );
    assert.deepEqual(
      world.gladys.fake.lastState(FEATURE(world, 'Dummy_Appliance_5', 'status')),
      'En marche',
    );
    // The widget is nudged, the badge published.
    assert.ok(world.gladys.fake.widgetRefreshes.includes(WIDGET_KEY));
    assert.deepEqual(world.gladys.fake.transports.at(-1), {
      device_external_id: dishwasher.external_id,
      transport: 'cloud',
    });
  } finally {
    await world.close();
  }
});

test('the container refreshes the states by itself, without onPoll', async () => {
  const world = await createWorld({
    app: { timers: true, periods: { fallbackMs: 30, streamingMs: 30 } },
  });
  try {
    const remaining = FEATURE(world, 'Dummy_Appliance_5', 'remaining_time');
    assert.equal(world.gladys.fake.lastState(remaining), 15);
    world.miele.devices.Dummy_Appliance_5.state.remainingTime = [0, 9];
    await waitFor(() => world.gladys.fake.lastState(remaining) === 9, { label: 'timer refresh' });
    // No onPoll was ever called: the fake records the ack of every command.
    assert.ok(!world.gladys.fake.wsMessages.some((m) => JSON.stringify(m).includes('"poll"')));
  } finally {
    await world.close();
  }
});

test('onPoll is a fallback that skips when the container read recently', async () => {
  const world = await createWorld();
  try {
    const reads = () => world.miele.requests.filter((r) => r.path === '/v1/devices').length;
    const before = reads();
    const ack = await world.gladys.fake.poll(world.device('Dummy_Appliance_5'));
    assert.equal(ack.success, true);
    assert.equal(reads(), before);
  } finally {
    await world.close();
  }
});

test('only the changes are published, with a heartbeat well under 12 hours', async (t) => {
  const world = await createWorld();
  try {
    const calls = [];
    const original = world.gladys.publishChangedStates.bind(world.gladys);
    t.mock.method(world.gladys, 'publishChangedStates', (states, options) => {
      calls.push(options);
      return original(states, options);
    });
    const count = world.gladys.fake.states.length;
    await world.app.hub.refresh();
    assert.equal(world.gladys.fake.states.length, count, 'an unchanged read publishes nothing');
    assert.ok(calls.length > 0 && calls.every((options) => options.heartbeat === HEARTBEAT_MS));
    assert.ok(HEARTBEAT_MS <= 12 * 3600 * 1000);
  } finally {
    await world.close();
  }
});

test('the stream brings the changes, and "program finished" fires once per transition', async () => {
  const world = await createWorld({ app: { stream: true } });
  try {
    await waitFor(() => world.app.hub.streamUp, { label: 'stream' });
    assert.deepEqual(world.gladys.fake.sceneEvents, [], 'nothing fired at startup');

    const devices = structuredClone(world.miele.devices);
    finishDishwasher(devices);
    world.miele.push('devices', { Dummy_Appliance_5: devices.Dummy_Appliance_5 });
    await waitFor(() => world.gladys.fake.sceneEvents.length === 1, { label: 'trigger' });
    const [event] = world.gladys.fake.sceneEvents;
    assert.equal(event.key, TRIGGERS.FINISHED);
    assert.deepEqual(event.data, {
      device: world.device('Dummy_Appliance_5').external_id,
      device_name: 'Miele lave-vaisselle',
      program: 'QuickPowerWash',
      energy_kwh: 1.4,
      water_liters: 12,
    });
    assert.equal(
      world.gladys.fake.lastState(FEATURE(world, 'Dummy_Appliance_5', 'status')),
      'Terminé',
    );
    // The data carries the declared filter fields and variables, nothing else.
    const manifest = JSON.parse(
      await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
    );
    for (const trigger of manifest.scene_triggers) {
      const declared = [
        ...trigger.fields.map((f) => f.key),
        ...trigger.variables.map((v) => v.key),
      ];
      if (trigger.key === TRIGGERS.FINISHED) {
        assert.deepEqual(Object.keys(event.data).sort(), declared.sort());
      }
      if (trigger.key === TRIGGERS.FAILURE) {
        assert.deepEqual(declared.sort(), ['device', 'device_name']);
      }
    }

    // The same state again (stream, then a read): no second event.
    world.miele.push('devices', { Dummy_Appliance_5: devices.Dummy_Appliance_5 });
    world.miele.devices = devices;
    await world.app.hub.refresh();
    assert.equal(world.gladys.fake.sceneEvents.length, 1);
  } finally {
    await world.close();
  }
});

test('a fault fires "appliance failure" once', async () => {
  const world = await createWorld();
  try {
    world.miele.devices.Dummy_Appliance_3.state.signalFailure = true;
    await world.app.hub.refresh();
    world.miele.devices.Dummy_Appliance_3.state.status.value_raw = 8;
    await world.app.hub.refresh();
    assert.deepEqual(
      world.gladys.fake.sceneEvents.map((e) => [e.key, e.data.device_name]),
      [[TRIGGERS.FAILURE, 'Miele lave-linge']],
    );
  } finally {
    await world.close();
  }
});

test('an appliance that drops off the Miele cloud gets the unreachable badge', async () => {
  const world = await createWorld();
  try {
    world.miele.devices.Dummy_Appliance_3.state.status.value_raw = 255;
    await world.app.hub.refresh();
    assert.deepEqual(world.gladys.fake.transports.at(-1), {
      device_external_id: world.device('Dummy_Appliance_3').external_id,
      transport: 'unreachable',
    });
    assert.equal(
      world.gladys.fake.lastState(FEATURE(world, 'Dummy_Appliance_3', 'status')),
      'Non connecté',
    );
    assert.ok(
      world.logger.at('info').some((line) => /not connected to the Miele cloud/.test(line)),
    );
  } finally {
    await world.close();
  }
});

test('a new appliance appearing in the stream is published to Gladys', async () => {
  const world = await createWorld({
    miele: {
      devices: {
        Dummy_Appliance_5: (await import('./helpers/fake-miele.js')).allAppliances()
          .Dummy_Appliance_5,
      },
    },
    app: { stream: true },
  });
  try {
    await waitFor(() => world.app.hub.streamUp, { label: 'stream' });
    assert.equal(world.gladys.fake.discoveredDevices.length, 1);
    const { allAppliances } = await import('./helpers/fake-miele.js');
    world.miele.push('devices', { DummyWasher: allAppliances().DummyWasher });
    await waitFor(() => world.gladys.fake.discoveredDevices.length === 2, {
      label: 'new appliance',
    });
  } finally {
    await world.close();
  }
});

test('a feature command goes to Miele, a refused one tells why', async () => {
  const world = await createWorld();
  try {
    // The fixture oven accepts "light off" only (actions.light = [2]).
    const oven = world.device('DummyAppliance_12');
    const light = oven.features.find((f) => f.external_id.endsWith(':light'));
    const ack = await world.gladys.fake.setValue(oven, light, 0);
    assert.equal(ack.success, true);
    assert.deepEqual(world.miele.sentActions.at(-1), {
      serial: 'DummyAppliance_12',
      body: { light: 2 },
    });
    assert.ok(world.logger.at('info').includes('Command light=0 sent to Miele four'));

    const sent = world.miele.sentActions.length;
    const notNow = await world.gladys.fake.setValue(oven, light, 1);
    assert.equal(notNow.success, false);
    assert.match(notNow.error, /n'accepte pas cette commande maintenant/);
    assert.equal(world.miele.sentActions.length, sent);

    world.miele.actionStatus = 400;
    const washer = world.device('DummyWasher');
    const power = washer.features.find((f) => f.external_id.endsWith(':power'));
    const refused = await world.gladys.fake.setValue(washer, power, 1);
    assert.equal(refused.success, false);
    assert.match(refused.error, /Miele a refusé la commande \(HTTP 400\)/);
    assert.ok(
      world.logger
        .at('info')
        .some((line) => /^Command power=1 on Miele lave-linge refused/.test(line)),
    );
  } finally {
    await world.close();
  }
});

test('the scene action starts a washing machine, never an oven', async () => {
  const world = await createWorld();
  try {
    const washer = world.device('Dummy_Appliance_3');
    const ack = await world.gladys.fake.sceneAction('appliance_command', {
      device: washer.external_id,
      command: 'start',
    });
    assert.deepEqual(ack, { success: true, data: { outputs: { sent: true } } });
    assert.deepEqual(world.miele.sentActions.at(-1), {
      serial: 'Dummy_Appliance_3',
      body: { processAction: 1 },
    });

    const sent = world.miele.sentActions.length;
    const oven = world.device('DummyAppliance_12');
    const refused = await world.gladys.fake.sceneAction('appliance_command', {
      device: oven.external_id,
      command: 'start',
    });
    assert.equal(refused.success, false);
    assert.match(refused.error, /appareil de cuisson/);
    assert.equal(world.miele.sentActions.length, sent, 'nothing sent to the oven');
  } finally {
    await world.close();
  }
});

test('the connection test lists the appliances', async () => {
  const world = await createWorld({ config: { ...CONFIG, language: 'en' } });
  try {
    const ack = await world.gladys.fake.action('test_connection', {});
    assert.equal(ack.success, true);
    assert.match(ack.data.message.fr, /^Connecté à Miele : 17 appareil\(s\)/);
    world.miele.devicesStatus = 0;
    const failed = await world.gladys.fake.action('test_connection', {});
    assert.equal(failed.success, false);
    assert.match(failed.error, /Miele cannot be reached: network/);
  } finally {
    await world.close();
  }
});

test('a Miele outage is reported once, and its end once', async () => {
  const world = await createWorld();
  try {
    world.logger.clear();
    world.miele.devicesStatus = 503;
    await world.app.hub.refresh();
    await world.app.hub.refresh();
    await world.app.hub.refresh();
    assert.equal(world.logger.at('warn').length, 1);
    assert.equal(world.gladys.fake.connectionStatus.connected, false);
    world.miele.devicesStatus = 200;
    await world.app.hub.refresh();
    assert.deepEqual(world.logger.at('info'), ['Miele cloud reachable again']);
    assert.equal(world.gladys.fake.connectionStatus.connected, true);
  } finally {
    await world.close();
  }
});

test('a normal cycle writes nothing at info level, and no secret ever reaches the logs', async () => {
  const world = await createWorld({ app: { stream: true } });
  try {
    await waitFor(() => world.app.hub.streamUp, { label: 'stream' });
    const startup = world.logger.lines.length;
    world.logger.lines.splice(0); // the startup lines (life cycle) are allowed
    assert.ok(startup > 0);

    // A normal cycle: a read, stream changes, the widget, a poll.
    world.miele.devices.Dummy_Appliance_5.state.remainingTime = [0, 14];
    await world.app.hub.refresh();
    const devices = structuredClone(world.miele.devices);
    devices.Dummy_Appliance_5.state.remainingTime = [0, 13];
    world.miele.push('devices', { Dummy_Appliance_5: devices.Dummy_Appliance_5 });
    world.miele.push('actions', { Dummy_Appliance_5: { processAction: [] } });
    await waitFor(
      () =>
        world.gladys.fake.lastState(FEATURE(world, 'Dummy_Appliance_5', 'remaining_time')) === 13,
      { label: 'stream update' },
    );
    await world.gladys.fake.widgetGet(WIDGET_KEY, {
      settings: {},
      language: 'fr',
      units: 'metric',
    });
    await world.gladys.fake.poll(world.device('Dummy_Appliance_5'));
    assert.deepEqual(world.logger.at('info'), []);
    assert.deepEqual(world.logger.at('warn'), []);

    // Secrets: the client secret and the tokens, at every level, whole run.
    world.miele.closeStreams();
    world.miele.devicesStatus = 401;
    await world.app.hub.refresh();
    const everything = world.logger.lines.map((line) => line.text).join('\n');
    for (const secret of [CONFIG.client_secret, 'access-1', 'refresh-1', 'refresh-2']) {
      assert.ok(!everything.includes(secret), `"${secret}" found in the logs`);
    }
  } finally {
    await world.close();
  }
});

test('a new language republishes the texts in it', async () => {
  const world = await createWorld();
  try {
    const status = FEATURE(world, 'Dummy_Appliance_5', 'status');
    assert.equal(world.gladys.fake.lastState(status), 'En marche');
    await world.gladys.fake.configUpdated({ ...CONFIG, language: 'de' });
    assert.equal(world.gladys.fake.lastState(status), 'In Betrieb');
  } finally {
    await world.close();
  }
});
