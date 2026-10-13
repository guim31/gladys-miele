// -----------------------------------------------------------------------------
// The "Miele appliances" widget: content valid for the core (vocabulary and
// budget, checked by the SDK's own validator), rows ordered, every state.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { WIDGET_KEY } from '../src/hub.js';
import { formatMinutes } from '../src/widgets.js';
import { CONFIG, createWorld } from './helpers/world.js';

const get = async (world, language = 'fr') => {
  const ack = await world.gladys.fake.widgetGet(WIDGET_KEY, {
    settings: {},
    language,
    units: 'metric',
  });
  assert.equal(ack.success, true, ack.error);
  return ack.data.content;
};

test('the running appliances are listed, the busiest first, in a valid content', async () => {
  const world = await createWorld();
  try {
    const content = await get(world);
    assert.deepEqual(validateWidgetContent(content), []);
    assert.equal(content.ttl_seconds, 60);
    const [heading, list] = content.components;
    assert.deepEqual(heading, { type: 'text', variant: 'heading', text: '5 en marche' });
    assert.equal(list.type, 'card-list');
    assert.ok(list.items.length <= 8);
    const titles = list.items.map((item) => item.title);
    // Running with time left first: the defrosting oven (5 min), the dishwasher (15 min).
    assert.deepEqual(titles.slice(0, 2), ['Miele four', 'Miele lave-vaisselle']);
    const dishwasher = list.items[1];
    assert.deepEqual(dishwasher.badge, { text: '15 min', color: 'primary' });
    assert.match(dishwasher.subtitle, /^QuickPowerWash · Drying · fin à \d\d:\d\d$/);
    assert.ok(!titles.some((title) => /réfrigérateur|congélateur/.test(title)), 'no fridge');
    for (const item of list.items) {
      assert.ok(item.badge.text.length <= 16, item.badge.text);
    }
  } finally {
    await world.close();
  }
});

test('a programmed oven waiting for its start is shown with its state', async () => {
  const world = await createWorld();
  try {
    const content = await get(world, 'en');
    const programmed = content.components[1].items.find((item) =>
      item.subtitle.startsWith('Fan plus'),
    );
    assert.deepEqual(programmed.badge, { text: 'Programmed', color: 'info' });
  } finally {
    await world.close();
  }
});

test('the widget speaks the language Gladys asks for', async () => {
  const world = await createWorld();
  try {
    assert.equal((await get(world, 'de')).components[0].text, '5 in Betrieb');
    assert.equal((await get(world, 'es')).components[0].text, '5 en marcha');
  } finally {
    await world.close();
  }
});

test('finished and faulty appliances get their badge', async () => {
  const world = await createWorld();
  try {
    world.miele.devices.Dummy_Appliance_5.state.status.value_raw = 7;
    world.miele.devices.Dummy_Appliance_3.state.status.value_raw = 8;
    await world.app.hub.refresh();
    const items = (await get(world, 'en')).components.at(-1).items;
    assert.deepEqual(
      items.find((i) => i.title === 'Miele dishwasher' || i.title === 'Miele lave-vaisselle').badge,
      {
        text: 'Finished',
        color: 'success',
      },
    );
    assert.ok(items.some((i) => i.badge.text === 'Fault' && i.badge.color === 'danger'));
  } finally {
    await world.close();
  }
});

test('nothing running, not linked, nothing added: one line says so', async () => {
  const idle = await createWorld({
    miele: {
      devices: {
        DummyWasher: (await import('./helpers/fake-miele.js')).allAppliances().DummyWasher,
      },
    },
  });
  try {
    assert.deepEqual((await get(idle)).components, [
      { type: 'text', variant: 'caption', text: 'Aucun appareil en marche' },
    ]);
  } finally {
    await idle.close();
  }
  const unlinked = await createWorld({ linked: false });
  try {
    assert.match((await get(unlinked, 'en')).components[0].text, /not linked/);
  } finally {
    await unlinked.close();
  }
  const empty = await createWorld({ addAll: false, config: CONFIG });
  try {
    assert.match((await get(empty, 'de')).components[0].text, /Noch kein Miele-Gerät/);
  } finally {
    await empty.close();
  }
});

test('durations read "42 min" or "1 h 05"', () => {
  assert.equal(formatMinutes(42), '42 min');
  assert.equal(formatMinutes(65), '1 h 05');
  assert.equal(formatMinutes(-3), '0 min');
});
