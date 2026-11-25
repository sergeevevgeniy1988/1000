import assert from 'node:assert/strict';
import test from 'node:test';

import { BIDDING, PHASES } from '../js/core/constants.js';
import { getCardById } from '../js/core/deck.js';
import { getLegalCards } from '../js/core/rules.js';
import { createAI } from '../js/ai/ai.js';
import {
  GUEST_RECONNECT_BASE_DELAY_MS,
  HOST_EVENT_BUFFER_LIMIT,
  POLL_INTERVAL_MS,
  formatOfflineWait,
  normalizeRoomCode,
  validateName,
} from '../js/net/protocol.js';
import {
  GUEST_STORAGE_PREFIX,
  NetworkLobby,
  clearStoredSession,
  createMemoryStorage,
  getSeatStatus,
} from '../js/net/lobby.js';
import { RelayError } from '../js/net/relay-client.js';
import { GuestSession } from '../js/session/guest-session.js';
import { HostSession } from '../js/session/host-session.js';

const SEATS = Object.freeze(['human', 'alice', 'boris']);
const ROOM_CODES = Object.freeze([
  'ABC234',
  'DEF567',
  'GHJ892',
  'KLM345',
  'NPQ678',
  'RST923',
  'UVW456',
  'XYZ789',
]);

/**
 * In-memory relay mirroring the room API. It supports presence changes, closed
 * rooms and injected network failures so the guest reconnect path is testable
 * without a real server.
 */
class FakeRelay {
  constructor({ lan = true } = {}) {
    this.lan = lan;
    this.rooms = new Map();
    this.tokens = new Map();
    this.tokenSeq = 0;
    this.codeSeq = 0;
  }

  async health() {
    return {
      ok: true,
      version: 'test',
      lan: this.lan,
      bindAddress: '127.0.0.1',
      port: 8765,
      lanUrl: 'http://127.0.0.1:8765/',
      roomTtlSeconds: 120,
    };
  }

