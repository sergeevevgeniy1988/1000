import {
  LOBBY_POLL_INTERVAL_MS,
  SEAT_IDS,
  formatInviteLink,
  isLanHealth,
  isValidRoomCode,
  normalizeName,
  normalizeRoomCode,
  validateName,
} from './protocol.js';
import { RelayError } from './relay-client.js';

/**
 * Lobby model, storage helpers and the testable lobby controller. The DOM
 * wrapper at the bottom is loaded lazily so unit tests can use the lobby with a
 * fake relay and no document.
 */

export const LAN_INSTRUCTION =
  'Сервер сетевой игры запущен без сетевого режима. Включите сетевой режим на сервере и проверьте снова.';
export const SERVER_INSTRUCTION =
  'Сервер сетевой игры не отвечает. Проверьте соединение с интернетом и проверьте снова.';
export const LOCAL_GAME_AVAILABLE_MESSAGE =
  'Локальная партия остаётся доступной: закройте это окно и играйте как раньше.';

export const AI_SEAT_NAMES = Object.freeze({
  alice: 'Алиса',
  boris: 'Борис',
  human: 'Вы',
});

/** Stable banner classes shared by the lobby UI and the game controller. */
export const NETWORK_BANNER_ONLINE_CLASS = 'network-banner network-banner--online';
export const NETWORK_BANNER_OFFLINE_CLASS = 'network-banner network-banner--offline';

/**
 * Builds the connection banner shown while the relay is reachable or after a
 * poll failed. The text never contains tokens or server internals.
 *
 * @param {object} [options]
 * @param {boolean} [options.connected]
 * @param {string} [options.name]
 * @returns {{ className: string, text: string }}
 */
export function getConnectionBanner({ connected = true, name = '' } = {}) {
  if (connected !== false) {
    return {
      className: NETWORK_BANNER_ONLINE_CLASS,
      text: 'Связь с комнатой есть.',
    };
  }

  return {
    className: NETWORK_BANNER_OFFLINE_CLASS,
    text: typeof name === 'string' && name.length > 0
      ? `Нет связи: ${name}. Пытаемся переподключиться…`
      : 'Нет связи с комнатой. Пытаемся переподключиться…',
  };
}

export const HOST_STORAGE_PREFIX = 'thousand.network.host.';
export const GUEST_STORAGE_PREFIX = 'thousand.network.guest.';
export const TAB_LOCK_PREFIX = 'thousand.network.tab.';
export const TAB_LOCK_STALE_MS = 15000;

/**
 * Normalizes a lobby snapshot coming from the relay. Free seats are always
 * marked as AI, exactly like the server does.
 *
 * @param {object | null | undefined} lobby
 * @returns {{ code: string, version: number, started: boolean, maxPlayers: number, seats: object[] }}
 */
export function normalizeLobby(lobby) {
  const seats = Array.isArray(lobby?.seats)
    ? lobby.seats.map((seat) => {
      const occupied = seat?.occupied === true;

      return {
        playerId: typeof seat?.playerId === 'string' ? seat.playerId : '',
        name: typeof seat?.name === 'string' && seat.name.length > 0 ? seat.name : null,
        occupied,
        isHost: seat?.isHost === true,
        isAI: occupied ? false : true,
        connected: occupied ? seat?.connected === true : false,
        lastSeen: typeof seat?.lastSeen === 'string' ? seat.lastSeen : null,
      };
    })
    : [];

  return {
    code: normalizeRoomCode(lobby?.code),
    version: Number.isFinite(lobby?.version) ? lobby.version : 0,
    started: lobby?.started === true,
    maxPlayers: Number.isFinite(lobby?.maxPlayers) ? lobby.maxPlayers : 3,
    seats,
  };
}

/**
 * @param {object | null | undefined} lobby
 * @returns {number}
 */
export function countLivePlayers(lobby) {
  return normalizeLobby(lobby).seats.filter((seat) => seat.occupied).length;
}

/**
 * A host may start with one, two or three live players. Every other seat is
 * played by AI.
 *
 * @param {object | null | undefined} lobby
 * @returns {boolean}
 */
export function canStartLobby(lobby) {
  const normalized = normalizeLobby(lobby);
  const live = normalized.seats.filter((seat) => seat.occupied).length;

  return !normalized.started && live >= 1 && live <= normalized.maxPlayers;
}

/**
 * @param {object | null | undefined} seat
 * @returns {string}
 */
export function getSeatDisplayName(seat) {
  if (seat?.occupied === true) {
    return typeof seat.name === 'string' && seat.name.length > 0 ? seat.name : 'Игрок';
  }

  return AI_SEAT_NAMES[seat?.playerId] ?? 'AI';
}

/**
 * @param {object | null | undefined} seat
 * @returns {string}
 */
export function getSeatStatus(seat) {
  if (!seat || seat.occupied !== true) {
    return 'AI';
  }

  return seat.connected === true ? 'в комнате' : 'нет связи';
}

