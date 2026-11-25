import {
  ACTION_ID_MAX_LENGTH,
  HEALTH_RETRY_ATTEMPTS,
  HEALTH_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  RETRY_ATTEMPTS,
  RETRY_BASE_DELAY_MS,
  buildRoomPath,
  isValidActionId,
  isValidRoomCode,
  normalizeRoomCode,
} from './protocol.js';

/**
 * Error thrown by {@link RelayClient}. It never contains the room token.
 */
export class RelayError extends Error {
  /**
   * @param {string} message
   * @param {object} [options]
   * @param {number} [options.status]
   * @param {string} [options.code]
   * @param {boolean} [options.retryable]
   * @param {unknown} [options.cause]
   */
  constructor(message, { status = 0, code = 'network_error', retryable = false, cause = null } = {}) {
    super(message);
    this.name = 'RelayError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.cause = cause;
  }
}

/**
 * @param {number} milliseconds
 * @returns {Promise<void>}
 */
function defaultSleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isAbortError(error) {
  return Boolean(error && typeof error === 'object' && error.name === 'AbortError');
}

/**
 * Thin same-origin JSON client for the LAN relay. The token is only ever sent
 * in the `X-Room-Token` header; it is never appended to a URL, logged or
 * written to `location`. An optional `baseUrl` points the client at a remote
 * relay (Render); an empty base URL keeps every request on the current origin.
 */
export class RelayClient {
  #baseUrl;
  #fetchImpl;
  #timeoutMs;
  #retryAttempts;
  #healthTimeoutMs;
  #healthRetryAttempts;
  #retryBaseDelayMs;
  #sleep;
  #AbortControllerImpl;

  /**
   * @param {object} [options]
   * @param {string} [options.baseUrl] Relay origin, empty for same-origin.
   * @param {typeof fetch | null} [options.fetchImpl]
   * @param {number} [options.timeoutMs]
   * @param {number} [options.retryAttempts]
   * @param {number} [options.healthTimeoutMs]
   * @param {number} [options.healthRetryAttempts]
   * @param {number} [options.retryBaseDelayMs]
   * @param {(milliseconds: number) => Promise<void>} [options.sleep]
   * @param {typeof AbortController | null} [options.AbortControllerImpl]
   */
  constructor({
    baseUrl = '',
    fetchImpl = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null,
    timeoutMs = REQUEST_TIMEOUT_MS,
    retryAttempts = RETRY_ATTEMPTS,
    healthTimeoutMs = HEALTH_TIMEOUT_MS,
    healthRetryAttempts = HEALTH_RETRY_ATTEMPTS,
    retryBaseDelayMs = RETRY_BASE_DELAY_MS,
    sleep = defaultSleep,
    AbortControllerImpl = typeof globalThis.AbortController === 'function'
      ? globalThis.AbortController
      : null,
  } = {}) {
    this.#baseUrl = typeof baseUrl === 'string' ? baseUrl.replace(/\/$/, '') : '';
    this.#fetchImpl = fetchImpl;
    this.#timeoutMs = timeoutMs;
    this.#retryAttempts = Math.max(1, retryAttempts);
    this.#healthTimeoutMs = healthTimeoutMs;
    this.#healthRetryAttempts = Math.max(1, healthRetryAttempts);
    this.#retryBaseDelayMs = Math.max(0, retryBaseDelayMs);
    this.#sleep = sleep;
    this.#AbortControllerImpl = AbortControllerImpl;
  }