  async createRoom(name) {
    const validation = validateName(name);

    if (!validation.ok) {
      throw new RelayError(validation.message, { status: 400, code: validation.code });
    }

    if (this.rooms.size >= ROOM_CODES.length) {
      throw new RelayError('Too many rooms.', { status: 429, code: 'too_many_rooms' });
    }

    const code = ROOM_CODES[this.codeSeq];
    this.codeSeq += 1;
    const token = `host-token-${++this.tokenSeq}`;
    const room = {
      code,
      started: false,
      closed: false,
      lobbyVersion: 1,
      publishVersion: 0,
      publishAttempts: 0,
      publishedVersions: [],
      lastGameReset: false,
      failPublishes: 0,
      failPlayerPolls: 0,
      failActions: 0,
      views: {},
      viewVersion: 0,
      logEpoch: 0,
      logTotal: 0,
      logSeq: 0,
      log: [],
      actions: [],
      actionSeq: 0,
      actionAttempts: [],
      messages: { human: [], alice: [], boris: [] },
      messageSeq: { human: 0, alice: 0, boris: 0 },
      seats: {
        human: {
          playerId: 'human',
          name: validation.name,
          token,
          isHost: true,
          connected: true,
          lastSeen: new Date().toISOString(),
        },
        alice: null,
        boris: null,
      },
    };

    this.rooms.set(code, room);
    this.tokens.set(token, { roomCode: code, playerId: 'human', isHost: true });

    return { roomCode: code, playerId: 'human', token, lobby: this.#lobby(room) };
  }

  async joinRoom(roomCode, name) {
    const room = this.#room(roomCode);

    if (room.started) {
      throw new RelayError('The game has already started.', { status: 409, code: 'game_started' });
    }

    const validation = validateName(name);

    if (!validation.ok) {
      throw new RelayError(validation.message, { status: 400, code: validation.code });
    }

    if (this.#lobby(room).seats.some((seat) => seat.occupied && seat.name === validation.name)) {
      throw new RelayError('That name is already used.', { status: 409, code: 'name_taken' });
    }

    const seatId = ['alice', 'boris'].find((id) => room.seats[id] === null);

    if (!seatId) {
      throw new RelayError('The room is full.', { status: 409, code: 'room_full' });
    }

    const token = `guest-token-${++this.tokenSeq}`;
    room.seats[seatId] = {
      playerId: seatId,
      name: validation.name,
      token,
      isHost: false,
      connected: true,
      lastSeen: new Date().toISOString(),
    };
    room.lobbyVersion += 1;
    this.tokens.set(token, { roomCode: room.code, playerId: seatId, isHost: false });

    return { roomCode: room.code, playerId: seatId, token, lobby: this.#lobby(room) };
  }

  async hostPoll(roomCode, token, { actionSince = 0 } = {}) {
    const room = this.#room(roomCode);
    this.#auth(room, token, true);
    const host = room.seats.human;

    if (host) {
      host.lastSeen = new Date().toISOString();
    }

    return {
      actions: room.actions.filter((action) => action.seq > actionSince),
      lobby: this.#lobby(room),
      cursor: room.actionSeq,
      lobbyVersion: room.lobbyVersion,
    };
  }

  async publish(roomCode, token, body) {
    const room = this.#room(roomCode);
    this.#auth(room, token, true);
    room.publishAttempts += 1;

    if (room.failPublishes > 0) {
      room.failPublishes -= 1;
      throw new RelayError('Network error.', { status: 0, code: 'network_error', retryable: true });
    }

    const version = body?.version;

    if (!Number.isInteger(version) || version < 1) {
      throw new RelayError('A numeric version is required.', { status: 400, code: 'bad_version' });
    }

    if (version < room.publishVersion) {
      throw new RelayError('A newer version exists.', { status: 409, code: 'stale_version' });
    }

    if (version === room.publishVersion) {
      return {
        version: room.publishVersion,
        started: room.started,
        gameReset: false,
        views: room.views,
        log: [],
        messages: { human: [], alice: [], boris: [] },
        cursor: room.actionSeq,
        lobbyVersion: room.lobbyVersion,
        duplicate: true,
      };
    }

    if (body.gameReset) {
      room.logEpoch += 1;
      room.log = [];
      room.logSeq = 0;
      room.lastGameReset = true;
    } else if (Number.isInteger(body.logEpoch) && body.logEpoch !== room.logEpoch) {
      room.logEpoch = body.logEpoch;
      room.log = [];
      room.logSeq = 0;
      room.lastGameReset = false;
    } else {
      room.lastGameReset = false;
    }

    if (body.views && typeof body.views === 'object') {
      for (const seat of SEATS) {
        if (Object.hasOwn(body.views, seat)) {
          room.views[seat] = body.views[seat];
        }
      }

      room.viewVersion = version;
    }

    if (typeof body.started === 'boolean' && body.started !== room.started) {
      room.started = body.started;
      room.lobbyVersion += 1;
    }

    const appendedLog = [];

    for (const entry of Array.isArray(body.log) ? body.log : []) {
      room.logSeq += 1;
      const wrapped = { seq: room.logSeq, entry };
      room.log.push(wrapped);
      appendedLog.push(wrapped);
    }

    while (room.log.length > HOST_EVENT_BUFFER_LIMIT) {
      room.log.shift();
      room.logEpoch += 1;
    }

    const appendedMessages = { human: [], alice: [], boris: [] };

    for (const seat of SEATS) {
      const list = body.messages?.[seat];

      if (!Array.isArray(list)) {
        continue;
      }

      for (const payload of list) {
        room.messageSeq[seat] += 1;
        const wrapped = { seq: room.messageSeq[seat], payload };
        room.messages[seat].push(wrapped);
        appendedMessages[seat].push(wrapped);
      }

      while (room.messages[seat].length > 50) {
        room.messages[seat].shift();
      }
    }

    room.publishVersion = version;
    room.publishedVersions.push(version);

    return {
      version: room.publishVersion,
      started: room.started,
      gameReset: Boolean(body.gameReset),
      views: room.views,
      log: appendedLog,
      messages: appendedMessages,
      cursor: room.actionSeq,
      lobbyVersion: room.lobbyVersion,
      duplicate: false,
    };
  }

  async playerPoll(roomCode, token, {
    viewSince = 0,
    logSince = 0,
    logEpoch = 0,
    messageSince = 0,
  } = {}) {
    const room = this.#room(roomCode);
    const player = this.#auth(room, token, false);

    if (room.failPlayerPolls > 0) {
      room.failPlayerPolls -= 1;
      throw new RelayError('Network error.', { status: 0, code: 'network_error', retryable: true });
    }

    const seat = room.seats[player.playerId];

    if (seat) {
      seat.connected = true;
      seat.lastSeen = new Date().toISOString();
    }

    const result = {
      lobby: this.#lobby(room),
      viewVersion: room.viewVersion,
      logEpoch: room.logEpoch,
      logTotal: room.logSeq,
      messageTotal: room.messageSeq[player.playerId] ?? 0,
      started: room.started,
      log: [],
      messages: [],
    };

    if (viewSince < room.viewVersion && room.views[player.playerId]) {
      result.view = room.views[player.playerId];
    }

    for (const item of room.log) {
      if (logEpoch !== room.logEpoch || item.seq > logSince) {
        result.log.push(item);
      }
    }

    for (const message of room.messages[player.playerId] ?? []) {
      if (message.seq > messageSince) {
        result.messages.push(message);
      }
    }

    return result;
  }

  async action(roomCode, token, { actionId, type, payload = {} } = {}) {
    const room = this.#room(roomCode);
    const player = this.#auth(room, token, false);

    if (typeof actionId !== 'string' || actionId.length === 0) {
      throw new RelayError('actionId is required.', { status: 400, code: 'bad_action' });
    }

    room.actionAttempts.push({
      playerId: player.playerId,
      actionId,
      type,
      attempt: room.actionAttempts.length + 1,
    });

    if (room.failActions > 0) {
      room.failActions -= 1;
      throw new RelayError('Network error.', { status: 0, code: 'network_error', retryable: true });
    }

    const duplicate = room.actions.find(
      (entry) => entry.playerId === player.playerId && entry.actionId === actionId,
    );

    if (duplicate) {
      return { ok: true, seq: duplicate.seq };
    }

    if (room.actions.length >= 100) {
      throw new RelayError('The action queue is full.', { status: 429, code: 'action_queue_full' });
    }

    room.actionSeq += 1;
    room.actions.push({
      seq: room.actionSeq,
      playerId: player.playerId,
      actionId,
      type,
      payload,
    });

    return { ok: true, seq: room.actionSeq };
  }

  async kick(roomCode, token, playerId) {
    const room = this.#room(roomCode);
    this.#auth(room, token, true);

    if (playerId === 'human') {
      throw new RelayError('The host cannot be removed.', { status: 403, code: 'cannot_remove_host' });
    }

    if (!['alice', 'boris'].includes(playerId)) {
      throw new RelayError('Unknown seat.', { status: 400, code: 'bad_player' });
    }

    const player = room.seats[playerId];

    if (!player) {
      throw new RelayError('The seat is empty.', { status: 400, code: 'seat_empty' });
    }

    if (room.started) {
      throw new RelayError('The game has already started.', { status: 409, code: 'game_started' });
    }

    room.seats[playerId] = null;
    room.lobbyVersion += 1;
    this.tokens.delete(player.token);

    return { ok: true, lobby: this.#lobby(room) };
  }

  async closeRoom(roomCode, token) {
    const room = this.#room(roomCode);
    this.#auth(room, token, true);
    room.closed = true;
    return { ok: true };
  }

  async leave(roomCode, token) {
    const room = this.#room(roomCode);
    const player = this.#auth(room, token, false);

    if (player.isHost) {
      room.closed = true;
      return { ok: true, closed: true };
    }

    room.seats[player.playerId] = null;
    room.lobbyVersion += 1;
    this.tokens.delete(token);

    return { ok: true, lobby: this.#lobby(room) };
  }

  setConnected(playerId, connected) {
    const entry = [...this.rooms.values()]
      .map((room) => ({ room, seat: room.seats[playerId] }))
      .find((item) => item.seat !== null && item.seat !== undefined);

    if (!entry) {
      throw new Error(`Unknown seat ${playerId}.`);
    }

    entry.seat.connected = connected === true;

    if (connected) {
      entry.seat.lastSeen = new Date().toISOString();
    }

    entry.room.lobbyVersion += 1;
  }

  failNextPublishes(count = 1) {
    const room = [...this.rooms.values()][0];

    if (room) {
      room.failPublishes = Math.max(0, count);
    }
  }

  failNextPlayerPolls(count = 1) {
    const room = [...this.rooms.values()][0];

    if (room) {
      room.failPlayerPolls = Math.max(0, count);
    }
  }

  failNextActions(count = 1) {
    const room = [...this.rooms.values()][0];

    if (room) {
      room.failActions = Math.max(0, count);
    }
  }

  room(roomCode) {
    const room = this.rooms.get(normalizeRoomCode(roomCode));

    if (!room) {
      throw new Error(`Unknown room ${roomCode}.`);
    }

    return room;
  }

  #room(roomCode) {
    const code = normalizeRoomCode(roomCode);
    const room = this.rooms.get(code);

    if (!room) {
      throw new RelayError('Room not found.', { status: 404, code: 'room_not_found' });
    }

    if (room.closed) {
      throw new RelayError('Room is closed.', { status: 410, code: 'room_closed' });
    }

    return room;
  }

  #auth(room, token, hostOnly) {
    const player = this.tokens.get(token);

    if (!player || player.roomCode !== room.code) {
      throw new RelayError('Room token is invalid.', { status: 401, code: 'invalid_token' });
    }

    if (hostOnly && !player.isHost) {
      throw new RelayError('Host token is required.', { status: 403, code: 'not_host' });
    }

    return player;
  }

  #lobby(room) {
    return {
      code: room.code,
      version: room.lobbyVersion,
      started: room.started,
      maxPlayers: 3,
      seats: SEATS.map((playerId) => {
        const player = room.seats[playerId];

        return {
          playerId,
          name: player ? player.name : null,
          occupied: Boolean(player),
          isHost: playerId === 'human',
          isAI: !player,
          connected: Boolean(player?.connected),
          lastSeen: player ? player.lastSeen : null,
        };
      }),
    };
  }
}

/**
 * Minimal timer harness. Every guest test injects it so pending-action
 * timeouts and poll backoff never use real time.
 */
function createFakeTimers() {
  let nextId = 1;
  const timers = new Map();

  return {
    setTimer(fn, delay) {
      const id = nextId;
      nextId += 1;
      timers.set(id, { fn, delay });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    get pending() {
      return [...timers.entries()].map(([id, timer]) => ({ id, delay: timer.delay }));
    },
    async runNext() {
      const entry = timers.entries().next().value;

      if (!entry) {
        return null;
      }

      const [id, timer] = entry;
      timers.delete(id);
      await timer.fn();
      await Promise.resolve();
      await Promise.resolve();
      return timer.delay;
    },
    clear() {
      timers.clear();
    },
  };
}

/**
 * Replaces the global timers with browser-like functions that throw
 * `TypeError('Illegal invocation')` when they receive a foreign receiver.
 * Browsers behave this way, while Node ignores the receiver, so the wrapper
 * reproduces the production defect in tests. Always call `restore()` in a
 * `finally` block.
 *
 * @returns {{ restore: () => void, scheduled: () => number }}
 */
function installBrowserLikeTimers() {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let scheduled = 0;

  globalThis.setTimeout = function browserSetTimeout(callback, milliseconds, ...rest) {
    if (this !== undefined && this !== globalThis) {
      throw new TypeError('Illegal invocation');
    }

    scheduled += 1;
    return originalSetTimeout(callback, milliseconds, ...rest);
  };

  globalThis.clearTimeout = function browserClearTimeout(timer) {
    if (this !== undefined && this !== globalThis) {
      throw new TypeError('Illegal invocation');
    }

    return originalClearTimeout(timer);
  };

  return {
    restore() {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    },
    scheduled() {
      return scheduled;
    },
  };
}

/**
 * Waits for a predicate using the (possibly replaced) global timer.
 *
 * @param {() => boolean} predicate
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }

  return predicate();
}

/**
 * @param {FakeRelay} relay
 * @param {object} [options]
 * @returns {Promise<{ roomCode: string, hostToken: string, hostLobby: object, guests: object[] }>}
 */
async function setupRoom(relay, { hostName = 'Хост', guests = [] } = {}) {
  const created = await relay.createRoom(hostName);
  const guestSeats = [];

  for (const name of guests) {
    guestSeats.push(await relay.joinRoom(created.roomCode, name));
  }

  const state = await relay.hostPoll(created.roomCode, created.token, { actionSince: 0 });

  return {
    roomCode: created.roomCode,
    hostToken: created.token,
    hostLobby: state.lobby,
    guests: guestSeats,
  };
}

/**
 * @param {FakeRelay} relay
 * @param {object} options
 * @returns {HostSession}
 */
function createHost(relay, {
  roomCode,
  hostToken,
  hostLobby,
  hostName = 'Хост',
  seed = 33,
  targetScore = 1000,
}) {
  return new HostSession({
    relay,
    roomCode,
    token: hostToken,
    lobby: hostLobby,
    hostName,
    seed,
    targetScore,
    autoPoll: false,
    autoPublish: false,
  });
}

/**
 * @param {FakeRelay} relay
 * @param {string} roomCode
 * @param {object} guest
 * @param {object} [options]
 * @returns {GuestSession}
 */
function createGuest(relay, roomCode, guest, options = {}) {
  const timers = options.timers ?? createFakeTimers();

  return new GuestSession({
    relay,
    roomCode,
    token: guest.token,
    playerId: guest.playerId,
    name: guest.lobby.seats.find((seat) => seat.playerId === guest.playerId)?.name ?? '',
    continuous: false,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    sleep: async () => {},
    ...options,
  });
}

/**
 * @param {object} view
 * @param {string} playerId
 * @returns {import('../js/core/deck.js').Card[]}
 */
function legalCardsFromView(view, playerId) {
  const player = view.players.find((entry) => entry.id === playerId);
  const leadSuit = view.currentTrick.length === 0
    ? null
    : getCardById(view.currentTrick[0].cardId).suit;

  return getLegalCards(player.hand, leadSuit, view.trumpSuit);
}

/**
 * @param {HostSession} host
 * @returns {Promise<void>}
 */
async function flushHost(host) {
  await host.pollActionsOnce();
  await host.flush();
}

/**
 * @param {ReadonlyArray<GuestSession>} guests
 * @returns {Promise<void>}
 */
async function pollGuests(guests) {
  for (const guest of guests) {
    await guest.pollOnce();
  }
}

/**
 * Advances bidding until Alice is the acting bidder.
 *
 * @param {HostSession} host
 * @returns {Promise<void>}
 */
async function advanceToAliceTurn(host) {
  let guard = 0;

  while (host.getState().currentBidderId !== 'alice') {
    const state = host.getState();
    const actor = state.currentBidderId;

    if (!actor) {
      throw new Error('Bidding ended before Alice could act.');
    }

    host.bid(actor, state.currentBid === 0 ? BIDDING.MIN : null);
    await host.flush();

    guard += 1;

    if (guard > 5) {
      throw new Error('Could not reach Alice in bidding.');
    }
  }
}

/**
 * Bids Alice up and makes every other live seat pass, so the guest becomes the
 * declarer and must take the prikup and give two cards.
 *
 * @param {HostSession} host
 * @param {GuestSession} aliceGuest
 * @returns {Promise<void>}
 */
async function makeAliceDeclarer(host, aliceGuest) {
  await advanceToAliceTurn(host);

  const state = host.getState();
  const amount = state.currentBid === 0
    ? BIDDING.MIN
    : state.currentBid + BIDDING.STEP;

  await aliceGuest.bid('alice', amount);
  await flushHost(host);
  await aliceGuest.pollOnce();

  let guard = 0;

  while (host.getState().phase === PHASES.BIDDING) {
    const bidder = host.getState().currentBidderId;

    if (!bidder) {
      break;
    }

    host.bid(bidder, null);
    await flushHost(host);

    guard += 1;

    if (guard > 5) {
      throw new Error('Could not finish bidding with Alice as the declarer.');
    }
  }

  assert.equal(host.getState().phase, PHASES.PRIKUP);
  assert.equal(host.getState().declarerId, 'alice');
}

/**
 * Plays a deal with any mix of host, guests and AI seats. Guest actions go
 * through `GuestSession`; AI actions are driven by the host, like the real
 * controller does.
 *
 * @param {HostSession} host
 * @param {object} options
 * @param {Record<string, GuestSession>} options.guests
 * @param {Record<string, ReturnType<typeof createAI>>} [options.ai]
 * @param {(state: object) => boolean} [options.stop]
 * @param {FakeRelay} [options.relay] When set together with `roomCode`, the
 *   helper also checks gift privacy on the published views and log.
 * @param {string} [options.roomCode]
 * @returns {Promise<{ guestActions: number, aiActions: number, tricks: number, privacyChecked: boolean }>}
 */
async function playDeal(host, {
  guests = {},
  ai = {},
  stop = null,
  relay = null,
  roomCode = null,
} = {}) {
  let guestActions = 0;
  let aiActions = 0;
  let privacyChecked = false;
  let guard = 0;

  while (host.getState().phase !== PHASES.DEAL_END) {
    const state = host.getState();

    if (stop && stop(state)) {
      break;
    }

    if (state.phase === PHASES.BIDDING) {
      const actor = state.currentBidderId;
      const amount = state.currentBid === 0 ? BIDDING.MIN : null;

      if (guests[actor]) {
        await guests[actor].bid(actor, amount);
        guestActions += 1;
      } else {
        host.bid(actor, amount);

        if (ai[actor]) {
          aiActions += 1;
        }
      }

      await flushHost(host);
      await pollGuests(Object.values(guests));
    } else if (state.phase === PHASES.PRIKUP) {
      const declarerId = state.declarerId;

      if (guests[declarerId]) {
        await guests[declarerId].takePrikup(declarerId);
        guestActions += 1;
      } else {
        host.takePrikup(declarerId);

        if (ai[declarerId]) {
          aiActions += 1;
        }
      }

      await flushHost(host);
      await pollGuests(Object.values(guests));
    } else if (state.phase === PHASES.GIVING) {
      const declarerId = state.declarerId;
      let giftCheck = null;

      if (!state.raiseDecided && state.givenCards.length === 0) {
        if (guests[declarerId]) {
          await guests[declarerId].declineRaise(declarerId);
          guestActions += 1;
        } else {
          host.raiseContract(declarerId, null);

          if (ai[declarerId]) {
            aiActions += 1;
          }
        }
      } else {
        const view = host.getPlayerView(declarerId);
        const self = view.players.find((player) => player.id === declarerId);
        const givenTo = new Set(state.givenCards.map((gift) => gift.toId));
        const givenCards = new Set(state.givenCards.map((gift) => gift.cardId));
        const target = view.players.find(
          (player) => player.id !== declarerId && !givenTo.has(player.id),
        );
        const cardId = self.hand.find((id) => !givenCards.has(id));
        const firstGift = state.givenCards.length === 0;

        assert.ok(target, 'the declarer must have an opponent to give a card to');
        assert.ok(cardId, 'the declarer must have a card to give');

        giftCheck = { declarerId, targetId: target.id, cardId, firstGift };

        if (guests[declarerId]) {
          await guests[declarerId].giveCard(target.id, cardId);
          guestActions += 1;
        } else {
          host.giveCard(target.id, cardId);

          if (ai[declarerId]) {
            aiActions += 1;
          }
        }
      }

      await flushHost(host);
      await pollGuests(Object.values(guests));

      if (giftCheck?.firstGift && !privacyChecked && relay && roomCode) {
        const room = relay.room(roomCode);
        const thirdId = SEATS.find(
          (id) => id !== giftCheck.declarerId && id !== giftCheck.targetId,
        );
        const publicGifts = room.log
          .map((item) => item.entry)
          .filter((entry) => entry.type === 'gift');

        assert.ok(publicGifts.length >= 1, 'the public log must announce the gift');

        for (const publicGift of publicGifts) {
          assert.equal(
            Object.hasOwn(publicGift, 'cardId'),
            false,
            'the public gift log must hide the card',
          );
        }

        assert.deepEqual(room.views[giftCheck.declarerId].givenCards, [
          { fromId: giftCheck.declarerId, toId: giftCheck.targetId, cardId: giftCheck.cardId },
        ]);
        assert.deepEqual(room.views[giftCheck.targetId].givenCards, [
          { fromId: giftCheck.declarerId, toId: giftCheck.targetId, cardId: giftCheck.cardId },
        ]);
        assert.deepEqual(room.views[thirdId].givenCards, [
          { fromId: giftCheck.declarerId, toId: giftCheck.targetId, cardId: null },
        ]);
        assert.equal(
          JSON.stringify(room.views[thirdId].givenCards).includes(giftCheck.cardId),
          false,
          'the third seat must not see the gifted card',
        );

        privacyChecked = true;
      }
    } else if (state.phase === PHASES.PLAYING) {
      const actor = state.currentPlayerId;
      const view = host.getPlayerView(actor);
      const legal = legalCardsFromView(view, actor);
      let card = legal[0];

      if (ai[actor]) {
        card = ai[actor].chooseCard(view, legal) ?? legal[0];
      }

      assert.ok(card, 'the acting player must have a legal card');

      if (guests[actor]) {
        await guests[actor].playCard(actor, card.id);
        guestActions += 1;
      } else {
        host.playCard(actor, card.id);

        if (ai[actor]) {
          aiActions += 1;
        }
      }

      await flushHost(host);
      await pollGuests(Object.values(guests));
    } else {
      throw new Error(`Unexpected phase ${state.phase} while playing a deal.`);
    }

    guard += 1;

    if (guard > 500) {
      throw new Error('The deal did not finish.');
    }
  }

  return {
    guestActions,
    aiActions,
    tricks: host.getState().completedTricks.length,
    privacyChecked,
  };
}

test('guest capabilities, first snapshot, statechange and merged log deltas', async () => {
  const relay = new FakeRelay();
  const { roomCode, hostToken, hostLobby, guests } = await setupRoom(relay, {
    guests: ['Алиса'],
  });
  const alice = guests[0];
  const host = createHost(relay, { roomCode, hostToken, hostLobby });
  const aliceGuest = createGuest(relay, roomCode, alice);
  const states = [];

  aliceGuest.on('statechange', (state) => states.push(state));

  await host.start();
  await aliceGuest.start();

  assert.deepEqual({ ...aliceGuest.capabilities }, {
    mode: 'network-guest',
    controlsAI: false,
    canRestart: false,
    isHost: false,
  });
  assert.equal(aliceGuest.humanId, 'alice');
  assert.equal(aliceGuest.connected, true);
  assert.equal(states.length, 1);
  assert.equal(states[0].viewerId, 'alice');

  const view = aliceGuest.getState();

  assert.equal(view.players.find((player) => player.id === 'alice').hand.length, 7);
  assert.equal(view.players.find((player) => player.id === 'alice').isAI, false);
  assert.deepEqual(view.players.find((player) => player.id === 'boris').hand, []);
  assert.equal('log' in view, false);
  assert.ok(aliceGuest.log.length >= 1, 'the first snapshot may include the current public log');
  assert.equal(aliceGuest.log[0].type, 'dealstarted');

  // Publish two more log entries and make sure the next poll appends only the
  // new delta and replays the matching semantic events.
  await host.bid(host.getState().currentBidderId, BIDDING.MIN);
  await host.flush();
  await aliceGuest.pollOnce();

  const logAfterBid = aliceGuest.log.length;
  const bidEvent = [];
  aliceGuest.on('bid', (payload) => bidEvent.push(payload));

  await host.bid(host.getState().currentBidderId, null);
  await host.flush();
  await aliceGuest.pollOnce();

  assert.ok(aliceGuest.log.length > logAfterBid);
  assert.equal(aliceGuest.log.filter((entry) => entry.type === 'bid').length, 1);
  assert.ok(bidEvent.length <= 1);
  assert.equal(aliceGuest.getSeatStatus('alice'), 'в комнате');
  assert.equal(aliceGuest.getSeatStatus('boris'), 'AI');

  aliceGuest.dispose();
  host.dispose();
});

test('guest keeps polling after join with browser-like timers and no Illegal invocation', async () => {
  const relay = new FakeRelay();
  const created = await relay.createRoom('Хост');
  const timers = installBrowserLikeTimers();
  const originalPoll = relay.playerPoll.bind(relay);
  const errors = [];
  let polls = 0;
  let guest = null;
  let host = null;

  relay.playerPoll = (...args) => {
    polls += 1;
    return originalPoll(...args);
  };

  try {
    guest = await GuestSession.join({
      relay,
      roomCode: created.roomCode,
      name: 'Алиса',
      continuous: true,
      pollIntervalMs: 50,
      sleep: async () => {},
    });
    guest.on('error', (error) => errors.push(error));

    const hostState = await relay.hostPoll(created.roomCode, created.token, { actionSince: 0 });

    host = new HostSession({
      relay,
      roomCode: created.roomCode,
      token: created.token,
      lobby: hostState.lobby,
      hostName: 'Хост',
      seed: 33,
      autoPoll: false,
      autoPublish: false,
    });
    await host.start();

    const firstView = await guest.start();

    assert.equal(firstView.viewerId, 'alice');
    assert.equal(guest.getState().viewerId, 'alice');
    assert.equal(polls, 1);

    const continued = await waitFor(() => polls >= 2);

    assert.equal(continued, true, 'the guest must keep polling after the first view');
    assert.equal(guest.connected, true);
    assert.equal(
      errors.some((error) => /Illegal invocation/.test(String(error?.message))),
      false,
    );
    assert.ok(timers.scheduled() > 0, 'the default timer wrapper must schedule the next poll');
  } finally {
    guest?.dispose();
    host?.dispose();
    timers.restore();
  }
});

test('guest actions retry with the same actionId and pending clears on statechange', async () => {
  const relay = new FakeRelay();
  const { roomCode, hostToken, hostLobby, guests } = await setupRoom(relay, {
    guests: ['Алиса'],
  });
  const alice = guests[0];
  const host = createHost(relay, { roomCode, hostToken, hostLobby });
  const aliceGuest = createGuest(relay, roomCode, alice);

  await host.start();
  await aliceGuest.start();
  await advanceToAliceTurn(host);

  const stateBefore = host.getState();
  const amount = stateBefore.currentBid === 0
    ? BIDDING.MIN
    : stateBefore.currentBid + BIDDING.STEP;

  relay.failNextActions(1);
  const result = await aliceGuest.bid('alice', amount);

  assert.equal(result.ok, true);
  assert.equal(aliceGuest.isPending, true);
  assert.equal(aliceGuest.pendingAction.type, 'bid');

  const attempts = relay.room(roomCode).actionAttempts.filter(
    (entry) => entry.playerId === 'alice',
  );

  assert.equal(attempts.length, 2, 'the first POST must be retried');
  assert.equal(attempts[0].actionId, attempts[1].actionId);
  assert.equal(
    relay.room(roomCode).actions.filter((entry) => entry.playerId === 'alice').length,
    1,
    'the retry must not queue a second action',
  );

  await flushHost(host);
  await aliceGuest.pollOnce();

  assert.equal(aliceGuest.isPending, false);
  assert.equal(host.getState().currentBid, amount);

  aliceGuest.dispose();
  host.dispose();
});

test('pending clears on a targeted error, nextDeal is allowed and restart is forbidden', async () => {
  const relay = new FakeRelay();
  const { roomCode, hostToken, hostLobby, guests } = await setupRoom(relay, {
    guests: ['Алиса'],
  });
  const alice = guests[0];
  const host = createHost(relay, { roomCode, hostToken, hostLobby });
  const aliceGuest = createGuest(relay, roomCode, alice);
  const errors = [];

  aliceGuest.on('error', (error) => errors.push(error));

  await host.start();
  await aliceGuest.start();

  await aliceGuest.playCard('alice', 'SA');

  assert.equal(aliceGuest.isPending, true);

  await flushHost(host);
  await aliceGuest.pollOnce();

  assert.equal(aliceGuest.isPending, false);
  assert.equal(aliceGuest.messages.length, 1);
  assert.equal(aliceGuest.messages[0].code, 'INVALID_PHASE');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].name, 'GameError');
  assert.match(errors[0].message, /недоступно|фазы/i);

  assert.throws(() => aliceGuest.restart(), /хост/);
  assert.throws(() => aliceGuest.createAIRng(), /AI/);

  // `nextDeal` is a legal guest action during DEAL_END.
  await playDeal(host, { guests: { alice: aliceGuest } });

  assert.equal(host.getState().phase, PHASES.DEAL_END);

  const dealBefore = host.getState().dealNumber;

  await aliceGuest.nextDeal();
  await flushHost(host);
  await aliceGuest.pollOnce();

  assert.equal(host.getState().dealNumber, dealBefore + 1);
  assert.equal(host.getState().phase, PHASES.BIDDING);

  aliceGuest.dispose();
  host.dispose();
});

