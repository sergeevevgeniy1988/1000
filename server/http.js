import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';

import { RelayError } from './relay.js';

/**
 * HTTP layer for the relay: routing, CORS, JSON helpers and a tiny allowlisted
 * static file server used for local play. No external dependencies.
 */

const API_PREFIX = '/api/';
const ALLOWED_METHODS = 'GET, POST, OPTIONS';
const ALLOWED_HEADERS = 'Content-Type, X-Room-Token';
const PREFLIGHT_MAX_AGE = '600';

const STATIC_CONTENT_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
});

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} payload
 * @returns {void}
 */
export function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');

  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Length', body.length);
  res.end(body);
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} error
 * @param {string} message
 * @returns {void}
 */
export function sendError(res, status, error, message) {
  sendJson(res, status, { ok: false, error, message });
}

/**
 * Sets the CORS headers for the request. Only exact allowlisted origins get an
 * `Access-Control-Allow-Origin` header; `Vary: Origin` is always present so a
 * cached response is never reused across origins.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {ReadonlySet<string>} origins
 * @returns {{ origin: string, allowed: boolean }}
 */
export function applyCors(req, res, origins) {
  const raw = req.headers.origin;
  const origin = typeof raw === 'string' ? raw.trim() : '';

  res.setHeader('Vary', 'Origin');

  if (origin.length === 0) {
    return { origin: '', allowed: true };
  }

  const normalized = origin.replace(/\/+$/, '').toLowerCase();
  const allowed = origins.has(normalized);

  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }

  return { origin, allowed };
}

/**
 * Answers `OPTIONS` with the preflight contract. Always used after the origin
 * allowlist check, so only trusted origins reach this function.
 *
 * @param {import('node:http').ServerResponse} res
 * @returns {void}
 */
export function handlePreflight(res) {
  res.statusCode = 204;
  res.setHeader('Allow', ALLOWED_METHODS);
  res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
  res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS);
  res.setHeader('Access-Control-Max-Age', PREFLIGHT_MAX_AGE);
  res.setHeader('Content-Length', '0');
  res.end();
}

/**
 * Reads and parses a JSON object body with a hard byte limit.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {number} limit
 * @returns {Promise<Record<string, unknown>>}
 */
export function readJsonBody(req, limit) {
  return new Promise((resolveBody, rejectBody) => {
    const declared = Number(req.headers['content-length']);

    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      rejectBody(new RelayError('body_too_large', 'Тело запроса слишком большое.', 413));
      return;
    }

    const chunks = [];
    let size = 0;
    let done = false;

    /** @param {Error} error */
    const fail = (error) => {
      if (done) {
        return;
      }

      done = true;
      req.removeListener('data', onData);
      req.resume();
      rejectBody(error);
    };

    /** @param {Buffer} chunk */
    const onData = (chunk) => {
      size += chunk.length;

      if (size > limit) {
        fail(new RelayError('body_too_large', 'Тело запроса слишком большое.', 413));
        return;
      }

      chunks.push(chunk);
    };

    req.on('data', onData);

    req.on('end', () => {
      if (done) {
        return;
      }

      done = true;

      const raw = Buffer.concat(chunks).toString('utf8').trim();

      if (raw.length === 0) {
        rejectBody(new RelayError('bad_json', 'Тело запроса должно быть JSON-объектом.', 400));
        return;
      }

      let parsed = null;

      try {
        parsed = JSON.parse(raw);
      } catch {
        rejectBody(new RelayError('bad_json', 'Тело запроса должно быть JSON-объектом.', 400));
        return;
      }

      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        rejectBody(new RelayError('bad_json', 'Тело запроса должно быть JSON-объектом.', 400));
        return;
      }

      resolveBody(parsed);
    });

    req.on('error', (error) => {
      if (done) {
        return;
      }

      done = true;
      rejectBody(error);
    });
  });
}

/**
 * Maps a pathname to a file inside `rootDir`, or `null` when the path is not on
 * the static allowlist. `/`, `/index.html`, `/favicon.svg`, `/css/*` and
 * `/js/*` only; dot files, backslashes and `..` segments are rejected.
 *
 * @param {string} pathname
 * @param {string} rootDir
 * @returns {string | null}
 */
function resolveStaticPath(pathname, rootDir) {
  let decoded;

  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  if (decoded.includes('\0') || decoded.includes('\\')) {
    return null;
  }

  const segments = decoded.split('/').filter((segment) => segment.length > 0);

  if (segments.some((segment) => segment === '.' || segment === '..' || segment.startsWith('.'))) {
    return null;
  }

  const root = resolve(rootDir);

  if (segments.length === 0) {
    return join(root, 'index.html');
  }

  if (segments.length === 1 && (segments[0] === 'index.html' || segments[0] === 'favicon.svg')) {
    return join(root, segments[0]);
  }

  if (segments.length >= 2 && (segments[0] === 'css' || segments[0] === 'js')) {
    const absolute = resolve(root, ...segments);

    if (!absolute.startsWith(`${root}${sep}`)) {
      return null;
    }

    return absolute;
  }

  return null;
}

