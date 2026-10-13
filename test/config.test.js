import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, hasCredentials, normalizeConfig } from '../src/config.js';

test('the defaults: no credentials, French', () => {
  assert.deepEqual(normalizeConfig(), DEFAULT_CONFIG);
  assert.equal(hasCredentials(normalizeConfig()), false);
});

test('credentials are trimmed (a paste often brings a space), an unknown language falls back to French', () => {
  const config = normalizeConfig({ client_id: ' id \n', client_secret: ' s ', language: 'it' });
  assert.deepEqual(config, { client_id: 'id', client_secret: 's', language: 'fr' });
  assert.equal(hasCredentials(config), true);
  assert.equal(normalizeConfig({ language: 'es' }).language, 'es');
  assert.equal(normalizeConfig({ client_id: 42 }).client_id, '');
});
