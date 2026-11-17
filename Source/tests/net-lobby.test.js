import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AI_SEAT_NAMES,
  GUEST_STORAGE_PREFIX,
  HOST_STORAGE_PREFIX,
  NetworkLobby,
  canStartLobby,
  createMemoryStorage,
  getHealthInstruction,
  getSeatDisplayName,
  normalizeLobby,
} from '../js/net/lobby.js';
import { RelayError } from '../js/net/relay-client.js';
import {
  isNameTaken,
  normalizeRoomCode,
  validateName,
} from '../js/net/protocol.js';
import { GuestSession } from '../js/session/guest-session.js';
import { HostSession } from '../js/session/host-session.js';
import { LocalSession } from '../js/session/local-session.js';

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

const PLAYERS = Object.freeze([
  Object.freeze({ id: 'alice', name: 'Алиса', isHuman: false }),
  Object.freeze({ id: 'boris', name: 'Борис', isHuman: false }),
  Object.freeze({ id: 'human', name: 'Вы', isHuman: true }),
]);

/**
 * In-memory relay that mirrors the PowerShell API contract. It is deliberately
 * strict about tokens, closed rooms and seat limits so the lobby tests exercise
 * the same failure modes as the real server.
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
      viewVersion: 0,
      views: {},
      logEpoch: 0,
      logTotal: 0,
      actions: [],
      actionSeq: 0,
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

    return {
      roomCode: code,
      playerId: 'human',
      token,
      lobby: this.#lobby(room),
    };
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

    if (isNameTaken(validation.name, this.#lobby(room).seats)) {
      throw new RelayError('That name is already used.', { status: 409, code: 'name_taken' });
    }

    const seat = ['alice', 'boris'].find((id) => room.seats[id] === null);

    if (!seat) {
      throw new RelayError('The room is full.', { status: 409, code: 'room_full' });
    }

    const token = `guest-token-${++this.tokenSeq}`;
    room.seats[seat] = {
      playerId: seat,
      name: validation.name,
      token,
      isHost: false,
      connected: true,
      lastSeen: new Date().toISOString(),
    };
    room.lobbyVersion += 1;
    this.tokens.set(token, { roomCode: room.code, playerId: seat, isHost: false });

    return {
      roomCode: room.code,
      playerId: seat,
      token,
      lobby: this.#lobby(room),
    };
  }

  async hostPoll(roomCode, token, { actionSince = 0 } = {}) {
    const room = this.#room(roomCode);
    this.#auth(room, token, true);

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
      room.logTotal = 0;
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

    room.publishVersion = version;

    return {
      version: room.publishVersion,
      started: room.started,
      gameReset: Boolean(body.gameReset),
      views: room.views,
      log: [],
      messages: { human: [], alice: [], boris: [] },
      cursor: room.actionSeq,
      lobbyVersion: room.lobbyVersion,
      duplicate: false,
    };
  }

  async playerPoll(roomCode, token, {
    viewSince = 0,
  } = {}) {
    const room = this.#room(roomCode);
    const player = this.#auth(room, token, false);
    const result = {
      lobby: this.#lobby(room),
      viewVersion: room.viewVersion,
      logEpoch: room.logEpoch,
      logTotal: room.logTotal,
      messageTotal: room.messageSeq[player.playerId] ?? 0,
      started: room.started,
      log: [],
      messages: [],
    };

    if (viewSince < room.viewVersion && room.views[player.playerId]) {
      result.view = room.views[player.playerId];
    }

    return result;
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
 * @returns {NetworkLobby}
 */
function createLobby(relay, options = {}) {
  return new NetworkLobby({
    relay,
    sessionStorage: createMemoryStorage(),
    localStorage: createMemoryStorage(),
    tabId: options.tabId ?? `tab-${Math.random()}`,
    ...options,
  });
}

