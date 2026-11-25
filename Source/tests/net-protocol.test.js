import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACTION_ID_MAX_LENGTH,
  ACTION_TYPES,
  ACTION_TYPE_LIST,
  API_VERSION,
  NAME_MAX_LENGTH,
  POLL_INTERVAL_MS,
  ROOM_CODE_LENGTH,
  createAction,
  createActionId,
  formatInviteLink,
  isLanHealth,
  isNameTaken,
  isValidActionId,
  isValidRoomCode,
  normalizeRoomCode,
  validateAction,
  validateLobbyName,
  validateName,
} from '../js/net/protocol.js';
import { RelayClient, RelayError } from '../js/net/relay-client.js';

test('protocol fixes the API version, polling cadence and action list', () => {
  assert.equal(API_VERSION, 1);
  assert.equal(POLL_INTERVAL_MS, 400);
  assert.equal(ROOM_CODE_LENGTH, 6);
  assert.equal(NAME_MAX_LENGTH, 24);
  assert.equal(ACTION_TYPE_LIST.length, 10);
  assert.deepEqual([...ACTION_TYPE_LIST].sort(), [
    'bid',
    'cancelMarriage',
    'declareMarriage',
    'declineRaise',
    'giveCard',
    'nextDeal',
    'pass',
    'playCard',
    'raiseContract',
    'takePrikup',
  ]);
  assert.equal(ACTION_TYPES.BID, 'bid');
});

test('room codes are six unambiguous characters and normalize case', () => {
  assert.equal(normalizeRoomCode(' abc234 '), 'ABC234');
  assert.equal(isValidRoomCode('abc234'), true);
  assert.equal(isValidRoomCode('ABC234'), true);
  assert.equal(isValidRoomCode('ABC23'), false);
  assert.equal(isValidRoomCode('ABC2345'), false);
  assert.equal(isValidRoomCode('ABC23O'), false);
  assert.equal(isValidRoomCode('ABC23I'), false);
  assert.equal(isValidRoomCode('ABC-34'), false);
  assert.equal(isValidRoomCode(null), false);
});

test('display names are trimmed, limited to 24 characters and reject controls', () => {
  const trimmed = validateName('  Иван  ');
  assert.equal(trimmed.ok, true);
  assert.equal(trimmed.name, 'Иван');

  assert.equal(validateName('').ok, false);
  assert.equal(validateName('   ').ok, false);
  assert.equal(validateName('a'.repeat(24)).ok, true);
  assert.equal(validateName('a'.repeat(25)).ok, false);
  assert.equal(validateName('bad\nname').ok, false);
  assert.equal(validateName('bad\u0000name').ok, false);
});

test('lobby name validation rejects duplicates case-insensitively', () => {
  const seats = [
    { playerId: 'human', name: 'Хост', occupied: true },
    { playerId: 'alice', name: 'Анна', occupied: true },
    { playerId: 'boris', name: null, occupied: false },
  ];

  assert.equal(isNameTaken('анна', seats), true);
  assert.equal(isNameTaken('Анна', seats), true);
  assert.equal(isNameTaken('Борис', seats), false);
  assert.equal(isNameTaken('Анна', seats, 'alice'), false);

  const duplicate = validateLobbyName('анна', { lobby: { seats } });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.code, 'name_taken');

  const free = validateLobbyName('Борис', { lobby: { seats } });
  assert.equal(free.ok, true);
  assert.equal(free.name, 'Борис');
});

test('all action forms are validated by the shared protocol', () => {
  const valid = [
    ['bid', { amount: 80 }],
    ['bid', { amount: 120 }],
    ['pass', {}],
    ['takePrikup', {}],
    ['raiseContract', { amount: 105 }],
    ['raiseContract', { amount: 125 }],
    ['raiseContract', { amount: 220 }],
    ['raiseContract', { amount: 400 }],
    ['declineRaise', {}],
    ['giveCard', { toPlayerId: 'alice', cardId: 'S10' }],
    ['declareMarriage', { suit: 'H' }],
    ['cancelMarriage', {}],
    ['playCard', { cardId: 'D9' }],
    ['nextDeal', {}],
  ];

  for (const [type, payload] of valid) {
    const result = validateAction(type, payload);
    assert.equal(result.ok, true, `${type} should be valid`);
    assert.equal(result.type, type);
  }
});

