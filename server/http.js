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
const TOKEN_HEADER = 'x-room-token';
const ROOM_ROUTE_PATTERN = /^\/api\/rooms\/([^/]+)\/([a-z]+)$/;
const UNSIGNED_INT_PATTERN = /^\d{1,15}$/;

const ROOM_ROUTE_METHODS = Object.freeze({
  join: 'POST',
  publish: 'POST',
  host: 'GET',
  player: 'GET',
  action: 'POST',
  kick: 'POST',
  close: 'POST',
  leave: 'POST',
});

const ROOM_ROUTE_ALLOW = Object.freeze({
  join: 'POST, OPTIONS',
  publish: 'POST, OPTIONS',
  host: 'GET, OPTIONS',
  player: 'GET, OPTIONS',
  action: 'POST, OPTIONS',
  kick: 'POST, OPTIONS',
  close: 'POST, OPTIONS',
  leave: 'POST, OPTIONS',
});

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
 * Reads the room token from the dedicated header. Tokens in the query string
 * are ignored on purpose, so a token never ends up in a URL or an access log.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {string}
 */
function readRoomToken(req) {
  const raw = req.headers[TOKEN_HEADER];

  return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * Reads a non-negative integer cursor from the query string. A missing value
 * means `0`; anything else must be plain digits, so `?actionSince=oops` is a
 * `bad_query` instead of a silently ignored cursor.
 *
 * @param {URL} url
 * @param {string} name
 * @returns {number}
 */
function readQueryInt(url, name) {
  const raw = url.searchParams.get(name);

  if (raw === null) {
    return 0;
  }

  if (!UNSIGNED_INT_PATTERN.test(raw)) {
    throw new RelayError('bad_query', `Параметр «${name}» должен быть целым числом.`, 400);
  }

  return Number(raw);
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

      const roomMatch = ROOM_ROUTE_PATTERN.exec(pathname);

      if (roomMatch) {
        const code = decodeURIComponent(roomMatch[1]);
        const route = roomMatch[2];
        const expectedMethod = ROOM_ROUTE_METHODS[route];
        const allow = ROOM_ROUTE_ALLOW[route];

        if (!expectedMethod) {
          sendError(res, 404, 'not_found', 'Эндпоинт не найден.');
          return;
        }

        if (method !== expectedMethod) {
          methodNotAllowed(res, allow);
          return;
        }

        if (route === 'join') {
          const body = await readJsonBody(req, config.maxBodyBytes);
          const joined = relay.joinRoom(code, body.name);
          sendJson(res, 200, { ok: true, ...joined });
          return;
        }

        if (route === 'publish') {
          const body = await readJsonBody(req, config.maxBodyBytes);
          const result = relay.publish(code, readRoomToken(req), body);
          sendJson(res, 200, result);
          return;
        }

        if (route === 'host') {
          const result = relay.hostPoll(code, readRoomToken(req), {
            actionSince: readQueryInt(url, 'actionSince'),
            lobbySince: readQueryInt(url, 'lobbySince'),
          });
          sendJson(res, 200, result);
          return;
        }

        if (route === 'player') {
          const result = relay.playerPoll(code, readRoomToken(req), {
            viewSince: readQueryInt(url, 'viewSince'),
            logSince: readQueryInt(url, 'logSince'),
            logEpoch: readQueryInt(url, 'logEpoch'),
            messageSince: readQueryInt(url, 'messageSince'),
          });
          sendJson(res, 200, result);
          return;
        }

        if (route === 'action') {
          const body = await readJsonBody(req, config.maxBodyBytes);
          const result = relay.addAction(code, readRoomToken(req), {
            actionId: body.actionId,
            type: body.type,
            payload: body.payload,
          });
          sendJson(res, 200, result);
          return;
        }

        if (route === 'kick') {
          const body = await readJsonBody(req, config.maxBodyBytes);
          const result = relay.kick(code, readRoomToken(req), body.playerId);
          sendJson(res, 200, result);
          return;
        }

        if (route === 'close') {
          await readJsonBody(req, config.maxBodyBytes);
          const result = relay.close(code, readRoomToken(req));
          sendJson(res, 200, result);
          return;
        }

        await readJsonBody(req, config.maxBodyBytes);
        const result = relay.leave(code, readRoomToken(req));
        sendJson(res, 200, result);
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
