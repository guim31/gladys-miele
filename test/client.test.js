// -----------------------------------------------------------------------------
// OAuth2 and the REST client against a fake Miele: the authorization URL,
// the code exchange, the tokens in /data (never anywhere else), the refresh
// before expiry and after a 401, the refused refresh.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PENDING_STATE_TTL_MS, createAuthStore } from '../src/miele/auth-store.js';
import {
  ReauthorizationRequiredError,
  REFRESH_MARGIN_MS,
  apiLanguage,
  createMieleClient,
} from '../src/miele/client.js';
import { createFakeMiele } from './helpers/fake-miele.js';

const REDIRECT = 'https://my.gladysassistant.com/redirect/oauth';

async function setup({ config = {}, now = () => Date.now() } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'gladys-miele-client-'));
  const miele = createFakeMiele();
  const store = createAuthStore({ dir, now });
  const settings = { client_id: 'id-1', client_secret: 'secret-1', language: 'fr', ...config };
  const client = createMieleClient({ getConfig: () => settings, store, fetch: miele.fetch, now });
  return {
    dir,
    miele,
    store,
    client,
    settings,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

test('the authorization URL carries the client id, the redirect URI and the state', async () => {
  const { client, cleanup } = await setup();
  const url = new URL(client.buildAuthorizeUrl(REDIRECT, 'state-1'));
  assert.equal(url.origin + url.pathname, 'https://api.mcs3.miele.com/thirdparty/login');
  assert.equal(url.searchParams.get('client_id'), 'id-1');
  assert.equal(url.searchParams.get('redirect_uri'), REDIRECT);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('state'), 'state-1');
  assert.ok(!url.toString().includes('secret-1'), 'the secret never goes to the browser');
  await cleanup();
});

test('without a client id, Connect explains what to fill in', async () => {
  const { client, cleanup } = await setup({ config: { client_id: '' } });
  assert.throws(() => client.buildAuthorizeUrl(REDIRECT, 's'), /client ID/);
  await cleanup();
});

test('the code is exchanged for tokens, kept in /data with owner-only rights', async () => {
  const { client, miele, store, dir, cleanup } = await setup();
  assert.equal(await client.isLinked(), false);
  await client.exchangeCode('code-1', REDIRECT);
  const [request] = miele.requests;
  assert.deepEqual(request.form, {
    grant_type: 'authorization_code',
    client_id: 'id-1',
    client_secret: 'secret-1',
    code: 'code-1',
    redirect_uri: REDIRECT,
  });
  assert.equal(await client.isLinked(), true);
  const saved = JSON.parse(await readFile(store.file, 'utf8'));
  assert.equal(saved.tokens.access_token, 'access-1');
  assert.equal(saved.tokens.client_id, 'id-1');
  assert.equal((await stat(store.file)).mode & 0o777, 0o600);
  assert.ok(store.file.startsWith(dir));
  await cleanup();
});

test('tokens issued to another client id are ignored: the user signs in again', async () => {
  const { client, store, settings, cleanup } = await setup();
  await store.setTokens('id-1', {
    access_token: 'access-1',
    refresh_token: 'r',
    expires_at: Date.now() + 9e9,
  });
  assert.equal(await client.isLinked(), true);
  settings.client_id = 'id-2';
  assert.equal(await client.isLinked(), false);
  await assert.rejects(client.getDevices(), ReauthorizationRequiredError);
  await cleanup();
});

test('the access token is refreshed a day before it expires', async () => {
  let clock = 1_000_000;
  const { client, store, miele, cleanup } = await setup({ now: () => clock });
  await store.setTokens('id-1', {
    access_token: 'access-1',
    refresh_token: 'refresh-1',
    expires_at: clock + REFRESH_MARGIN_MS + 60_000,
  });
  await client.getDevices();
  assert.equal(miele.requests.filter((r) => r.path === '/thirdparty/token').length, 0);
  clock += 120_000;
  await client.getDevices();
  const refreshes = miele.requests.filter((r) => r.path === '/thirdparty/token');
  assert.equal(refreshes.length, 1);
  assert.equal(refreshes[0].form.grant_type, 'refresh_token');
  assert.equal(refreshes[0].form.refresh_token, 'refresh-1');
  assert.equal((await store.getTokens('id-1')).refresh_token, 'refresh-2');
  await cleanup();
});

