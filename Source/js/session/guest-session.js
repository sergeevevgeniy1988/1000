import { GAME_EVENTS } from '../core/constants.js';
import { GameError } from '../core/errors.js';
import { EventEmitter } from '../core/events.js';
import { normalizeLobby } from '../net/lobby.js';
import { POLL_INTERVAL_MS, validateName } from '../net/protocol.js';

/**
 * Network guest session scaffold. It resumes a seat with the saved token,
 * polls the lobby until the host starts the game and emits the first personal
 * player view. Applying guest actions over the network belongs to stages 4–5.
 */
export class GuestSession {
  #relay;
  #roomCode;
  #token;
  #playerId;
  #name;
  #pollIntervalMs;
  #continuous;
  #setTimer;
  #clearTimer;
  #emitter = new EventEmitter();
  #lobby = normalizeLobby(null);
  #view = null;
  #viewVersion = 0;
  #log = [];
  #logSince = 0;
  #logEpoch = 0;
  #logTotal = 0;
  #messages = [];
  #messageTotal = 0;
  #started = false;
  #running = false;
  #disposed = false;
  #timer = null;
  #startPromise = null;

  /**
   * @param {object} options
   * @param {object} options.relay Relay-like client with `playerPoll`.
   * @param {string} options.roomCode
   * @param {string} options.token Guest token.
   * @param {string} options.playerId Guest seat id.
   * @param {string} [options.name]
   * @param {number} [options.pollIntervalMs]
   * @param {boolean} [options.continuous] Keep polling after the first view.
   * @param {typeof setTimeout} [options.setTimer]
   * @param {typeof clearTimeout} [options.clearTimer]
   */
  constructor({
    relay,
    roomCode,
    token,
    playerId,
    name = '',
    pollIntervalMs = POLL_INTERVAL_MS,
    continuous = false,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {}) {
    if (!relay || typeof relay.playerPoll !== 'function') {
      throw new TypeError('GuestSession requires a relay client with playerPoll().');
    }

    if (typeof roomCode !== 'string' || roomCode.length === 0) {
      throw new TypeError('GuestSession requires a room code.');
    }

    if (typeof token !== 'string' || token.length === 0) {
      throw new TypeError('GuestSession requires a guest token.');
    }

    if (typeof playerId !== 'string' || playerId.length === 0) {
      throw new TypeError('GuestSession requires a player id.');
    }

    this.#relay = relay;
    this.#roomCode = roomCode;
    this.#token = token;
    this.#playerId = playerId;
    this.#name = typeof name === 'string' ? name : '';
    this.#pollIntervalMs = Math.max(50, pollIntervalMs);
    this.#continuous = continuous === true;
    this.#setTimer = setTimer;
    this.#clearTimer = clearTimer;
  }

  /** @returns {Readonly<{ mode: 'network-guest', controlsAI: false, canRestart: false, isHost: false }>} */
  get capabilities() {
    return GuestSession.CAPABILITIES;
  }

  /** @returns {string} */
  get humanId() {
    return this.#playerId;
  }

  /** @returns {string} */
  get playerId() {
    return this.#playerId;
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
  getState() {
    return this.#view;
  }

  /** @returns {ReadonlyArray<object>} Merged public-log entries. */
  get log() {
    return this.#log;
  }

  /** @returns {ReadonlyArray<object>} Targeted messages addressed to this seat. */
  get messages() {
    return this.#messages;
  }

  /**
   * @param {string} playerId
   * @returns {object}
   */
  getPlayerView(playerId) {
    if (playerId !== this.#playerId) {
      throw new Error('Гость может видеть только своё место.');
    }

    if (!this.#view) {
      throw new Error('Снимок стола ещё не получен.');
    }

    return this.#view;
  }

  /**
   * Starts polling. The first poll is awaited so the caller knows whether the
   * seat is still valid; subsequent polls are scheduled in the background.
   *
   * @returns {Promise<object | null>}
   */
  start() {
    if (!this.#startPromise) {
      this.#startPromise = this.#startInternal();
    }

    return this.#startPromise;
  }

  /**
   * @returns {Promise<object | null>}
   */
  async #startInternal() {
    if (this.#disposed) {
      return null;
    }

    this.#running = true;
    await this.pollOnce();
    this.#schedule();

    return this.#view;
  }

  /**
   * Polls the relay once and applies the lobby/view deltas.
   *
   * @returns {Promise<object | null>}
   */
  async pollOnce() {
    if (this.#disposed) {
      return null;
    }

    const state = await this.#relay.playerPoll(this.#roomCode, this.#token, {
      viewSince: this.#viewVersion,
      logSince: this.#logSince,
      logEpoch: this.#logEpoch,
      messageSince: this.#messageTotal,
    });

