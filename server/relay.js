import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * In-memory room model for the relay. Rooms hold seats, a lobby version, the
 * authoritative game transport (publish snapshots, action queue, public log and
 * targeted messages) and presence timestamps; nothing is persisted and there
 * are no external dependencies.
 */

/** Seats in clockwise order. The host is always the `human` seat. */
export const SEAT_IDS = Object.freeze(['human', 'alice', 'boris']);
export const MAX_PLAYERS = SEAT_IDS.length;
export const HOST_SEAT = 'human';
export const GUEST_SEATS = Object.freeze(['alice', 'boris']);

/** Six characters without visually ambiguous symbols. */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 6;
export const ROOM_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{6}$/;

/** Display-name limits shared with the browser client. */
export const NAME_MIN_LENGTH = 1;
export const NAME_MAX_LENGTH = 24;

/** Transport limits shared with the browser client (`js/net/protocol.js`). */
export const ACTION_ID_MIN_LENGTH = 1;
export const ACTION_ID_MAX_LENGTH = 64;
export const ACTION_TYPE_MAX_LENGTH = 64;
export const MAX_ACTION_QUEUE = 100;
export const MAX_LOG_ENTRIES = 500;
export const MAX_PLAYER_MESSAGES = 100;
export const MAX_VIEW_BYTES = 64 * 1024;
export const MAX_ACTION_PAYLOAD_BYTES = 8 * 1024;
export const MAX_LOG_ENTRY_BYTES = 16 * 1024;
export const MAX_MESSAGE_BYTES = 4 * 1024;

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;
const ROOM_CODE_ATTEMPTS = 100;
const TOKEN_BYTES = 32;
const MAX_ACTION_RECEIPTS = 1000;

/**
 * Error with an HTTP status and a stable machine-readable code. The message is
 * safe to show to a player; it never contains a token or server internals.
 */