test('concurrent callers share one refresh', async () => {
  const { client, store, miele, cleanup } = await setup();
  await store.setTokens('id-1', { access_token: 'old', refresh_token: 'refresh-1', expires_at: 0 });
  await Promise.all([
    client.getDevices(),
    client.getDevices(),
    client.getActions('Dummy_Appliance_3'),
  ]);
  assert.equal(miele.requests.filter((r) => r.path === '/thirdparty/token').length, 1);
  await cleanup();
});

test('a 401 refreshes the token once and retries', async () => {
  const { client, store, miele, cleanup } = await setup();
  await store.setTokens('id-1', {
    access_token: 'revoked',
    refresh_token: 'refresh-1',
    expires_at: Date.now() + 9e9,
  });
  const devices = await client.getDevices();
  assert.ok(devices.Dummy_Appliance_1);
  assert.deepEqual(
    miele.requests.map((r) => r.path),
    ['/v1/devices', '/thirdparty/token', '/v1/devices'],
  );
  await cleanup();
});

test('a refused refresh token asks the user to sign in again', async () => {
  const { client, store, miele, cleanup } = await setup();
  miele.tokenAnswers.refresh_token = () =>
    new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'expired' }), {
      status: 400,
    });
  await store.setTokens('id-1', { access_token: 'old', refresh_token: 'refresh-1', expires_at: 0 });
  await assert.rejects(client.getDevices(), (err) => {
    assert.ok(err instanceof ReauthorizationRequiredError);
    assert.match(err.message, /invalid_grant: expired/);
    return true;
  });
  await cleanup();
});

test('the API is asked for German or English, the only languages it has', async () => {
  assert.equal(apiLanguage('de'), 'de');
  assert.equal(apiLanguage('fr'), 'en');
  assert.equal(apiLanguage('es'), 'en');
  const { client, miele, cleanup } = await setup({ config: { language: 'de' } });
  const { store } = { store: null };
  void store;
  await client.exchangeCode('c', REDIRECT);
  await client.getDevices();
  assert.equal(miele.requests.at(-1).query.language, 'de');
  await cleanup();
});

test('a command is a PUT of the action body', async () => {
  const { client, miele, cleanup } = await setup();
  await client.exchangeCode('c', REDIRECT);
  await client.sendAction('Dummy_Appliance_3', { processAction: 1 });
  assert.deepEqual(miele.sentActions, [
    { serial: 'Dummy_Appliance_3', body: { processAction: 1 } },
  ]);
  miele.actionStatus = 400;
  await assert.rejects(client.sendAction('Dummy_Appliance_3', { processAction: 1 }), /HTTP 400/);
  await cleanup();
});

test('the anti-CSRF state is single use and expires', async () => {
  let clock = 0;
  const dir = await mkdtemp(join(tmpdir(), 'gladys-miele-state-'));
  const store = createAuthStore({ dir, now: () => clock });
  const state = await store.createPendingState();
  assert.equal(await store.consumePendingState('other'), false);
  assert.equal(await store.consumePendingState(state), true);
  assert.equal(await store.consumePendingState(state), false);
  const late = await store.createPendingState();
  clock += PENDING_STATE_TTL_MS + 1;
  assert.equal(await store.consumePendingState(late), false);
  // It survives a restart of the container (a new store on the same file).
  clock = 0;
  const kept = await store.createPendingState();
  assert.equal(await createAuthStore({ dir, now: () => clock }).consumePendingState(kept), true);
  await rm(dir, { recursive: true, force: true });
});