test('lobby model marks free seats as AI and allows one to three live players', () => {
  const makeLobby = (live) => ({
    code: 'ABC234',
    started: false,
    maxPlayers: 3,
    seats: SEATS.map((playerId, index) => ({
      playerId,
      name: index < live ? `Игрок ${index + 1}` : null,
      occupied: index < live,
      isHost: playerId === 'human',
      isAI: index >= live,
      connected: index < live,
      lastSeen: index < live ? new Date().toISOString() : null,
    })),
  });

  assert.equal(canStartLobby(makeLobby(0)), false);
  assert.equal(canStartLobby(makeLobby(1)), true);
  assert.equal(canStartLobby(makeLobby(2)), true);
  assert.equal(canStartLobby(makeLobby(3)), true);
  assert.equal(canStartLobby({ ...makeLobby(2), started: true }), false);

  const normalized = normalizeLobby(makeLobby(1));

  assert.equal(normalized.seats[1].isAI, true);
  assert.equal(normalized.seats[1].occupied, false);
  assert.equal(getSeatDisplayName(normalized.seats[1]), AI_SEAT_NAMES.alice);
  assert.equal(getSeatDisplayName(normalized.seats[0]), 'Игрок 1');
});

test('health lan:false returns start-lan.cmd instruction and keeps the local game', async () => {
  const relay = new FakeRelay({ lan: false });
  const lobby = createLobby(relay);
  const health = await lobby.checkHealth();

  assert.equal(health.ok, false);
  assert.equal(health.code, 'lan_disabled');
  assert.match(health.message, /start-lan\.cmd/);
  assert.equal(health.localGameAvailable, true);

  const created = await lobby.createRoom('Хост');

  assert.equal(created.ok, false);
  assert.equal(created.code, 'lan_disabled');
  assert.equal(relay.rooms.size, 0);

  const local = new LocalSession({
    players: PLAYERS,
    humanId: 'human',
    seed: 1,
  });

  local.start();
  assert.equal(local.getState().viewerId, 'human');
  local.dispose();

  assert.match(getHealthInstruction({ ok: true, lan: false }).message, /start-lan\.cmd/);
  assert.match(getHealthInstruction(null).message, /start-lan\.cmd/);
  assert.equal(getHealthInstruction({ ok: true, lan: true }), null);
});

test('host creates a room, two guests take alice/boris and a third guest gets 409', async () => {
  const relay = new FakeRelay();
  const hostLobby = createLobby(relay);
  const host = await hostLobby.createRoom('Хост');

  assert.equal(host.ok, true);
  assert.equal(host.role, 'host');
  assert.equal(host.playerId, 'human');
  assert.equal(host.lobby.started, false);

  const aliceLobby = createLobby(relay);
  const alice = await aliceLobby.joinRoom(host.roomCode, 'Алиса');
  const borisLobby = createLobby(relay);
  const boris = await borisLobby.joinRoom(host.roomCode, 'Борис');

  assert.equal(alice.ok, true);
  assert.equal(alice.playerId, 'alice');
  assert.equal(boris.ok, true);
  assert.equal(boris.playerId, 'boris');

  const thirdLobby = createLobby(relay);
  const third = await thirdLobby.joinRoom(host.roomCode, 'Третий');

  assert.equal(third.ok, false);
  assert.equal(third.status, 409);
  assert.equal(third.code, 'room_full');

  const seats = boris.lobby.seats;
  assert.equal(seats.length, 3);

  for (const seat of seats) {
    assert.equal(typeof seat.playerId, 'string');
    assert.equal(Object.hasOwn(seat, 'name'), true);
    assert.equal(typeof seat.occupied, 'boolean');
    assert.equal(typeof seat.isHost, 'boolean');
    assert.equal(typeof seat.isAI, 'boolean');
    assert.equal(typeof seat.connected, 'boolean');
    assert.equal(Object.hasOwn(seat, 'lastSeen'), true);
  }

  assert.equal(seats.find((seat) => seat.playerId === 'human').isHost, true);
  assert.equal(seats.find((seat) => seat.playerId === 'alice').name, 'Алиса');
  assert.equal(seats.find((seat) => seat.playerId === 'boris').name, 'Борис');
});