test('guest polls back off with protocol constants and report offline/online', async () => {
  const relay = new FakeRelay();
  const { roomCode, hostToken, hostLobby, guests } = await setupRoom(relay, {
    guests: ['Алиса'],
  });
  const alice = guests[0];
  const host = createHost(relay, { roomCode, hostToken, hostLobby });
  const timers = createFakeTimers();
  const aliceGuest = createGuest(relay, roomCode, alice, {
    continuous: true,
    timers,
  });
  const offline = [];
  const online = [];
  const errors = [];

  aliceGuest.on('offline', (payload) => offline.push(payload));
  aliceGuest.on('online', (payload) => online.push(payload));
  aliceGuest.on('error', (error) => errors.push(error));

  await host.start();
  await aliceGuest.start();

  assert.equal(timers.pending.length, 1);
  assert.equal(timers.pending[0].delay, POLL_INTERVAL_MS);

  relay.failNextPlayerPolls(1);
  await timers.runNext();

  assert.equal(aliceGuest.connected, false);
  assert.equal(offline.length, 1);
  assert.equal(errors.length, 1);
  assert.equal(timers.pending[0].delay, GUEST_RECONNECT_BASE_DELAY_MS);

  relay.failNextPlayerPolls(1);
  await timers.runNext();

  assert.equal(timers.pending[0].delay, GUEST_RECONNECT_BASE_DELAY_MS * 2);

  await timers.runNext();

  assert.equal(aliceGuest.connected, true);
  assert.equal(online.length, 1);
  assert.equal(timers.pending[0].delay, POLL_INTERVAL_MS);

  aliceGuest.dispose();

  assert.equal(timers.pending.length, 0, 'dispose must clear the poll timer');
  host.dispose();
});

