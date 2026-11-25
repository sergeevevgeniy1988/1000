/**
 * Browser configuration for the network relay.
 *
 * The Render relay address is configured in `index.html` through the
 * `relay-base-url` meta tag. An empty value means the client keeps using the
 * same origin, which is what the local relay server serves. Nothing in this
 * file is secret: room tokens never appear here and only travel in the
 * `X-Room-Token` request header.
 */

/** Name of the meta tag that carries the relay base URL. */
export const RELAY_BASE_URL_META = 'relay-base-url';

/**
 * Normalizes the configured relay address. The value is trimmed, trailing
 * slashes are removed, and an address on the current origin (or an invalid
 * one) becomes an empty string so that requests stay same-origin.
 *
 * @param {unknown} raw
 * @param {{ origin?: string } | null} [location]
 * @returns {string}
 */
export function resolveRelayBaseUrl(raw, location = null) {
  if (typeof raw !== 'string') {
    return '';
  }

  const trimmed = raw.trim().replace(/\/+$/, '');

  if (trimmed.length === 0) {
    return '';
  }

  const origin = location && typeof location.origin === 'string' ? location.origin : '';

  if (origin.length > 0) {
    try {
      if (new URL(trimmed).origin === origin) {
        return '';
      }
    } catch {
      return '';
    }
  }

  return trimmed;
}

/**
 * Reads the relay base URL from the document. Node and any environment without
 * a DOM get an empty string, so importing this module never throws.
 *
 * @returns {string}
 */
function readConfiguredRelayBaseUrl() {
  if (typeof document === 'undefined' || !document || typeof document.querySelector !== 'function') {
    return '';
  }

  const meta = document.querySelector(`meta[name="${RELAY_BASE_URL_META}"]`);

  if (!meta || typeof meta.getAttribute !== 'function') {
    return '';
  }

  return meta.getAttribute('content') ?? '';
}

/** Relay base URL without a trailing slash; empty for a same-origin relay. */
export const RELAY_BASE_URL = resolveRelayBaseUrl(
  readConfiguredRelayBaseUrl(),
  typeof globalThis.location === 'object' && globalThis.location !== null
    ? globalThis.location
    : null,
);
