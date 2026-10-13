// -----------------------------------------------------------------------------
// The Miele tokens and the authorization in flight, kept in /data.
//
// /data is the container's only writable volume: it survives restarts and
// updates of the integration, and nothing else reads it. The tokens never
// enter the Gladys configuration, never reach a log line.
//
// The anti-CSRF state of an authorization started but not finished lives here
// too: the user signs in at Miele between the two calls Gladys relays, and an
// update or a restart in between must not turn a correct sign-in into a
// "state mismatch".
//
// The tokens remember the client id they were issued to: a user who types a
// new client id must sign in again, rather than see the old tokens refused
// one by one.
// -----------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const DEFAULT_DATA_DIR = '/data';
const FILE_NAME = 'miele-auth.json';

/** How long an authorization started but never finished stays acceptable. */
export const PENDING_STATE_TTL_MS = 15 * 60 * 1000;

/**
 * @param {object} [options]
 * @param {string} [options.dir] where to keep the file (tests use a temp dir)
 * @param {() => number} [options.now]
 */
export function createAuthStore({
  dir = process.env.DATA_DIR || DEFAULT_DATA_DIR,
  now = () => Date.now(),
} = {}) {
  const file = join(dir, FILE_NAME);
  let cache = null;

  async function load() {
    if (cache) {
      return cache;
    }
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'));
      cache = parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      // Missing (first start) or unreadable: start from nothing, the user
      // signs in again.
      cache = {};
    }
    return cache;
  }

  async function save(next) {
    cache = next;
    await mkdir(dirname(file), { recursive: true });
    // Write then rename: a crash in between never leaves half a file.
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(next), { mode: 0o600 });
    await rename(tmp, file);
  }

  return {
    file,

    /**
     * The tokens issued to this client id, or null.
     * @param {string} clientId
     * @returns {Promise<{ access_token: string, refresh_token: string|null, expires_at: number }|null>}
     */
    async getTokens(clientId) {
      const data = await load();
      const tokens = data.tokens;
      if (!tokens?.access_token || !clientId || tokens.client_id !== clientId) {
        return null;
      }
      return tokens;
    },

    /** @param {string} clientId @param {object} tokens */
    async setTokens(clientId, tokens) {
      const data = await load();
      await save({ ...data, tokens: { ...tokens, client_id: clientId } });
    },

    async clearTokens() {
      const data = await load();
      const { tokens: _dropped, ...rest } = data;
      await save(rest);
    },

    /** Start an authorization: a new unguessable state, remembered. */
    async createPendingState() {
      const data = await load();
      const state = randomUUID();
      await save({ ...data, pending: { state, created_at: now() } });
      return state;
    },

    /**
     * Whether `state` is the one of the authorization in flight. A match
     * consumes it: a code can be exchanged once.
     * @param {unknown} state
     */
    async consumePendingState(state) {
      const data = await load();
      const pending = data.pending;
      if (!pending || typeof state !== 'string' || state === '') {
        return false;
      }
      if (now() - pending.created_at > PENDING_STATE_TTL_MS || pending.state !== state) {
        return false;
      }
      const { pending: _consumed, ...rest } = data;
      await save(rest);
      return true;
    },
  };
}
