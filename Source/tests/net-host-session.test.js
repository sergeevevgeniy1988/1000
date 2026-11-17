import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { BIDDING, PHASES } from '../js/core/constants.js';
import { getCardById } from '../js/core/deck.js';
import { getLegalCards } from '../js/core/rules.js';
import { createAI } from '../js/ai/ai.js';
import {
  HOST_ACTION_POLL_INTERVAL_MS,
  HOST_EVENT_BUFFER_LIMIT,
  HOST_VIEW_MAX_BYTES,
  formatOfflineWait,
  normalizeRoomCode,
  validateActionEnvelope,
  validateName,
} from '../js/net/protocol.js';
import { RelayError } from '../js/net/relay-client.js';
import { GuestSession } from '../js/session/guest-session.js';
import {
  HostSession,
  capLogDelta,
  measureViewBytes,
} from '../js/session/host-session.js';

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
 * In-memory relay that mirrors the PowerShell room API. It stores opaque
 * per-seat views, public-log deltas, targeted messages and the action queue,
 * and it can simulate disconnects, duplicate actions and publish failures.
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
      views: {},
      viewVersion: 0,
      logEpoch: 0,
      logTotal: 0,
      logSeq: 0,
      log: [],
      actions: [],
      actionSeq: 0,
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

    const seat = room.seats[player.playerId];

    if (seat) {
      seat.lastSeen = new Date().toISOString();
    }

    return result;
  }

  async action(roomCode, token, { actionId, type, payload = {} } = {}) {
    const room = this.#room(roomCode);
    const player = this.#auth(room, token, false);

    if (typeof actionId !== 'string' || actionId.length === 0) {
      throw new RelayError('actionId is required.', { status: 400, code: 'bad_action' });
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

  injectAction({ roomCode, playerId, actionId, type, payload = {}, seq = null }) {
    const room = this.#room(roomCode);
    const nextSeq = Number.isInteger(seq) ? seq : room.actionSeq + 1;

    if (!Number.isInteger(seq)) {
      room.actionSeq = nextSeq;
    } else {
      room.actionSeq = Math.max(room.actionSeq, nextSeq);
    }

    const action = { seq: nextSeq, playerId, actionId, type, payload };
    room.actions.push(action);
    return action;
  }

  failNextPublishes(count = 1) {
    const room = [...this.rooms.values()][0];

    if (room) {
      room.failPublishes = Math.max(0, count);
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
 * @returns {GuestSession}
 */
function createGuest(relay, roomCode, guest) {
  return new GuestSession({
    relay,
    roomCode,
    token: guest.token,
    playerId: guest.playerId,
    name: guest.lobby.seats.find((seat) => seat.playerId === guest.playerId)?.name ?? '',
    continuous: false,
  });
}

/**
 * Replaces the global timers with browser-like functions that throw
 * `TypeError('Illegal invocation')` when they receive a foreign receiver.
 * Always call `restore()` in a `finally` block.
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
 * Drives bidding until it is Alice's turn. Used to submit a legal guest action
 * without depending on the shuffled dealer.
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
 * Submits a guest action through the fake relay (the equivalent of POST
 * /action), then lets the host consume the queue and publish the result.
 *
 * @param {HostSession} host
 * @param {FakeRelay} relay
 * @param {string} roomCode
 * @param {string} token
 * @param {string} type
 * @param {object} payload
 * @returns {Promise<{ seq: number }>}
 */
async function submitGuestAction(host, relay, roomCode, token, type, payload = {}) {
  const actionId = `guest-${type}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const result = await relay.action(roomCode, token, { actionId, type, payload });
  await host.pollActionsOnce();
  await host.flush();
  return result;
}

/**
 * Plays one complete deal through the host. Alice is always made the declarer
 * so the guest exercises bidding, the raise decision, both gifts and cards.
 *
 * @param {HostSession} host
 * @param {FakeRelay} relay
 * @param {string} roomCode
 * @param {string} aliceToken
 * @param {GuestSession} aliceGuest
 * @param {object} borisAI
 * @returns {Promise<{ guestActions: number, aiActions: number, prikupChecked: boolean }>}
 */
async function playFullDeal(host, relay, roomCode, aliceToken, aliceGuest, borisAI) {
  let guestActions = 0;
  let aiActions = 0;
  let prikupChecked = false;
  let guard = 0;

  while (host.getState().phase !== PHASES.DEAL_END) {
    const state = host.getState();

    if (state.phase === PHASES.BIDDING) {
      const actor = state.currentBidderId;
      let amount = null;

      if (actor === 'alice') {
        amount = state.currentBid === 0 ? BIDDING.MIN : BIDDING.MIN + BIDDING.STEP;
      } else if (state.currentBid === 0) {
        amount = BIDDING.MIN;
      }

      if (actor === 'alice') {
        await submitGuestAction(
          host,
          relay,
          roomCode,
          aliceToken,
          amount === null ? 'pass' : 'bid',
          amount === null ? {} : { amount },
        );
        guestActions += 1;
      } else {
        host.bid(actor, amount);
        await host.flush();

        if (actor === 'boris') {
          aiActions += 1;
        }
      }
    } else if (state.phase === PHASES.PRIKUP) {
      if (!prikupChecked) {
        await aliceGuest.pollOnce();
        const guestView = aliceGuest.getState();
        assert.equal(guestView.prikup.length, 3, 'the revealed prikup must be visible to the guest');
        assert.equal(guestView.prikupRevealed, true);

        for (const playerId of SEATS) {
          assert.equal(
            host.getPlayerView(playerId).prikup.length,
            3,
            `the revealed prikup must be visible to ${playerId}`,
          );
        }

        prikupChecked = true;
      }

      if (state.declarerId === 'alice') {
        await submitGuestAction(host, relay, roomCode, aliceToken, 'takePrikup', {});
        guestActions += 1;
      } else {
        host.takePrikup(state.declarerId);
        await host.flush();

        if (state.declarerId === 'boris') {
          aiActions += 1;
        }
      }
    } else if (state.phase === PHASES.GIVING) {
      const declarerId = state.declarerId;

      if (!state.raiseDecided && state.givenCards.length === 0) {
        if (declarerId === 'alice') {
          await submitGuestAction(host, relay, roomCode, aliceToken, 'declineRaise', {});
          guestActions += 1;
        } else {
          host.raiseContract(declarerId, null);
          await host.flush();

          if (declarerId === 'boris') {
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

        assert.ok(target, 'the declarer must have an opponent to give a card to');
        assert.ok(cardId, 'the declarer must have a card to give');

        if (declarerId === 'alice') {
          await submitGuestAction(
            host,
            relay,
            roomCode,
            aliceToken,
            'giveCard',
            { toPlayerId: target.id, cardId },
          );
          guestActions += 1;
        } else {
          host.giveCard(target.id, cardId);
          await host.flush();

          if (declarerId === 'boris') {
            aiActions += 1;
          }
        }
      }
    } else if (state.phase === PHASES.PLAYING) {
      const actor = state.currentPlayerId;

      if (actor === 'alice') {
        const view = host.getPlayerView('alice');
        const card = legalCardsFromView(view, 'alice')[0];

        await submitGuestAction(
          host,
          relay,
          roomCode,
          aliceToken,
          'playCard',
          { cardId: card.id },
        );
        guestActions += 1;
      } else {
        const view = host.getPlayerView(actor);
        const legal = legalCardsFromView(view, actor);
        let card = legal[0];

        if (actor === 'boris') {
          card = borisAI.chooseCard(view, legal) ?? legal[0];
        }

        host.playCard(actor, card.id);
        await host.flush();

        if (actor === 'boris') {
          aiActions += 1;
        }
      }
    } else {
      throw new Error(`Unexpected phase ${state.phase} while playing a deal.`);
    }

    guard += 1;

    if (guard > 300) {
      throw new Error('The deal did not finish.');
    }
  }

  return { guestActions, aiActions, prikupChecked };
}

test('HostSession capabilities, started publish and personal views without log', async () => {
  const relay = new FakeRelay();
  const { roomCode, hostToken, hostLobby, guests } = await setupRoom(relay, {
    guests: ['Алиса', 'Борис'],
  });
  const host = createHost(relay, { roomCode, hostToken, hostLobby });

  assert.deepEqual({ ...host.capabilities }, {
    mode: 'network-host',
    controlsAI: true,
    canRestart: true,
    isHost: true,
  });
  assert.equal(host.humanId, 'human');

  const state = await host.start();

  assert.equal(host.started, true);
  assert.equal(host.version, 1);
  assert.equal(host.lastPublishError, null);
  assert.equal(state.viewerId, 'human');
  assert.equal(state.players.find((player) => player.id === 'human').hand.length, 7);
  assert.deepEqual(state.players.find((player) => player.id === 'alice').hand, []);
  assert.deepEqual(state.prikup, []);

  const room = relay.room(roomCode);

  assert.equal(room.started, true);
  assert.equal(room.lastGameReset, true);
  assert.equal(room.publishVersion, 1);
  assert.deepEqual(room.publishedVersions, [1]);

  for (const playerId of SEATS) {
    const view = room.views[playerId];
    const serialized = JSON.stringify(view);

    assert.ok(view, `${playerId} must receive a view`);
    assert.equal(view.viewerId, playerId);
    assert.equal(view.network.hostId, 'human');
    assert.equal(view.network.presence.length, 3);
    assert.equal('log' in view, false);
    assert.equal(view.players.find((player) => player.id === playerId).hand.length, 7);
    assert.equal(view.players.find((player) => player.id === playerId).isAI, false);

    for (const player of view.players) {
      if (player.id !== playerId) {
        assert.deepEqual(player.hand, []);
      }
    }

    assert.deepEqual(view.prikup, []);
    assert.ok(measureViewBytes(view) <= HOST_VIEW_MAX_BYTES);

    for (const token of [hostToken, ...guests.map((guest) => guest.token)]) {
      assert.equal(serialized.includes(token), false, 'views must never contain room tokens');
    }
  }

  host.dispose();
});

test('host poll advances the cursor, deduplicates action ids and ignores foreign seats', async () => {
  const relay = new FakeRelay();
  const { roomCode, hostToken, hostLobby, guests } = await setupRoom(relay, {
    guests: ['Алиса'],
  });
  const alice = guests[0];
  const host = createHost(relay, { roomCode, hostToken, hostLobby });
  const aliceGuest = createGuest(relay, roomCode, alice);

  await host.start();
  await advanceToAliceTurn(host);

  const stateBefore = host.getState();
  const amount = stateBefore.currentBid === 0 ? BIDDING.MIN : stateBefore.currentBid + BIDDING.STEP;
  const cursorBefore = host.cursor;
  const first = await relay.action(roomCode, alice.token, {
    actionId: 'alice-bid-1',
    type: 'bid',
    payload: { amount },
  });

  assert.equal(first.seq, cursorBefore + 1);

  await host.pollActionsOnce();

  assert.equal(host.cursor, first.seq);
  assert.equal(host.getState().currentBid, amount);

  await host.flush();

  const versionAfterFirst = relay.room(roomCode).publishVersion;
  const duplicate = await relay.action(roomCode, alice.token, {
    actionId: 'alice-bid-1',
    type: 'bid',
    payload: { amount },
  });

  assert.equal(duplicate.seq, first.seq);

  await host.pollActionsOnce();
  await host.flush();

  assert.equal(host.getState().currentBid, amount);
  assert.equal(relay.room(roomCode).publishVersion, versionAfterFirst);

  // Two injected entries with the same actionId: the host must apply the first
  // one and skip the duplicate before it can raise NOT_YOUR_TURN.
  await host.restart();
  await host.flush();
  await advanceToAliceTurn(host);

  const nextState = host.getState();
  const nextAmount = nextState.currentBid === 0
    ? BIDDING.MIN
    : nextState.currentBid + BIDDING.STEP;

  relay.injectAction({
    roomCode,
    playerId: 'alice',
    actionId: 'alice-duplicate-2',
    type: 'bid',
    payload: { amount: nextAmount },
  });
  relay.injectAction({
    roomCode,
    playerId: 'alice',
    actionId: 'alice-duplicate-2',
    type: 'bid',
    payload: { amount: nextAmount },
  });

  await host.pollActionsOnce();
  await host.flush();
  await aliceGuest.pollOnce();

  assert.equal(host.getState().currentBid, nextAmount);
  assert.equal(aliceGuest.messages.length, 0, 'the duplicate must not produce an error');

  // Foreign/AI seats cannot submit actions through the queue.
  const stateBeforeForeign = JSON.stringify(host.getState());
  const foreignSeq = relay.injectAction({
    roomCode,
    playerId: 'boris',
    actionId: 'ai-bid-1',
    type: 'bid',
    payload: { amount: BIDDING.MIN },
  });

  await host.pollActionsOnce();

  assert.equal(host.cursor, foreignSeq.seq);
  assert.equal(JSON.stringify(host.getState()), stateBeforeForeign);
  assert.equal(aliceGuest.messages.length, 0);

  aliceGuest.dispose();
  host.dispose();
});

test('illegal guest action produces a targeted error only for its author', async () => {
  const relay = new FakeRelay();
  const { roomCode, hostToken, hostLobby, guests } = await setupRoom(relay, {
    guests: ['Алиса', 'Борис'],
  });
  const alice = guests[0];
  const boris = guests[1];
  const host = createHost(relay, { roomCode, hostToken, hostLobby });
  const aliceGuest = createGuest(relay, roomCode, alice);
  const borisGuest = createGuest(relay, roomCode, boris);

  await host.start();
  await aliceGuest.pollOnce();
  await borisGuest.pollOnce();

  const stateBefore = JSON.stringify(host.getState());
  const logBefore = aliceGuest.log.length;
  const versionBefore = relay.room(roomCode).publishVersion;

  await relay.action(roomCode, alice.token, {
    actionId: 'illegal-play',
    type: 'playCard',
    payload: { cardId: 'SA' },
  });

  await host.pollActionsOnce();
  await host.flush();
  await aliceGuest.pollOnce();
  await borisGuest.pollOnce();

  assert.equal(aliceGuest.messages.length, 1);
  assert.equal(aliceGuest.messages[0].code, 'INVALID_PHASE');
  assert.equal(typeof aliceGuest.messages[0].message, 'string');
  assert.equal(borisGuest.messages.length, 0, 'the other guest must not receive the error');
  assert.equal(JSON.stringify(host.getState()), stateBefore);
  assert.equal(aliceGuest.log.length, logBefore);
  assert.ok(relay.room(roomCode).publishVersion > versionBefore);
  assert.equal(host.cursor, relay.room(roomCode).actionSeq);

  aliceGuest.dispose();
  borisGuest.dispose();
  host.dispose();
});

test('publish pipeline is monotonic, retries without duplicate versions and resets on restart', async () => {
  const relay = new FakeRelay();
  const { roomCode, hostToken, hostLobby, guests } = await setupRoom(relay, {
    guests: ['Алиса'],
  });
  const alice = guests[0];
  const host = createHost(relay, { roomCode, hostToken, hostLobby });
  const aliceGuest = createGuest(relay, roomCode, alice);

  await host.start();
  assert.deepEqual(relay.room(roomCode).publishedVersions, [1]);

  await host.resync();
  assert.equal(host.version, 2);
  assert.equal(relay.room(roomCode).publishVersion, 2);
  assert.equal(relay.room(roomCode).logEpoch, host.logEpoch);

  relay.failNextPublishes(1);
  const attemptsBefore = relay.room(roomCode).publishAttempts;
  host.restart();
  await host.flush();

  const room = relay.room(roomCode);

  assert.ok(host.version > 2);
  assert.equal(room.publishVersion, host.version);
  assert.ok(room.publishAttempts >= attemptsBefore + 2, 'the failed publish must be retried');
  assert.equal(new Set(room.publishedVersions).size, room.publishedVersions.length);
  assert.equal(room.publishedVersions[room.publishedVersions.length - 1], host.version);
  assert.equal(room.lastGameReset, true);
  assert.equal(host.getState().dealNumber, 1);

  await aliceGuest.pollOnce();

  const view = aliceGuest.getState();

  assert.equal(view.viewerId, 'alice');
  assert.equal(view.dealNumber, 1);
  assert.equal('log' in view, false);
  assert.ok(measureViewBytes(view) <= HOST_VIEW_MAX_BYTES);

  aliceGuest.dispose();
  host.dispose();
});

test('HostSession and GuestSession play a complete deal through the fake relay', async () => {
  const relay = new FakeRelay();
  const { roomCode, hostToken, hostLobby, guests } = await setupRoom(relay, {
    guests: ['Алиса'],
  });
  const alice = guests[0];
  const host = createHost(relay, { roomCode, hostToken, hostLobby, seed: 33 });
  const aliceGuest = createGuest(relay, roomCode, alice);
  const borisAI = createAI({ playerId: 'boris', rng: host.createAIRng('boris') });

  await host.start();
  await aliceGuest.pollOnce();

  const startView = aliceGuest.getState();

  assert.equal(startView.viewerId, 'alice');
  assert.equal(startView.players.find((player) => player.id === 'alice').hand.length, 7);
  assert.equal(startView.players.find((player) => player.id === 'alice').isAI, false);
  assert.equal(startView.players.find((player) => player.id === 'boris').isAI, true);
  assert.equal(startView.players.find((player) => player.id === 'human').isAI, false);
  assert.deepEqual(startView.prikup, []);
  assert.equal('log' in startView, false);

  for (const player of startView.players) {
    if (player.id !== 'alice') {
      assert.deepEqual(player.hand, []);
    }
  }

  const result = await playFullDeal(host, relay, roomCode, alice.token, aliceGuest, borisAI);

  assert.equal(result.prikupChecked, true);
  assert.ok(result.guestActions >= 6, 'the guest must bid, take the prikup, give cards and play cards');
  assert.ok(result.aiActions > 0, 'the AI seat must act under host control');
  assert.equal(
    relay.room(roomCode).actions.some((action) => action.playerId === 'boris'),
    false,
    'AI seats must never submit actions through the relay queue',
  );

  await aliceGuest.pollOnce();

  const finalView = aliceGuest.getState();

  assert.equal(finalView.phase, PHASES.DEAL_END);
  assert.equal(finalView.viewerId, 'alice');
  assert.equal(finalView.completedTricks.length, 8);
  assert.ok(finalView.lastDealResult);
  assert.equal(finalView.players.find((player) => player.id === 'alice').hand.length, 0);
  assert.equal('log' in finalView, false);
  assert.ok(measureViewBytes(finalView) <= HOST_VIEW_MAX_BYTES);

  const guestTypes = aliceGuest.log.map((entry) => entry.type);
  const hostTypes = host.getState().log.map((entry) => entry.type);

  assert.deepEqual(guestTypes, hostTypes, 'log deltas must preserve the host order');
  assert.ok(guestTypes.includes('dealstarted'));
  assert.ok(guestTypes.includes('bid'));
  assert.ok(guestTypes.includes('pass'));
  assert.ok(guestTypes.includes('prikuprevealed'));
  assert.ok(guestTypes.includes('prikup'));
  assert.ok(guestTypes.includes('gift'));
  assert.ok(guestTypes.includes('cardplayed'));
  assert.ok(guestTypes.includes('trickwon'));
  assert.ok(guestTypes.includes('scored'));
  assert.ok(aliceGuest.log.length <= HOST_EVENT_BUFFER_LIMIT);
  assert.ok(host.pendingEventCount <= HOST_EVENT_BUFFER_LIMIT);

  aliceGuest.dispose();
  host.dispose();
});

test('presence changes are published without changing the game and never trigger AI substitution', async () => {
  const relay = new FakeRelay();
  const { roomCode, hostToken, hostLobby, guests } = await setupRoom(relay, {
    guests: ['Алиса'],
  });
  const alice = guests[0];
  const host = createHost(relay, { roomCode, hostToken, hostLobby });
  const aliceGuest = createGuest(relay, roomCode, alice);

  await host.start();
  await advanceToAliceTurn(host);

  const stateBefore = JSON.stringify(host.getState());

  relay.setConnected('alice', false);
  await host.pollActionsOnce();
  await host.flush();

  assert.equal(host.getSeatStatus('alice'), 'нет связи');
  assert.equal(host.getSeatStatus('boris'), 'AI');
  assert.equal(host.getSeatStatus('human'), 'в комнате');

  const presence = relay.room(roomCode).views.alice.network.presence;
  const alicePresence = presence.find((seat) => seat.playerId === 'alice');

  assert.equal(alicePresence.connected, false);
  assert.equal(typeof alicePresence.lastSeen, 'string');
  assert.equal(alicePresence.isAI, false);
  assert.equal(host.getState().players.find((player) => player.id === 'alice').isAI, false);
  assert.equal(JSON.stringify(host.getState()), stateBefore);
  assert.equal(host.getState().currentBidderId, 'alice');

  // The host keeps waiting: no AI action appears for the disconnected person.
  await host.pollActionsOnce();
  await host.flush();
  assert.equal(JSON.stringify(host.getState()), stateBefore);

  await aliceGuest.pollOnce();
  assert.equal(aliceGuest.getState().network.presence.find((seat) => seat.playerId === 'alice').connected, false);

  aliceGuest.dispose();
  host.dispose();
});

test('guest resume keeps the seat, restart is host-only and closing the room returns 410', async () => {
  const relay = new FakeRelay();
  const { roomCode, hostToken, hostLobby, guests } = await setupRoom(relay, {
    guests: ['Алиса'],
  });
  const alice = guests[0];
  const host = createHost(relay, { roomCode, hostToken, hostLobby });

  await host.start();

  const resumed = await GuestSession.resume({
    relay,
    roomCode,
    token: alice.token,
    playerId: 'alice',
    name: 'Алиса',
  });

  assert.equal(resumed.playerId, 'alice');
  assert.equal(resumed.getState().viewerId, 'alice');
  assert.equal(resumed.getState().players.find((player) => player.id === 'alice').hand.length, 7);
  assert.throws(() => resumed.restart(), /хост/);
  assert.throws(() => resumed.createAIRng(), /AI/);

  await host.closeRoom();

  await assert.rejects(
    () => resumed.pollOnce(),
    (error) => error instanceof RelayError && error.status === 410,
  );

  resumed.dispose();
  host.dispose();
});

test('host protocol helpers enforce the poll cadence, action envelope and log buffer', () => {
  assert.ok(HOST_ACTION_POLL_INTERVAL_MS >= 350 && HOST_ACTION_POLL_INTERVAL_MS <= 500);
  assert.equal(HOST_EVENT_BUFFER_LIMIT, 500);

  assert.equal(formatOfflineWait('Алиса'), 'Ждём Алиса — нет связи.');
  assert.equal(formatOfflineWait(''), 'Ждём игрока — нет связи.');

  const valid = validateActionEnvelope({
    playerId: 'alice',
    actionId: 'act-1',
    type: 'bid',
    payload: { amount: 80 },
    seq: 1,
  });

  assert.equal(valid.ok, true);
  assert.equal(valid.playerId, 'alice');
  assert.equal(valid.payload.amount, 80);

  const badSeat = validateActionEnvelope({
    playerId: 'ghost',
    actionId: 'act-1',
    type: 'bid',
    payload: { amount: 80 },
    seq: 1,
  });

  assert.equal(badSeat.ok, false);
  assert.equal(badSeat.code, 'bad_player');

  const capped = capLogDelta(Array.from({ length: 600 }, (_, index) => index), 500);

  assert.equal(capped.entries.length, 500);
  assert.equal(capped.dropped, 100);
  assert.equal(capped.entries[0], 100);
});

test('HostSession schedules poll and publish with browser-like timers', async () => {
  const relay = new FakeRelay();
  const { roomCode, hostToken, hostLobby } = await setupRoom(relay, { guests: [] });
  const timers = installBrowserLikeTimers();
  const originalPoll = relay.hostPoll.bind(relay);
  const errors = [];
  let polls = 0;
  let host = null;

  relay.hostPoll = (...args) => {
    polls += 1;
    return originalPoll(...args);
  };

  try {
    host = new HostSession({
      relay,
      roomCode,
      token: hostToken,
      lobby: hostLobby,
      hostName: 'Хост',
      seed: 33,
      actionPollIntervalMs: 10,
    });
    host.on('error', (error) => errors.push(error));

    const state = await host.start();

    assert.equal(state.viewerId, 'human');
    assert.equal(host.started, true);

    const polled = await waitFor(() => polls >= 2);

    assert.equal(polled, true, 'the host must keep polling the action queue');

    const versionBefore = relay.room(roomCode).publishVersion;

    await host.resync();

    assert.ok(relay.room(roomCode).publishVersion > versionBefore);
    assert.equal(
      errors.some((error) => /Illegal invocation/.test(String(error?.message))),
      false,
    );
    assert.ok(timers.scheduled() > 0, 'the default timer wrapper must schedule work');
  } finally {
    host?.dispose();
    timers.restore();
  }
});

test('controller gates AI by isAI/controlsAI and blocks restart when canRestart is false', () => {
  const controllerSource = readFileSync(
    new URL('../js/ui/controller.js', import.meta.url),
    'utf8',
  );
  const tableSource = readFileSync(
    new URL('../js/ui/table.js', import.meta.url),
    'utf8',
  );

  assert.match(controllerSource, /capabilities\?\.controlsAI === false/);
  assert.match(controllerSource, /actor\.isAI/);
  assert.match(controllerSource, /capabilities\?\.canRestart === false/);
  assert.match(controllerSource, /getSeatStatus/);
  assert.match(controllerSource, /нет связи/);
  assert.match(controllerSource, /Ждём/);
  assert.match(tableSource, /player\.isAI && isActing/);
});
