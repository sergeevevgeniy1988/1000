import { GAME_EVENTS, TARGET_SCORE } from '../core/constants.js';
import { GameError } from '../core/errors.js';
import { EventEmitter } from '../core/events.js';
import { AI_SEAT_NAMES, getSeatStatus, normalizeLobby } from '../net/lobby.js';
import {
  ACTION_TYPES,
  HOST_ACTION_BATCH_LIMIT,
  HOST_ACTION_DEDUPE_LIMIT,
  HOST_ACTION_POLL_INTERVAL_MS,
  HOST_EVENT_BUFFER_LIMIT,
  HOST_PUBLISH_COALESCE_MS,
  HOST_PUBLISH_RETRY_ATTEMPTS,
  HOST_PUBLISH_RETRY_DELAY_MS,
  HOST_VIEW_MAX_BYTES,
  isValidActionId,
  isValidSeatId,
  validateAction,
} from '../net/protocol.js';
import { LocalSession } from './local-session.js';

/**
 * Browser-safe timer wrapper. Native timers throw `TypeError: Illegal
 * invocation` when they receive a receiver other than the global object, and
 * `this.#setTimer(...)` would pass the session instance as the receiver. The
 * wrapper drops the receiver and calls the global timer as a plain function.
 *
 * @param {() => void} callback
 * @param {number} milliseconds
 * @returns {unknown}
 */
function defaultSetTimer(callback, milliseconds) {
  return setTimeout(callback, milliseconds);
}

/**
 * Browser-safe counterpart of {@link defaultSetTimer}.
 *
 * @param {unknown} timer
 * @returns {void}
 */
function defaultClearTimer(timer) {
  clearTimeout(timer);
}

/** Fixed clockwise seating order used by the network host. */
export const HOST_SEAT_ORDER = Object.freeze(['alice', 'boris', 'human']);

/** The host always occupies the internal `human` seat. */
export const HOST_HOST_ID = 'human';

/**
 * Builds the three game players from a lobby snapshot. Occupied guest seats are
 * live people; empty seats keep the familiar AI names and are marked as AI by
 * `Game#buildSnapshot`.
 *
 * @param {object | null | undefined} lobby
 * @param {string} [hostName]
 * @returns {ReadonlyArray<{ id: string, name: string, isHuman: boolean }>}
 */
export function buildHostPlayers(lobby, hostName = '') {
  const normalized = normalizeLobby(lobby);
  const byId = new Map(normalized.seats.map((seat) => [seat.playerId, seat]));

  return HOST_SEAT_ORDER.map((id) => {
    const seat = byId.get(id);
    const occupied = seat?.occupied === true;
    const fallback = id === HOST_HOST_ID
      ? (hostName.length > 0 ? hostName : AI_SEAT_NAMES.human)
      : (AI_SEAT_NAMES[id] ?? id);
    const name = occupied && typeof seat.name === 'string' && seat.name.length > 0
      ? seat.name
      : fallback;

    return Object.freeze({ id, name, isHuman: occupied });
  });
}

/**
 * Measures the serialized size of one published view. The relay accepts the
 * view as opaque JSON, so the byte length is the relevant limit.
 *
 * @param {unknown} view
 * @returns {number}
 */
export function measureViewBytes(view) {
  const json = JSON.stringify(view);

  if (typeof TextEncoder === 'function') {
    return new TextEncoder().encode(json).length;
  }

  return json.length;
}

/**
 * Keeps the most recent entries when a log delta exceeds the relay buffer.
 * Older entries are dropped together with an epoch bump, so guests can reset
 * their local log instead of applying a gap.
 *
 * @param {ReadonlyArray<unknown>} entries
 * @param {number} [limit]
 * @returns {{ entries: ReadonlyArray<unknown>, dropped: number }}
 */