/**
 * Returns a user-facing instruction when the server cannot host a network
 * game. `null` means network mode is available: any relay that reports
 * `network: true` (Render) or the legacy `lan: true` flag can host a room.
 *
 * @param {object | null | undefined} health
 * @returns {{ ok: false, code: string, message: string, localGameAvailable: boolean } | null}
 */
export function getHealthInstruction(health) {
  if (isLanHealth(health) || (health && health.ok === true && health.network === true)) {
    return null;
  }

  if (health && health.ok === true) {
    return {
      ok: false,
      code: 'lan_disabled',
      message: LAN_INSTRUCTION,
      localGameAvailable: true,
    };
  }

  return {
    ok: false,
    code: 'server_unavailable',
    message: SERVER_INSTRUCTION,
    localGameAvailable: true,
  };
}

/**
 * Minimal in-memory `Storage` implementation for tests.
 *
 * @param {Record<string, string>} [initial]
 * @returns {Storage}
 */
export function createMemoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));

  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    key(index) {
      return [...map.keys()][index] ?? null;
    },
    removeItem(key) {
      map.delete(key);
    },
    setItem(key, value) {
      map.set(key, String(value));
    },
  };
}

/**
 * @param {Storage | null | undefined} storage
 * @param {string} prefix
 * @param {string} roomCode
 * @returns {object | null}
 */