export class RelayError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {number} status
   */
  constructor(code, message, status) {
    super(message);
    this.name = 'RelayError';
    this.code = code;
    this.status = status;
  }
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeName(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Validates and normalizes a display name. Names are 1–24 characters after
 * trimming and must not contain control characters.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function validateName(value) {
  const name = normalizeName(value);

  if (name.length < NAME_MIN_LENGTH) {
    throw new RelayError('bad_name', 'Введите имя игрока.', 400);
  }

  if (name.length > NAME_MAX_LENGTH) {
    throw new RelayError('bad_name', `Имя должно быть не длиннее ${NAME_MAX_LENGTH} символов.`, 400);
  }

  if (CONTROL_CHARACTER_PATTERN.test(name)) {
    throw new RelayError('bad_name', 'Имя не должно содержать управляющих символов.', 400);
  }

  return name;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeRoomCode(value) {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidRoomCode(value) {
  const code = normalizeRoomCode(value);

  return code.length === ROOM_CODE_LENGTH && ROOM_CODE_PATTERN.test(code);
}

/**
 * Checks an opaque client-generated action id: 1–64 characters without control
 * characters. The relay never interprets the value beyond deduplication.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidActionId(value) {
  return typeof value === 'string'
    && value.length >= ACTION_ID_MIN_LENGTH
    && value.length <= ACTION_ID_MAX_LENGTH
    && !CONTROL_CHARACTER_PATTERN.test(value);
}

/**
 * Constant-time string comparison used for room tokens.
 *
 * @param {string} expected
 * @param {string} provided
 * @returns {boolean}
 */
export function safeEqual(expected, provided) {
  if (typeof expected !== 'string' || typeof provided !== 'string') {
    return false;
  }

  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(provided, 'utf8');

  if (left.length !== right.length || left.length === 0) {
    return false;
  }

  return timingSafeEqual(left, right);
}

/** @returns {string} */
function createToken() {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * Serialized byte size of an opaque JSON value. A value that cannot be
 * serialized is treated as oversized, which safely rejects it.
 *
 * @param {unknown} value
 * @returns {number}
 */
function measureBytes(value) {
  try {
    const json = JSON.stringify(value);

    return typeof json === 'string' ? Buffer.byteLength(json, 'utf8') : Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @param {string} code
 * @param {string} message
 * @returns {boolean}
 */
function readOptionalBoolean(value, code, message) {
  if (value === undefined || value === null) {
    return false;
  }

  if (typeof value !== 'boolean') {
    throw new RelayError(code, message, 400);
  }

  return true;
}

/**
 * @param {unknown} value
 * @param {string} code
 * @param {string} message
 * @returns {boolean}
 */
function readOptionalNonNegativeInt(value, code, message) {
  if (value === undefined || value === null) {
    return false;
  }

  if (!Number.isInteger(value) || value < 0) {
    throw new RelayError(code, message, 400);
  }

  return true;
}

/**
 * @param {ReadonlySet<string>} taken
 * @returns {string}
 */
function createRoomCode(taken) {
  for (let attempt = 0; attempt < ROOM_CODE_ATTEMPTS; attempt += 1) {
    let code = '';

    for (let index = 0; index < ROOM_CODE_LENGTH; index += 1) {
      code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
    }

    if (!taken.has(code)) {
      return code;
    }
  }

  throw new RelayError('capacity', 'Не удалось выделить код комнаты. Попробуйте ещё раз.', 503);
}

/**
 * Creates the in-memory relay store.
 *
 * @param {object} [options]
 * @param {number} [options.roomTtlMs] Room lifetime measured from the last host activity.
 * @param {number} [options.maxRooms]
 * @param {number} [options.presenceTimeoutMs]
 * @param {number} [options.closedRoomTtlMs] How long closed/expired rooms stay for 410 responses.
 * @param {number} [options.cleanupIntervalMs]
 * @param {() => number} [options.now]
 * @returns {object}
 */
export function createRelay({
  roomTtlMs = 120000,
  maxRooms = 200,
  presenceTimeoutMs = 30000,
  closedRoomTtlMs = 5 * 60 * 1000,
  cleanupIntervalMs = 30000,
  now = () => Date.now(),
} = {}) {
  /** @type {Map<string, object>} */
  const rooms = new Map();

  /**
   * @param {object} room
   * @param {number} at
   * @returns {boolean}
   */
  function isExpired(room, at) {
    return room.closedAt === null && at - room.hostLastSeen > roomTtlMs;
  }

  /**
   * Marks a live room closed so that later requests receive 410 until the
   * retention window passes.
   *
   * @param {object} room
   */
  function markClosed(room) {
    if (room.closedAt === null) {
      room.closedAt = now();
    }
  }

  /**
   * Finds the room and enforces the TTL on access. Never returns a closed or
   * expired room.
   *
   * @param {unknown} code
   * @returns {object}
   */
  function requireActiveRoom(code) {
    if (!isValidRoomCode(code)) {
      throw new RelayError('bad_room_code', 'Некорректный код комнаты.', 400);
    }

    const normalized = normalizeRoomCode(code);
    const room = rooms.get(normalized);

    if (!room) {
      throw new RelayError('room_not_found', 'Комната не найдена. Проверьте код.', 404);
    }

    if (room.closedAt !== null) {
      throw new RelayError('room_closed', 'Комната закрыта или истекла.', 410);
    }

    if (isExpired(room, now())) {
      markClosed(room);
      throw new RelayError('room_closed', 'Комната закрыта или истекла.', 410);
    }

    return room;
  }

  /**
   * @param {object} room
   */
  function bumpLobby(room) {
    room.lobbyVersion += 1;
  }

  /**
   * @param {object} room
   * @param {number} index
   * @returns {number}
   */
  function seatLastSeen(room, index) {
    return index === 0 ? room.hostLastSeen : room.players[index].lastSeen;
  }

  /**
   * Refreshes one seat's activity timestamp. Host activity also refreshes the
   * room TTL (`hostLastSeen`); the caller must have passed the TTL check first.
   *
   * @param {object} room
   * @param {number} index
   * @returns {void}
   */
  function touchPresence(room, index) {
    const at = now();

    if (index === 0) {
      room.hostLastSeen = at;
    }

    room.players[index].lastSeen = at;
  }

  /**
   * Recomputes the `connected` flag of every occupied seat and bumps the lobby
   * version when at least one flag changed. This is what makes presence changes
   * visible to the host without a dedicated polling channel.
   *
   * @param {object} room
   * @returns {boolean} True when the lobby version changed.
   */
  function reconcilePresence(room) {
    const at = now();
    let changed = false;

    for (let index = 0; index < MAX_PLAYERS; index += 1) {
      const player = room.players[index];
      const connected = player !== null && at - seatLastSeen(room, index) <= presenceTimeoutMs;

      if (room.presence[index] !== connected) {
        room.presence[index] = connected;
        changed = true;
      }
    }

    if (changed) {
      bumpLobby(room);
    }

    return changed;
  }

  /**
   * @param {unknown} token
   * @param {'missing' | 'invalid'} reason
   * @returns {never}
   */
  function throwTokenError(token, reason) {
    if (reason === 'missing') {
      throw new RelayError('missing_token', 'Нужен заголовок X-Room-Token.', 401);
    }

    throw new RelayError('invalid_token', 'Токен комнаты недействителен.', 401);
  }

  /**
   * Finds the occupied seat that owns a token, or `null`. Used to tell a
   * missing/unknown token (401) from a valid token on the wrong route (403).
   *
   * @param {object} room
   * @param {string} token
   * @returns {{ index: number, seat: string, player: object } | null}
   */
  function findSeatByToken(room, token) {
    for (let index = 0; index < MAX_PLAYERS; index += 1) {
      const player = room.players[index];

      if (player !== null && safeEqual(player.token, token)) {
        return { index, seat: player.seat, player };
      }
    }

    return null;
  }

  /**
   * Host authorization by token. Uses a constant-time comparison. A valid guest
   * token on a host-only route is a 403, not an authentication failure.
   *
   * @param {object} room
   * @param {unknown} token
   * @returns {object} The host player record.
   */
  function requireHost(room, token) {
    if (typeof token !== 'string' || token.length === 0) {
      throwTokenError(token, 'missing');
    }

    if (safeEqual(room.hostToken, token)) {
      return room.players[0];
    }

    if (findSeatByToken(room, token) !== null) {
      throw new RelayError('not_host', 'Действие доступно только хосту.', 403);
    }

    throwTokenError(token, 'invalid');
  }

  /**
   * Guest authorization by token. Only occupied guest seats are accepted, so a
   * kicked guest token stops working immediately. A valid host token is a 403.
   *
   * @param {object} room
   * @param {unknown} token
   * @returns {{ index: number, seat: string, player: object }}
   */
  function requireGuest(room, token) {
    if (typeof token !== 'string' || token.length === 0) {
      throwTokenError(token, 'missing');
    }

    for (let index = 1; index < MAX_PLAYERS; index += 1) {
      const player = room.players[index];

      if (player !== null && safeEqual(player.token, token)) {
        return { index, seat: player.seat, player };
      }
    }

    if (safeEqual(room.hostToken, token)) {
      throw new RelayError('not_guest', 'Действие доступно только гостю.', 403);
    }

    throwTokenError(token, 'invalid');
  }

  /**
   * Any-seat authorization by token, used by the player poll where the host is
   * also allowed to read its own view.
   *
   * @param {object} room
   * @param {unknown} token
   * @returns {{ index: number, seat: string, player: object }}
   */
  function requireSeat(room, token) {
    if (typeof token !== 'string' || token.length === 0) {
      throwTokenError(token, 'missing');
    }

    const seat = findSeatByToken(room, token);

    if (seat !== null) {
      return seat;
    }

    throwTokenError(token, 'invalid');
  }

  /**
   * Case-insensitive duplicate check across occupied seats.
   *
   * @param {object} room
   * @param {string} name
   * @returns {boolean}
   */
  function isNameTaken(room, name) {
    const normalized = name.toLocaleLowerCase('ru-RU');

    return room.players.some((player) => (
      player !== null
      && normalizeName(player.name).toLocaleLowerCase('ru-RU') === normalized
    ));
  }

  /**
   * Builds the lobby snapshot shared with the browser.
   *
   * @param {object} room
   * @returns {object}
   */
  function getLobby(room) {
    const at = now();
    const seats = SEAT_IDS.map((seat, index) => {
      const player = room.players[index];

      if (!player) {
        return {
          playerId: seat,
          name: null,
          occupied: false,
          isHost: seat === HOST_SEAT,
          connected: false,
          lastSeen: null,
        };
      }

      const lastSeen = seatLastSeen(room, index);

      return {
        playerId: seat,
        name: player.name,
        occupied: true,
        isHost: seat === HOST_SEAT,
        connected: at - lastSeen <= presenceTimeoutMs,
        lastSeen: new Date(lastSeen).toISOString(),
      };
    });

    return {
      code: room.code,
      version: room.lobbyVersion,
      started: room.started,
      maxPlayers: MAX_PLAYERS,
      seats,
    };
  }

  /**
   * Removes rooms that have been closed for longer than the retention window.
   * Expired live rooms are marked closed first so they answer 410 for a while.
   *
   * @returns {void}
   */
  function cleanup() {
    const at = now();

    for (const [code, room] of rooms) {
      if (isExpired(room, at)) {
        markClosed(room);
      }

      if (room.closedAt !== null && at - room.closedAt > closedRoomTtlMs) {
        rooms.delete(code);
      }
    }
  }

  /**
   * @param {unknown} name
   * @returns {{ roomCode: string, playerId: string, token: string, lobby: object }}
   */
  function createRoom(name) {
    const displayName = validateName(name);

    if (rooms.size >= maxRooms) {
      cleanup();
    }

    if (rooms.size >= maxRooms) {
      throw new RelayError('room_limit', 'Слишком много активных комнат. Попробуйте позже.', 429);
    }

    const code = createRoomCode(new Set(rooms.keys()));
    const token = createToken();
    const createdAt = now();
    const room = {
      code,
      hostToken: token,
      players: [
        {
          seat: HOST_SEAT,
          name: displayName,
          token,
          joinedAt: createdAt,
          lastSeen: createdAt,
        },
        null,
        null,
      ],
      presence: [true, false, false],
      lobbyVersion: 1,
      hostLastSeen: createdAt,
      createdAt,
      closedAt: null,
      started: false,
      publishVersion: 0,
      views: {},
      viewVersion: 0,
      log: [],
      logEpoch: 0,
      logTotal: 0,
      messages: { human: [], alice: [], boris: [] },
      messageTotal: { human: 0, alice: 0, boris: 0 },
      actions: [],
      actionSeq: 0,
      actionReceipts: new Map(),
    };

    rooms.set(code, room);

    return {
      roomCode: code,
      playerId: HOST_SEAT,
      token,
      lobby: getLobby(room),
    };
  }

  /**
   * @param {unknown} code
   * @param {unknown} name
   * @returns {{ roomCode: string, playerId: string, token: string, lobby: object }}
   */
  function joinRoom(code, name) {
    const room = requireActiveRoom(code);

    if (room.started) {
      throw new RelayError('room_started', 'Партия уже началась.', 409);
    }

    const displayName = validateName(name);

    if (isNameTaken(room, displayName)) {
      throw new RelayError('name_taken', 'Это имя уже занято в комнате.', 409);
    }

    const index = room.players.findIndex((player, seatIndex) => seatIndex > 0 && player === null);

    if (index < 0) {
      throw new RelayError('room_full', 'В комнате нет свободных мест.', 409);
    }

    const seat = SEAT_IDS[index];
    const token = createToken();
    const joinedAt = now();

    room.players[index] = {
      seat,
      name: displayName,
      token,
      joinedAt,
      lastSeen: joinedAt,
    };
    room.presence[index] = true;
    bumpLobby(room);

    return {
      roomCode: room.code,
      playerId: seat,
      token,
      lobby: getLobby(room),
    };
  }

  /**
   * Stores one host snapshot. Versions are monotonic; repeating the current
   * version is an idempotent no-op so a retried publish never duplicates log
   * entries or messages. An older version is rejected with `stale_version`.
   *
   * @param {unknown} code
   * @param {unknown} token
   * @param {object} body
   * @returns {{ ok: true, version: number, lobbyVersion: number }}
   */
  function publish(code, token, body) {
    const room = requireActiveRoom(code);
    requireHost(room, token);

    const request = isPlainObject(body) ? body : {};
    const version = request.version;

    if (!Number.isInteger(version) || version < 1) {
      throw new RelayError('bad_version', 'Нужен номер версии (целое число от 1).', 400);
    }

    if (version < room.publishVersion) {
      throw new RelayError('stale_version', 'Уже опубликована более новая версия.', 409);
    }

    if (version === room.publishVersion) {
      return { ok: true, version: room.publishVersion, lobbyVersion: room.lobbyVersion };
    }

    const gameReset = request.gameReset;
    const hasGameReset = readOptionalBoolean(
      gameReset,
      'bad_publish',
      'gameReset должен быть логическим значением.',
    );
    const hasLogEpoch = readOptionalNonNegativeInt(
      request.logEpoch,
      'bad_publish',
      'logEpoch должен быть целым неотрицательным числом.',
    );
    const hasStarted = readOptionalBoolean(
      request.started,
      'bad_publish',
      'started должен быть логическим значением.',
    );

    let views = null;

    if (request.views !== undefined && request.views !== null) {
      if (!isPlainObject(request.views)) {
        throw new RelayError('bad_publish', 'views должен быть объектом.', 400);
      }

      views = {};

      for (const seat of SEAT_IDS) {
        if (!Object.hasOwn(request.views, seat)) {
          continue;
        }

        const view = request.views[seat];

        if (measureBytes(view) > MAX_VIEW_BYTES) {
          throw new RelayError('bad_publish', 'Снимок стола слишком большой.', 400);
        }

        views[seat] = view;
      }
    }

    let logEntries = null;

    if (request.log !== undefined && request.log !== null) {
      if (!Array.isArray(request.log)) {
        throw new RelayError('bad_publish', 'log должен быть массивом.', 400);
      }

      if (request.log.length > MAX_LOG_ENTRIES) {
        throw new RelayError('bad_publish', 'Слишком много записей журнала.', 400);
      }

      for (const entry of request.log) {
        if (measureBytes(entry) > MAX_LOG_ENTRY_BYTES) {
          throw new RelayError('bad_publish', 'Запись журнала слишком большая.', 400);
        }
      }

      logEntries = request.log;
    }

    let messageItems = null;

    if (request.messages !== undefined && request.messages !== null) {
      if (!isPlainObject(request.messages)) {
        throw new RelayError('bad_publish', 'messages должен быть объектом.', 400);
      }

      messageItems = {};

      for (const seat of SEAT_IDS) {
        if (!Object.hasOwn(request.messages, seat)) {
          continue;
        }

        const list = request.messages[seat];

        if (!Array.isArray(list)) {
          throw new RelayError('bad_publish', 'Каждое значение messages должно быть массивом.', 400);
        }

        if (list.length > MAX_PLAYER_MESSAGES) {
          throw new RelayError('bad_publish', 'Слишком много сообщений для места.', 400);
        }

        for (const payload of list) {
          if (measureBytes(payload) > MAX_MESSAGE_BYTES) {
            throw new RelayError('bad_publish', 'Сообщение игроку слишком большое.', 400);
          }
        }

        messageItems[seat] = list;
      }
    }

    if (hasGameReset && gameReset) {
      room.logEpoch += 1;
      room.log = [];
      room.logTotal = 0;
    } else if (hasLogEpoch && request.logEpoch !== room.logEpoch) {
      room.logEpoch = request.logEpoch;
      room.log = [];
      room.logTotal = 0;
    }

    if (views !== null) {
      for (const seat of SEAT_IDS) {
        if (Object.hasOwn(views, seat)) {
          room.views[seat] = views[seat];
        }
      }
    }

    if (hasStarted && request.started !== room.started) {
      room.started = request.started;
      bumpLobby(room);
    }

    if (logEntries !== null) {
      for (const entry of logEntries) {
        room.logTotal += 1;
        room.log.push({ seq: room.logTotal, entry });
      }

      if (room.log.length > MAX_LOG_ENTRIES) {
        room.log.splice(0, room.log.length - MAX_LOG_ENTRIES);
        // Guests must drop deltas that predate a trimmed log.
        room.logEpoch += 1;
      }
    }

    if (messageItems !== null) {
      for (const seat of SEAT_IDS) {
        if (!Object.hasOwn(messageItems, seat)) {
          continue;
        }

        const queue = room.messages[seat];

        for (const payload of messageItems[seat]) {
          room.messageTotal[seat] += 1;
          queue.push({ seq: room.messageTotal[seat], payload });
        }

        if (queue.length > MAX_PLAYER_MESSAGES) {
          queue.splice(0, queue.length - MAX_PLAYER_MESSAGES);
        }
      }
    }

    room.publishVersion = version;
    room.viewVersion = version;

    touchPresence(room, 0);
    reconcilePresence(room);

    return { ok: true, version: room.publishVersion, lobbyVersion: room.lobbyVersion };
  }

  /**
   * Returns queued guest actions with `seq > actionSince` and, when
   * `lobbySince < lobbyVersion`, the current lobby snapshot.
   *
   * @param {unknown} code
   * @param {unknown} token
   * @param {{ actionSince?: number, lobbySince?: number }} [cursor]
   * @returns {{ actions: object[], cursor: number, lobbyVersion: number, lobby?: object }}
   */
  function hostPoll(code, token, { actionSince = 0, lobbySince = 0 } = {}) {
    const room = requireActiveRoom(code);
    requireHost(room, token);

    touchPresence(room, 0);
    reconcilePresence(room);

    const actions = room.actions
      .filter((action) => action.seq > actionSince)
      .sort((left, right) => left.seq - right.seq);

    const state = {
      actions,
      cursor: room.actionSeq,
      lobbyVersion: room.lobbyVersion,
    };

    if (lobbySince < room.lobbyVersion) {
      state.lobby = getLobby(room);
    }

    return state;
  }

  /**
   * Returns the personal view of one seat plus log and message deltas. A guest
   * never receives another seat's view or token.
   *
   * @param {unknown} code
   * @param {unknown} token
   * @param {{ viewSince?: number, logSince?: number, logEpoch?: number, messageSince?: number }} [cursor]
   * @returns {object}
   */
  function playerPoll(code, token, {
    viewSince = 0,
    logSince = 0,
    logEpoch = 0,
    messageSince = 0,
  } = {}) {
    const room = requireActiveRoom(code);
    const seat = requireSeat(room, token);

    touchPresence(room, seat.index);
    reconcilePresence(room);

    const state = {
      lobby: getLobby(room),
      started: room.started,
      viewVersion: room.viewVersion,
      logEpoch: room.logEpoch,
      logTotal: room.logTotal,
      messageTotal: room.messageTotal[seat.seat],
      log: logEpoch !== room.logEpoch
        ? room.log.map((entry) => entry)
        : room.log.filter((entry) => entry.seq > logSince),
      messages: room.messages[seat.seat].filter((message) => message.seq > messageSince),
    };

    if (viewSince < room.viewVersion && Object.hasOwn(room.views, seat.seat)) {
      state.view = room.views[seat.seat];
    }

    return state;
  }

  /**
   * Queues one guest action. `playerId` is derived from the token; any client
   * field is ignored. A retried `actionId` returns its original `seq`.
   *
   * @param {unknown} code
   * @param {unknown} token
   * @param {{ actionId?: unknown, type?: unknown, payload?: unknown }} [action]
   * @returns {{ ok: true, seq: number }}
   */
  function addAction(code, token, action = {}) {
    const room = requireActiveRoom(code);
    const guest = requireGuest(room, token);

    if (!room.started) {
      throw new RelayError('room_started', 'Партия ещё не началась.', 409);
    }

    const request = isPlainObject(action) ? action : {};

    if (!isValidActionId(request.actionId)) {
      throw new RelayError('bad_action', 'Некорректный идентификатор действия.', 400);
    }

    if (
      typeof request.type !== 'string'
      || request.type.length === 0
      || request.type.length > ACTION_TYPE_MAX_LENGTH
      || CONTROL_CHARACTER_PATTERN.test(request.type)
    ) {
      throw new RelayError('bad_action', 'Некорректный тип действия.', 400);
    }

    let payload = request.payload;

    if (payload === undefined || payload === null) {
      payload = {};
    }

    if (!isPlainObject(payload)) {
      throw new RelayError('bad_action', 'Тело действия должно быть объектом.', 400);
    }

    if (measureBytes(payload) > MAX_ACTION_PAYLOAD_BYTES) {
      throw new RelayError('bad_action', 'Тело действия слишком большое.', 400);
    }

    const receiptKey = `${guest.seat}\u0000${request.actionId}`;
    const previousSeq = room.actionReceipts.get(receiptKey);

    if (previousSeq !== undefined) {
      return { ok: true, seq: previousSeq };
    }

    if (room.actions.length >= MAX_ACTION_QUEUE) {
      throw new RelayError('action_queue_full', 'Очередь действий переполнена.', 429);
    }

    room.actionSeq += 1;

    room.actions.push({
      seq: room.actionSeq,
      playerId: guest.seat,
      actionId: request.actionId,
      type: request.type,
      payload,
    });

    room.actionReceipts.set(receiptKey, room.actionSeq);

    if (room.actionReceipts.size > MAX_ACTION_RECEIPTS) {
      room.actionReceipts.delete(room.actionReceipts.keys().next().value);
    }

    touchPresence(room, guest.index);

    return { ok: true, seq: room.actionSeq };
  }

  /**
   * Frees a guest seat, drops that seat's actions and invalidates its token.
   *
   * @param {object} room
   * @param {number} index
   * @returns {void}
   */
  function releaseSeat(room, index) {
    const seat = SEAT_IDS[index];

    room.players[index] = null;
    room.presence[index] = false;
    delete room.views[seat];
    room.messages[seat] = [];
    room.messageTotal[seat] = 0;

    room.actions = room.actions.filter((action) => action.playerId !== seat);

    for (const key of room.actionReceipts.keys()) {
      if (key.startsWith(`${seat}\u0000`)) {
        room.actionReceipts.delete(key);
      }
    }

    bumpLobby(room);
  }

  /**
   * @param {unknown} code
   * @param {unknown} token
   * @param {unknown} playerId
   * @returns {{ ok: true, lobby: object }}
   */
  function kick(code, token, playerId) {
    const room = requireActiveRoom(code);
    requireHost(room, token);

    if (typeof playerId !== 'string' || !GUEST_SEATS.includes(playerId)) {
      throw new RelayError('not_guest', 'Исключить можно только гостя.', 403);
    }

    const index = SEAT_IDS.indexOf(playerId);

    if (!room.players[index]) {
      throw new RelayError('not_guest', 'Это место уже свободно.', 403);
    }

    releaseSeat(room, index);

    return { ok: true, lobby: getLobby(room) };
  }

  /**
   * @param {unknown} code
   * @param {unknown} token
   * @returns {{ ok: true }}
   */
  function close(code, token) {
    const room = requireActiveRoom(code);
    requireHost(room, token);

    if (room.closedAt === null) {
      markClosed(room);
      bumpLobby(room);
    }

    return { ok: true };
  }

  /**
   * @param {unknown} code
   * @param {unknown} token
   * @returns {{ ok: true, lobby: object }}
   */
  function leave(code, token) {
    const room = requireActiveRoom(code);
    const guest = requireGuest(room, token);

    releaseSeat(room, guest.index);

    return { ok: true, lobby: getLobby(room) };
  }

  const timer = setInterval(cleanup, cleanupIntervalMs);

  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  return {
    createRoom,
    joinRoom,
    getLobby,
    cleanup,
    publish,
    hostPoll,
    playerPoll,
    addAction,
    kick,
    close,
    leave,
    /** Stops the periodic cleanup timer. */
    stop() {
      clearInterval(timer);
    },
    /** @returns {number} */
    get size() {
      return rooms.size;
    },
    /** @internal Transport helpers exported for tests and future stages. */
    requireActiveRoom,
    requireHost,
    requireGuest,
    bumpLobby,
    markClosed,
    touchPresence,
    reconcilePresence,
  };
}