test('closed room gives 410, a clear sessionclosed message and clears the saved token', async () => {
  const relay = new FakeRelay();
  const { roomCode, hostToken, hostLobby, guests } = await setupRoom(relay, {
    guests: ['Алиса'],
  });
  const alice = guests[0];
  const host = createHost(relay, { roomCode, hostToken, hostLobby });
  const timers = createFakeTimers();
  const aliceGuest = createGuest(relay, roomCode, alice, {
    continuous: true,
    timers,
  });
  const closed = [];

  aliceGuest.on('sessionclosed', (payload) => closed.push(payload));

  await host.start();
  await aliceGuest.start();
  await host.closeRoom();
  await timers.runNext();

  assert.equal(aliceGuest.connected, false);
  assert.equal(closed.length, 1);
  assert.equal(closed[0].code, 'room_closed');
  assert.equal(closed[0].status, 410);
  assert.match(closed[0].message, /закрыта хостом/);

  await assert.rejects(
    () => aliceGuest.pollOnce(),
    (error) => error instanceof RelayError && error.status === 410,
  );

  aliceGuest.dispose();
  host.dispose();

  // A fresh lobby resume maps 410 to a user-facing message and forgets the
  // stored guest token so the form is shown again.
  const secondRelay = new FakeRelay();
  const hostLobbySession = new NetworkLobby({
    relay: secondRelay,
    sessionStorage: createMemoryStorage(),
    localStorage: createMemoryStorage(),
    tabId: 'host-tab',
  });
  const created = await hostLobbySession.createRoom('Хост');
  const guestStorage = createMemoryStorage();
  const guestLobby = new NetworkLobby({
    relay: secondRelay,
    sessionStorage: createMemoryStorage(),
    localStorage: guestStorage,
    tabId: 'guest-tab',
  });

  await guestLobby.joinRoom(created.roomCode, 'Гость');
  await hostLobbySession.closeRoom();

  const resumed = await guestLobby.resumeGuest(created.roomCode);

  assert.equal(resumed.ok, false);
  assert.equal(resumed.code, 'room_closed');
  assert.match(resumed.message, /закрыта хостом/);
  assert.equal(guestStorage.getItem(`${GUEST_STORAGE_PREFIX}${created.roomCode}`), null);
});

