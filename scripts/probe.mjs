#!/usr/bin/env node
// -----------------------------------------------------------------------------
// Probe the real Miele 3rd Party API with the integration's own client, read
// only, from a machine that has the network. Prints what the integration
// would make of the account, never a token, a secret or a full serial number.
//
// 1. Sign in once (the tokens land in ./probe-data/miele-auth.json, mode 600):
//      MIELE_CLIENT_ID=… MIELE_CLIENT_SECRET=… node scripts/probe.mjs login https://localhost/callback
//    open the printed URL, sign in, copy the `code` parameter of the page you
//    land on (an error page on localhost is fine), then:
//      MIELE_CLIENT_ID=… MIELE_CLIENT_SECRET=… node scripts/probe.mjs code <code> https://localhost/callback
// 2. Probe (devices, actions, a language check, 60 s of the event stream):
//      MIELE_CLIENT_ID=… MIELE_CLIENT_SECRET=… node scripts/probe.mjs
//
// Sends no command. DATA_DIR overrides ./probe-data.
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { buildDevice, parseAppliances, stateValues } from '../src/appliances.js';
import { createAuthStore } from '../src/miele/auth-store.js';
import { API_BASE_URL } from '../src/miele/constants.js';
import { createMieleClient } from '../src/miele/client.js';
import { startEventStream } from '../src/miele/events.js';

const config = {
  client_id: process.env.MIELE_CLIENT_ID ?? '',
  client_secret: process.env.MIELE_CLIENT_SECRET ?? '',
  language: process.env.MIELE_LANGUAGE ?? 'fr',
};
if (!config.client_id || !config.client_secret) {
  console.error('Set MIELE_CLIENT_ID and MIELE_CLIENT_SECRET.');
  process.exit(2);
}
const store = createAuthStore({ dir: process.env.DATA_DIR ?? './probe-data' });
const client = createMieleClient({ getConfig: () => config, store });
const mask = (serial) => `${String(serial).slice(0, 3)}…${String(serial).slice(-2)}`;
const [command, ...args] = process.argv.slice(2);

if (command === 'login') {
  const state = await store.createPendingState();
  console.log(client.buildAuthorizeUrl(args[0], state));
  process.exit(0);
}
if (command === 'code') {
  await client.exchangeCode(args[0], args[1]);
  console.log(`Tokens saved in ${store.file}`);
  process.exit(0);
}

const gladys = createFakeGladys();
const raw = await client.getDevices();
const appliances = parseAppliances(raw);
console.log(`GET /devices: ${appliances.length} appliance(s)`);
for (const appliance of appliances) {
  let actions = null;
  try {
    actions = await client.getActions(appliance.serial);
  } catch (err) {
    console.log(`  actions of ${mask(appliance.serial)}: ${err.message}`);
  }
  const device = buildDevice(gladys, appliance, actions, config.language);
  console.log(
    `\n${mask(appliance.serial)} type ${appliance.type} (${appliance.family}) → "${device.name}"`,
  );
  console.log(
    `  features: ${device.features.map((f) => f.external_id.split(':').pop()).join(', ')}`,
  );
  console.log(
    `  states: ${JSON.stringify(stateValues(appliance, actions, { language: config.language, now: Date.now() }))}`,
  );
  console.log(`  actions: ${JSON.stringify(actions)}`);
}

// Does the API take other languages than de/en? (Documented: de, en.)
for (const language of ['fr', 'es']) {
  const token = await client.getAccessToken();
  const response = await fetch(`${API_BASE_URL}/devices?language=${language}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  const body = await response.json().catch(() => null);
  const first = body && Object.values(body)[0];
  console.log(
    `\nlanguage=${language}: HTTP ${response.status}, status reads "${first?.state?.status?.value_localized ?? '?'}"`,
  );
}

console.log('\nEvent stream, 60 s:');
const counts = {};
const stream = startEventStream({
  open: (signal) => client.openEventStream(signal),
  onEvent: ({ type, data }) => {
    counts[type] = (counts[type] ?? 0) + 1;
    console.log(
      `  ${new Date().toISOString()} ${type}: ${Object.keys(data ?? {})
        .map(mask)
        .join(', ')}`,
    );
  },
  onStatus: (state, err) => console.log(`  stream ${state}${err ? ` (${err.message})` : ''}`),
});
await new Promise((resolve) => setTimeout(resolve, 60_000));
stream.stop();
console.log(`Events: ${JSON.stringify(counts)}`);
process.exit(0);