/**
 * Serves an allowlisted static file. `HEAD` behaves like `GET` without a body.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} pathname
 * @param {string} rootDir
 * @returns {Promise<void>}
 */
export async function serveStatic(req, res, pathname, rootDir) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD, OPTIONS');
    sendError(res, 405, 'method_not_allowed', 'Метод не поддерживается.');
    return;
  }

  const filePath = resolveStaticPath(pathname, rootDir);

  if (!filePath) {
    sendError(res, 404, 'not_found', 'Файл не найден.');
    return;
  }

  let data;

  try {
    data = await readFile(filePath);
  } catch {
    sendError(res, 404, 'not_found', 'Файл не найден.');
    return;
  }

  const type = STATIC_CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';

  res.statusCode = 200;
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Length', data.length);

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  res.end(data);
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {string} allow
 * @returns {void}
 */
function methodNotAllowed(res, allow) {
  res.setHeader('Allow', allow);
  sendError(res, 405, 'method_not_allowed', 'Метод не поддерживается.');
}

/**
 * Creates the relay HTTP server. The caller owns `listen()` and shutdown.
 *
 * @param {object} options
 * @param {object} options.config
 * @param {object} options.relay
 * @param {string} options.rootDir
 * @param {((entry: { method: string, path: string, status: number }) => void) | null} [options.logger]
 * @returns {import('node:http').Server}
 */
export function createHttpServer({ config, relay, rootDir, logger = null }) {
  const origins = new Set(config.frontendOrigins.map((origin) => origin.toLowerCase()));

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @returns {Promise<void>}
   */
  async function handleRequest(req, res) {
    const method = typeof req.method === 'string' ? req.method : 'GET';
    const rawUrl = typeof req.url === 'string' ? req.url : '/';
    let pathname = '/';

    if (typeof logger === 'function') {
      res.on('finish', () => {
        logger({ method, path: pathname, status: res.statusCode });
      });
    }

    try {
      if (rawUrl.includes('\0') || rawUrl.includes('\\')) {
        sendError(res, 404, 'not_found', 'Страница не найдена.');
        return;
      }

      const url = new URL(rawUrl, 'http://localhost');
      pathname = url.pathname;

      const { origin, allowed } = applyCors(req, res, origins);

      if (origin.length > 0 && !allowed) {
        sendError(res, 403, 'bad_origin', 'Источник запроса не разрешён.');
        return;
      }

      if (method === 'OPTIONS') {
        handlePreflight(res);
        return;
      }

      if (pathname === '/api/health') {
        if (method !== 'GET') {
          methodNotAllowed(res, 'GET, OPTIONS');
          return;
        }

        sendJson(res, 200, {
          ok: true,
          lan: true,
          network: true,
          version: config.version,
          roomTtlSeconds: config.roomTtlSeconds,
        });
        return;
      }

      if (pathname === '/api/rooms') {
        if (method !== 'POST') {
          methodNotAllowed(res, 'POST, OPTIONS');
          return;
        }

        const body = await readJsonBody(req, config.maxBodyBytes);
        const created = relay.createRoom(body.name);
        sendJson(res, 201, { ok: true, ...created });
        return;
      }

      const joinMatch = /^\/api\/rooms\/([^/]+)\/join$/.exec(pathname);

      if (joinMatch) {
        if (method !== 'POST') {
          methodNotAllowed(res, 'POST, OPTIONS');
          return;
        }

        const body = await readJsonBody(req, config.maxBodyBytes);
        const joined = relay.joinRoom(decodeURIComponent(joinMatch[1]), body.name);
        sendJson(res, 200, { ok: true, ...joined });
        return;
      }

      if (pathname.startsWith(API_PREFIX)) {
        sendError(res, 404, 'not_found', 'Эндпоинт не найден.');
        return;
      }

      if (config.serveStatic) {
        await serveStatic(req, res, pathname, rootDir);
        return;
      }

      sendError(res, 404, 'not_found', 'Страница не найдена.');
    } catch (error) {
      if (res.writableEnded || res.destroyed) {
        return;
      }

      if (error instanceof RelayError) {
        sendError(res, error.status, error.code, error.message);
        return;
      }

      if (error instanceof URIError) {
        sendError(res, 400, 'bad_room_code', 'Некорректный код комнаты.');
        return;
      }

      sendError(res, 500, 'internal_error', 'Внутренняя ошибка сервера.');
    }
  }

  const server = createServer(
    { maxHeaderSize: config.maxHeaderSize },
    (req, res) => {
      handleRequest(req, res).catch(() => {
        if (!res.writableEnded && !res.destroyed) {
          res.destroy();
        }
      });
    },
  );

  server.requestTimeout = config.requestTimeoutMs;

  return server;
}
