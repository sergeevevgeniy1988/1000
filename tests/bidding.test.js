import test from 'node:test';
import assert from 'node:assert/strict';

import { BIDDING, GAME_EVENTS, PHASES } from '../js/core/constants.js';
import { Game } from '../js/core/game.js';
import { GameError } from '../js/core/errors.js';
import {
  createBiddingGame,
  getStatePlayer,
  PLAYERS,
} from './helpers.js';

function expectError(action, code) {
  assert.throws(
    action,
    (error) => error instanceof GameError && error.code === code,
    `Expected GameError with code ${code}.`,
  );
}

function allCardIds(state) {
  return [
    ...state.players.flatMap((player) => player.hand),
    ...state.prikup,
  ];
}

test('start deals 7/7/7 + 3 and the player left of the dealer opens bidding', () => {
  for (let dealerIndex = 0; dealerIndex < PLAYERS.length; dealerIndex += 1) {
    const game = createBiddingGame({ dealerIndex });
    const state = game.getState();
    const openerIndex = (dealerIndex + 1) % PLAYERS.length;
    const openerId = PLAYERS[openerIndex].id;

    assert.equal(state.phase, PHASES.BIDDING);
    assert.equal(state.dealNumber, 1);
    assert.equal(state.dealerIndex, dealerIndex);
    assert.equal(state.dealerId, PLAYERS[dealerIndex].id);
    assert.equal(state.firstBidderId, openerId);
    assert.equal(state.currentBidderId, openerId);
    assert.equal(state.currentBid, 0);
    assert.deepEqual(
      state.activeBidderIds,
      PLAYERS.map((_, offset) => PLAYERS[(openerIndex + offset) % PLAYERS.length].id),
    );

    for (const player of state.players) {
      assert.equal(player.hand.length, 7, `${player.id} must start with 7 cards.`);
      assert.equal(player.score, 0);
      assert.equal(player.bolts, 0);
      assert.equal(player.passed, false);
      assert.equal(player.isDeclarer, false);
    }

    assert.equal(state.prikup.length, 3);

    const cardIds = allCardIds(state);
    assert.equal(cardIds.length, 24);
    assert.equal(new Set(cardIds).size, 24);
  }
});

test('the game starts only once and actions are unavailable in IDLE', () => {
  const game = new Game({
    players: PLAYERS.map((player) => ({ ...player })),
    rng: () => 0,
  });

  const idle = game.getState();
  assert.equal(idle.phase, PHASES.IDLE);
  assert.equal(idle.dealNumber, 0);
  assert.equal(idle.dealerIndex, null);
  assert.equal(idle.currentPlayerId, null);
  assert.ok(idle.players.every((player) => player.hand.length === 0));

  expectError(() => game.bid('alice', 100), 'INVALID_PHASE');
  expectError(() => game.playCard('alice', 'S9'), 'INVALID_PHASE');
  expectError(() => game.nextDeal(), 'INVALID_PHASE');

  game.start();
  expectError(() => game.start(), 'INVALID_PHASE');
});

test('the opener must bid exactly 100, cannot pass and bids follow the step rule', () => {
  const game = createBiddingGame();

  expectError(() => game.bid('alice', 'pass'), 'CANNOT_PASS');
  expectError(() => game.bid('alice', 95), 'INVALID_BID');
  expectError(() => game.bid('alice', 105), 'INVALID_BID');
  expectError(() => game.bid('alice', 102), 'INVALID_BID');
  expectError(() => game.bid('boris', 100), 'NOT_YOUR_TURN');
  expectError(() => game.bid('alice', 125), 'INVALID_BID');

  let state = game.bid('alice', 100);
  assert.equal(state.currentBid, 100);
  assert.equal(state.currentBidderId, 'boris');
  assert.equal(getStatePlayer(state, 'alice').bid, 100);

  expectError(() => game.bid('human', 105), 'NOT_YOUR_TURN');

  state = game.bid('boris', 105);
  assert.equal(state.currentBid, 105);
  assert.equal(state.currentBidderId, 'human');

  expectError(() => game.bid('human', 105), 'INVALID_BID');
  expectError(() => game.bid('human', 107), 'INVALID_BID');
  expectError(() => game.bid('human', 125), 'INVALID_BID');

  state = game.bid('human', 110);
  assert.equal(state.currentBid, 110);
  assert.equal(state.currentBidderId, 'alice');

  state = game.bid('alice', 120);
  assert.equal(state.phase, PHASES.GIVING);
  assert.equal(state.currentBid, BIDDING.MAX);
  assert.equal(state.contract, BIDDING.MAX);
  assert.equal(state.declarerId, 'alice');
  assert.deepEqual(state.activeBidderIds, ['alice']);
  assert.equal(state.currentBidderId, null);
  assert.equal(getStatePlayer(state, 'alice').hand.length, 10);
  assert.equal(getStatePlayer(state, 'alice').isDeclarer, true);

  expectError(() => game.bid('alice', 120), 'INVALID_PHASE');

  const bids = state.log.filter((entry) => entry.type === 'bid');
  assert.deepEqual(
    bids.map((entry) => [entry.playerId, entry.amount]),
    [['alice', 100], ['boris', 105], ['human', 110], ['alice', 120]],
  );
});

