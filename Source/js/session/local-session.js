import { GAME_EVENTS, TARGET_SCORE } from '../core/constants.js';
import { GameError } from '../core/errors.js';
import { EventEmitter } from '../core/events.js';
import { Game } from '../core/game.js';
import { mulberry32 } from '../core/rng.js';

const GAME_INDEX_STRIDE = 104729;

/**
 * Local single-game session. Owns the authoritative `Game` together with the
 * deterministic seed, target score and the player whose seat the UI shows.
 *
 * The controller never talks to `Game` directly: it receives player views via
 * {@link LocalSession#getState}, delegates every action here and subscribes to
 * forwarded game events. A session keeps its listeners across `restart()`, so
 * the controller does not have to re-bind after a new game starts.
 */
export class LocalSession {
  #players;
  #humanId;
  #seed;
  #targetScore;
  #gameIndex = 0;
  #game = null;
  #started = false;
  #emitter = new EventEmitter();
  #eventNames = new Set();
  #gameUnsubscribers = new Map();

  /**
   * @param {object} options
   * @param {ReadonlyArray<{ id: string, name: string, isHuman?: boolean }>} options.players
   *   Players in clockwise seating order.
   * @param {string} options.humanId Player id whose view the UI shows.
   * @param {number | null} [options.seed] Deterministic seed for tests and demos.
   * @param {number} [options.targetScore] Score required to win; 1000 by default.
   */
  constructor({ players, humanId, seed = null, targetScore = TARGET_SCORE }) {
    if (!Array.isArray(players) || players.length === 0) {
      throw new TypeError('LocalSession requires a non-empty players list.');
    }

    this.#players = Object.freeze(players.map((player) => Object.freeze({ ...player })));

    if (typeof humanId !== 'string' || !this.#players.some((player) => player.id === humanId)) {
      throw new TypeError('LocalSession requires a valid humanId from the players list.');
    }

    this.#humanId = humanId;
    this.#seed = seed === null || !Number.isFinite(seed) ? null : seed >>> 0;
    this.#targetScore = targetScore;
  }

  /** @returns {string} */
  get humanId() {
    return this.#humanId;
  }

  /** @returns {ReadonlyArray<{ id: string, name: string, isHuman: boolean }>} */
  get players() {
    return this.#players;
  }

  /** @returns {number | null} */
  get seed() {
    return this.#seed;
  }

  /** @returns {number} */
  get gameIndex() {
    return this.#gameIndex;
  }

  /** @returns {number} */
  get targetScore() {
    return this.#targetScore;
  }

  /** @returns {boolean} */
  get started() {
    return this.#started;
  }

  /**
   * Creates and starts the first game. Repeated calls are ignored.
   *
   * @returns {object | null} The first player view.
   */
  start() {
    if (this.#started) {
      return this.getState();
    }

    this.#started = true;
    this.#createGame();
    this.#game.start();

    return this.getState();
  }

  /**
   * Starts a fresh game with a new deterministic shuffle. Existing listeners
   * stay subscribed: forwarded events are re-attached to the new game.
   *
   * @returns {object | null} The fresh player view.
   */
  restart() {
    this.#started = true;
    this.#detachGameListeners();
    this.#gameIndex += 1;
    this.#createGame();
    this.#game.start();

    return this.getState();
  }

  /**
   * Returns the only snapshot the UI may render: the player view of `humanId`.
   *
   * @returns {object | null}
   */
  getState() {
    if (!this.#game) {
      return null;
    }

    return this.#game.getPlayerView(this.#humanId);
  }

  /**
   * Returns a player view for another seat. Used by the controller for AI
   * decisions, which must never receive hidden cards of other players.
   *
   * @param {string} playerId
   * @returns {object}
   */
  getPlayerView(playerId) {
    if (!this.#game) {
      throw new Error('Партия ещё не начата.');
    }

    return this.#game.getPlayerView(playerId);
  }

  /**
   * Returns the public game log. The log never contains hidden cards and is
   * the same for every player; the host publishes it as deltas.
   *
   * @returns {ReadonlyArray<object>}
   */
  getLog() {
    if (!this.#game) {
      return [];
    }

    return this.#game.getPlayerView(this.#humanId).log;
  }

  /**
   * Adds a state listener. Supports `subscribe(listener)` and
   * `subscribe(eventName, listener)`.
   *
   * @param {string | ((state: object) => void)} listenerOrEvent
   * @param {((payload: unknown) => void)} [maybeListener]
   * @returns {() => void} Unsubscribe function.
   */
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

  /**
   * Subscribes to a forwarded game event.
   *
   * @param {string} eventName
   * @param {(payload: unknown) => void} listener
   * @returns {() => void} Unsubscribe function.
   */
  on(eventName, listener) {
    this.#eventNames.add(eventName);

    const unsubscribe = this.#emitter.on(eventName, listener);

    this.#ensureForwarder(eventName);

    return () => {
      unsubscribe();
      this.#dropUnusedForwarder(eventName);
    };
  }

  /**
   * Removes a forwarded game event listener.
   *
   * @param {string} eventName
   * @param {(payload: unknown) => void} listener
   * @returns {boolean}
   */
  off(eventName, listener) {
    const removed = this.#emitter.off(eventName, listener);

    this.#dropUnusedForwarder(eventName);

    return removed;
  }