test('clearStoredSession removes only the guest token for the room', () => {
  const storage = createMemoryStorage();
  const key = `${GUEST_STORAGE_PREFIX}ABC234`;

  storage.setItem(key, JSON.stringify({ token: 'secret-token', playerId: 'alice' }));
  storage.setItem('unrelated', 'keep-me');

  clearStoredSession(storage, GUEST_STORAGE_PREFIX, 'abc234');

  assert.equal(storage.getItem(key), null);
  assert.equal(storage.getItem('unrelated'), 'keep-me');
});

test('guest reload resumes the same seat with the current cards and score', async () => {
  const relay = new FakeRelay();
  const { roomCode, hostToken, hostLobby, guests } = await setupRoom(relay, {
    guests: ['Алиса', 'Борис'],
  });
  const alice = guests[0];
  const boris = guests[1];
  const host = createHost(relay, { roomCode, hostToken, hostLobby, seed: 33 });
  const aliceGuest = createGuest(relay, roomCode, alice);
  const borisGuest = createGuest(relay, roomCode, boris);

  await host.start();
  await aliceGuest.start();
  await borisGuest.start();

  await playDeal(host, {
    guests: { alice: aliceGuest, boris: borisGuest },
    stop: (state) => state.completedTricks.length >= 2,
  });

  const before = aliceGuest.getState();

  assert.ok(before.completedTricks.length >= 2);

  aliceGuest.dispose();

  const resumeTimers = createFakeTimers();
  const resumed = await GuestSession.resume({
    relay,
    roomCode,
    token: alice.token,
    playerId: 'alice',
    name: 'Алиса',
    setTimer: resumeTimers.setTimer,
    clearTimer: resumeTimers.clearTimer,
    sleep: async () => {},
  });
  const after = resumed.getState();
  const hostView = host.getPlayerView('alice');

  assert.equal(after.viewerId, 'alice');
  assert.equal(after.phase, before.phase);
  assert.equal(after.dealNumber, before.dealNumber);
  assert.equal(after.contract, before.contract);
  assert.equal(after.completedTricks.length, before.completedTricks.length);
  assert.deepEqual(
    after.players.find((player) => player.id === 'alice').hand,
    hostView.players.find((player) => player.id === 'alice').hand,
  );
  assert.deepEqual(
    after.players.map((player) => [player.id, player.score]),
    hostView.players.map((player) => [player.id, player.score]),
  );

  resumed.dispose();
  borisGuest.dispose();
  host.dispose();
});