    this.#applyState(state);

    return this.#view;
  }

  /** @param {string | ((state: object) => void)} listenerOrEvent @param {((payload: unknown) => void)} [maybeListener] @returns {() => void} */
  subscribe(listenerOrEvent, maybeListener) {
    if (typeof listenerOrEvent === 'string') {
      if (typeof maybeListener !== 'function') {
        throw new TypeError('Event listener must be a function.');
      }

      return this.on(listenerOrEvent, maybeListener);
    }

    if (typeof listenerOrEvent === 'function') {
      return this.on(GAME_EVENTS.STATE_CHANGE, listenerOrEvent);
    }

    throw new TypeError('Subscribe requires an event name or a listener function.');
  }

  /** @param {string} eventName @param {(payload: unknown) => void} listener @returns {() => void} */
  on(eventName, listener) {
    return this.#emitter.on(eventName, listener);
  }

  /** @param {string} eventName @param {(payload: unknown) => void} listener @returns {boolean} */
  off(eventName, listener) {
    return this.#emitter.off(eventName, listener);
  }

  /**
   * Stops polling and releases listeners.
   *
   * @returns {void}
   */
  dispose() {
    this.#disposed = true;
    this.#running = false;

    if (this.#timer !== null) {
      this.#clearTimer(this.#timer);
      this.#timer = null;
    }

    this.#emitter.clear();
  }

  /**
   * @param {object} state
   * @returns {void}
   */
  #applyState(state) {
    if (state?.lobby) {
      this.#lobby = normalizeLobby(state.lobby);
      this.#emitter.emit('lobby', this.#lobby);
    }

    this.#started = state?.started === true;

    if (Number.isFinite(state?.viewVersion)) {
      this.#viewVersion = state.viewVersion;
    }

    this.#applyLog(state);
    this.#applyMessages(state);

    if (state?.view) {
      if (state.view.viewerId !== this.#playerId) {
        throw new Error('Сервер прислал снимок чужого места.');
      }

      this.#view = state.view;
      this.#emitter.emit(GAME_EVENTS.STATE_CHANGE, this.#view);
    }
  }

  /**
   * Merges public-log deltas. A changed epoch means the host reset the log
   * (new game or a resync), so stale local entries are dropped first.
   *
   * @param {object} state
   * @returns {void}
   */
  #applyLog(state) {
    const nextEpoch = Number.isFinite(state?.logEpoch) ? state.logEpoch : this.#logEpoch;

    if (nextEpoch !== this.#logEpoch) {
      this.#logEpoch = nextEpoch;
      this.#log = [];
      this.#logSince = 0;
    }

    const entries = Array.isArray(state?.log) ? state.log : [];
    const appended = [];

    for (const item of entries) {
      if (!item || !Number.isFinite(item.seq) || item.seq <= this.#logSince) {
        continue;
      }

      appended.push(item.entry);
      this.#log.push(item.entry);
      this.#logSince = Math.max(this.#logSince, item.seq);
    }

    if (Number.isFinite(state?.logTotal)) {
      this.#logTotal = state.logTotal;
    }

    if (appended.length > 0) {
      this.#emitter.emit('log', appended);
    }
  }

  /**
   * Applies targeted messages addressed to this seat. Error payloads are also
   * surfaced through the regular `error` event so the existing toast helper
   * can show them.
   *
   * @param {object} state
   * @returns {void}
   */
  #applyMessages(state) {
    const messages = Array.isArray(state?.messages) ? state.messages : [];
    const appended = [];

    for (const item of messages) {
      if (!item || !Number.isFinite(item.seq) || item.seq <= this.#messageTotal) {
        continue;
      }

      appended.push(item.payload);
      this.#messageTotal = Math.max(this.#messageTotal, item.seq);
    }

    if (Number.isFinite(state?.messageTotal)) {
      this.#messageTotal = Math.max(this.#messageTotal, state.messageTotal);
    }

    for (const payload of appended) {
      this.#messages.push(payload);
      this.#emitter.emit('message', payload);

      if (payload && typeof payload === 'object' && typeof payload.code === 'string') {
        this.#emitter.emit(GAME_EVENTS.ERROR, new GameError(
          payload.code,
          typeof payload.message === 'string' && payload.message.length > 0
            ? payload.message
            : 'Не удалось выполнить действие.',
        ));
      }
    }
  }

  /**
   * @returns {void}
   */
  #schedule() {
    if (
      this.#disposed
      || !this.#running
      || this.#timer !== null
      || (this.#started && this.#view && !this.#continuous)
    ) {
      return;
    }

    this.#timer = this.#setTimer(() => {
      this.#timer = null;
      void this.#pollLoop();
    }, this.#pollIntervalMs);
  }

  /**
   * @returns {Promise<void>}
   */
  async #pollLoop() {
    try {
      await this.pollOnce();
    } catch (error) {
      this.#emitter.emit(GAME_EVENTS.ERROR, error);

      if ([401, 404, 410].includes(error?.status)) {
        this.#running = false;
        return;
      }
    } finally {
      this.#schedule();
    }
  }

  /**
   * Joins a room and returns a ready session. The caller owns storage.
   *
   * @param {object} options
   * @returns {Promise<GuestSession>}
   */
  static async join({ relay, roomCode, name, ...options }) {
    const validation = validateName(name);

    if (!validation.ok) {
      throw new Error(validation.message);
    }

    const joined = await relay.joinRoom(roomCode, validation.name);

    return new GuestSession({
      relay,
      roomCode: joined.roomCode ?? roomCode,
      token: joined.token,
      playerId: joined.playerId,
      name: validation.name,
      ...options,
    });
  }

  /**
   * Resumes a saved seat and performs the first poll.
   *
   * @param {object} options
   * @returns {Promise<GuestSession>}
   */
  static async resume({ relay, roomCode, token, playerId, name = '', ...options }) {
    const session = new GuestSession({
      relay,
      roomCode,
      token,
      playerId,
      name,
      ...options,
    });

    await session.pollOnce();

    return session;
  }

  /** @returns {never} */
  #actionsNotAvailable() {
    throw new Error('Сетевые игровые действия появятся на следующем этапе.');
  }

  bid() {
    this.#actionsNotAvailable();
  }

  takePrikup() {
    this.#actionsNotAvailable();
  }

  raiseContract() {
    this.#actionsNotAvailable();
  }

  declineRaise() {
    this.#actionsNotAvailable();
  }

  giveCard() {
    this.#actionsNotAvailable();
  }

  declareMarriage() {
    this.#actionsNotAvailable();
  }

  cancelMarriage() {
    this.#actionsNotAvailable();
  }

  playCard() {
    this.#actionsNotAvailable();
  }

  nextDeal() {
    this.#actionsNotAvailable();
  }

  restart() {
    throw new Error('Новую игру может начать только хост.');
  }

  createAIRng() {
    throw new Error('Гость не управляет AI.');
  }
}

GuestSession.CAPABILITIES = Object.freeze({
  mode: 'network-guest',
  controlsAI: false,
  canRestart: false,
  isHost: false,
});
