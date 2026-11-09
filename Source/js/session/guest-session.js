import { GAME_EVENTS } from '../core/constants.js';
import { GameError } from '../core/errors.js';
import { EventEmitter } from '../core/events.js';
import { getSeatStatus, normalizeLobby } from '../net/lobby.js';
import {
  ACTION_TYPES,
  GUEST_ACTION_RETRY_ATTEMPTS,
  GUEST_ACTION_TIMEOUT_MS,
  POLL_INTERVAL_MS,
  RETRY_BASE_DELAY_MS,
  createActionId,
  getReconnectDelay,
  validateAction,
  validateName,
} from '../net/protocol.js';

/** Maps public-log entry types back to the semantic game events. */
const LOG_EVENT_MAP = Object.freeze({
  dealstarted: GAME_EVENTS.DEAL_STARTED,
  bid: GAME_EVENTS.BID,
  pass: GAME_EVENTS.PASS,
  prikuprevealed: GAME_EVENTS.PRIKUP_REVEALED,
  prikup: GAME_EVENTS.PRIKUP,
  contractraised: GAME_EVENTS.CONTRACT_RAISED,
  gift: GAME_EVENTS.GIFT,
  marriage: GAME_EVENTS.MARRIAGE,
  cardplayed: GAME_EVENTS.CARD_PLAYED,
  trickwon: GAME_EVENTS.TRICK_WON,
  scored: GAME_EVENTS.SCORED,
  gameover: GAME_EVENTS.GAME_OVER,
});

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
 * Network guest session. It polls the relay for the seat's personal player
 * view, merges public-log and targeted-message deltas, replays the semantic
 * events the UI needs and posts guest actions with a stable `actionId`.
 *
 * A guest never owns the game: it cannot restart, control AI seats or see any
 * other player's hand. The relay only returns this seat's view.
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
  #sleep;
  #actionRetryAttempts;
  #actionRetryBaseDelayMs;
  #actionTimeoutMs;
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
  #connected = true;
  #offlineAttempts = 0;
  #pendingActions = new Map();
  #lastPollError = null;
  #lastActionError = null;
  #sessionClosed = false;

  /**
   * @param {object} options
   * @param {object} options.relay Relay-like client with `playerPoll` and `action`.
   * @param {string} options.roomCode
   * @param {string} options.token Guest token.
   * @param {string} options.playerId Guest seat id.
   * @param {string} [options.name]
   * @param {number} [options.pollIntervalMs]
   * @param {boolean} [options.continuous] Keep polling after the first view.
   * @param {typeof setTimeout} [options.setTimer]
   * @param {typeof clearTimeout} [options.clearTimer]
   * @param {(milliseconds: number) => Promise<void>} [options.sleep]
   * @param {number} [options.actionRetryAttempts]
   * @param {number} [options.actionRetryBaseDelayMs]
   * @param {number} [options.actionTimeoutMs]
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
    sleep = defaultSleep,
    actionRetryAttempts = GUEST_ACTION_RETRY_ATTEMPTS,
    actionRetryBaseDelayMs = RETRY_BASE_DELAY_MS,
    actionTimeoutMs = GUEST_ACTION_TIMEOUT_MS,
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
    this.#sleep = typeof sleep === 'function' ? sleep : defaultSleep;
    this.#actionRetryAttempts = Math.max(1, actionRetryAttempts);
    this.#actionRetryBaseDelayMs = Math.max(0, actionRetryBaseDelayMs);
    this.#actionTimeoutMs = Math.max(0, actionTimeoutMs);
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

  /** @returns {object | null} The last personal view (never contains `log`). */
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

  /** @returns {boolean} True while the relay is reachable. */
  get connected() {
    return this.#connected && !this.#sessionClosed;
  }

  /** @returns {boolean} True while an action waits for its state change or error. */
  get isPending() {
    return this.#pendingActions.size > 0;
  }

  /** @returns {{ actionId: string, type: string } | null} */
  get pendingAction() {
    const entry = this.#pendingActions.values().next().value;

    return entry ? { actionId: entry.actionId, type: entry.type } : null;
  }

  /** @returns {unknown} */
  get lastPollError() {
    return this.#lastPollError;
  }

  /** @returns {unknown} */
  get lastActionError() {
    return this.#lastActionError;
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
   * @param {string} playerId
   * @returns {string} `AI`, `в комнате` or `нет связи`.
   */
  getSeatStatus(playerId) {
    const seat = this.#lobby.seats.find((entry) => entry.playerId === playerId);
    return getSeatStatus(seat);
  }

  /**
   * Returns the presence snapshot embedded into the last published view.
   *
   * @returns {ReadonlyArray<object>}
   */
  getPresence() {
    const presence = this.#view?.network?.presence;

    return Array.isArray(presence) ? presence : [];
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

    try {
      await this.pollOnce();
    } catch (error) {
      this.#running = false;
      throw error;
    }

    this.#schedule();

    return this.#view;
  }

  /**
   * Polls the relay once and applies the lobby/view/log/message deltas.
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

    this.#lastPollError = null;

    if (!this.#connected) {
      this.#connected = true;
      this.#offlineAttempts = 0;
      this.#emitter.emit('online', { message: 'Связь восстановлена.' });
    }

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
   * Stops polling, clears action timers and releases listeners.
   *
   * @returns {void}
   */
  dispose() {
    this.#disposed = true;
    this.#running = false;
    this.#clearPollTimer();
    this.#clearPendingActions();
    this.#emitter.clear();
  }

  /**
   * @param {object} state
   * @returns {void}
   */
  #applyState(state) {
    const hadView = this.#view !== null;

    if (state?.lobby) {
      this.#lobby = normalizeLobby(state.lobby);
      this.#emitter.emit('lobby', this.#lobby);
    }

    this.#started = state?.started === true;

    if (Number.isFinite(state?.viewVersion)) {
      this.#viewVersion = state.viewVersion;
    }

    if (state?.view) {
      if (state.view.viewerId !== this.#playerId) {
        throw new Error('Сервер прислал снимок чужого места.');
      }

      this.#view = state.view;
    }

    this.#applyLog(state, hadView);
    this.#applyMessages(state);

    if (state?.view) {
      this.#clearPendingActions();
      this.#emitter.emit(GAME_EVENTS.STATE_CHANGE, this.#view);
    }
  }

  /**
   * Merges public-log deltas. A changed epoch means the host reset the log
   * (new game or a resync), so stale local entries are dropped first.
   *
   * @param {object} state
   * @param {boolean} replayEvents Replay semantic events for appended entries.
   * @returns {void}
   */
  #applyLog(state, replayEvents) {
    const nextEpoch = Number.isFinite(state?.logEpoch) ? state.logEpoch : this.#logEpoch;

    if (nextEpoch !== this.#logEpoch) {
      this.#logEpoch = nextEpoch;
      this.#log = [];
      this.#logSince = 0;
    } else if (Number.isFinite(state?.logTotal) && state.logTotal < this.#logSince) {
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

    if (appended.length === 0) {
      return;
    }

    this.#emitter.emit('log', appended);

    if (replayEvents) {
      for (const entry of appended) {
        this.#replayLogEntry(entry);
      }
    }
  }

  /**
   * Turns a public-log entry back into the semantic event the UI reacts to.
   *
   * @param {object} entry
   * @returns {void}
   */
  #replayLogEntry(entry) {
    if (!entry || typeof entry.type !== 'string') {
      return;
    }

    const eventName = LOG_EVENT_MAP[entry.type];

    if (!eventName) {
      return;
    }

    const payload = { ...entry };

    if (entry.type === 'prikup') {
      payload.declarerId = entry.playerId;
      payload.handSize = entry.count;
    } else if (entry.type === 'prikuprevealed') {
      payload.declarerId = entry.playerId;
    }

    this.#emitter.emit(eventName, payload);
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

    if (appended.length === 0) {
      return;
    }

    // The host answered an action: it is no longer pending even when the
    // action was rejected and produced no state change.
    this.#clearPendingActions();

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
   * @param {number} [delay]
   * @returns {void}
   */
  #schedule(delay = this.#pollIntervalMs) {
    if (
      this.#disposed
      || !this.#running
      || this.#timer !== null
      || (!this.#continuous && this.#started && this.#view)
    ) {
      return;
    }

    this.#timer = this.#setTimer(() => {
      this.#timer = null;
      return this.#pollLoop();
    }, Math.max(0, delay));
  }

  /**
   * @returns {Promise<void>}
   */
  async #pollLoop() {
    try {
      await this.pollOnce();
    } catch (error) {
      this.#lastPollError = error;

      if ([401, 404, 410].includes(error?.status)) {
        this.#closeSession(error);
        return;
      }

      const wasOnline = this.#connected;
      this.#connected = false;
      this.#offlineAttempts += 1;

      if (wasOnline) {
        const message = 'Нет связи с комнатой. Пытаемся переподключиться…';
        this.#emitter.emit('offline', { message });
        this.#emitter.emit(GAME_EVENTS.ERROR, new GameError('network_error', message));
      }
    } finally {
      if (this.#running && !this.#disposed) {
        const delay = this.#connected
          ? this.#pollIntervalMs
          : getReconnectDelay(this.#offlineAttempts - 1);

        this.#schedule(delay);
      }
    }
  }

  /**
   * Marks the room as unavailable, stops polling and notifies the UI.
   *
   * @param {unknown} error
   * @returns {void}
   */
  #closeSession(error) {
    if (this.#sessionClosed) {
      return;
    }

    this.#sessionClosed = true;
    this.#running = false;
    this.#clearPollTimer();
    this.#clearPendingActions();

    const status = Number.isFinite(error?.status) ? error.status : 0;
    let code = typeof error?.code === 'string' && error.code.length > 0
      ? error.code
      : 'session_closed';
    let message = 'Сетевая сессия завершена.';

    if (status === 410) {
      code = 'room_closed';
      message = 'Комната закрыта хостом.';
    } else if (status === 401) {
      code = 'invalid_token';
      message = 'Место больше недоступно. Присоединитесь заново.';
    } else if (status === 404) {
      code = 'room_not_found';
      message = 'Комната не найдена. Проверьте код.';
    }

    this.#emitter.emit('sessionclosed', { code, message, status });
  }

  /**
   * Posts an action and keeps it pending until the next state change, targeted
   * error or timeout. Network failures retry with the same `actionId`, so the
   * relay deduplication cannot create a second action.
   *
   * @param {string} type
   * @param {object} [payload]
   * @returns {Promise<object | false>}
   */
  #sendAction(type, payload = {}) {
    if (this.#disposed || this.#sessionClosed) {
      return Promise.resolve(false);
    }

    const validation = validateAction(type, payload);

    if (!validation.ok) {
      this.#emitter.emit(GAME_EVENTS.ERROR, new GameError(validation.code, validation.message));
      return Promise.resolve(false);
    }

    const actionId = createActionId(type);
    const entry = {
      actionId,
      type: validation.type,
      payload: validation.payload,
      timer: null,
    };

    this.#pendingActions.set(actionId, entry);
    entry.timer = this.#setTimer(() => {
      if (!this.#pendingActions.has(actionId)) {
        return;
      }

      this.#removePending(actionId);
      this.#emitter.emit(GAME_EVENTS.ERROR, new GameError(
        'action_timeout',
        'Сервер не подтвердил действие. Попробуйте ещё раз.',
      ));
    }, this.#actionTimeoutMs);

    return this.#postWithRetry(entry).catch((error) => {
      this.#lastActionError = error;
      this.#removePending(actionId);

      if ([401, 404, 410].includes(error?.status)) {
        this.#closeSession(error);
        return false;
      }

      const message = error?.status === 429
        ? 'Слишком часто. Подождите немного и попробуйте снова.'
        : 'Не удалось отправить действие. Проверьте связь.';

      this.#emitter.emit(GAME_EVENTS.ERROR, new GameError(
        typeof error?.code === 'string' && error.code.length > 0 ? error.code : 'network_error',
        message,
      ));

      return false;
    });
  }

  /**
   * @param {{ actionId: string, type: string, payload: object }} entry
   * @returns {Promise<object>}
   */
  async #postWithRetry(entry) {
    let lastError = null;

    for (let attempt = 0; attempt < this.#actionRetryAttempts; attempt += 1) {
      try {
        return await this.#relay.action(this.#roomCode, this.#token, {
          actionId: entry.actionId,
          type: entry.type,
          payload: entry.payload,
        });
      } catch (error) {
        lastError = error;

        const canRetry = this.#isRetryable(error)
          && attempt < this.#actionRetryAttempts - 1;

        if (!canRetry) {
          break;
        }

        await this.#sleep(this.#actionRetryBaseDelayMs * (2 ** attempt));
      }
    }

    throw lastError;
  }

  /**
   * @param {unknown} error
   * @returns {boolean}
   */
  #isRetryable(error) {
    return Boolean(
      error
      && typeof error === 'object'
      && (
        error.retryable === true
        || error.status === 0
        || error.code === 'network_error'
        || error.code === 'timeout'
      ),
    );
  }

  /**
   * @param {string} actionId
   * @returns {void}
   */
  #removePending(actionId) {
    const entry = this.#pendingActions.get(actionId);

    if (!entry) {
      return;
    }

    if (entry.timer !== null) {
      this.#clearTimer(entry.timer);
    }

    this.#pendingActions.delete(actionId);
  }

  /** @returns {void} */
  #clearPendingActions() {
    for (const entry of this.#pendingActions.values()) {
      if (entry.timer !== null) {
        this.#clearTimer(entry.timer);
      }
    }

    this.#pendingActions.clear();
  }

  /** @returns {void} */
  #clearPollTimer() {
    if (this.#timer !== null) {
      this.#clearTimer(this.#timer);
      this.#timer = null;
    }
  }

  /**
   * @param {string} playerId
   * @returns {boolean}
   */
  #isSelf(playerId) {
    return playerId === this.#playerId;
  }

  /** @param {string} playerId @param {number | null} amountOrPass @returns {Promise<object | false>} */
  bid(playerId, amountOrPass) {
    if (!this.#isSelf(playerId)) {
      return Promise.resolve(false);
    }

    return amountOrPass === null || amountOrPass === undefined
      ? this.#sendAction(ACTION_TYPES.PASS)
      : this.#sendAction(ACTION_TYPES.BID, { amount: amountOrPass });
  }

  /** @param {string} playerId @returns {Promise<object | false>} */
  takePrikup(playerId) {
    if (!this.#isSelf(playerId)) {
      return Promise.resolve(false);
    }

    return this.#sendAction(ACTION_TYPES.TAKE_PRIKUP);
  }

  /** @param {string} playerId @param {number | null} amountOrNull @returns {Promise<object | false>} */
  raiseContract(playerId, amountOrNull) {
    if (!this.#isSelf(playerId)) {
      return Promise.resolve(false);
    }

    return amountOrNull === null
      ? this.#sendAction(ACTION_TYPES.DECLINE_RAISE)
      : this.#sendAction(ACTION_TYPES.RAISE_CONTRACT, { amount: amountOrNull });
  }

  /** @param {string} playerId @returns {Promise<object | false>} */
  declineRaise(playerId) {
    if (!this.#isSelf(playerId)) {
      return Promise.resolve(false);
    }

    return this.#sendAction(ACTION_TYPES.DECLINE_RAISE);
  }

  /** @param {string} toPlayerId @param {string} cardId @returns {Promise<object | false>} */
  giveCard(toPlayerId, cardId) {
    return this.#sendAction(ACTION_TYPES.GIVE_CARD, { toPlayerId, cardId });
  }

  /** @param {string} playerId @param {string} suit @returns {Promise<object | false>} */
  declareMarriage(playerId, suit) {
    if (!this.#isSelf(playerId)) {
      return Promise.resolve(false);
    }

    return this.#sendAction(ACTION_TYPES.DECLARE_MARRIAGE, { suit });
  }

  /** @param {string} playerId @returns {Promise<object | false>} */
  cancelMarriage(playerId) {
    if (!this.#isSelf(playerId)) {
      return Promise.resolve(false);
    }

    return this.#sendAction(ACTION_TYPES.CANCEL_MARRIAGE);
  }

  /** @param {string} playerId @param {string} cardId @returns {Promise<object | false>} */
  playCard(playerId, cardId) {
    if (!this.#isSelf(playerId)) {
      return Promise.resolve(false);
    }

    return this.#sendAction(ACTION_TYPES.PLAY_CARD, { cardId });
  }

  /** @returns {Promise<object | false>} */
  nextDeal() {
    return this.#sendAction(ACTION_TYPES.NEXT_DEAL);
  }

  /** @returns {never} */
  restart() {
    throw new Error('Новую игру может начать только хост.');
  }

  /** @returns {never} */
  createAIRng() {
    throw new Error('Гость не управляет AI.');
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
}

GuestSession.CAPABILITIES = Object.freeze({
  mode: 'network-guest',
  controlsAI: false,
  canRestart: false,
  isHost: false,
});
