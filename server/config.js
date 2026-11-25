import { readFileSync } from 'node:fs';

/**
 * Relay configuration. Every value comes from the environment, is validated
 * and falls back to a safe default on garbage input. The module never throws on
 * a malformed variable: a broken `PORT` must not stop the service from booting.
 */

const DEFAULT_PORT = 8787;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_ORIGINS = Object.freeze([
  'https://sergeevevgeniy1988.github.io',
  'http://localhost:8787',
  'http://127.0.0.1:8787',
]);

const DEFAULT_ROOM_TTL_SECONDS = 120;
const DEFAULT_MAX_ROOMS = 200;
const DEFAULT_MAX_BODY_BYTES = 512 * 1024;
const DEFAULT_MAX_HEADER_SIZE = 16 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const DEFAULT_PRESENCE_TIMEOUT_MS = 30000;
const DEFAULT_CLOSED_ROOM_TTL_MS = 5 * 60 * 1000;

/**
 * Reads the package version once so `/api/health` can report it without a
 * second source of truth. A missing or malformed package.json is not fatal.
 *
 * @returns {string}
 */
function readPackageVersion() {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed?.version === 'string' && parsed.version.length > 0
      ? parsed.version
      : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Version reported by `/api/health`; taken from `package.json`. */
export const VERSION = readPackageVersion();

/**
 * Parses an integer environment variable, clamping it into a safe range.
 *
 * @param {unknown} value
 * @param {number} fallback
 * @param {{ min?: number, max?: number }} [bounds]
 * @returns {number}
 */
export function toInt(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  let parsed = null;

  if (typeof value === 'number') {
    parsed = value;
  } else if (typeof value === 'string' && value.trim().length > 0) {
    parsed = Number(value.trim());
  }

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

/**
 * Parses a boolean-ish environment variable (`1/true/yes/on`).
 *
 * @param {unknown} value
 * @param {boolean} fallback
 * @returns {boolean}
 */
export function toBool(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();

  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return fallback;
}

/**
 * Parses the CORS allowlist. Origins are trims, lowercased and have a trailing
 * slash removed so that an exact `Origin` header comparison is predictable.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
export function parseOrigins(value) {
  const raw = typeof value === 'string' ? value.split(',') : [];
  const result = [];

  for (const entry of raw) {
    const origin = entry.trim().replace(/\/+$/, '').toLowerCase();

    if (origin.length === 0 || result.includes(origin)) {
      continue;
    }

    result.push(origin);
  }

  return result.length > 0 ? result : [...DEFAULT_ORIGINS];
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function parseHost(value) {
  const host = typeof value === 'string' ? value.trim() : '';

  return host.length > 0 ? host : DEFAULT_HOST;
}

/**
 * Builds the relay configuration.
 *
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 * @returns {{
 *   port: number,
 *   host: string,
 *   frontendOrigins: string[],
 *   roomTtlSeconds: number,
 *   roomTtlMs: number,
 *   maxRooms: number,
 *   serveStatic: boolean,
 *   maxBodyBytes: number,
 *   maxHeaderSize: number,
 *   requestTimeoutMs: number,
 *   presenceTimeoutMs: number,
 *   closedRoomTtlMs: number,
 *   version: string,
 * }}
 */
export function readConfig(env = process.env) {
  const roomTtlSeconds = toInt(env.ROOM_TTL_SECONDS, DEFAULT_ROOM_TTL_SECONDS, {
    min: 1,
    max: 86400,
  });

  return {
    port: toInt(env.PORT, DEFAULT_PORT, { min: 0, max: 65535 }),
    host: parseHost(env.HOST),
    frontendOrigins: parseOrigins(env.FRONTEND_ORIGINS),
    roomTtlSeconds,
    roomTtlMs: roomTtlSeconds * 1000,
    maxRooms: toInt(env.MAX_ROOMS, DEFAULT_MAX_ROOMS, { min: 1, max: 10000 }),
    serveStatic: toBool(env.SERVE_STATIC, true),
    maxBodyBytes: toInt(env.MAX_BODY_BYTES, DEFAULT_MAX_BODY_BYTES, {
      min: 1024,
      max: 16 * 1024 * 1024,
    }),
    maxHeaderSize: toInt(env.MAX_HEADER_SIZE, DEFAULT_MAX_HEADER_SIZE, {
      min: 4096,
      max: 128 * 1024,
    }),
    requestTimeoutMs: toInt(env.REQUEST_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS, {
      min: 1000,
      max: 120000,
    }),
    presenceTimeoutMs: toInt(env.PRESENCE_TIMEOUT_MS, DEFAULT_PRESENCE_TIMEOUT_MS, {
      min: 5000,
      max: 300000,
    }),
    closedRoomTtlMs: toInt(env.CLOSED_ROOM_TTL_MS, DEFAULT_CLOSED_ROOM_TTL_MS, {
      min: 10000,
      max: 3600000,
    }),
    version: VERSION,
  };
}