export function capLogDelta(entries, limit = HOST_EVENT_BUFFER_LIMIT) {
  if (!Array.isArray(entries)) {
    return { entries: [], dropped: 0 };
  }

  if (entries.length <= limit) {
    return { entries, dropped: 0 };
  }

  return {
    entries: entries.slice(entries.length - limit),
    dropped: entries.length - limit,
  };
}

/**
 * Authoritative network host session. It owns a `LocalSession`, applies
 * validated guest actions one by one, publishes per-player views without the
 * public log, streams public-log deltas and targeted error messages, and keeps
 * the lobby presence in every published view.
 */
export class HostSession {
  #relay;
  #roomCode;
  #token;
  #local;
  #players;
  #started = false;
  #running = false;
  #disposed = false;
  #version = 0;
  #lastPublishError = null;
  #lastPollError = null;
  #cursor = 0;
  #lobbyVersion = 0;
  #lobby;
  #logEpoch = 0;
  #logTotal = 0;
  #publishedLogCount = 0;
  #pendingMessages = new Map();
  #stateGeneration = 0;
  #stateDirty = false;
  #presenceGeneration = 0;
  #presenceDirty = false;
  #gameResetPending = false;
  #needsResync = false;
  #seenActions = new Map();
  #presenceSignature = '';
  #emitter = new EventEmitter();
  #eventUnsubscribers = [];
  #remoteApplyDepth = 0;
  #startPromise = null;
  #actionPollIntervalMs;
  #autoPoll;
  #autoPublish;
  #setTimer;
  #clearTimer;
  #pollTimer = null;
  #publishTimer = null;
  #publishing = null;
  #pendingPublish = null;

