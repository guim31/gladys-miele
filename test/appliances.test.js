// -----------------------------------------------------------------------------
// The device model on the real answers of the API: features per family,
// values read from the state, the traps of the core (opening sensor
// inverted, empty texts, stable external ids).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import {
  NO_VALUE,
  buildDevice,
  featureSpecs,
  parseAppliance,
  parseAppliances,
  stateValues,
  zoneCount,
} from '../src/appliances.js';
import { FAMILY_TYPES, TYPE, familyOf } from '../src/miele/constants.js';
import { allActions, allAppliances, fixture } from './helpers/fake-miele.js';

const gladys = createFakeGladys();
const appliances = Object.fromEntries(parseAppliances(allAppliances()).map((a) => [a.serial, a]));
const actions = allActions();
const keysOf = (serial) =>
  featureSpecs(appliances[serial], actions[serial] ?? null).map((s) => s.key);
const NOW = Date.UTC(2026, 9, 13, 18, 0, 0);
const values = (serial, language = 'fr') =>
  stateValues(appliances[serial], actions[serial] ?? null, { language, now: NOW });

test('every type the API knows belongs to one family exactly', () => {
  const all = Object.values(TYPE);
  for (const type of all) {
    const families = Object.entries(FAMILY_TYPES).filter(([, types]) => types.includes(type));
    assert.equal(families.length, 1, `type ${type} is in ${families.map(([f]) => f)}`);
  }
  assert.equal(familyOf(999), 'other');
});

test('the external ids are built from the serial number, never from a name', () => {
  const device = buildDevice(gladys, appliances.Dummy_Appliance_5, null, 'fr');
  assert.equal(device.external_id, 'ext:test-integration:appliance:Dummy_Appliance_5');
  assert.deepEqual(
    device.features.map((feature) => feature.external_id.split(':').pop()),
    keysOf('Dummy_Appliance_5'),
  );
  // Same structure in every language: only the names change.
  const english = buildDevice(gladys, appliances.Dummy_Appliance_5, null, 'en');
  assert.deepEqual(
    english.features.map((feature) => feature.external_id),
    device.features.map((feature) => feature.external_id),
  );
  assert.equal(english.name, 'Miele dishwasher');
  assert.equal(device.name, 'Miele lave-vaisselle');
});

test('the name the user gave the appliance in the Miele app wins', () => {
  const hob = appliances.DummyAppliance_hob_w_extr;
  assert.equal(buildDevice(gladys, hob, null, 'fr').name, 'KDMA7774 | APP2-2');
});