export function readStoredSession(storage, prefix, roomCode) {
  if (!storage) {
    return null;
  }

  const key = `${prefix}${normalizeRoomCode(roomCode)}`;

  try {
    const raw = storage.getItem(key);

    if (typeof raw !== 'string' || raw.length === 0) {
      return null;
    }

    const parsed = JSON.parse(raw);

    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * @param {Storage | null | undefined} storage
 * @param {string} prefix
 * @param {string} roomCode
 * @param {object} session
 * @returns {void}
 */
export function writeStoredSession(storage, prefix, roomCode, session) {
  if (!storage) {
    return;
  }

  try {
    storage.setItem(`${prefix}${normalizeRoomCode(roomCode)}`, JSON.stringify(session));
  } catch {
    // Storage can be unavailable in private mode; the game still works.
  }
}

/**
 * @param {Storage | null | undefined} storage
 * @param {string} prefix
 * @param {string} roomCode
 * @returns {void}
 */
export function clearStoredSession(storage, prefix, roomCode) {
  if (!storage) {
    return;
  }

  try {
    storage.removeItem(`${prefix}${normalizeRoomCode(roomCode)}`);
  } catch {
    // Nothing to clear.
  }
}

/** @param {Storage | null | undefined} storage @param {string} roomCode */
export function readHostSession(storage, roomCode) {
  return readStoredSession(storage, HOST_STORAGE_PREFIX, roomCode);
}

/** @param {Storage | null | undefined} storage @param {string} roomCode */
export function readGuestSession(storage, roomCode) {
  return readStoredSession(storage, GUEST_STORAGE_PREFIX, roomCode);
}

/**
 * Best-effort lock that warns when the same player is open in two tabs.
 *
 * @param {object} options
 * @param {Storage | null | undefined} options.storage
 * @param {string} options.roomCode
 * @param {string} options.playerId
 * @param {string} options.tabId
 * @param {number} [options.now]
 * @param {number} [options.staleMs]
 * @returns {{ ok: boolean, warning: string | null }}
 */
export function acquirePlayerTabLock({
  storage,
  roomCode,
  playerId,
  tabId,
  now = Date.now(),
  staleMs = TAB_LOCK_STALE_MS,
}) {
  if (!storage || !roomCode || !playerId || !tabId) {
    return { ok: true, warning: null };
  }

  const key = `${TAB_LOCK_PREFIX}${normalizeRoomCode(roomCode)}.${playerId}`;
  let existing = null;

  try {
    const raw = storage.getItem(key);
    existing = raw ? JSON.parse(raw) : null;
  } catch {
    existing = null;
  }

  if (
    existing
    && existing.tabId !== tabId
    && Number.isFinite(existing.at)
    && now - existing.at < staleMs
  ) {
    return {
      ok: false,
      warning: 'Этот игрок уже открыт в другой вкладке. Закройте лишнюю вкладку или продолжите здесь.',
    };
  }

  try {
    storage.setItem(key, JSON.stringify({ tabId, at: now }));
  } catch {
    // Ignore quota and privacy-mode errors.
  }

  return { ok: true, warning: null };
}

/**
 * @param {object} options
 * @param {Storage | null | undefined} options.storage
 * @param {string} options.roomCode
 * @param {string} options.playerId
 * @param {string} options.tabId
 * @returns {void}
 */
export function releasePlayerTabLock({ storage, roomCode, playerId, tabId }) {
  if (!storage || !roomCode || !playerId || !tabId) {
    return;
  }

  const key = `${TAB_LOCK_PREFIX}${normalizeRoomCode(roomCode)}.${playerId}`;

  try {
    const raw = storage.getItem(key);
    const existing = raw ? JSON.parse(raw) : null;

    if (!existing || existing.tabId === tabId) {
      storage.removeItem(key);
    }
  } catch {
    // Nothing to release.
  }
}

/**
 * @returns {string}
 */
function createTabId() {
  const cryptoApi = typeof globalThis !== 'undefined' ? globalThis.crypto : null;

  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }

  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Lobby controller shared by the browser UI and tests. It owns room creation,
 * joining, resume, kick/close/leave and the optional lobby poll. It does not
 * touch the DOM.
 */
export class NetworkLobby {
  #relay;
  #sessionStorage;
  #localStorage;
  #now;
  #tabId;
  #role = null;
  #roomCode = '';
  #playerId = '';
  #token = '';
  #name = '';
  #lobby = normalizeLobby(null);
  #started = false;
  #view = null;
  #viewVersion = 0;
  #warning = null;
  #pollTimer = null;
  #pollGeneration = 0;
  #disposed = false;

  /**
   * @param {object} options
   * @param {object} options.relay Relay-like client.
   * @param {Storage | null} [options.sessionStorage]
   * @param {Storage | null} [options.localStorage]
   * @param {() => number} [options.now]
   * @param {string} [options.tabId]
   */
  constructor({
    relay,
    sessionStorage = null,
    localStorage = null,
    now = () => Date.now(),
    tabId = null,
  } = {}) {
    if (!relay || typeof relay.health !== 'function' || typeof relay.createRoom !== 'function') {
      throw new TypeError('NetworkLobby requires a relay client.');
    }

    this.#relay = relay;
    this.#sessionStorage = sessionStorage;
    this.#localStorage = localStorage;
    this.#now = now;
    this.#tabId = tabId ?? createTabId();
  }

  /** @returns {object} */
  get relay() {
    return this.#relay;
  }

  /** @returns {string | null} */
  get role() {
    return this.#role;
  }

  /** @returns {string} */
  get roomCode() {
    return this.#roomCode;
  }

  /** @returns {string} */
  get playerId() {
    return this.#playerId;
  }

  /** @returns {string} */
  get token() {
    return this.#token;
  }

  /** @returns {string} */
  get name() {
    return this.#name;
  }

  /** @returns {object} */
  get lobby() {
    return this.#lobby;
  }

  /** @returns {boolean} */
  get started() {
    return this.#started;
  }

  /** @returns {object | null} */
  get view() {
    return this.#view;
  }

  /** @returns {string | null} */
  get warning() {
    return this.#warning;
  }

  /**
   * Checks `/api/health` and turns `lan: false` into a user-facing instruction.
   *
   * @returns {Promise<{ ok: true, health: object } | { ok: false, code: string, message: string, localGameAvailable: boolean, health?: object }>}
   */
  async checkHealth() {
    let health = null;

    try {
      health = await this.#relay.health();
    } catch {
      return {
        ok: false,
        code: 'server_unavailable',
        message: SERVER_INSTRUCTION,
        localGameAvailable: true,
      };
    }

    const issue = getHealthInstruction(health);

    if (issue) {
      return { ...issue, health };
    }

    return { ok: true, health };
  }

  /**
   * @param {string} name
   * @returns {Promise<object>}
   */
  async createRoom(name) {
    const health = await this.checkHealth();

    if (!health.ok) {
      return health;
    }

    const validation = validateName(name);

    if (!validation.ok) {
      return validation;
    }

    let created;

    try {
      created = await this.#relay.createRoom(validation.name);
    } catch (error) {
      return this.#relayFailure(error);
    }

    this.#applySession({
      role: 'host',
      roomCode: created.roomCode,
      playerId: created.playerId,
      token: created.token,
      name: validation.name,
      lobby: created.lobby,
    });
    writeStoredSession(this.#sessionStorage, HOST_STORAGE_PREFIX, this.#roomCode, {
      token: this.#token,
      playerId: this.#playerId,
      name: this.#name,
      savedAt: this.#now(),
    });
    this.#warning = this.#acquireTabLock();

    return {
      ok: true,
      role: 'host',
      roomCode: this.#roomCode,
      playerId: this.#playerId,
      token: this.#token,
      lobby: this.#lobby,
      warning: this.#warning,
    };
  }

  /**
   * @param {string} roomCode
   * @param {string} name
   * @returns {Promise<object>}
   */
  async joinRoom(roomCode, name) {
    const code = normalizeRoomCode(roomCode);

    if (!isValidRoomCode(code)) {
      return {
        ok: false,
        code: 'bad_room_code',
        message: 'Код комнаты состоит из шести символов.',
      };
    }

    const health = await this.checkHealth();

    if (!health.ok) {
      return health;
    }

    const validation = validateName(name);

    if (!validation.ok) {
      return validation;
    }

    let joined;

    try {
      joined = await this.#relay.joinRoom(code, validation.name);
    } catch (error) {
      return this.#relayFailure(error);
    }

    this.#applySession({
      role: 'guest',
      roomCode: joined.roomCode ?? code,
      playerId: joined.playerId,
      token: joined.token,
      name: validation.name,
      lobby: joined.lobby,
    });
    writeStoredSession(this.#localStorage, GUEST_STORAGE_PREFIX, this.#roomCode, {
      token: this.#token,
      playerId: this.#playerId,
      name: this.#name,
      savedAt: this.#now(),
    });
    this.#warning = this.#acquireTabLock();

    return {
      ok: true,
      role: 'guest',
      roomCode: this.#roomCode,
      playerId: this.#playerId,
      token: this.#token,
      lobby: this.#lobby,
      warning: this.#warning,
    };
  }

  /**
   * Restores a guest seat from the token saved under the room code.
   *
   * @param {string} roomCode
   * @returns {Promise<object>}
   */
  async resumeGuest(roomCode) {
    const code = normalizeRoomCode(roomCode);

    if (!isValidRoomCode(code)) {
      return {
        ok: false,
        code: 'bad_room_code',
        message: 'Код комнаты состоит из шести символов.',
      };
    }

    const stored = readGuestSession(this.#localStorage, code);

    if (
      !stored
      || typeof stored.token !== 'string'
      || typeof stored.playerId !== 'string'
      || !SEAT_IDS.includes(stored.playerId)
    ) {
      return {
        ok: false,
        code: 'no_saved_guest',
        message: 'Нет сохранённого гостевого места. Введите имя и присоединитесь.',
      };
    }

    let state;

    try {
      state = await this.#relay.playerPoll(code, stored.token, {
        viewSince: 0,
        logSince: 0,
        logEpoch: 0,
        messageSince: 0,
      });
    } catch (error) {
      if (error instanceof RelayError && [401, 404, 410].includes(error.status)) {
        clearStoredSession(this.#localStorage, GUEST_STORAGE_PREFIX, code);
      }

      return this.#relayFailure(error);
    }

    this.#applySession({
      role: 'guest',
      roomCode: code,
      playerId: stored.playerId,
      token: stored.token,
      name: typeof stored.name === 'string' ? stored.name : '',
      lobby: state.lobby,
      started: state.started,
      view: state.view ?? null,
    });
    this.#viewVersion = Number.isFinite(state.viewVersion) ? state.viewVersion : 0;
    this.#warning = this.#acquireTabLock();

    return {
      ok: true,
      role: 'guest',
      roomCode: this.#roomCode,
      playerId: this.#playerId,
      token: this.#token,
      name: this.#name,
      lobby: this.#lobby,
      started: this.#started,
      view: this.#view,
      warning: this.#warning,
    };
  }

  /**
   * Polls the current room once. The host receives the action queue and lobby;
   * a guest receives the lobby and, when available, a fresh player view.
   *
   * @returns {Promise<object>}
   */
  async refresh() {
    if (!this.#role) {
      return { ok: false, code: 'no_room', message: 'Сначала создайте комнату или присоединитесь.' };
    }

    try {
      if (this.#role === 'host') {
        const state = await this.#relay.hostPoll(this.#roomCode, this.#token, {
          actionSince: 0,
          lobbySince: 0,
        });
        this.#lobby = normalizeLobby(state.lobby);
        this.#started = this.#lobby.started;

        return { ok: true, lobby: this.#lobby, started: this.#started, actions: state.actions ?? [] };
      }

      const state = await this.#relay.playerPoll(this.#roomCode, this.#token, {
        viewSince: this.#viewVersion,
        logSince: 0,
        logEpoch: 0,
        messageSince: 0,
      });
      this.#lobby = normalizeLobby(state.lobby);
      this.#started = state.started === true;

      if (state.view) {
        this.#view = state.view;
      }

      if (Number.isFinite(state.viewVersion)) {
        this.#viewVersion = state.viewVersion;
      }

      return {
        ok: true,
        lobby: this.#lobby,
        started: this.#started,
        view: this.#view,
      };
    } catch (error) {
      return this.#relayFailure(error);
    }
  }

  /**
   * @param {string} playerId
   * @returns {Promise<object>}
   */
  async kick(playerId) {
    if (this.#role !== 'host') {
      return { ok: false, code: 'not_host', message: 'Удалять игроков может только хост.' };
    }

    try {
      const result = await this.#relay.kick(this.#roomCode, this.#token, playerId);
      this.#lobby = normalizeLobby(result.lobby);

      return { ok: true, lobby: this.#lobby };
    } catch (error) {
      return this.#relayFailure(error);
    }
  }

  /**
   * Closes the room and clears the host token.
   *
   * @returns {Promise<object>}
   */
  async closeRoom() {
    if (this.#role !== 'host') {
      return { ok: false, code: 'not_host', message: 'Закрыть комнату может только хост.' };
    }

    const roomCode = this.#roomCode;

    this.stopPolling();

    try {
      await this.#relay.closeRoom(roomCode, this.#token);
    } catch (error) {
      const failure = this.#relayFailure(error);
      clearStoredSession(this.#sessionStorage, HOST_STORAGE_PREFIX, roomCode);
      this.#releaseTabLock();
      this.#clearSession();
      return failure;
    }

    clearStoredSession(this.#sessionStorage, HOST_STORAGE_PREFIX, roomCode);
    this.#releaseTabLock();
    this.#clearSession();
    return { ok: true };
  }

  /**
   * Explicit exit: clears the stored token, releases the tab lock and stops
   * polling. The host leaves by closing the room.
   *
   * @returns {Promise<{ ok: true }>}
   */
  async leave() {
    const role = this.#role;
    const roomCode = this.#roomCode;
    const token = this.#token;

    this.stopPolling();

    if (role === 'host') {
      clearStoredSession(this.#sessionStorage, HOST_STORAGE_PREFIX, roomCode);
    } else if (role === 'guest') {
      clearStoredSession(this.#localStorage, GUEST_STORAGE_PREFIX, roomCode);
    }

    this.#releaseTabLock();
    this.#clearSession();

    if (role && roomCode && token) {
      try {
        await this.#relay.leave(roomCode, token);
      } catch {
        // The room may already be closed or expired; local cleanup is done.
      }
    }

    return { ok: true };
  }

  /**
   * Starts a lightweight lobby poll. The host sees guests joining and leaving;
   * a guest sees the lobby snapshot until the game session takes over.
   *
   * @param {object} [options]
   * @param {number} [options.intervalMs]
   * @param {(result: object) => void} [options.onUpdate]
   * @param {(result: object) => void} [options.onError]
   * @returns {void}
   */
  startPolling({
    intervalMs = LOBBY_POLL_INTERVAL_MS,
    onUpdate = null,
    onError = null,
  } = {}) {
    this.stopPolling();

    if (!this.#role) {
      return;
    }

    const generation = this.#pollGeneration;

    const tick = async () => {
      this.#pollTimer = null;

      if (this.#disposed || !this.#role || generation !== this.#pollGeneration) {
        return;
      }

      const result = await this.refresh();

      if (generation !== this.#pollGeneration) {
        return;
      }

      if (result.ok) {
        onUpdate?.(result);
      } else {
        onError?.(result);

        if (['room_closed', 'room_not_found', 'invalid_token', 'missing_token'].includes(result.code)) {
          return;
        }
      }

      if (!this.#disposed && this.#role && generation === this.#pollGeneration) {
        this.#pollTimer = setTimeout(tick, intervalMs);
      }
    };

    this.#pollTimer = setTimeout(tick, intervalMs);
  }

  /**
   * @returns {void}
   */
  stopPolling() {
    this.#pollGeneration += 1;

    if (this.#pollTimer !== null) {
      clearTimeout(this.#pollTimer);
      this.#pollTimer = null;
    }
  }

  /**
   * Stops polling and makes the instance inert. Does not clear stored tokens:
   * switching to the game session keeps the room alive.
   *
   * @returns {void}
   */
  dispose() {
    this.#disposed = true;
    this.stopPolling();
  }

  /**
   * @param {object} options
   * @returns {string}
   */
  getInviteLink({ origin = '', pathname = '/' } = {}) {
    return formatInviteLink(this.#roomCode, { origin, pathname });
  }

  /**
   * @param {object} options
   * @returns {void}
   */
  #applySession({
    role,
    roomCode,
    playerId,
    token,
    name,
    lobby,
    started = false,
    view = null,
  }) {
    this.#role = role;
    this.#roomCode = normalizeRoomCode(roomCode);
    this.#playerId = typeof playerId === 'string' ? playerId : '';
    this.#token = typeof token === 'string' ? token : '';
    this.#name = normalizeName(name);
    this.#lobby = normalizeLobby(lobby);
    this.#started = started === true || this.#lobby.started;
    this.#view = view;
    this.#viewVersion = 0;
  }

  /**
   * @returns {void}
   */
  #clearSession() {
    this.#role = null;
    this.#roomCode = '';
    this.#playerId = '';
    this.#token = '';
    this.#name = '';
    this.#lobby = normalizeLobby(null);
    this.#started = false;
    this.#view = null;
    this.#viewVersion = 0;
    this.#warning = null;
  }

  /**
   * @returns {string | null}
   */
  #acquireTabLock() {
    if (!this.#localStorage || !this.#roomCode || !this.#playerId) {
      return null;
    }

    const result = acquirePlayerTabLock({
      storage: this.#localStorage,
      roomCode: this.#roomCode,
      playerId: this.#playerId,
      tabId: this.#tabId,
      now: this.#now(),
    });

    return result.ok ? null : result.warning;
  }

  /**
   * @returns {void}
   */
  #releaseTabLock() {
    if (!this.#localStorage || !this.#roomCode || !this.#playerId) {
      return;
    }

    releasePlayerTabLock({
      storage: this.#localStorage,
      roomCode: this.#roomCode,
      playerId: this.#playerId,
      tabId: this.#tabId,
    });
  }

  /**
   * @param {unknown} error
   * @returns {{ ok: false, code: string, message: string, status?: number }}
   */
  #relayFailure(error) {
    if (error instanceof RelayError) {
      if (error.status === 410) {
        return {
          ok: false,
          code: 'room_closed',
          message: 'Комната закрыта хостом.',
          status: 410,
        };
      }

      if (error.status === 404) {
        return {
          ok: false,
          code: 'room_not_found',
          message: 'Комната не найдена. Проверьте код.',
          status: 404,
        };
      }

      if (error.status === 401) {
        return {
          ok: false,
          code: 'invalid_token',
          message: 'Место больше недоступно. Присоединитесь заново.',
          status: 401,
        };
      }

      return {
        ok: false,
        code: error.code,
        message: error.message,
        status: error.status,
      };
    }

    return {
      ok: false,
      code: 'network_error',
      message: 'Не удалось связаться с сервером.',
    };
  }
}