  /**
   * @param {object} options
   * @param {object} options.relay Relay-like client with `hostPoll` and `publish`.
   * @param {string} options.roomCode
   * @param {string} options.token Host token.
   * @param {object} options.lobby Lobby snapshot at start time.
   * @param {string} [options.hostName]
   * @param {number | null} [options.seed]
   * @param {number} [options.targetScore]
   * @param {number} [options.actionPollIntervalMs] 350–500 ms in production.
   * @param {boolean} [options.autoPoll] Set false in unit tests to poll manually.
   * @param {boolean} [options.autoPublish] Set false in unit tests to flush manually.
   * @param {typeof setTimeout} [options.setTimer]
   * @param {typeof clearTimeout} [options.clearTimer]
   */
  constructor({
    relay,
    roomCode,
    token,
    lobby,
    hostName = '',
    seed = null,
    targetScore = TARGET_SCORE,
    actionPollIntervalMs = HOST_ACTION_POLL_INTERVAL_MS,
    autoPoll = true,
    autoPublish = true,
    setTimer = defaultSetTimer,
    clearTimer = defaultClearTimer,
  } = {}) {
    if (
      !relay
      || typeof relay.publish !== 'function'
      || typeof relay.hostPoll !== 'function'
    ) {
      throw new TypeError('HostSession requires a relay client with hostPoll() and publish().');
    }

    if (typeof roomCode !== 'string' || roomCode.length === 0) {
      throw new TypeError('HostSession requires a room code.');
    }

    if (typeof token !== 'string' || token.length === 0) {
      throw new TypeError('HostSession requires a host token.');
    }

    this.#relay = relay;
    this.#roomCode = roomCode;
    this.#token = token;
    this.#players = buildHostPlayers(lobby, hostName);
    this.#lobby = normalizeLobby(lobby);
    this.#lobbyVersion = this.#lobby.version;
    this.#presenceSignature = this.#presenceKey(this.#lobby);
    this.#actionPollIntervalMs = Math.max(0, actionPollIntervalMs);
    this.#autoPoll = autoPoll !== false;
    this.#autoPublish = autoPublish !== false;
    this.#setTimer = typeof setTimer === 'function'
      ? (callback, milliseconds) => setTimer(callback, milliseconds)
      : defaultSetTimer;
    this.#clearTimer = typeof clearTimer === 'function'
      ? (timer) => clearTimer(timer)
      : defaultClearTimer;
    this.#local = new LocalSession({
      players: this.#players,
      humanId: HOST_HOST_ID,
      seed,
      targetScore,
    });

    for (const player of this.#players) {
      this.#pendingMessages.set(player.id, []);
    }

    this.#bindLocalEvents();
  }

  /** @returns {Readonly<{ mode: 'network-host', controlsAI: true, canRestart: true, isHost: true }>} */
  get capabilities() {
    return HostSession.CAPABILITIES;
  }

  /** @returns {string} */
  get humanId() {
    return HOST_HOST_ID;
  }

  /** @returns {ReadonlyArray<{ id: string, name: string, isHuman: boolean }>} */
  get players() {
    return this.#players;
  }

  /** @returns {number | null} */
  get seed() {
    return this.#local.seed;
  }

  /** @returns {number} */
  get targetScore() {
    return this.#local.targetScore;
  }

  /** @returns {boolean} */
  get started() {
    return this.#started;
  }

  /** @returns {number} Last successfully published version. */
  get version() {
    return this.#version;
  }

  /** @returns {number} Last processed action sequence. */
  get cursor() {
    return this.#cursor;
  }

  /** @returns {number} Current public-log epoch. */
  get logEpoch() {
    return this.#logEpoch;
  }

  /** @returns {number} Number of public-log entries published in the epoch. */
  get logTotal() {
    return this.#logTotal;
  }

  /** @returns {number} Public-log entries waiting for the next publish. */
  get pendingEventCount() {
    if (!this.#local.started) {
      return 0;
    }

    return Math.max(0, this.#local.getLog().length - this.#publishedLogCount);
  }

  /** @returns {unknown} */
  get lastPublishError() {
    return this.#lastPublishError;
  }

  /** @returns {unknown} */
  get lastPollError() {
    return this.#lastPollError;
  }

  /** @returns {object} */
  get lobby() {
    return this.#lobby;
  }

  /**
   * Starts the authoritative game, publishes the first snapshot and begins
   * polling the action queue. Repeated calls return the same promise.
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

    this.#started = true;
    this.#running = true;
    this.#gameResetPending = true;
    this.#local.start();
    await this.flush();
    this.#schedulePoll();

    return this.getState();
  }

  /**
   * Starts a fresh game and publishes it as a reset. The room and seats stay
   * the same, so guests keep their places.
   *
   * @returns {object | null}
   */
  restart() {
    if (!this.#started) {
      void this.start();
      return this.getState();
    }

    if (!this.#publishing) {
      this.#pendingPublish = null;
    }

    this.#gameResetPending = true;
    this.#needsResync = false;
    this.#publishedLogCount = 0;
    this.#logTotal = 0;
    const view = this.#local.restart();
    this.#stateGeneration += 1;
    this.#stateDirty = true;
    this.#schedulePublish({ immediate: true });

    return view;
  }

  /** @returns {object | null} */
  getState() {
    return this.#local.getState();
  }

  /**
   * @param {string} playerId
   * @returns {object}
   */
  getPlayerView(playerId) {
    return this.#local.getPlayerView(playerId);
  }

  /**
   * @param {string} playerId
   * @returns {() => number}
   */
  createAIRng(playerId) {
    return this.#local.createAIRng(playerId);
  }

  /**
   * Returns the presence string for one seat: `AI`, `в комнате` or `нет связи`.
   *
   * @param {string} playerId
   * @returns {string}
   */
  getSeatStatus(playerId) {
    const seat = this.#lobby.seats.find((entry) => entry.playerId === playerId);
    return getSeatStatus(seat);
  }

  /**
   * Returns the presence snapshot embedded into every published view.
   *
   * @returns {ReadonlyArray<object>}
   */
  getPresence() {
    return this.#players.map((player) => {
      const seat = this.#lobby.seats.find((entry) => entry.playerId === player.id);
      const occupied = player.isHuman === true;

      return {
        playerId: player.id,
        name: player.name,
        occupied,
        isAI: !occupied,
        isHost: player.id === HOST_HOST_ID,
        connected: occupied ? seat?.connected === true : false,
        lastSeen: seat?.lastSeen ?? null,
      };
    });
  }

  /** @param {...unknown} args @returns {() => void} */
  subscribe(...args) {
    if (typeof args[0] === 'string') {
      return this.on(args[0], args[1]);
    }

    if (typeof args[0] === 'function') {
      return this.on(GAME_EVENTS.STATE_CHANGE, args[0]);
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

  /** @param {...unknown} args */
  bid(...args) {
    return this.#local.bid(...args);
  }

  /** @param {...unknown} args */
  takePrikup(...args) {
    return this.#local.takePrikup(...args);
  }

  /** @param {...unknown} args */
  raiseContract(...args) {
    return this.#local.raiseContract(...args);
  }

  /** @param {...unknown} args */
  declineRaise(...args) {
    return this.#local.declineRaise(...args);
  }

  /** @param {...unknown} args */
  giveCard(...args) {
    return this.#local.giveCard(...args);
  }

  /** @param {...unknown} args */
  declareMarriage(...args) {
    return this.#local.declareMarriage(...args);
  }

  /** @param {...unknown} args */
  cancelMarriage(...args) {
    return this.#local.cancelMarriage(...args);
  }

  /** @param {...unknown} args */
  playCard(...args) {
    return this.#local.playCard(...args);
  }

  /** @param {...unknown} args */
  nextDeal(...args) {
    return this.#local.nextDeal(...args);
  }

  /**
   * Polls the relay once, applies queued guest actions and refreshes presence.
   * The automatic loop calls this every 350–500 ms in production.
   *
   * @returns {Promise<object | null>}
   */
  async pollActionsOnce() {
    if (this.#disposed || !this.#started) {
      return null;
    }

    const state = await this.#relay.hostPoll(this.#roomCode, this.#token, {
      actionSince: this.#cursor,
      lobbySince: this.#lobbyVersion,
    });
    const presenceChanged = this.#applyLobby(state?.lobby, state?.lobbyVersion);
    const actions = Array.isArray(state?.actions)
      ? [...state.actions].sort((left, right) => left.seq - right.seq)
      : [];
    let processed = 0;
    let batchLimited = false;

    for (const action of actions) {
      if (this.#disposed) {
        break;
      }

      if (processed >= HOST_ACTION_BATCH_LIMIT) {
        batchLimited = true;
        break;
      }

      if (!action || !Number.isInteger(action.seq) || action.seq <= this.#cursor) {
        continue;
      }

      this.#processAction(action);
      this.#cursor = Math.max(this.#cursor, action.seq);
      processed += 1;
    }

    if (!batchLimited && Number.isFinite(state?.cursor)) {
      this.#cursor = Math.max(this.#cursor, state.cursor);
    }

    if (batchLimited) {
      this.#schedulePoll(0);
    }

    if (this.#stateDirty || this.#hasPendingMessages() || presenceChanged) {
      this.#schedulePublish();
    }

    return state;
  }

  /**
   * Publishes pending changes and waits until the relay acknowledges the
   * current version. Safe to call from tests and from the controller.
   *
   * @returns {Promise<void>}
   */
  async flush() {
    this.#clearPublishTimer();

    if (this.#publishing) {
      await this.#publishing;
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (!this.#hasPendingChanges()) {
        break;
      }

      const ok = await this.#publishOnce();

      if (!ok) {
        break;
      }
    }
  }

  /**
   * Forces a full resync: a new log epoch, the current views and the latest
   * public-log tail. Used after a network outage when deltas may be stale.
   *
   * @returns {Promise<void>}
   */
  async resync() {
    this.#needsResync = true;
    this.#stateDirty = true;
    this.#schedulePublish({ immediate: true });
    await this.flush();
  }

  /**
   * Closes the room on the relay. Guests receive `410` on their next poll.
   *
   * @returns {Promise<void>}
   */
  async closeRoom() {
    this.#running = false;
    this.#clearPollTimer();
    this.#clearPublishTimer();

    if (typeof this.#relay.closeRoom === 'function') {
      await this.#relay.closeRoom(this.#roomCode, this.#token);
    }

    this.#emitter.emit('sessionclosed', {
      code: 'room_closed',
      message: 'Комната закрыта хостом.',
    });
  }

  /** @returns {void} */
  dispose() {
    this.#disposed = true;
    this.#running = false;
    this.#clearPollTimer();
    this.#clearPublishTimer();

    for (const unsubscribe of this.#eventUnsubscribers) {
      unsubscribe?.();
    }

    this.#eventUnsubscribers = [];
    this.#local.dispose();
    this.#emitter.clear();
  }

  /**
   * Forwards state changes and semantic events from the authoritative game.
   * Errors caused by remote actions are suppressed here: they are delivered to
   * the action author as a targeted message instead.
   *
   * @returns {void}
   */
  #bindLocalEvents() {
    const stateUnsubscribe = this.#local.on(GAME_EVENTS.STATE_CHANGE, (view) => {
      this.#stateGeneration += 1;
      this.#stateDirty = true;
      this.#emitter.emit(GAME_EVENTS.STATE_CHANGE, view);
      this.#schedulePublish();
    });

    this.#eventUnsubscribers.push(stateUnsubscribe);

    for (const eventName of Object.values(GAME_EVENTS)) {
      if (eventName === GAME_EVENTS.STATE_CHANGE) {
        continue;
      }

      const unsubscribe = this.#local.on(eventName, (payload) => {
        if (eventName === GAME_EVENTS.ERROR) {
          if (this.#remoteApplyDepth > 0) {
            return;
          }

          this.#emitter.emit(eventName, payload);
          return;
        }

        this.#emitter.emit(eventName, payload);
      });

      this.#eventUnsubscribers.push(unsubscribe);
    }
  }

  /**
   * @param {object | null | undefined} lobby
   * @param {unknown} lobbyVersion
   * @returns {boolean} True when presence or seat composition changed.
   */
  #applyLobby(lobby, lobbyVersion) {
    if (!lobby) {
      return false;
    }

    const normalized = normalizeLobby(lobby);
    const previous = this.#presenceSignature;
    const next = this.#presenceKey(normalized);

    this.#lobby = normalized;
    this.#presenceSignature = next;

    if (Number.isFinite(lobbyVersion)) {
      this.#lobbyVersion = lobbyVersion;
    } else if (Number.isFinite(normalized.version)) {
      this.#lobbyVersion = normalized.version;
    }

    if (previous !== next) {
      this.#presenceGeneration += 1;
      this.#presenceDirty = true;
      return true;
    }

    return false;
  }

  /**
   * @param {object} lobby
   * @returns {string}
   */
  #presenceKey(lobby) {
    return lobby.seats
      .map((seat) => `${seat.playerId}:${seat.occupied ? 1 : 0}:${seat.connected ? 1 : 0}:${seat.name ?? ''}`)
      .join('|');
  }

  /**
   * Applies one server-wrapped action. The wrapper `playerId` is authoritative;
   * only live (occupied) seats may act, and AI seats are driven by the host
   * controller directly, never through the relay queue.
   *
   * @param {object} action
   * @returns {'applied' | 'invalid' | 'duplicate' | 'ignored' | 'error'}
   */
  #processAction(action) {
    const playerId = action?.playerId;

    if (!isValidSeatId(playerId)) {
      return 'ignored';
    }

    const seat = this.#players.find((player) => player.id === playerId);

    if (!seat || seat.isHuman !== true) {
      return 'ignored';
    }

    if (!isValidActionId(action.actionId)) {
      this.#sendTargetedError(playerId, 'bad_action', 'Некорректный идентификатор действия.');
      return 'invalid';
    }

    if (this.#isDuplicateAction(playerId, action.actionId)) {
      return 'duplicate';
    }

    this.#rememberAction(playerId, action.actionId);

    const validation = validateAction(action.type, action.payload ?? {});

    if (!validation.ok) {
      this.#sendTargetedError(playerId, validation.code, validation.message);
      return 'invalid';
    }

    try {
      this.#applyValidatedAction(playerId, validation);
      return 'applied';
    } catch (error) {
      if (error instanceof GameError || error?.name === 'GameError') {
        this.#sendTargetedError(playerId, error.code, error.message);
        return 'error';
      }

      this.#emitter.emit(GAME_EVENTS.ERROR, error);
      return 'error';
    }
  }

  /**
   * @param {string} playerId
   * @param {{ type: string, payload: Record<string, unknown> }} action
   * @returns {void}
   */
  #applyValidatedAction(playerId, { type, payload }) {
    this.#remoteApplyDepth += 1;

    try {
      switch (type) {
        case ACTION_TYPES.BID:
          this.#local.bid(playerId, payload.amount);
          break;
        case ACTION_TYPES.PASS:
          this.#local.bid(playerId, null);
          break;
        case ACTION_TYPES.TAKE_PRIKUP:
          this.#local.takePrikup(playerId);
          break;
        case ACTION_TYPES.RAISE_CONTRACT:
          this.#local.raiseContract(playerId, payload.amount);
          break;
        case ACTION_TYPES.DECLINE_RAISE:
          this.#local.declineRaise(playerId);
          break;
        case ACTION_TYPES.GIVE_CARD:
          this.#local.giveCardAs(playerId, payload.toPlayerId, payload.cardId);
          break;
        case ACTION_TYPES.DECLARE_MARRIAGE:
          this.#local.declareMarriage(playerId, payload.suit);
          break;
        case ACTION_TYPES.CANCEL_MARRIAGE:
          this.#local.cancelMarriage(playerId);
          break;
        case ACTION_TYPES.PLAY_CARD:
          this.#local.playCard(playerId, payload.cardId);
          break;
        case ACTION_TYPES.NEXT_DEAL:
          this.#local.nextDeal();
          break;
        default:
          throw new GameError('UNKNOWN_ACTION', 'Неизвестное действие.');
      }
    } finally {
      this.#remoteApplyDepth -= 1;
    }
  }

  /**
   * @param {string} playerId
   * @param {unknown} code
   * @param {unknown} message
   * @returns {void}
   */
  #sendTargetedError(playerId, code, message) {
    const queue = this.#pendingMessages.get(playerId);

    if (!queue) {
      return;
    }

    queue.push({
      code: typeof code === 'string' && code.length > 0 ? code : 'action_error',
      message: typeof message === 'string' && message.length > 0
        ? message
        : 'Не удалось выполнить действие.',
    });
    this.#schedulePublish();
  }

  /**
   * @param {string} playerId
   * @param {string} actionId
   * @returns {boolean}
   */
  #isDuplicateAction(playerId, actionId) {
    return this.#seenActions.get(playerId)?.has(actionId) === true;
  }

  /**
   * @param {string} playerId
   * @param {string} actionId
   * @returns {void}
   */
  #rememberAction(playerId, actionId) {
    let seen = this.#seenActions.get(playerId);

    if (!seen) {
      seen = new Set();
      this.#seenActions.set(playerId, seen);
    }

    seen.add(actionId);

    if (seen.size > HOST_ACTION_DEDUPE_LIMIT) {
      const oldest = seen.values().next().value;
      seen.delete(oldest);
    }
  }

  /**
   * @returns {boolean}
   */
  #hasPendingMessages() {
    for (const queue of this.#pendingMessages.values()) {
      if (queue.length > 0) {
        return true;
      }
    }

    return false;
  }

  /**
   * @returns {boolean}
   */
  #hasPendingChanges() {
    if (this.#disposed || !this.#local.started) {
      return false;
    }

    if (this.#gameResetPending || this.#needsResync || this.#stateDirty || this.#presenceDirty) {
      return true;
    }

    if (this.#hasPendingMessages()) {
      return true;
    }

    return this.#local.getLog().length > this.#publishedLogCount;
  }

  /**
   * @param {object} [options]
   * @param {boolean} [options.immediate]
   * @returns {void}
   */
  #schedulePublish({ immediate = false } = {}) {
    if (this.#disposed || !this.#autoPublish || !this.#started) {
      return;
    }

    if (this.#publishTimer !== null || this.#publishing) {
      return;
    }

    this.#publishTimer = this.#setTimer(() => {
      this.#publishTimer = null;
      void this.#publishOnce();
    }, immediate ? 0 : HOST_PUBLISH_COALESCE_MS);
  }

  /**
   * @returns {Promise<boolean>}
   */
  #publishOnce() {
    if (this.#publishing) {
      return this.#publishing;
    }

    this.#publishing = this.#doPublishOnce().finally(() => {
      this.#publishing = null;
    });

    return this.#publishing;
  }

  /**
   * @returns {Promise<boolean>}
   */
  async #doPublishOnce() {
    if (this.#disposed || !this.#hasPendingChanges()) {
      return true;
    }

    const record = this.#pendingPublish ?? this.#buildPublishRecord();

    if (!record) {
      this.#stateDirty = false;
      return true;
    }

    this.#pendingPublish = record;

    for (let attempt = 0; attempt < HOST_PUBLISH_RETRY_ATTEMPTS; attempt += 1) {
      try {
        const result = await this.#relay.publish(this.#roomCode, this.#token, record.body);
        this.#commitPublish(record, result);
        this.#pendingPublish = null;

        if (this.#hasPendingChanges()) {
          this.#schedulePublish();
        }

        return true;
      } catch (error) {
        this.#lastPublishError = error;

        if (error?.status === 409 && error?.code === 'stale_version') {
          this.#pendingPublish = null;
          this.#version += 1;
          return false;
        }

        if (attempt === HOST_PUBLISH_RETRY_ATTEMPTS - 1) {
          this.#emitter.emit(GAME_EVENTS.ERROR, error);
          this.#schedulePublishRetry();
          return false;
        }
      }
    }

    return false;
  }

  /**
   * @returns {object | null}
   */
  #buildPublishRecord() {
    const log = this.#local.getLog();
    const gameReset = this.#gameResetPending;

    if (gameReset || this.#needsResync) {
      this.#logEpoch += 1;
      this.#publishedLogCount = 0;
      this.#logTotal = 0;
      this.#gameResetPending = false;
      this.#needsResync = false;
    }

    let entries = log.slice(this.#publishedLogCount);

    if (
      entries.length > HOST_EVENT_BUFFER_LIMIT
      || this.#logTotal + entries.length > HOST_EVENT_BUFFER_LIMIT
    ) {
      // The relay keeps at most 500 log entries per epoch. Reset the epoch and
      // send the latest tail so guests can drop stale deltas without a gap.
      this.#logEpoch += 1;
      this.#logTotal = 0;
      this.#publishedLogCount = Math.max(0, log.length - HOST_EVENT_BUFFER_LIMIT);
      entries = log.slice(this.#publishedLogCount);
    }

    const capped = capLogDelta(entries);

    if (capped.dropped > 0) {
      this.#logEpoch += 1;
      this.#logTotal = 0;
      this.#publishedLogCount = Math.max(0, log.length - HOST_EVENT_BUFFER_LIMIT);
      entries = log.slice(this.#publishedLogCount);
    } else {
      entries = capped.entries;
    }

    const messages = this.#takeMessagesSnapshot();
    const version = this.#version + 1;

    return {
      version,
      body: {
        version,
        started: true,
        gameReset,
        logEpoch: this.#logEpoch,
        views: this.#buildViews(),
        log: entries,
        messages: messages.messages,
      },
      stateGeneration: this.#stateGeneration,
      presenceGeneration: this.#presenceGeneration,
      publishedLogCount: log.length,
      logTotalAfter: this.#logTotal + entries.length,
      messageCounts: messages.counts,
    };
  }

  /**
   * @returns {{ messages: Record<string, object[]>, counts: Record<string, number> }}
   */
  #takeMessagesSnapshot() {
    const messages = {};
    const counts = {};

    for (const player of this.#players) {
      const queue = this.#pendingMessages.get(player.id) ?? [];
      messages[player.id] = queue.map((message) => ({ ...message }));
      counts[player.id] = queue.length;
    }

    return { messages, counts };
  }

  /**
   * @param {object} record
   * @param {object} result
   * @returns {void}
   */
  #commitPublish(record, result) {
    this.#version = record.version;
    this.#publishedLogCount = record.publishedLogCount;
    this.#logTotal = record.logTotalAfter;
    this.#lastPublishError = null;

    if (Number.isFinite(result?.lobbyVersion)) {
      this.#lobbyVersion = result.lobbyVersion;
    }

    if (this.#stateGeneration === record.stateGeneration) {
      this.#stateDirty = false;
    }

    if (this.#presenceGeneration === record.presenceGeneration) {
      this.#presenceDirty = false;
    }

    for (const player of this.#players) {
      const queue = this.#pendingMessages.get(player.id);
      const count = record.messageCounts[player.id] ?? 0;

      if (queue && count > 0) {
        queue.splice(0, count);
      }
    }
  }

  /**
   * Builds one frozen-enough view per seat: the player view without the public
   * log plus the current network presence.
   *
   * @returns {Record<string, object>}
   */
  #buildViews() {
    const presence = this.getPresence();
    const network = { hostId: HOST_HOST_ID, presence };
    const views = {};

    for (const player of this.#players) {
      const view = this.#local.getPlayerView(player.id);
      const { log: _log, ...rest } = view;
      const published = { ...rest, network };
      const bytes = measureViewBytes(published);

      if (bytes > HOST_VIEW_MAX_BYTES) {
        throw new GameError(
          'VIEW_TOO_LARGE',
          'Снимок стола превышает допустимый размер.',
          { playerId: player.id, bytes },
        );
      }

      views[player.id] = published;
    }

    return views;
  }

  /**
   * @param {number} [delay]
   * @returns {void}
   */
  #schedulePoll(delay = this.#actionPollIntervalMs) {
    if (this.#disposed || !this.#running || !this.#autoPoll || this.#pollTimer !== null) {
      return;
    }

    this.#pollTimer = this.#setTimer(() => {
      this.#pollTimer = null;
      void this.#pollLoop();
    }, Math.max(0, delay));
  }

  /**
   * @returns {Promise<void>}
   */
  async #pollLoop() {
    try {
      await this.pollActionsOnce();
    } catch (error) {
      this.#lastPollError = error;
      this.#emitter.emit(GAME_EVENTS.ERROR, error);

      if ([401, 403, 404, 410].includes(error?.status)) {
        this.#running = false;
        return;
      }
    } finally {
      if (this.#running) {
        this.#schedulePoll();
      }
    }
  }

  /**
   * @returns {void}
   */
  #schedulePublishRetry() {
    if (this.#disposed || !this.#autoPublish) {
      return;
    }

    if (this.#publishTimer !== null) {
      return;
    }

    this.#publishTimer = this.#setTimer(() => {
      this.#publishTimer = null;
      void this.#publishOnce();
    }, HOST_PUBLISH_RETRY_DELAY_MS);
  }

  /** @returns {void} */
  #clearPollTimer() {
    if (this.#pollTimer !== null) {
      this.#clearTimer(this.#pollTimer);
      this.#pollTimer = null;
    }
  }

  /** @returns {void} */
  #clearPublishTimer() {
    if (this.#publishTimer !== null) {
      this.#clearTimer(this.#publishTimer);
      this.#publishTimer = null;
    }
  }
}

HostSession.CAPABILITIES = Object.freeze({
  mode: 'network-host',
  controlsAI: true,
  canRestart: true,
  isHost: true,
});
