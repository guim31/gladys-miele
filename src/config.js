// -----------------------------------------------------------------------------
// Integration configuration: the defaults (mirroring the manifest
// `config_schema`) and the normalization of what Gladys sends.
//
// The Miele tokens are NOT here: they live in /data (src/miele/auth-store.js),
// never in the Gladys configuration.
// -----------------------------------------------------------------------------

import { LANGUAGES, pickLanguage } from './i18n.js';

export { LANGUAGES };

// Must match the `default` values of the manifest (test/manifest.test.js).
export const DEFAULT_CONFIG = {
  client_id: '',
  client_secret: '',
  language: 'fr',
};

/**
 * @param {Record<string, unknown>} [raw] config as Gladys sends it
 */
export function normalizeConfig(raw = {}) {
  const text = (value) => (typeof value === 'string' ? value.trim() : '');
  return {
    client_id: text(raw.client_id),
    client_secret: text(raw.client_secret),
    language: pickLanguage(raw.language ?? DEFAULT_CONFIG.language),
  };
}

/** Whether the developer credentials are filled in. */
export function hasCredentials(config) {
  return config.client_id !== '' && config.client_secret !== '';
}