  /**
   * Creates the deterministic RNG for one AI player. Without a seed it falls
   * back to `Math.random`, like the rest of the local game.
   *
   * @param {string} playerId
   * @returns {() => number}
   */
  createAIRng(playerId) {
    if (this.#seed === null) {
      return Math.random;
    }

    const seed = (this.#seed + this.#gameIndex * GAME_INDEX_STRIDE + hashString(playerId)) >>> 0;

    return mulberry32(seed);
  }

  /**
   * Places a bid or passes during bidding.
   *
   * @param {string} playerId
   * @param {number | string | null} amountOrPass
   * @returns {object | null} The player view after the action.
   */
  bid(playerId, amountOrPass) {
    return this.#run((game) => game.bid(playerId, amountOrPass));
  }

  /**
   * Moves the revealed prikup to the declarer's hand.
   *
   * @param {string} playerId
   * @returns {object | null}
   */
  takePrikup(playerId) {
    return this.#run((game) => game.takePrikup(playerId));
  }

  /**
   * Raises the contract or declines the raise with `null`.
   *
   * @param {string} playerId
   * @param {number | null} amountOrNull
   * @returns {object | null}
   */
  raiseContract(playerId, amountOrNull) {
    return this.#run((game) => game.raiseContract(playerId, amountOrNull));
  }

  /**
   * Declines the optional contract raise.
   *
   * @param {string} playerId
   * @returns {object | null}
   */
  declineRaise(playerId) {
    return this.#run((game) => game.declineRaise(playerId));
  }

  /**
   * Gives one card from the declarer to an opponent.
   *
   * @param {string} toPlayerId
   * @param {string} cardId
   * @returns {object | null}
   */
  giveCard(toPlayerId, cardId) {
    return this.#run((game) => game.giveCard(toPlayerId, cardId));
  }

  /**
   * Gives a card on behalf of an explicit acting player. `Game#giveCard` does
   * not accept an actor id, so the network host must verify that the action
   * author really is the declarer before applying it.
   *
   * @param {string} playerId Author of the action, must be the declarer.
   * @param {string} toPlayerId
   * @param {string} cardId
   * @returns {object | null}
   */
  giveCardAs(playerId, toPlayerId, cardId) {
    return this.#run((game) => {
      const state = game.getState();

      if (state.declarerId !== playerId) {
        throw new GameError(
          'NOT_DECLARER',
          'Только играющий может отдать карту.',
          { playerId, declarerId: state.declarerId },
        );
      }

      game.giveCard(toPlayerId, cardId);
    });
  }

  /**
   * Declares a marriage for the acting player.
   *
   * @param {string} playerId
   * @param {string} suit
   * @returns {object | null}
   */
  declareMarriage(playerId, suit) {
    return this.#run((game) => game.declareMarriage(playerId, suit));
  }

  /**
   * Cancels a pending marriage.
   *
   * @param {string} playerId
   * @returns {object | null}
   */
  cancelMarriage(playerId) {
    return this.#run((game) => game.cancelMarriage(playerId));
  }

  /**
   * Plays one card.
   *
   * @param {string} playerId
   * @param {string} cardId
   * @returns {object | null}
   */
  playCard(playerId, cardId) {
    return this.#run((game) => game.playCard(playerId, cardId));
  }

  /**
   * Starts the next deal after results.
   *
   * @returns {object | null}
   */
  nextDeal() {
    return this.#run((game) => game.nextDeal());
  }

  /**
   * Removes every listener and releases the game. The session cannot be used
   * afterwards.
   *
   * @returns {void}
   */
  dispose() {
    this.#detachGameListeners();
    this.#emitter.clear();
    this.#eventNames.clear();
    this.#game = null;
    this.#started = false;
  }

  /**
   * @param {(game: Game) => unknown} action
   * @returns {object | null}
   */
  #run(action) {
    if (!this.#game) {
      throw new Error('Партия ещё не начата.');
    }

    action(this.#game);

    return this.getState();
  }

  /**
   * Creates the game for the current `gameIndex` and re-attaches listeners.
   *
   * @returns {void}
   */
  #createGame() {
    const rng = this.#seed === null
      ? Math.random
      : mulberry32((this.#seed + this.#gameIndex * GAME_INDEX_STRIDE) >>> 0);

    this.#game = new Game({
      players: this.#players,
      targetScore: this.#targetScore,
      rng,
    });
    this.#attachGameListeners();
  }

  /**
   * @returns {void}
   */
  #attachGameListeners() {
    for (const eventName of this.#eventNames) {
      this.#ensureForwarder(eventName);
    }
  }

  /**
   * @param {string} eventName
   * @returns {void}
   */
  #ensureForwarder(eventName) {
    if (
      !this.#game
      || this.#gameUnsubscribers.has(eventName)
      || this.#emitter.listenerCount(eventName) === 0
    ) {
      return;
    }

    const unsubscribe = this.#game.on(eventName, (payload) => {
      // The UI must never receive the full authoritative snapshot. State
      // change listeners always get the current player view instead.
      const forwarded = eventName === GAME_EVENTS.STATE_CHANGE
        ? this.getState()
        : payload;

      this.#emitter.emit(eventName, forwarded);
    });

    this.#gameUnsubscribers.set(eventName, unsubscribe);
  }

  /**
   * @param {string} eventName
   * @returns {void}
   */
  #dropUnusedForwarder(eventName) {
    if (this.#emitter.listenerCount(eventName) > 0) {
      return;
    }

    this.#eventNames.delete(eventName);

    const unsubscribe = this.#gameUnsubscribers.get(eventName);

    if (unsubscribe) {
      unsubscribe();
      this.#gameUnsubscribers.delete(eventName);
    }
  }

  /**
   * @returns {void}
   */
  #detachGameListeners() {
    for (const unsubscribe of this.#gameUnsubscribers.values()) {
      unsubscribe();
    }

    this.#gameUnsubscribers.clear();
  }
}

/**
 * @param {string} value
 * @returns {number}
 */
function hashString(value) {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}