/**
 * Opens the network lobby modal. The DOM modules are imported lazily so the
 * lobby model and its tests remain DOM-free.
 *
 * @param {object} options
 * @param {NetworkLobby} options.lobby
 * @param {string} [options.initialRoomCode]
 * @param {(context: { lobby: NetworkLobby, close: () => void }) => Promise<void> | void} [options.onHostStart]
 * @param {(context: { lobby: NetworkLobby, close: () => void }) => Promise<void> | void} [options.onGuestJoined]
 * @param {() => void} [options.onExit]
 * @returns {Promise<{ element: HTMLElement, close: () => void } | null>}
 */
export async function openNetworkLobbyModal({
  lobby,
  initialRoomCode = '',
  onHostStart = null,
  onGuestJoined = null,
  onExit = null,
}) {
  const [{ openModal, closeModal }, { createElement }] = await Promise.all([
    import('../ui/modals.js'),
    import('../ui/dom.js'),
  ]);

  const state = {
    health: null,
    issue: null,
    role: null,
    roomCode: normalizeRoomCode(initialRoomCode),
    name: '',
    lobby: normalizeLobby(null),
    status: '',
    busy: false,
    started: false,
  };
  const body = createElement('div', { className: 'network-lobby' });
  let closed = false;
  let modal = null;

  const closeSelf = () => {
    if (closed) {
      return;
    }

    closed = true;
    lobby.stopPolling();
    closeModal({ silent: true });
  };

  const handleUserClose = () => {
    closed = true;
    lobby.stopPolling();

    if (state.role) {
      void lobby.leave().catch(() => {});
    }

    onExit?.();
  };

  const renderStatus = () => {
    if (!state.status) {
      return null;
    }

    return createElement('p', {
      className: 'network-status',
      text: state.status,
      attrs: { role: 'status' },
    });
  };

  const renderIssue = () => {
    body.append(
      createElement('p', {
        className: 'network-instruction',
        text: state.issue.message,
      }),
      createElement('p', {
        className: 'network-hint',
        text: LOCAL_GAME_AVAILABLE_MESSAGE,
      }),
    );

    const retry = createElement('button', {
      className: 'button button--ghost',
      text: 'Проверить снова',
      attrs: { type: 'button' },
    });
    const local = createElement('button', {
      className: 'button',
      text: 'Играть локально',
      attrs: { type: 'button' },
    });

    retry.addEventListener('click', () => {
      void checkHealth();
    });
    local.addEventListener('click', () => {
      closeSelf();
      onExit?.();
    });

    body.append(createElement('div', { className: 'network-actions' }, retry, local));
  };

  const startHostPolling = () => {
    lobby.startPolling({
      onUpdate: (result) => {
        state.lobby = result.lobby;
        state.started = result.started === true;
        render();
      },
      onError: (result) => {
        state.status = result.message ?? 'Не удалось обновить лобби.';
        render();
      },
    });
  };

  const handleCreate = async (nameInput) => {
    state.name = nameInput.value;
    state.busy = true;
    state.status = 'Создаём комнату…';
    render();

    const result = await lobby.createRoom(state.name);

    state.busy = false;

    if (!result.ok) {
      state.status = result.message ?? 'Не удалось создать комнату.';
      render();
      return;
    }

    state.role = 'host';
    state.roomCode = result.roomCode;
    state.lobby = result.lobby;
    state.status = result.warning ?? '';
    render();
    startHostPolling();
  };

  const handleJoin = async (nameInput, codeInput) => {
    state.name = nameInput.value;
    state.roomCode = codeInput.value;
    state.busy = true;
    state.status = 'Присоединяемся…';
    render();

    const result = await lobby.joinRoom(state.roomCode, state.name);

    state.busy = false;

    if (!result.ok) {
      state.status = result.message ?? 'Не удалось присоединиться.';
      render();
      return;
    }

    state.role = 'guest';
    state.roomCode = result.roomCode;
    state.lobby = result.lobby;
    state.status = result.warning ?? 'Вы в комнате. Ждём, пока хост начнёт партию…';
    render();

    if (onGuestJoined) {
      try {
        await onGuestJoined({ lobby, close: closeSelf });
      } catch (error) {
        state.status = error instanceof Error && error.message
          ? error.message
          : 'Не удалось начать гостевую сессию.';
        render();
      }
    }
  };

  const handleKick = async (playerId) => {
    state.busy = true;
    state.status = 'Обновляем лобби…';
    render();

    const result = await lobby.kick(playerId);

    state.busy = false;
    state.status = result.ok ? '' : (result.message ?? 'Не удалось удалить игрока.');

    if (result.ok) {
      state.lobby = result.lobby;
    }

    render();
  };

  const handleStart = async () => {
    if (!canStartLobby(state.lobby) || state.busy) {
      return;
    }

    state.busy = true;
    state.status = 'Запускаем партию…';
    render();

    try {
      await onHostStart?.({ lobby, close: closeSelf });
    } catch (error) {
      state.busy = false;
      state.status = error instanceof Error ? error.message : 'Не удалось начать партию.';
      render();
    }
  };

  const handleCloseRoom = async () => {
    state.busy = true;
    state.status = 'Закрываем комнату…';
    render();

    await lobby.closeRoom();
    closeSelf();
    onExit?.();
  };

  const handleLeave = async () => {
    state.busy = true;
    state.status = 'Выходим…';
    render();

    await lobby.leave();
    closeSelf();
    onExit?.();
  };

  const renderForm = () => {
    const nameInput = createElement('input', {
      className: 'network-input',
      attrs: {
        id: 'network-name',
        type: 'text',
        maxlength: '24',
        autocomplete: 'nickname',
        placeholder: 'Ваше имя',
        'data-autofocus': 'true',
      },
    });
    nameInput.value = state.name;

    const codeInput = createElement('input', {
      className: 'network-input network-input--code',
      attrs: {
        id: 'network-code',
        type: 'text',
        maxlength: '6',
        inputmode: 'text',
        autocomplete: 'off',
        placeholder: 'ABC234',
      },
    });
    codeInput.value = state.roomCode;

    const createButton = createElement('button', {
      className: 'button',
      text: 'Создать комнату',
      attrs: { type: 'button' },
    });
    const joinButton = createElement('button', {
      className: 'button button--ghost',
      text: 'Присоединиться',
      attrs: { type: 'button' },
    });

    createButton.disabled = state.busy;
    joinButton.disabled = state.busy;

    createButton.addEventListener('click', () => {
      void handleCreate(nameInput);
    });
    joinButton.addEventListener('click', () => {
      void handleJoin(nameInput, codeInput);
    });

    body.append(
      createElement('p', {
        className: 'network-hint',
        text: 'Создайте комнату на этом компьютере или присоединитесь по коду из ссылки.',
      }),
      createElement('div', { className: 'network-field' }, ...[
        createElement('label', { className: 'network-label', text: 'Имя', attrs: { for: 'network-name' } }),
        nameInput,
      ]),
      createElement('div', { className: 'network-actions' }, createButton),
      createElement('div', { className: 'network-divider', text: 'или' }),
      createElement('div', { className: 'network-field' }, ...[
        createElement('label', { className: 'network-label', text: 'Код комнаты', attrs: { for: 'network-code' } }),
        codeInput,
      ]),
      createElement('div', { className: 'network-actions' }, joinButton),
    );

    const status = renderStatus();

    if (status) {
      body.append(status);
    }
  };

  const renderSeats = () => {
    const list = createElement('ul', { className: 'network-seats' });

    for (const seat of state.lobby.seats) {
      const item = createElement('li', {
        className: [
          'network-seat',
          seat.occupied ? 'network-seat--occupied' : 'network-seat--ai',
          seat.connected ? '' : 'network-seat--offline',
        ].filter(Boolean),
      });
      const badges = createElement('span', { className: 'network-seat__badges' });

      if (seat.isHost) {
        badges.append(createElement('span', { className: 'badge', text: 'хост' }));
      }

      if (!seat.occupied) {
        badges.append(createElement('span', { className: 'badge', text: 'AI' }));
      } else if (!seat.connected) {
        badges.append(createElement('span', { className: 'badge', text: 'нет связи' }));
      }

      item.append(
        createElement('span', {
          className: 'network-seat__name',
          text: getSeatDisplayName(seat),
        }),
        badges,
      );

      if (
        state.role === 'host'
        && seat.occupied
        && !seat.isHost
        && !state.started
      ) {
        const kick = createElement('button', {
          className: 'button button--ghost network-seat__kick',
          text: 'Убрать',
          attrs: { type: 'button', 'aria-label': `Убрать ${getSeatDisplayName(seat)}` },
        });

        kick.disabled = state.busy;
        kick.addEventListener('click', () => {
          void handleKick(seat.playerId);
        });
        item.append(kick);
      }

      list.append(item);
    }

    return list;
  };

  const renderRoom = () => {
    const invite = lobby.getInviteLink({
      origin: window.location.origin,
      pathname: window.location.pathname,
    });
    const code = createElement('div', {
      className: 'network-room-code',
      text: state.roomCode,
      attrs: { 'aria-label': `Код комнаты ${state.roomCode}` },
    });
    const linkInput = createElement('input', {
      className: 'network-input network-invite__input',
      attrs: {
        type: 'text',
        readonly: true,
        value: invite,
        'aria-label': 'Ссылка-приглашение',
      },
    });
    const copyButton = createElement('button', {
      className: 'button button--ghost',
      text: 'Скопировать ссылку',
      attrs: { type: 'button' },
    });

    copyButton.addEventListener('click', () => {
      void copyText(invite);
    });

    body.append(
      createElement('p', { className: 'network-label', text: 'Код комнаты' }),
      code,
      createElement('p', { className: 'network-label', text: 'Ссылка-приглашение' }),
      createElement('div', { className: 'network-invite' }, linkInput, copyButton),
      createElement('h3', { className: 'network-seats__title', text: 'За столом' }),
      renderSeats(),
    );

    const actions = createElement('div', { className: 'network-actions' });

    if (state.role === 'host') {
      const start = createElement('button', {
        className: 'button',
        text: 'Начать игру',
        attrs: { type: 'button' },
      });
      const close = createElement('button', {
        className: 'button button--ghost',
        text: 'Закрыть комнату',
        attrs: { type: 'button' },
      });

      start.disabled = state.busy || !canStartLobby(state.lobby);
      close.disabled = state.busy;
      start.addEventListener('click', () => {
        void handleStart();
      });
      close.addEventListener('click', () => {
        void handleCloseRoom();
      });
      actions.append(start, close);
    }

    const leave = createElement('button', {
      className: 'button button--ghost',
      text: 'Выйти',
      attrs: { type: 'button' },
    });

    leave.disabled = state.busy;
    leave.addEventListener('click', () => {
      void handleLeave();
    });
    actions.append(leave);
    body.append(actions);

    if (state.role === 'guest') {
      body.append(createElement('p', {
        className: 'network-status network-status--waiting',
        text: state.started
          ? 'Хост начал партию. Получаем первый снимок стола…'
          : 'Ждём, пока хост начнёт партию…',
        attrs: { role: 'status' },
      }));
    }

    const status = renderStatus();

    if (status) {
      body.append(status);
    }
  };

  const render = () => {
    body.replaceChildren();

    if (state.issue) {
      renderIssue();
      return;
    }

    if (!state.role) {
      renderForm();
      return;
    }

    renderRoom();
  };

  const checkHealth = async () => {
    state.issue = null;
    state.status = 'Проверяем сервер…';
    render();

    const health = await lobby.checkHealth();

    if (!health.ok) {
      state.issue = health;
      state.health = health.health ?? null;
      render();
      return;
    }

    state.health = health.health;
    state.status = '';

    if (state.roomCode) {
      const resumed = await lobby.resumeGuest(state.roomCode);

      if (resumed.ok) {
        state.role = 'guest';
        state.roomCode = resumed.roomCode;
        state.lobby = resumed.lobby;
        state.started = resumed.started === true;
        state.status = resumed.warning ?? '';
        render();

        if (onGuestJoined) {
          try {
            await onGuestJoined({ lobby, close: closeSelf });
          } catch (error) {
            state.status = error instanceof Error && error.message
              ? error.message
              : 'Не удалось начать гостевую сессию.';
            render();
          }
        }

        return;
      }

      if (resumed.code !== 'no_saved_guest') {
        state.status = resumed.message ?? '';
      }
    }

    render();
  };

  modal = openModal({
    kind: 'network-lobby',
    title: 'Сетевая игра',
    subtitle: 'Сетевая комната',
    body,
    dismissible: true,
    wide: true,
    className: 'modal--network',
    onClose: handleUserClose,
  });

  if (!modal) {
    return null;
  }

  await checkHealth();

  return {
    element: modal.element,
    close: closeSelf,
    isClosed: () => closed,
  };
}

/**
 * Copies text through the clipboard API with a selection fallback.
 *
 * @param {string} text
 * @returns {Promise<void>}
 */
async function copyText(text) {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to the selection fallback.
    }
  }

  const input = document.createElement('input');

  input.value = text;
  document.body.append(input);
  input.select();

  try {
    document.execCommand('copy');
  } finally {
    input.remove();
  }
}

export { formatInviteLink };
