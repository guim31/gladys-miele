// -----------------------------------------------------------------------------
// Miele 3rd Party API client: OAuth2 (authorization code grant) and REST.
//
// Gladys carries the browser part of the sign-in (`oauth2` config field): the
// core asks us for the authorization URL, then hands us the code Miele sent
// back. This file builds that URL, exchanges the code, keeps the access token
// fresh with the refresh token, and signs every API request.
//
// `fetch` is injectable: the tests run the whole client against a fake Miele
// that serves the real answers of the API (test/fixtures/miele/), never the
// network.
// -----------------------------------------------------------------------------

import { API_BASE_URL, API_LANGUAGES, OAUTH_AUTHORIZE_URL, OAUTH_TOKEN_URL } from './constants.js';

/** Budget of an API request. */
export const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Budget of the code exchange. Gladys waits 5 s for the ack of the OAuth
 * callback, then tells the user the integration refused the connection,
 * whatever we answer later: better fail in time with our own message.
 */
export const EXCHANGE_TIMEOUT_MS = 3_500;

/** Refresh the access token this long before it expires. */
export const REFRESH_MARGIN_MS = 24 * 60 * 60 * 1000;

/** The user must sign in again (no token, or the refresh token is refused). */
export class ReauthorizationRequiredError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReauthorizationRequiredError';
  }
}

/** The API answered with an error status. */
export class MieleApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'MieleApiError';
    this.status = status;
  }
}

/** The language the API should localize program and phase names in. */
export function apiLanguage(language) {
  return API_LANGUAGES.includes(language) ? language : 'en';
}

/**
 * @param {object} options
 * @param {() => { client_id: string, client_secret: string, language: string }} options.getConfig
 * @param {ReturnType<import('./auth-store.js').createAuthStore>} options.store
 * @param {typeof fetch} [options.fetch]
 * @param {() => number} [options.now]
 */
export function createMieleClient({ getConfig, store, fetch = globalThis.fetch, now = Date.now }) {
  /** The refresh in progress: concurrent callers wait for the same one. */
  let refreshing = null;

  async function tokenRequest(params, timeoutMs) {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') {
        body.set(key, String(value));
      }
    }
    const response = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = await readJson(response);
    if (!response.ok) {
      // Never the body as such: it could echo a token. The OAuth error code
      // and its description are enough to understand.
      const detail = [payload?.error, payload?.error_description]
        .filter((part) => typeof part === 'string' && part !== '')
        .join(': ');
      const message = `Miele refused the token request (HTTP ${response.status}${detail ? `, ${detail}` : ''})`;
      if (response.status === 400 || response.status === 401) {
        throw new ReauthorizationRequiredError(message);
      }
      throw new MieleApiError(response.status, message);
    }
    if (typeof payload?.access_token !== 'string' || payload.access_token === '') {
      throw new MieleApiError(response.status, 'Miele sent no access token');
    }
    const lifetime = Number(payload.expires_in);
    return {
      access_token: payload.access_token,
      refresh_token: payload.refresh_token ?? params.refresh_token ?? null,
      expires_at: now() + (Number.isFinite(lifetime) && lifetime > 0 ? lifetime : 86_400) * 1000,
    };
  }

  async function refresh(tokens) {
    const config = getConfig();
    if (!tokens.refresh_token) {
      throw new ReauthorizationRequiredError('No refresh token: sign in to Miele again');
    }
    const fresh = await tokenRequest(
      {
        grant_type: 'refresh_token',
        client_id: config.client_id,
        client_secret: config.client_secret,
        refresh_token: tokens.refresh_token,
      },
      REQUEST_TIMEOUT_MS,
    );
    await store.setTokens(config.client_id, fresh);
    return fresh;
  }

  /** One refresh at a time, whoever asks. */
  function refreshOnce(tokens) {
    refreshing ??= refresh(tokens).finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  async function getAccessToken({ force = false } = {}) {
    const config = getConfig();
    const tokens = await store.getTokens(config.client_id);
    if (!tokens) {
      throw new ReauthorizationRequiredError('No Miele account linked');
    }
    if (force || tokens.expires_at - now() < REFRESH_MARGIN_MS) {
      return (await refreshOnce(tokens)).access_token;
    }
    return tokens.access_token;
  }

  async function request(method, path, { body, query } = {}) {
    const url = new URL(`${API_BASE_URL}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      url.searchParams.set(key, value);
    }
    const send = async (token) =>
      fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

    let response = await send(await getAccessToken());
    if (response.status === 401) {
      // Revoked or expired early: one refresh, one retry.
      response = await send(await getAccessToken({ force: true }));
    }
    if (!response.ok) {
      const payload = await readJson(response);
      const detail = typeof payload?.message === 'string' ? `: ${payload.message}` : '';
      throw new MieleApiError(
        response.status,
        `Miele API ${method} ${path}: HTTP ${response.status}${detail}`,
      );
    }
    if (response.status === 204) {
      return null;
    }
    return readJson(response);
  }

  return {
    /** Whether tokens exist for the configured client id. */
    async isLinked() {
      return (await store.getTokens(getConfig().client_id)) !== null;
    },

    /**
     * The Miele sign-in page the browser is sent to.
     * @param {string} redirectUri given by Gladys, used as is
     * @param {string} state anti-CSRF state, checked in the callback
     */
    buildAuthorizeUrl(redirectUri, state) {
      const config = getConfig();
      if (!config.client_id) {
        throw new Error('Fill in the Miele client ID first');
      }
      const url = new URL(OAUTH_AUTHORIZE_URL);
      url.searchParams.set('client_id', config.client_id);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('state', state);
      return url.toString();
    },

    /**
     * Trade the code Miele sent back for tokens, and keep them.
     * @param {string} code
     * @param {string} redirectUri the same one as in the authorization URL
     */
    async exchangeCode(code, redirectUri) {
      const config = getConfig();
      if (!config.client_id || !config.client_secret) {
        throw new Error('Fill in the Miele client ID and client secret first');
      }
      const tokens = await tokenRequest(
        {
          grant_type: 'authorization_code',
          client_id: config.client_id,
          client_secret: config.client_secret,
          code,
          redirect_uri: redirectUri,
        },
        EXCHANGE_TIMEOUT_MS,
      );
      await store.setTokens(config.client_id, tokens);
    },

    getAccessToken,

    /** Every appliance of the account, by serial number (GET /devices). */
    getDevices() {
      return request('GET', '/devices', {
        query: { language: apiLanguage(getConfig().language) },
      });
    },

    /** What an appliance accepts right now (GET /devices/{id}/actions). */
    getActions(serial) {
      return request('GET', `/devices/${encodeURIComponent(serial)}/actions`);
    },

    /** Send a command (PUT /devices/{id}/actions). */
    sendAction(serial, body) {
      return request('PUT', `/devices/${encodeURIComponent(serial)}/actions`, { body });
    },

    /**
     * Open the event stream of every appliance (Server-Sent Events). The
     * caller reads the body; a 401 refreshes the token for the next attempt.
     * @param {AbortSignal} signal
     */
    async openEventStream(signal) {
      const token = await getAccessToken();
      const language = apiLanguage(getConfig().language);
      const url = new URL(`${API_BASE_URL}/devices/all/events`);
      url.searchParams.set('language', language);
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'text/event-stream',
          'Accept-Language': language,
          'Cache-Control': 'no-cache',
        },
        signal,
      });
      if (response.status === 401) {
        await getAccessToken({ force: true });
      }
      if (!response.ok || !response.body) {
        throw new MieleApiError(response.status, `Miele event stream: HTTP ${response.status}`);
      }
      return response;
    },
  };
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