test('passes remove players from bidding and the last active player wins', () => {
  const game = createBiddingGame();

  let state = game.bid('alice', 100);
  state = game.bid('boris', 'pass');

  assert.equal(getStatePlayer(state, 'boris').passed, true);
  assert.deepEqual(state.activeBidderIds, ['alice', 'human']);
  assert.equal(state.currentBidderId, 'human');
  expectError(() => game.bid('boris', 105), 'PLAYER_PASSED');

  state = game.bid('human', 'Пас');
  assert.equal(state.phase, PHASES.GIVING);
  assert.equal(state.declarerId, 'alice');
  assert.equal(state.contract, 100);
  assert.deepEqual(state.activeBidderIds, ['alice']);
  assert.equal(getStatePlayer(state, 'boris').passed, true);
  assert.equal(getStatePlayer(state, 'human').passed, true);
  assert.equal(getStatePlayer(state, 'alice').passed, false);
  assert.equal(getStatePlayer(state, 'alice').hand.length, 10);

  const passes = state.log.filter((entry) => entry.type === 'pass');
  assert.deepEqual(passes.map((entry) => entry.playerId), ['boris', 'human']);
});

test('a player may raise after passing is impossible and passes skip turns', () => {
  const game = createBiddingGame();

  game.bid('alice', 100);
  game.bid('boris', 105);
  let state = game.bid('human', null);

  assert.deepEqual(state.activeBidderIds, ['alice', 'boris']);
  assert.equal(state.currentBidderId, 'alice');

  state = game.bid('alice', 110);
  assert.equal(state.currentBidderId, 'boris');

  state = game.bid('boris', 'pass');
  assert.equal(state.phase, PHASES.GIVING);
  assert.equal(state.declarerId, 'alice');
  assert.equal(state.contract, 110);
  assert.equal(getStatePlayer(state, 'alice').bid, 110);
});

test('jump bids are legal and 120 ends bidding immediately', () => {
  const game = createBiddingGame();

  game.bid('alice', 100);
  const afterJump = game.bid('boris', 110);

  assert.equal(afterJump.currentBid, 110);
  assert.equal(afterJump.currentBidderId, 'human');

  const state = game.bid('human', 120);

  assert.equal(state.phase, PHASES.GIVING);
  assert.equal(state.declarerId, 'human');
  assert.equal(state.contract, 120);
  assert.equal(state.currentBid, 120);
  assert.deepEqual(state.activeBidderIds, ['human']);
  assert.equal(getStatePlayer(state, 'human').isDeclarer, true);
  assert.equal(getStatePlayer(state, 'human').hand.length, 10);
  assert.equal(getStatePlayer(state, 'alice').passed, false);
  assert.equal(getStatePlayer(state, 'boris').passed, false);

  expectError(() => game.bid('alice', 120), 'INVALID_PHASE');
});

test('the engine emits semantic bidding events and an error event', () => {
  const game = createBiddingGame();
  const events = {
    bids: [],
    passes: [],
    prikup: null,
    stateChanges: 0,
    errors: [],
  };

  game.on(GAME_EVENTS.BID, (payload) => events.bids.push(payload));
  game.on(GAME_EVENTS.PASS, (payload) => events.passes.push(payload));
  game.on(GAME_EVENTS.PRIKUP, (payload) => {
    events.prikup = payload;
  });
  game.on(GAME_EVENTS.ERROR, (error) => events.errors.push(error));

  const unsubscribe = game.subscribe(() => {
    events.stateChanges += 1;
  });

  game.bid('alice', 100);
  game.bid('boris', 'pass');
  game.bid('human', 'pass');

  assert.equal(events.bids.length, 1);
  assert.equal(events.bids[0].playerId, 'alice');
  assert.equal(events.bids[0].amount, 100);

  assert.equal(events.passes.length, 2);
  assert.deepEqual(events.passes.map((payload) => payload.playerId), ['boris', 'human']);

  assert.equal(events.prikup.declarerId, 'alice');
  assert.equal(events.prikup.cards.length, 3);
  assert.equal(events.prikup.handSize, 10);

  assert.equal(events.stateChanges, 3);

  expectError(() => game.bid('alice', 100), 'INVALID_PHASE');
  assert.equal(events.errors.length, 1);
  assert.equal(events.errors[0].code, 'INVALID_PHASE');
  assert.equal(events.stateChanges, 3);

  unsubscribe();
  expectError(() => game.bid('alice', 100), 'INVALID_PHASE');
  assert.equal(events.stateChanges, 3);
});
