// -----------------------------------------------------------------------------
// The two gates of a command: safety (nothing that heats food is started
// remotely), then availability (what the appliance accepts right now).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAppliances } from '../src/appliances.js';
import { CommandError, featureCommand, programCommand } from '../src/commands.js';
import { COMMAND_KEYS_BY_FAMILY } from '../src/appliances.js';
import { allActions, allAppliances } from './helpers/fake-miele.js';

const appliances = Object.fromEntries(parseAppliances(allAppliances()).map((a) => [a.serial, a]));
const actions = allActions();

const refusal = (fn) => {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof CommandError, err.message);
    return err;
  }
  assert.fail('the command was not refused');
};

test('no command key ever reaches a cooking appliance but the light', () => {
  assert.deepEqual(COMMAND_KEYS_BY_FAMILY.oven, ['light']);
  assert.deepEqual(COMMAND_KEYS_BY_FAMILY.hob, []);
  const oven = appliances.DummyAppliance_12;
  for (const key of ['power', 'target_temperature_1', 'supercooling', 'program']) {
    const err = refusal(() => featureCommand(oven, null, key, 1, 'fr'));
    assert.match(err.texts.en, /never starts a cooking appliance/);
  }
  assert.deepEqual(featureCommand(oven, null, 'light', 0, 'fr'), { light: 2 });
});

test('a program is never started on an oven or a hob, but may be stopped on an oven', () => {
  const oven = appliances.DummyAppliance_12;
  const hob = appliances.DummyAppliance_hob_w_extr;
  refusal(() => programCommand(oven, null, 'start', 'fr'));
  refusal(() => programCommand(oven, null, 'pause', 'fr'));
  refusal(() => programCommand(hob, null, 'stop', 'fr'));
  assert.deepEqual(programCommand(oven, null, 'stop', 'fr'), { processAction: 2 });
  refusal(() => programCommand(appliances.Dummy_Appliance_5, null, 'explode', 'fr'));
});

test('start, pause and stop a washing machine that accepts them', () => {
  const washer = appliances.Dummy_Appliance_3;
  const accepts = actions.Dummy_Appliance_3; // processAction [1, 2, 3]
  assert.deepEqual(programCommand(washer, accepts, 'start', 'fr'), { processAction: 1 });
  assert.deepEqual(programCommand(washer, accepts, 'pause', 'fr'), { processAction: 3 });
  assert.deepEqual(programCommand(washer, accepts, 'stop', 'fr'), { processAction: 2 });
});

test('a start the appliance does not accept now explains Remote Start', () => {
  const washer = appliances.Dummy_Appliance_3;
  const err = refusal(() => programCommand(washer, { processAction: [] }, 'start', 'en'));
  assert.match(err.message, /Remote Start/);
});

test('power follows what the appliance accepts', () => {
  const washer = appliances.Dummy_Appliance_3;
  assert.deepEqual(featureCommand(washer, { powerOn: true, powerOff: false }, 'power', 1, 'fr'), {
    powerOn: true,
  });
  refusal(() => featureCommand(washer, { powerOn: true, powerOff: false }, 'power', 0, 'fr'));
  // Unknown actions (not read yet): the API decides.
  assert.deepEqual(featureCommand(washer, null, 'power', 0, 'fr'), { powerOff: true });
});

test('a fridge setpoint is rounded and kept within the range of the zone', () => {
  const fridgeFreezer = appliances.DummyAppliance_Fridge_Freezer;
  const accepts = actions.DummyAppliance_Fridge_Freezer;
  assert.deepEqual(featureCommand(fridgeFreezer, accepts, 'target_temperature_1', 4.4, 'fr'), {
    targetTemperature: [{ zone: 1, value: 4 }],
  });
  assert.deepEqual(featureCommand(fridgeFreezer, accepts, 'target_temperature_2', -20, 'fr'), {
    targetTemperature: [{ zone: 2, value: -20 }],
  });
  const err = refusal(() =>
    featureCommand(fridgeFreezer, accepts, 'target_temperature_1', 15, 'fr'),
  );
  assert.match(err.message, /1 à 9 °C/);
});

test('SuperCool and SuperFreeze use their process actions', () => {
  const fridgeFreezer = appliances.DummyAppliance_Fridge_Freezer;
  assert.deepEqual(featureCommand(fridgeFreezer, null, 'supercooling', 1, 'fr'), {
    processAction: 6,
  });
  assert.deepEqual(featureCommand(fridgeFreezer, null, 'superfreezing', 0, 'fr'), {
    processAction: 5,
  });
  // The fixture fridge-freezer accepts only "start SuperCool" right now.
  refusal(() =>
    featureCommand(fridgeFreezer, actions.DummyAppliance_Fridge_Freezer, 'superfreezing', 1, 'fr'),
  );
});

test('the hood light follows the light actions', () => {
  const hood = appliances.DummyAppliance_18;
  assert.deepEqual(featureCommand(hood, null, 'light', 1, 'fr'), { light: 1 });
  refusal(() => featureCommand(hood, { light: [] }, 'light', 1, 'fr'));
});

test('a robot vacuum has no command in Gladys', () => {
  const err = refusal(() => featureCommand(appliances.Dummy_Vacuum_1, null, 'power', 1, 'en'));
  assert.match(err.message, /does not offer this command/);
});
