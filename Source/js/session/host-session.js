import { TARGET_SCORE } from '../core/constants.js';
import { AI_SEAT_NAMES, normalizeLobby } from '../net/lobby.js';
import { LocalSession } from './local-session.js';

/** Fixed clockwise seating order used by the network host. */
export const HOST_SEAT_ORDER = Object.freeze(['alice', 'boris', 'human']);

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
    const fallback = id === 'human'
      ? (hostName.length > 0 ? hostName : AI_SEAT_NAMES.human)
      : (AI_SEAT_NAMES[id] ?? id);
    const name = occupied && typeof seat.name === 'string' && seat.name.length > 0
      ? seat.name
      : fallback;

    return Object.freeze({ id, name, isHuman: occupied });
  });
}

/**
 * Network host session scaffold. It owns the authoritative `LocalSession`,
 * publishes the first per-player views when the host starts the game and
 * exposes the same capabilities/actions as the local session.
 */
export class HostSession {
  #relay;
  #roomCode;
  #token;
  #local;
  #players;
  #started = false;
  #version = 0;
  #startPromise = null;
  #lastPublishError = null;

  /**
   * @param {object} options
   * @param {object} options.relay Relay-like client with `publish`.
   * @param {string} options.roomCode
   * @param {string} options.token Host token.
   * @param {object} options.lobby Lobby snapshot at start time.
   * @param {string} [options.hostName]
   * @param {number | null} [options.seed]
   * @param {number} [options.targetScore]
   */
  constructor({
    relay,
    roomCode,
    token,
    lobby,
    hostName = '',
    seed = null,
    targetScore = TARGET_SCORE,
  } = {}) {
    if (!relay || typeof relay.publish !== 'function') {
      throw new TypeError('HostSession requires a relay client with publish().');
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
    this.#local = new LocalSession({
      players: this.#players,
      humanId: 'human',
      seed,
      targetScore,
    });
  }

  /** @returns {Readonly<{ mode: 'network-host', controlsAI: true, canRestart: true, isHost: true }>} */
  get capabilities() {
    return HostSession.CAPABILITIES;
  }

  /** @returns {string} */
  get humanId() {
    return 'human';
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

  /** @returns {unknown} */
  get lastPublishError() {
    return this.#lastPublishError;
  }

  /**
   * Starts the authoritative game and publishes the first snapshot. Repeated
   * calls return the same promise, so the controller and `main.js` can both
   * await it safely.
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
    this.#started = true;
    this.#local.start();
    await this.#publish({ gameReset: true });

    return this.getState();
  }

  /**
   * Starts a fresh game and publishes it as a reset. The full restart flow is
   * refined in stage 4; the scaffold already keeps guests on the same room.
   *
   * @returns {object | null}
   */
  restart() {
    if (!this.#started) {
      void this.start();
      return this.getState();
    }

    const view = this.#local.restart();
    void this.#publish({ gameReset: true });

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

  /** @param {...unknown} args @returns {() => void} */
  subscribe(...args) {
    return this.#local.subscribe(...args);
  }

  /** @param {...unknown} args @returns {() => void} */
  on(...args) {
    return this.#local.on(...args);
  }

  /** @param {...unknown} args @returns {boolean} */
  off(...args) {
    return this.#local.off(...args);
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
   * Publishes one immutable snapshot for every seat. Views are always player
   * views, so no guest receives another hand or a hidden prikup.
   *
   * @param {{ gameReset: boolean }} options
   * @returns {Promise<void>}
   */
  async #publish({ gameReset }) {
    this.#version += 1;
    const views = {};

    for (const player of this.#players) {
      views[player.id] = this.#local.getPlayerView(player.id);
    }

    try {
      await this.#relay.publish(this.#roomCode, this.#token, {
        version: this.#version,
        started: true,
        gameReset,
        views,
      });
      this.#lastPublishError = null;
    } catch (error) {
      this.#lastPublishError = error;
    }
  }

  /** @returns {void} */
  dispose() {
    this.#local.dispose();
  }
}

HostSession.CAPABILITIES = Object.freeze({
  mode: 'network-host',
  controlsAI: true,
  canRestart: true,
  isHost: true,
});