test('closing a guest tab stops polling and the host waits without AI substitution', async () => {
  const relay = new FakeRelay();
  const { roomCode, hostToken, hostLobby, guests } = await setupRoom(relay, {
    guests: ['Алиса'],
  });
  const alice = guests[0];
  const host = createHost(relay, { roomCode, hostToken, hostLobby });
  const timers = createFakeTimers();
  const aliceGuest = createGuest(relay, roomCode, alice, {
    continuous: true,
    timers,
  });

  await host.start();
  await aliceGuest.start();
  await advanceToAliceTurn(host);

  const stateBefore = JSON.stringify(host.getState());

  aliceGuest.dispose();

  assert.equal(timers.pending.length, 0, 'the closed tab must not keep polling');

  relay.setConnected('alice', false);
  await host.pollActionsOnce();
  await host.flush();

  assert.equal(host.getSeatStatus('alice'), 'нет связи');
  assert.equal(getSeatStatus({ occupied: true, connected: false }), 'нет связи');
  assert.equal(formatOfflineWait('Алиса'), 'Ждём Алиса — нет связи.');

  const presence = host.getPresence();
  const alicePresence = presence.find((seat) => seat.playerId === 'alice');

  assert.equal(alicePresence.connected, false);
  assert.equal(alicePresence.isAI, false);
  assert.equal(host.getState().players.find((player) => player.id === 'alice').isAI, false);
  assert.equal(host.getState().currentBidderId, 'alice');
  assert.equal(JSON.stringify(host.getState()), stateBefore);

  await host.pollActionsOnce();
  await host.flush();

  assert.equal(JSON.stringify(host.getState()), stateBefore, 'the host must keep waiting');
  host.dispose();
});