test('a dishwasher in its drying phase', () => {
  assert.deepEqual(values('Dummy_Appliance_5'), {
    status: { text: 'En marche' },
    program: { text: 'QuickPowerWash' },
    phase: { text: 'Drying' },
    remaining_time: 15,
    elapsed_time: 59,
    end_time: {
      text: new Intl.DateTimeFormat('fr', {
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).format(NOW + 15 * 60000),
    },
    door: 1,
    power: 1,
    energy: 1.4,
    water: 12,
  });
});

test('the door of an opening sensor is 0 when open, 1 when closed (Gladys convention)', () => {
  // Fixture washer: signalDoor true = door open.
  assert.equal(appliances.Dummy_Appliance_3.doorOpen, true);
  assert.equal(values('Dummy_Appliance_3').door, 0);
  assert.equal(appliances.Dummy_Appliance_5.doorOpen, false);
  assert.equal(values('Dummy_Appliance_5').door, 1);
});

test('an appliance off shows no program, no time left, no end, never an empty text', () => {
  const washer = values('Dummy_Appliance_3');
  assert.deepEqual(washer.status, { text: 'Éteint' });
  assert.deepEqual(washer.program, { text: NO_VALUE });
  assert.deepEqual(washer.phase, { text: NO_VALUE });
  assert.deepEqual(washer.end_time, { text: NO_VALUE });
  assert.equal(washer.remaining_time, 0);
  assert.equal(washer.power, 0);
});

test('temperatures are in degrees, the zones without value are left out', () => {
  const fridgeFreezer = values('DummyAppliance_Fridge_Freezer');
  assert.equal(fridgeFreezer.temperature_1, 4);
  assert.equal(fridgeFreezer.temperature_2, -18);
  assert.equal(fridgeFreezer.temperature_3, -28);
  assert.equal(fridgeFreezer.target_temperature_2, -18);
  const freezer = values('Dummy_Appliance_1');
  assert.equal(freezer.temperature_1, -18);
  assert.equal(freezer.temperature_2, undefined);
  assert.equal(freezer.target_temperature_1, -18);
});

test('a fridge-freezer names its zones, and takes its setpoint ranges from the appliance', () => {
  const device = buildDevice(
    gladys,
    appliances.DummyAppliance_Fridge_Freezer,
    actions.DummyAppliance_Fridge_Freezer,
    'fr',
  );
  const byKey = Object.fromEntries(device.features.map((f) => [f.external_id.split(':').pop(), f]));
  assert.equal(byKey.temperature_1.name, 'Température réfrigérateur');
  assert.equal(byKey.temperature_2.name, 'Température congélateur');
  assert.equal(byKey.temperature_3.name, 'Température zone 3');
  assert.deepEqual([byKey.target_temperature_1.min, byKey.target_temperature_1.max], [1, 9]);
  assert.deepEqual([byKey.target_temperature_2.min, byKey.target_temperature_2.max], [-28, -14]);
  assert.deepEqual([byKey.target_temperature_3.min, byKey.target_temperature_3.max], [-30, -15]);
  assert.equal(byKey.target_temperature_1.read_only, false);
});

test('an offline appliance keeps the zones of its type, and publishes its state only', () => {
  const offline = parseAppliance(
    'DummyAppliance_Fridge_Freezer_Offline',
    fixture('fridge_freezer').DummyAppliance_Fridge_Freezer_Offline,
  );
  assert.equal(offline.connected, false);
  assert.equal(zoneCount(offline, null), 2);
  assert.deepEqual(stateValues(offline, null, { language: 'en', now: NOW }), {
    status: { text: 'Not connected' },
  });
});

test('ovens, hobs and microwaves are read only, their light aside', () => {
  const cooking = Object.values(appliances).filter((a) => ['oven', 'hob'].includes(a.family));
  assert.ok(cooking.length >= 4);
  for (const appliance of cooking) {
    const writable = featureSpecs(appliance, actions[appliance.serial] ?? null)
      .filter((spec) => !spec.read_only)
      .map((spec) => spec.key);
    assert.ok(
      writable.every((key) => key === 'light'),
      `${appliance.serial}: ${writable.join(', ')} writable`,
    );
  }
  // The oven setpoint is shown, as a sensor, never as a thermostat.
  const oven = featureSpecs(appliances.DummyAppliance_12, null);
  const target = oven.find((spec) => spec.key === 'target_temperature_1');
  assert.equal(target.category, 'temperature-sensor');
  assert.equal(target.read_only, true);
});

test('an oven reads its temperature, setpoint and food probe', () => {
  const oven = values('DummyAppliance_12');
  assert.equal(oven.temperature_1, 19.54);
  assert.equal(oven.target_temperature_1, 25);
  assert.equal(oven.core_temperature, 22);
  assert.equal(oven.light, 1);
  assert.deepEqual(oven.program, { text: 'Defrost' });
});

test('a robot vacuum reports its battery', () => {
  assert.equal(values('Dummy_Vacuum_1').battery, 65);
  assert.deepEqual(keysOf('Dummy_Vacuum_1'), ['status', 'program', 'phase', 'battery']);
});

test('the hood offers power and light, the coffee machine no timer', () => {
  assert.deepEqual(keysOf('DummyAppliance_18'), ['status', 'power', 'light']);
  assert.ok(!keysOf('DummyAppliance_CoffeeSystem').includes('remaining_time'));
});

test('a delayed start shows when it will end', () => {
  const waiting = {
    ...appliances.Dummy_Appliance_5,
    status: 4,
    startDelayMinutes: 120,
    remainingMinutes: 90,
  };
  const states = stateValues(waiting, null, { language: 'en', now: NOW });
  assert.deepEqual(states.status, { text: 'Waiting to start' });
  assert.equal(states.remaining_time, 90);
  const end = new Intl.DateTimeFormat('en', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(NOW + 210 * 60000);
  assert.deepEqual(states.end_time, { text: end });
});

test('a paused program has no expected end', () => {
  const paused = { ...appliances.Dummy_Appliance_5, status: 6 };
  assert.deepEqual(stateValues(paused, null, { language: 'en', now: NOW }).end_time, {
    text: NO_VALUE,
  });
});

test('an unknown status code still gives a readable text', () => {
  const odd = { ...appliances.Dummy_Appliance_5, status: 42 };
  assert.deepEqual(stateValues(odd, null, { language: 'en', now: NOW }).status, {
    text: 'Unknown (42)',
  });
});

test('a malformed answer gives no appliance rather than a crash', () => {
  assert.deepEqual(parseAppliances(null), []);
  assert.deepEqual(parseAppliances([]), []);
  assert.deepEqual(parseAppliances({ a: null, b: { state: {} } }), []);
  const bare = parseAppliance('x', { ident: {}, state: {} });
  assert.equal(bare.family, 'other');
  assert.deepEqual(
    featureSpecs(bare, null).map((s) => s.key),
    ['status'],
  );
});