test('kick frees the seat, invalidates the token and closed/unknown rooms return 410/404', async () => {
  const relay = new FakeRelay();
  const hostLobby = createLobby(relay);
  const host = await hostLobby.createRoom('Хост');
  const aliceLobby = createLobby(relay);
  const alice = await aliceLobby.joinRoom(host.roomCode, 'Алиса');
  const borisLobby = createLobby(relay);
  const boris = await borisLobby.joinRoom(host.roomCode, 'Борис');

  const kicked = await hostLobby.kick(alice.playerId);

  assert.equal(kicked.ok, true);
  assert.equal(kicked.lobby.seats.find((seat) => seat.playerId === 'alice').occupied, false);

  await assert.rejects(
    () => relay.playerPoll(host.roomCode, alice.token, {}),
    (error) => error instanceof RelayError && error.status === 401,
  );

  const closed = await hostLobby.closeRoom();
  assert.equal(closed.ok, true);

  await assert.rejects(
    () => relay.hostPoll(host.roomCode, host.token, {}),
    (error) => error instanceof RelayError && error.status === 410,
  );
  await assert.rejects(
    () => relay.playerPoll(host.roomCode, boris.token, {}),
    (error) => error instanceof RelayError && error.status === 410,
  );
  await assert.rejects(
    () => relay.joinRoom(host.roomCode, 'Поздний'),
    (error) => error instanceof RelayError && error.status === 410,
  );

  const unknownLobby = createLobby(relay);
  const unknown = await unknownLobby.joinRoom('ZZZ999', 'Никто');

  assert.equal(unknown.ok, false);
  assert.equal(unknown.status, 404);
  assert.equal(unknown.code, 'room_not_found');
});

test('guest resume with the saved token returns the same seat and current lobby', async () => {
  const relay = new FakeRelay();
  const hostLobby = createLobby(relay);
  const host = await hostLobby.createRoom('Хост');
  const guestStorage = createMemoryStorage();
  const firstLobby = new NetworkLobby({
    relay,
    sessionStorage: createMemoryStorage(),
    localStorage: guestStorage,
    tabId: 'guest-tab-1',
  });
  const joined = await firstLobby.joinRoom(host.roomCode, 'Гость');

  assert.equal(joined.ok, true);

  const secondLobby = new NetworkLobby({
    relay,
    sessionStorage: createMemoryStorage(),
    localStorage: guestStorage,
    tabId: 'guest-tab-2',
  });
  const resumed = await secondLobby.resumeGuest(host.roomCode);

  assert.equal(resumed.ok, true);
  assert.equal(resumed.playerId, joined.playerId);
  assert.equal(resumed.roomCode, host.roomCode);
  assert.equal(resumed.lobby.seats.find((seat) => seat.playerId === joined.playerId).name, 'Гость');
  assert.equal(resumed.started, false);

  const missingLobby = createLobby(relay);
  const missing = await missingLobby.resumeGuest(host.roomCode);

  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'no_saved_guest');
});

test('explicit leave clears the saved token and frees the seat', async () => {
  const relay = new FakeRelay();
  const hostStorage = createMemoryStorage();
  const hostLobby = new NetworkLobby({
    relay,
    sessionStorage: hostStorage,
    localStorage: createMemoryStorage(),
    tabId: 'host-tab',
  });
  const host = await hostLobby.createRoom('Хост');

  assert.notEqual(hostStorage.getItem(`${HOST_STORAGE_PREFIX}${host.roomCode}`), null);

  const guestStorage = createMemoryStorage();
  const guestLobby = new NetworkLobby({
    relay,
    sessionStorage: createMemoryStorage(),
    localStorage: guestStorage,
    tabId: 'guest-tab',
  });
  const guest = await guestLobby.joinRoom(host.roomCode, 'Гость');

  assert.notEqual(guestStorage.getItem(`${GUEST_STORAGE_PREFIX}${host.roomCode}`), null);

  await guestLobby.leave();

  assert.equal(guestStorage.getItem(`${GUEST_STORAGE_PREFIX}${host.roomCode}`), null);
  await assert.rejects(
    () => relay.playerPoll(host.roomCode, guest.token, {}),
    (error) => error instanceof RelayError && error.status === 401,
  );

  await hostLobby.leave();

  assert.equal(hostStorage.getItem(`${HOST_STORAGE_PREFIX}${host.roomCode}`), null);
  await assert.rejects(
    () => relay.hostPoll(host.roomCode, host.token, {}),
    (error) => error instanceof RelayError && error.status === 410,
  );
});