  /**
   * Checks `/api/health`. The request tolerates a Render cold start: it waits
   * much longer than a game request and is attempted twice.
   *
   * @returns {Promise<object>}
   */
  health() {
    return this.#request('GET', '/api/health', {
      retry: true,
      timeoutMs: this.#healthTimeoutMs,
      attempts: this.#healthRetryAttempts,
    });
  }

  /**
   * Creates a room. Never retried automatically: a retry could create a
   * second room with a different code.
   *
   * @param {string} name
   * @returns {Promise<{ roomCode: string, playerId: string, token: string, lobby: object }>}
   */
  createRoom(name) {
    return this.#request('POST', '/api/rooms', {
      body: { name },
      retry: false,
    });
  }

  /**
   * Joins a room. Never retried automatically for the same reason as
   * {@link RelayClient#createRoom}.
   *
   * @param {string} roomCode
   * @param {string} name
   * @returns {Promise<{ roomCode: string, playerId: string, token: string, lobby: object }>}
   */
  joinRoom(roomCode, name) {
    const code = this.#assertRoomCode(roomCode);

    return this.#request('POST', buildRoomPath(code, 'join'), {
      body: { name },
      retry: false,
    });
  }

  /**
   * @param {string} roomCode
   * @param {string} token
   * @param {{ actionSince?: number, lobbySince?: number }} [cursor]
   * @returns {Promise<object>}
   */
  hostPoll(roomCode, token, { actionSince = 0, lobbySince = 0 } = {}) {
    const code = this.#assertRoomCode(roomCode);

    return this.#request('GET', buildRoomPath(code, 'host'), {
      token,
      query: { actionSince, lobbySince },
      retry: true,
    });
  }

  /**
   * @param {string} roomCode
   * @param {string} token
   * @param {object} body
   * @returns {Promise<object>}
   */
  publish(roomCode, token, body) {
    const code = this.#assertRoomCode(roomCode);

    return this.#request('POST', buildRoomPath(code, 'publish'), {
      token,
      body,
      retry: true,
    });
  }

  /**
   * @param {string} roomCode
   * @param {string} token
   * @param {string} playerId
   * @returns {Promise<object>}
   */
  kick(roomCode, token, playerId) {
    const code = this.#assertRoomCode(roomCode);

    return this.#request('POST', buildRoomPath(code, 'kick'), {
      token,
      body: { playerId },
      retry: false,
    });
  }

  /**
   * @param {string} roomCode
   * @param {string} token
   * @returns {Promise<object>}
   */
  closeRoom(roomCode, token) {
    const code = this.#assertRoomCode(roomCode);

    return this.#request('POST', buildRoomPath(code, 'close'), {
      token,
      body: {},
      retry: false,
    });
  }

  /**
   * @param {string} roomCode
   * @param {string} token
   * @param {{ viewSince?: number, logSince?: number, logEpoch?: number, messageSince?: number }} [cursor]
   * @returns {Promise<object>}
   */
  playerPoll(roomCode, token, {
    viewSince = 0,
    logSince = 0,
    logEpoch = 0,
    messageSince = 0,
  } = {}) {
    const code = this.#assertRoomCode(roomCode);

    return this.#request('GET', buildRoomPath(code, 'player'), {
      token,
      query: { viewSince, logSince, logEpoch, messageSince },
      retry: true,
    });
  }

  /**
   * @param {string} roomCode
   * @param {string} token
   * @param {{ actionId: string, type: string, payload?: object }} action
   * @returns {Promise<{ ok: boolean, seq: number }>}
   */
  action(roomCode, token, action) {
    const code = this.#assertRoomCode(roomCode);

    if (!action || !isValidActionId(action.actionId) || typeof action.type !== 'string') {
      return Promise.reject(new RelayError('Некорректное действие.', {
        status: 400,
        code: 'bad_action',
      }));
    }

    return this.#request('POST', buildRoomPath(code, 'action'), {
      token,
      body: {
        actionId: action.actionId.slice(0, ACTION_ID_MAX_LENGTH),
        type: action.type,
        payload: action.payload ?? {},
      },
      retry: true,
    });
  }

  /**
   * @param {string} roomCode
   * @param {string} token
   * @returns {Promise<object>}
   */
  leave(roomCode, token) {
    const code = this.#assertRoomCode(roomCode);

    return this.#request('POST', buildRoomPath(code, 'leave'), {
      token,
      body: {},
      retry: false,
    });
  }

  /**
   * @param {unknown} roomCode
   * @returns {string}
   */
  #assertRoomCode(roomCode) {
    const code = normalizeRoomCode(roomCode);

    if (!isValidRoomCode(code)) {
      throw new RelayError('Некорректный код комнаты.', {
        status: 400,
        code: 'bad_room_code',
      });
    }

    return code;
  }

  /**
   * @param {string} pathname
   * @param {Record<string, string | number | null | undefined>} [query]
   * @returns {string}
   */
  #buildUrl(pathname, query = {}) {
    const params = new URLSearchParams();

    for (const [key, value] of Object.entries(query)) {
      if (value === null || value === undefined) {
        continue;
      }

      params.set(key, String(value));
    }

    const suffix = params.toString().length > 0 ? `?${params.toString()}` : '';
    const base = this.#baseUrl.length > 0 ? this.#baseUrl : '';

    return `${base}${pathname}${suffix}`;
  }

  /**
   * @param {string} method
   * @param {string} pathname
   * @param {object} options
   * @param {string} [options.token]
   * @param {object} [options.body]
   * @param {Record<string, string | number | null | undefined>} [options.query]
   * @param {boolean} [options.retry]
   * @param {number} [options.timeoutMs]
   * @param {number} [options.attempts]
   * @returns {Promise<any>}
   */
  async #request(method, pathname, {
    token = '',
    body,
    query = {},
    retry = false,
    timeoutMs = this.#timeoutMs,
    attempts = this.#retryAttempts,
  } = {}) {
    if (typeof this.#fetchImpl !== 'function') {
      throw new RelayError('Браузер не поддерживает сетевые запросы.', {
        code: 'fetch_unavailable',
      });
    }

    const maxAttempts = Math.max(1, Number.isFinite(attempts) ? attempts : 1);
    let lastError = null;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        return await this.#requestOnce(method, pathname, { token, body, query, timeoutMs });
      } catch (error) {
        lastError = error;

        const canRetry = retry
          && error instanceof RelayError
          && error.retryable
          && attempt < maxAttempts - 1;

        if (!canRetry) {
          throw error;
        }

        await this.#sleep(this.#retryBaseDelayMs * (2 ** attempt));
      }
    }

    throw lastError;
  }

  /**
   * @param {string} method
   * @param {string} pathname
   * @param {object} options
   * @returns {Promise<any>}
   */
  async #requestOnce(method, pathname, {
    token = '',
    body,
    query = {},
    timeoutMs = this.#timeoutMs,
  } = {}) {
    const url = this.#buildUrl(pathname, query);
    const headers = { Accept: 'application/json' };
    const init = {
      method,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
    };

    if (typeof token === 'string' && token.length > 0) {
      headers['X-Room-Token'] = token;
    }

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    let controller = null;
    let timer = null;

    if (this.#AbortControllerImpl) {
      controller = new this.#AbortControllerImpl();
      init.signal = controller.signal;
      timer = setTimeout(() => {
        controller.abort();
      }, timeoutMs);
    }

    let response;

    try {
      response = await this.#fetchImpl(url, init);
    } catch (error) {
      if (isAbortError(error)) {
        throw new RelayError('Сервер не ответил вовремя.', {
          code: 'timeout',
          retryable: true,
          cause: error,
        });
      }

      throw new RelayError('Не удалось связаться с сервером.', {
        code: 'network_error',
        retryable: true,
        cause: error,
      });
    } finally {
      if (timer !== null) {
        clearTimeout(timer);
      }
    }

    const text = await response.text();
    let json = null;

    if (text.length > 0) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }

    if (!response.ok) {
      throw new RelayError(
        typeof json?.message === 'string' && json.message.length > 0
          ? json.message
          : `Сервер вернул ошибку ${response.status}.`,
        {
          status: response.status,
          code: typeof json?.error === 'string' && json.error.length > 0
            ? json.error
            : `http_${response.status}`,
          retryable: response.status === 429 || response.status >= 500,
        },
      );
    }

    return json;
  }
}
