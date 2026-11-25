import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * In-memory room model for the relay. Rooms hold seats, a lobby version and
 * presence timestamps; nothing is persisted and there are no external
 * dependencies. Stage 1 exposes creation, joining and the lobby snapshot; the
 * game transport (publish/poll/action) builds on the same room objects.
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

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;
const ROOM_CODE_ATTEMPTS = 100;
const TOKEN_BYTES = 32;

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

      const lastSeen = seat === HOST_SEAT ? room.hostLastSeen : player.lastSeen;

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
      lobbyVersion: 1,
      hostLastSeen: createdAt,
      createdAt,
      closedAt: null,
      started: false,
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
    bumpLobby(room);

    return {
      roomCode: room.code,
      playerId: seat,
      token,
      lobby: getLobby(room),
    };
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
    /** Stops the periodic cleanup timer. */
    stop() {
      clearInterval(timer);
    },
    /** @returns {number} */
    get size() {
      return rooms.size;
    },
    /** @internal Stage 2 transport uses these. */
    requireActiveRoom,
    bumpLobby,
    markClosed,
  };
}