test('host start publishes the first personal view to every guest', async () => {
  const relay = new FakeRelay();
  const hostLobby = createLobby(relay);
  const host = await hostLobby.createRoom('Хост');
  const aliceLobby = createLobby(relay);
  const alice = await aliceLobby.joinRoom(host.roomCode, 'Алиса');
  const borisLobby = createLobby(relay);
  const boris = await borisLobby.joinRoom(host.roomCode, 'Борис');

  const current = await hostLobby.refresh();
  assert.equal(current.ok, true);

  const hostSession = new HostSession({
    relay,
    roomCode: host.roomCode,
    token: host.token,
    lobby: current.lobby,
    hostName: 'Хост',
    seed: 33,
  });

  assert.deepEqual({ ...hostSession.capabilities }, {
    mode: 'network-host',
    controlsAI: true,
    canRestart: true,
    isHost: true,
  });

  await hostSession.start();

  assert.equal(hostSession.lastPublishError, null);
  assert.equal(hostSession.started, true);

  const hostView = hostSession.getState();
  assert.equal(hostView.viewerId, 'human');
  assert.equal(hostView.players.find((player) => player.id === 'human').hand.length, 7);
  assert.deepEqual(hostView.players.find((player) => player.id === 'alice').hand, []);
  assert.deepEqual(hostView.prikup, []);

  for (const [guest, playerId] of [[alice, 'alice'], [boris, 'boris']]) {
    const session = new GuestSession({
      relay,
      roomCode: host.roomCode,
      token: guest.token,
      playerId: guest.playerId,
      name: guest.lobby.seats.find((seat) => seat.playerId === guest.playerId).name,
    });

    assert.deepEqual({ ...session.capabilities }, {
      mode: 'network-guest',
      controlsAI: false,
      canRestart: false,
      isHost: false,
    });

    const view = await session.start();

    assert.ok(view, `${playerId} must receive a view`);
    assert.equal(view.viewerId, playerId);
    assert.equal(view.players.find((player) => player.id === playerId).hand.length, 7);
    assert.equal(view.players.find((player) => player.id === playerId).isAI, false);
    assert.deepEqual(view.prikup, []);

    for (const player of view.players) {
      if (player.id !== playerId) {
        assert.deepEqual(player.hand, []);
      }
    }

    session.dispose();
  }

  hostSession.dispose();
});

test('empty seats stay AI and receive only their own view after start', async () => {
  const relay = new FakeRelay();
  const hostLobby = createLobby(relay);
  const host = await hostLobby.createRoom('Хост');
  const aliceLobby = createLobby(relay);
  const alice = await aliceLobby.joinRoom(host.roomCode, 'Алиса');
  const current = await hostLobby.refresh();

  const hostSession = new HostSession({
    relay,
    roomCode: host.roomCode,
    token: host.token,
    lobby: current.lobby,
    hostName: 'Хост',
    seed: 5,
  });

  await hostSession.start();

  const hostView = hostSession.getState();
  const boris = hostView.players.find((player) => player.id === 'boris');
  const aliceSeat = hostView.players.find((player) => player.id === 'alice');

  assert.equal(boris.isAI, true);
  assert.equal(boris.name, 'Борис');
  assert.equal(aliceSeat.isAI, false);

  const borisView = hostSession.getPlayerView('boris');
  assert.equal(borisView.viewerId, 'boris');
  assert.equal(borisView.players.find((player) => player.id === 'boris').hand.length, 7);
  assert.deepEqual(borisView.players.find((player) => player.id === 'alice').hand, []);

  const guest = new GuestSession({
    relay,
    roomCode: host.roomCode,
    token: alice.token,
    playerId: alice.playerId,
  });
  const guestView = await guest.start();

  assert.equal(guestView.players.find((player) => player.id === 'boris').isAI, true);
  guest.dispose();
  hostSession.dispose();
});