test('a guest declarer bids, takes the prikup, gives cards, plays cards and starts the next deal', async () => {
  const relay = new FakeRelay();
  const { roomCode, hostToken, hostLobby, guests } = await setupRoom(relay, {
    guests: ['Алиса'],
  });
  const alice = guests[0];
  const host = createHost(relay, { roomCode, hostToken, hostLobby, seed: 33 });
  const aliceGuest = createGuest(relay, roomCode, alice);
  const borisAI = createAI({ playerId: 'boris', rng: host.createAIRng('boris') });

  await host.start();
  await aliceGuest.start();
  await makeAliceDeclarer(host, aliceGuest);

  await playDeal(host, {
    guests: { alice: aliceGuest },
    ai: { boris: borisAI },
  });

  assert.equal(host.getState().phase, PHASES.DEAL_END);
  assert.equal(host.getState().completedTricks.length, 8);

  const guestActionTypes = relay.room(roomCode).actions
    .filter((action) => action.playerId === 'alice')
    .map((action) => action.type);

  assert.ok(guestActionTypes.includes('bid'));
  assert.ok(guestActionTypes.includes('takePrikup'));
  assert.ok(guestActionTypes.includes('giveCard'));
  assert.ok(guestActionTypes.includes('playCard'));

  await aliceGuest.nextDeal();
  await flushHost(host);
  await aliceGuest.pollOnce();

  assert.equal(host.getState().phase, PHASES.BIDDING);
  assert.equal(
    relay.room(roomCode).actions.some(
      (action) => action.playerId === 'alice' && action.type === 'nextDeal',
    ),
    true,
  );

  aliceGuest.dispose();
  host.dispose();
});

test('two live guests play a complete deal through their sessions', async () => {
  const relay = new FakeRelay();
  const { roomCode, hostToken, hostLobby, guests } = await setupRoom(relay, {
    guests: ['Алиса', 'Борис'],
  });
  const alice = guests[0];
  const boris = guests[1];
  const host = createHost(relay, { roomCode, hostToken, hostLobby, seed: 33 });
  const aliceGuest = createGuest(relay, roomCode, alice);
  const borisGuest = createGuest(relay, roomCode, boris);

  await host.start();
  await aliceGuest.start();
  await borisGuest.start();

  const result = await playDeal(host, {
    guests: { alice: aliceGuest, boris: borisGuest },
    relay,
    roomCode,
  });

  assert.equal(host.getState().phase, PHASES.DEAL_END);
  assert.equal(host.getState().completedTricks.length, 8);
  assert.equal(result.tricks, 8);
  assert.equal(result.privacyChecked, true);
  assert.ok(result.guestActions >= 10, 'both guests must bid, give cards and play cards');

  const aliceView = aliceGuest.getState();

  assert.equal(aliceView.viewerId, 'alice');
  assert.equal(aliceView.completedTricks.length, 8);
  assert.equal(aliceView.players.find((player) => player.id === 'alice').isAI, false);
  assert.equal(aliceView.players.find((player) => player.id === 'boris').isAI, false);
  assert.deepEqual(aliceView.players.find((player) => player.id === 'boris').hand, []);
  assert.ok(aliceGuest.log.length > 0);
  assert.ok(aliceGuest.log.length <= HOST_EVENT_BUFFER_LIMIT);
  assert.equal('log' in aliceView, false);

  const dealBefore = host.getState().dealNumber;

  await aliceGuest.nextDeal();
  await flushHost(host);
  await aliceGuest.pollOnce();
  await borisGuest.pollOnce();

  assert.equal(host.getState().dealNumber, dealBefore + 1);
  assert.equal(host.getState().phase, PHASES.BIDDING);

  aliceGuest.dispose();
  borisGuest.dispose();
  host.dispose();
});