test('action validation rejects bad amounts, cards, seats, suits and unknown fields', () => {
  const invalidCases = [
    ['bid', { amount: 83 }, 'bad_amount'],
    ['bid', { amount: 125 }, 'bad_amount'],
    ['bid', {}, 'bad_amount'],
    ['raiseContract', { amount: 79 }, 'bad_amount'],
    ['raiseContract', { amount: 405 }, 'bad_amount'],
    ['raiseContract', { amount: 82 }, 'bad_amount'],
    ['giveCard', { toPlayerId: 'cat', cardId: 'S10' }, 'bad_target'],
    ['giveCard', { toPlayerId: 'alice', cardId: 'X10' }, 'bad_card'],
    ['playCard', { cardId: 'S11' }, 'bad_card'],
    ['declareMarriage', { suit: 'X' }, 'bad_suit'],
    ['bid', { amount: 80, extra: true }, 'unknown_field'],
    ['nextDeal', { playerId: 'alice' }, 'forbidden_field'],
    ['playCard', { cardId: 'S10', token: 'secret' }, 'forbidden_field'],
    ['unknown', {}, 'unknown_action'],
  ];

  for (const [type, payload, code] of invalidCases) {
    const result = validateAction(type, payload);
    assert.equal(result.ok, false, `${type} ${JSON.stringify(payload)} should fail`);
    assert.equal(result.code, code);
  }

  assert.equal(validateAction('pass', []).code, 'bad_payload');
  assert.equal(validateAction('pass', null).ok, true);
});

test('action ids are opaque, bounded and safe to send', () => {
  const id = createActionId('bid');
  assert.equal(typeof id, 'string');
  assert.equal(isValidActionId(id), true);
  assert.ok(id.length <= ACTION_ID_MAX_LENGTH);

  assert.equal(isValidActionId(''), false);
  assert.equal(isValidActionId('a'.repeat(65)), false);
  assert.equal(isValidActionId('bad\nid'), false);

  const created = createAction('playCard', { cardId: 'H10' });
  assert.equal(created.ok, true);
  assert.equal(created.action.type, 'playCard');
  assert.equal(created.action.payload.cardId, 'H10');
  assert.equal(isValidActionId(created.action.actionId), true);

  const rejected = createAction('playCard', { cardId: 'H11' });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'bad_card');
});

test('invite links contain only the room code and health checks LAN mode', () => {
  assert.equal(
    formatInviteLink('abc234', { origin: 'http://192.168.1.10:8765', pathname: '/' }),
    'http://192.168.1.10:8765/?room=ABC234',
  );
  assert.equal(formatInviteLink('bad', { origin: 'http://host' }), '');

  assert.equal(isLanHealth({ ok: true, lan: true }), true);
  assert.equal(isLanHealth({ ok: true, lan: false }), false);
  assert.equal(isLanHealth({ ok: false, lan: true }), false);
  assert.equal(isLanHealth(null), false);
});

/**
 * @param {object} body
 * @param {number} [status]
 * @returns {object}
 */
function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

test('RelayClient does not retry create/join and keeps tokens out of URLs', async () => {
  const calls = [];
  const relay = new RelayClient({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({
        roomCode: 'ABC234',
        playerId: 'alice',
        token: 'secret-token',
        lobby: { code: 'ABC234', seats: [] },
      });
    },
  });

  await relay.createRoom('Игрок');
  await relay.joinRoom('ABC234', 'Игрок');

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, '/api/rooms');
  assert.equal(calls[1].url, '/api/rooms/ABC234/join');
  assert.equal(calls[0].init.headers['X-Room-Token'], undefined);
  assert.equal(calls[1].init.headers['X-Room-Token'], undefined);
  assert.equal(calls[0].url.includes('secret-token'), false);
});

test('RelayClient sends the token only in the header and retries polls', async () => {
  const calls = [];
  let attempt = 0;
  const relay = new RelayClient({
    sleep: async () => {},
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      attempt += 1;

      if (attempt === 1) {
        throw new Error('offline');
      }

      return jsonResponse({ lobby: { code: 'ABC234', seats: [] }, started: false });
    },
  });

  const result = await relay.playerPoll('abc234', 'secret-token', {
    viewSince: 1,
    logSince: 0,
    logEpoch: 0,
    messageSince: 0,
  });

  assert.equal(result.started, false);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, '/api/rooms/ABC234/player?viewSince=1&logSince=0&logEpoch=0&messageSince=0');
  assert.equal(calls[1].url.includes('secret-token'), false);
  assert.equal(calls[1].init.headers['X-Room-Token'], 'secret-token');
});

test('RelayClient surfaces relay error codes and never retries create/join', async () => {
  let calls = 0;
  const relay = new RelayClient({
    sleep: async () => {},
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ error: 'room_full', message: 'The room is full.' }, 409);
    },
  });

  await assert.rejects(
    () => relay.joinRoom('ABC234', 'Игрок'),
    (error) => error instanceof RelayError
      && error.status === 409
      && error.code === 'room_full',
  );

  assert.equal(calls, 1);
});