test('two humans plus AI: AI acts only for the free seat and never through the relay', async () => {
  const relay = new FakeRelay();
  const { roomCode, hostToken, hostLobby, guests } = await setupRoom(relay, {
    guests: ['Алиса'],
  });
  const alice = guests[0];
  const host = createHost(relay, { roomCode, hostToken, hostLobby, seed: 33 });
  const aliceGuest = createGuest(relay, roomCode, alice);
  const borisAI = createAI({ playerId: 'boris', rng: host.createAIRng('boris') });

  await host.start();
  await aliceGuest.start();

  const result = await playDeal(host, {
    guests: { alice: aliceGuest },
    ai: { boris: borisAI },
  });

  assert.equal(host.getState().phase, PHASES.DEAL_END);
  assert.ok(result.aiActions > 0, 'the AI seat must act under host control');
  assert.equal(host.getSeatStatus('boris'), 'AI');

  const aliceView = aliceGuest.getState();
  const boris = aliceView.players.find((player) => player.id === 'boris');
  const aliceSeat = aliceView.players.find((player) => player.id === 'alice');

  assert.equal(boris.isAI, true);
  assert.equal(aliceSeat.isAI, false);
  assert.equal(
    relay.room(roomCode).actions.some((action) => action.playerId === 'boris'),
    false,
    'AI seats must never submit actions through the relay queue',
  );

  aliceGuest.dispose();
  host.dispose();
});

test('two AI seats complete a deal under host control without relay actions', async () => {
  const relay = new FakeRelay();
  const { roomCode, hostToken, hostLobby } = await setupRoom(relay, { guests: [] });
  const host = createHost(relay, { roomCode, hostToken, hostLobby, seed: 33 });
  const aliceAI = createAI({ playerId: 'alice', rng: host.createAIRng('alice') });
  const borisAI = createAI({ playerId: 'boris', rng: host.createAIRng('boris') });

  await host.start();

  const result = await playDeal(host, {
    ai: { alice: aliceAI, boris: borisAI },
  });

  assert.equal(host.getState().phase, PHASES.DEAL_END);
  assert.equal(host.getState().completedTricks.length, 8);
  assert.equal(result.tricks, 8);
  assert.ok(result.aiActions > 0, 'the AI seats must act under host control');
  assert.equal(relay.room(roomCode).actions.length, 0, 'AI seats never use the relay queue');

  host.dispose();
});

test('simultaneous nextDeal advances one deal and repeated clicks are rejected', async () => {
  const relay = new FakeRelay();
  const { roomCode, hostToken, hostLobby, guests } = await setupRoom(relay, {
    guests: ['Алиса', 'Борис'],
  });
  const alice = guests[0];
  const boris = guests[1];
  const host = createHost(relay, { roomCode, hostToken, hostLobby, seed: 33 });
  const aliceGuest = createGuest(relay, roomCode, alice);
  const borisGuest = createGuest(relay, roomCode, boris);

  await host.start();
  await aliceGuest.start();
  await borisGuest.start();

  await playDeal(host, { guests: { alice: aliceGuest, boris: borisGuest } });

  assert.equal(host.getState().phase, PHASES.DEAL_END);

  const dealBefore = host.getState().dealNumber;

  await Promise.all([aliceGuest.nextDeal(), borisGuest.nextDeal()]);
  await flushHost(host);
  await aliceGuest.pollOnce();
  await borisGuest.pollOnce();

  assert.equal(host.getState().dealNumber, dealBefore + 1, 'only one deal may start');
  assert.equal(host.getState().phase, PHASES.BIDDING);

  const rejected = [...aliceGuest.messages, ...borisGuest.messages];

  assert.equal(rejected.length, 1, 'exactly one simultaneous nextDeal must be rejected');
  assert.equal(rejected[0].code, 'INVALID_PHASE');

  const dealAfter = host.getState().dealNumber;

  await aliceGuest.nextDeal();
  await flushHost(host);
  await aliceGuest.pollOnce();

  assert.equal(host.getState().dealNumber, dealAfter, 'a repeated click must not start a deal');
  assert.equal(host.getState().phase, PHASES.BIDDING);

  aliceGuest.dispose();
  borisGuest.dispose();
  host.dispose();
});

test('guest view and public log never expose hidden prikup, foreign hands or tokens', async () => {
  const relay = new FakeRelay();
  const { roomCode, hostToken, hostLobby, guests } = await setupRoom(relay, {
    guests: ['Алиса', 'Борис'],
  });
  const alice = guests[0];
  const boris = guests[1];
  const host = createHost(relay, { roomCode, hostToken, hostLobby, seed: 33 });
  const aliceGuest = createGuest(relay, roomCode, alice);
  const borisGuest = createGuest(relay, roomCode, boris);
  const tokens = [hostToken, alice.token, boris.token];

  await host.start();
  await aliceGuest.start();
  await borisGuest.start();

  const viewBefore = aliceGuest.getState();
  const logBefore = JSON.stringify(aliceGuest.log);

  assert.deepEqual(viewBefore.prikup, []);
  assert.equal(viewBefore.prikupRevealed, false);
  assert.deepEqual(viewBefore.players.find((player) => player.id === 'boris').hand, []);
  assert.deepEqual(viewBefore.players.find((player) => player.id === 'human').hand, []);

  for (const token of tokens) {
    assert.equal(JSON.stringify(viewBefore).includes(token), false, 'views must not contain tokens');
    assert.equal(logBefore.includes(token), false, 'the log must not contain tokens');
  }

  let guard = 0;

  while (host.getState().phase === PHASES.BIDDING) {
    const state = host.getState();
    const actor = state.currentBidderId;

    assert.ok(actor, 'bidding must have an active player');

    host.bid(actor, state.currentBid === 0 ? BIDDING.MIN : null);
    await host.flush();
    await aliceGuest.pollOnce();
    await borisGuest.pollOnce();

    guard += 1;

    if (guard > 10) {
      throw new Error('Bidding did not finish.');
    }
  }

  assert.equal(host.getState().phase, PHASES.PRIKUP);

  await aliceGuest.pollOnce();

  const viewAfter = aliceGuest.getState();
  const revealed = viewAfter.prikup;
  const revealEntry = aliceGuest.log.find((entry) => entry.type === 'prikuprevealed');

  assert.equal(viewAfter.prikupRevealed, true);
  assert.equal(revealed.length, 3);
  assert.ok(revealEntry, 'the public log must announce the revealed prikup');
  assert.deepEqual(revealEntry.cards, revealed);

  for (const cardId of revealed) {
    assert.equal(
      logBefore.includes(cardId),
      false,
      'the pre-reveal log must not contain a hidden prikup card',
    );
  }

  for (const token of tokens) {
    assert.equal(JSON.stringify(viewAfter).includes(token), false);
  }

  aliceGuest.dispose();
  borisGuest.dispose();
  host.dispose();
});
