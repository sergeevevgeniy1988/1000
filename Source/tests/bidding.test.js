import test from 'node:test';
import assert from 'node:assert/strict';

import { BIDDING, GAME_EVENTS, PHASES } from '../js/core/constants.js';
import { Game } from '../js/core/game.js';
import { getCardById } from '../js/core/deck.js';
import { GameError } from '../js/core/errors.js';
import { getLegalCards } from '../js/core/rules.js';
import { mulberry32 } from '../js/core/rng.js';
import {
  createBiddingGame,
  createFixedGame,
  getStatePlayer,
  PLAYERS,
} from './helpers.js';

const TIE_HANDS = {
  alice: ['SA', 'HA', 'DA', 'CA', 'SQ', 'HQ', 'DQ'],
  boris: ['HK', 'DK', 'CK', 'S10', 'D10', 'HJ', 'CJ'],
  human: ['H9', 'D9', 'C9', 'SJ', 'DJ', 'H10', 'C10'],
};
const TIE_PRIKUP = ['CQ', 'SK', 'S9'];
const TIE_PLAYS = [
  ['alice', 'SA'], ['boris', 'SK'], ['human', 'S9'],
  ['alice', 'HA'], ['boris', 'HK'], ['human', 'H9'],
  ['alice', 'DA'], ['boris', 'DK'], ['human', 'D9'],
  ['alice', 'CA'], ['boris', 'CK'], ['human', 'C9'],
  ['alice', 'SQ'], ['boris', 'S10'], ['human', 'SJ'],
  ['boris', 'HJ'], ['human', 'H10'], ['alice', 'HQ'],
  ['human', 'C10'], ['alice', 'CQ'], ['boris', 'CJ'],
  ['human', 'DJ'], ['alice', 'DQ'], ['boris', 'D10'],
];

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

function playDealEndingWithAliceAtMinusEighty(game) {
  game.bid('alice', BIDDING.MIN);
  game.bid('boris', 'pass');
  game.bid('human', 'pass');
  game.takePrikup('alice');

  game.giveCard('boris', 'SK');
  game.giveCard('human', 'S9');

  for (const [playerId, cardId] of TIE_PLAYS) {
    game.playCard(playerId, cardId);
  }
}

function chooseSimpleCard(state) {
  const player = state.players.find((entry) => entry.id === state.currentPlayerId);
  const leadSuit = state.currentTrick.length === 0
    ? null
    : getCardById(state.currentTrick[0].cardId).suit;
  const legal = getLegalCards(player.hand, leadSuit, state.trumpSuit)
    .sort((left, right) => left.strength - right.strength);

  return player.id === state.declarerId
    ? legal[0]
    : legal[legal.length - 1];
}

function playSimpleDeal(game) {
  let actions = 0;

  while (game.getState().phase !== PHASES.DEAL_END) {
    const state = game.getState();

    if (state.phase === PHASES.BIDDING) {
      const bidder = state.players.find((player) => player.id === state.currentBidderId);

      if (state.currentBid === 0) {
        game.bid(state.currentBidderId, BIDDING.MIN);
      } else if (bidder.score >= 0) {
        game.bid(state.currentBidderId, BIDDING.MAX);
      } else {
        throw new Error('A negative player must be passed automatically.');
      }
    } else if (state.phase === PHASES.PRIKUP) {
      game.takePrikup(state.declarerId);
    } else if (state.phase === PHASES.GIVING) {
      const declarer = state.players.find((player) => player.id === state.declarerId);
      const received = new Set(state.givenCards.map((gift) => gift.toId));
      const target = state.players.find(
        (player) => player.id !== declarer.id && !received.has(player.id),
      );
      const givenCardIds = new Set(state.givenCards.map((gift) => gift.cardId));
      const cardId = declarer.hand.find((id) => !givenCardIds.has(id));

      game.giveCard(target.id, cardId);
    } else if (state.phase === PHASES.PLAYING) {
      game.playCard(state.currentPlayerId, chooseSimpleCard(state).id);
    } else {
      throw new Error(`Unexpected phase ${state.phase} while playing a simple deal.`);
    }

    actions += 1;
    assert.ok(actions < 100, 'A simple deal must finish.');
  }
}

function createAllNegativeBiddingGame() {
  const game = new Game({
    players: PLAYERS.map((player) => ({ ...player })),
    rng: mulberry32(1),
    targetScore: 1_000_000_000,
  });
  game.start();

  let deals = 0;

  while (deals < 200) {
    const state = game.getState();

    if (
      state.phase === PHASES.BIDDING
      && state.players.every((player) => player.score < 0)
    ) {
      return game;
    }

    if (state.phase === PHASES.DEAL_END) {
      deals += 1;
      game.nextDeal();
    } else {
      playSimpleDeal(game);
    }
  }

  throw new Error('Could not reach a bidding state with all players negative.');
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

  expectError(() => game.bid('alice', 80), 'INVALID_PHASE');
  expectError(() => game.takePrikup('alice'), 'INVALID_PHASE');
  expectError(() => game.playCard('alice', 'S9'), 'INVALID_PHASE');
  expectError(() => game.nextDeal(), 'INVALID_PHASE');

  game.start();
  expectError(() => game.start(), 'INVALID_PHASE');
});

test('the opener must bid exactly 80, cannot pass and bids follow the step rule', () => {
  const game = createBiddingGame();

  expectError(() => game.bid('alice', 'pass'), 'CANNOT_PASS');
  expectError(() => game.takePrikup('alice'), 'INVALID_PHASE');
  expectError(() => game.bid('alice', 75), 'INVALID_BID');
  expectError(() => game.bid('alice', 85), 'INVALID_BID');
  expectError(() => game.bid('alice', 100), 'INVALID_BID');
  expectError(() => game.bid('alice', 102), 'INVALID_BID');
  expectError(() => game.bid('boris', 80), 'NOT_YOUR_TURN');
  expectError(() => game.bid('alice', 125), 'INVALID_BID');
  expectError(() => game.bid('alice', 82), 'INVALID_BID');

  let state = game.bid('alice', 80);
  assert.equal(state.currentBid, 80);
  assert.equal(state.currentBidderId, 'boris');
  assert.equal(getStatePlayer(state, 'alice').bid, 80);

  expectError(() => game.bid('human', 85), 'NOT_YOUR_TURN');

  state = game.bid('boris', 85);
  assert.equal(state.currentBid, 85);
  assert.equal(state.currentBidderId, 'human');

  expectError(() => game.bid('human', 85), 'INVALID_BID');
  expectError(() => game.bid('human', 87), 'INVALID_BID');
  expectError(() => game.bid('human', 125), 'INVALID_BID');

  state = game.bid('human', 110);
  assert.equal(state.currentBid, 110);
  assert.equal(state.currentBidderId, 'alice');

  state = game.bid('alice', 120);
  assert.equal(state.phase, PHASES.PRIKUP);
  assert.equal(state.currentBid, BIDDING.MAX);
  assert.equal(state.contract, BIDDING.MAX);
  assert.equal(state.declarerId, 'alice');
  assert.deepEqual(state.activeBidderIds, ['alice']);
  assert.equal(state.currentBidderId, null);
  assert.equal(getStatePlayer(state, 'alice').hand.length, 7);
  assert.equal(getStatePlayer(state, 'alice').isDeclarer, true);
  assert.equal(state.prikupRevealed, true);
  assert.equal(state.prikupTaken, false);

  expectError(() => game.takePrikup('human'), 'NOT_DECLARER');
  expectError(() => game.giveCard('boris', 'S9'), 'INVALID_PHASE');

  state = game.takePrikup('alice');
  assert.equal(state.phase, PHASES.GIVING);
  assert.equal(state.prikupTaken, true);
  assert.equal(getStatePlayer(state, 'alice').hand.length, 10);

  expectError(() => game.bid('alice', 120), 'INVALID_PHASE');

  const bids = state.log.filter((entry) => entry.type === 'bid');
  assert.deepEqual(
    bids.map((entry) => [entry.playerId, entry.amount]),
    [['alice', 80], ['boris', 85], ['human', 110], ['alice', 120]],
  );
});

test('bidding reveals the prikup to every player before the declarer takes it', () => {
  const game = createFixedGame({
    hands: TIE_HANDS,
    prikup: TIE_PRIKUP,
    dealerIndex: 0,
  });

  const bidding = game.getState();

  assert.equal(bidding.phase, PHASES.BIDDING);
  assert.equal(bidding.prikupRevealed, false);
  assert.equal(bidding.prikupTaken, false);

  for (const player of PLAYERS) {
    const view = game.getPlayerView(player.id);

    assert.deepEqual(view.prikup, []);
    assert.equal(view.prikupRevealed, false);
    assert.equal(view.prikupTaken, false);
  }

  game.bid('alice', BIDDING.MIN);
  game.bid('boris', 'pass');
  const revealed = game.bid('human', 'pass');

  assert.equal(revealed.phase, PHASES.PRIKUP);
  assert.equal(revealed.prikupRevealed, true);
  assert.equal(revealed.prikupTaken, false);
  assert.equal(revealed.prikup.length, 3);
  assert.equal(getStatePlayer(revealed, 'alice').hand.length, 7);
  assert.equal(getStatePlayer(revealed, 'human').hand.length, 7);

  for (const player of PLAYERS) {
    const view = game.getPlayerView(player.id);

    assert.deepEqual(view.prikup, revealed.prikup);
    assert.equal(view.prikupRevealed, true);
    assert.equal(view.prikupTaken, false);
  }

  expectError(() => game.takePrikup('human'), 'NOT_DECLARER');

  const taken = game.takePrikup('alice');

  assert.equal(taken.phase, PHASES.GIVING);
  assert.equal(taken.prikupTaken, true);
  assert.deepEqual(taken.prikup, revealed.prikup);
  assert.equal(getStatePlayer(taken, 'alice').hand.length, 10);
  assert.equal(getStatePlayer(taken, 'human').hand.length, 7);

  for (const player of PLAYERS) {
    assert.deepEqual(game.getPlayerView(player.id).prikup, revealed.prikup);
  }

  expectError(() => game.takePrikup('alice'), 'PRIKUP_ALREADY_TAKEN');
});

test('passes remove players from bidding and the last active player wins', () => {
  const game = createBiddingGame();

  let state = game.bid('alice', 80);
  state = game.bid('boris', 'pass');

  assert.equal(getStatePlayer(state, 'boris').passed, true);
  assert.deepEqual(state.activeBidderIds, ['alice', 'human']);
  assert.equal(state.currentBidderId, 'human');
  expectError(() => game.bid('boris', 85), 'PLAYER_PASSED');

  state = game.bid('human', 'Пас');
  assert.equal(state.phase, PHASES.PRIKUP);
  assert.equal(state.declarerId, 'alice');
  assert.equal(state.contract, 80);
  assert.deepEqual(state.activeBidderIds, ['alice']);
  assert.equal(getStatePlayer(state, 'boris').passed, true);
  assert.equal(getStatePlayer(state, 'human').passed, true);
  assert.equal(getStatePlayer(state, 'alice').passed, false);
  assert.equal(getStatePlayer(state, 'alice').hand.length, 7);
  assert.equal(state.prikupRevealed, true);

  state = game.takePrikup('alice');
  assert.equal(state.phase, PHASES.GIVING);
  assert.equal(getStatePlayer(state, 'alice').hand.length, 10);

  const passes = state.log.filter((entry) => entry.type === 'pass');
  assert.deepEqual(passes.map((entry) => entry.playerId), ['boris', 'human']);
});

test('a player may raise after passing is impossible and passes skip turns', () => {
  const game = createBiddingGame();

  game.bid('alice', 80);
  game.bid('boris', 85);
  let state = game.bid('human', null);

  assert.deepEqual(state.activeBidderIds, ['alice', 'boris']);
  assert.equal(state.currentBidderId, 'alice');

  state = game.bid('alice', 90);
  assert.equal(state.currentBidderId, 'boris');

  state = game.bid('boris', 'pass');
  assert.equal(state.phase, PHASES.PRIKUP);
  assert.equal(state.declarerId, 'alice');
  assert.equal(state.contract, 90);
  assert.equal(getStatePlayer(state, 'alice').bid, 90);
});

test('jump bids are legal and 120 ends bidding immediately', () => {
  const game = createBiddingGame();

  game.bid('alice', 80);
  const afterJump = game.bid('boris', 110);

  assert.equal(afterJump.currentBid, 110);
  assert.equal(afterJump.currentBidderId, 'human');

  let state = game.bid('human', 120);

  assert.equal(state.phase, PHASES.PRIKUP);
  assert.equal(state.declarerId, 'human');
  assert.equal(state.contract, 120);
  assert.equal(state.currentBid, 120);
  assert.deepEqual(state.activeBidderIds, ['human']);
  assert.equal(getStatePlayer(state, 'human').isDeclarer, true);
  assert.equal(getStatePlayer(state, 'human').hand.length, 7);
  assert.equal(getStatePlayer(state, 'alice').passed, false);
  assert.equal(getStatePlayer(state, 'boris').passed, false);

  state = game.takePrikup('human');
  assert.equal(state.phase, PHASES.GIVING);
  assert.equal(getStatePlayer(state, 'human').hand.length, 10);

  expectError(() => game.bid('alice', 120), 'INVALID_PHASE');
});

test('every bid from 85 to 120 is accepted with a step of five', () => {
  const game = createBiddingGame();
  const sequence = [
    ['alice', 80],
    ['boris', 85],
    ['human', 90],
    ['alice', 95],
    ['boris', 100],
    ['human', 105],
    ['alice', 110],
    ['boris', 115],
    ['human', 120],
  ];

  for (const [playerId, amount] of sequence) {
    const state = game.bid(playerId, amount);

    assert.equal(state.currentBid, amount);
  }

  const state = game.getState();

  assert.equal(state.phase, PHASES.PRIKUP);
  assert.equal(state.declarerId, 'human');
  assert.equal(state.contract, 120);
  assert.equal(getStatePlayer(state, 'human').hand.length, 7);
});

test('the engine emits semantic bidding events and an error event', () => {
  const game = createBiddingGame();
  const events = {
    bids: [],
    passes: [],
    revealed: [],
    prikup: null,
    stateChanges: 0,
    errors: [],
  };

  game.on(GAME_EVENTS.BID, (payload) => events.bids.push(payload));
  game.on(GAME_EVENTS.PASS, (payload) => events.passes.push(payload));
  game.on(GAME_EVENTS.PRIKUP_REVEALED, (payload) => events.revealed.push(payload));
  game.on(GAME_EVENTS.PRIKUP, (payload) => {
    events.prikup = payload;
  });
  game.on(GAME_EVENTS.ERROR, (error) => events.errors.push(error));

  const unsubscribe = game.subscribe(() => {
    events.stateChanges += 1;
  });

  game.bid('alice', 80);
  game.bid('boris', 'pass');
  game.bid('human', 'pass');

  assert.equal(events.bids.length, 1);
  assert.equal(events.bids[0].playerId, 'alice');
  assert.equal(events.bids[0].amount, 80);

  assert.equal(events.passes.length, 2);
  assert.deepEqual(events.passes.map((payload) => payload.playerId), ['boris', 'human']);

  assert.equal(events.revealed.length, 1);
  assert.equal(events.revealed[0].declarerId, 'alice');
  assert.equal(events.revealed[0].cards.length, 3);
  assert.equal(events.revealed[0].contract, 80);
  assert.equal(events.prikup, null);

  assert.equal(events.stateChanges, 3);

  game.takePrikup('alice');

  assert.equal(events.prikup.declarerId, 'alice');
  assert.equal(events.prikup.cards.length, 3);
  assert.equal(events.prikup.handSize, 10);
  assert.equal(events.stateChanges, 4);

  expectError(() => game.bid('alice', 80), 'INVALID_PHASE');
  assert.equal(events.errors.length, 1);
  assert.equal(events.errors[0].code, 'INVALID_PHASE');
  assert.equal(events.stateChanges, 4);

  unsubscribe();
  expectError(() => game.bid('alice', 80), 'INVALID_PHASE');
  assert.equal(events.stateChanges, 4);
});

test('a negative non-opener is passed automatically after the opening bid', () => {
  const game = createFixedGame({
    hands: TIE_HANDS,
    prikup: TIE_PRIKUP,
    dealerIndex: 0,
  });
  const passEvents = [];

  playDealEndingWithAliceAtMinusEighty(game);

  let state = game.getState();
  assert.equal(state.phase, PHASES.DEAL_END);
  assert.equal(getStatePlayer(state, 'alice').score, -80);

  state = game.nextDeal();
  assert.equal(state.phase, PHASES.BIDDING);
  assert.equal(state.currentBidderId, 'boris');
  assert.equal(getStatePlayer(state, 'alice').score, -80);

  state = game.bid('boris', 80);
  assert.equal(state.currentBidderId, 'human');

  game.on(GAME_EVENTS.PASS, (payload) => passEvents.push(payload));

  state = game.bid('human', 'pass');

  assert.equal(state.phase, PHASES.PRIKUP);
  assert.equal(getStatePlayer(state, 'alice').passed, true);
  assert.deepEqual(state.activeBidderIds, ['boris']);
  assert.equal(state.contract, 80);
  assert.equal(state.declarerId, 'boris');
  assert.equal(getStatePlayer(state, 'boris').hand.length, 7);

  const automaticPassEvent = passEvents.find((payload) => payload.automatic === true);

  assert.deepEqual(automaticPassEvent, { playerId: 'alice', automatic: true });

  const automaticPass = state.log.find(
    (entry) => entry.type === 'pass'
      && entry.playerId === 'alice'
      && entry.dealNumber === state.dealNumber,
  );

  assert.ok(automaticPass);
  assert.equal(automaticPass.automatic, true);
});

test('all players in the minus open 80 and finish bidding without a deadlock', () => {
  const game = createAllNegativeBiddingGame();
  const state = game.getState();

  assert.equal(state.phase, PHASES.BIDDING);
  assert.ok(state.players.every((player) => player.score < 0));

  const openerId = state.currentBidderId;
  const biddingOrder = [...state.activeBidderIds];

  assert.equal(openerId, state.firstBidderId);

  expectError(() => game.bid(openerId, 'pass'), 'NEGATIVE_SCORE_CANNOT_BID');
  expectError(() => game.bid(openerId, 85), 'NEGATIVE_SCORE_CANNOT_BID');
  expectError(() => game.bid(openerId, 100), 'NEGATIVE_SCORE_CANNOT_BID');

  const passEvents = [];

  game.on(GAME_EVENTS.PASS, (payload) => passEvents.push(payload));

  let finished = game.bid(openerId, 80);

  assert.equal(finished.phase, PHASES.PRIKUP);
  assert.equal(finished.contract, 80);
  assert.equal(finished.declarerId, openerId);
  assert.deepEqual(finished.activeBidderIds, [openerId]);
  assert.equal(getStatePlayer(finished, openerId).hand.length, 7);
  assert.equal(finished.prikupRevealed, true);

  for (const player of finished.players) {
    if (player.id === openerId) {
      assert.equal(player.passed, false);
    } else {
      assert.equal(player.passed, true);
    }
  }

  assert.equal(passEvents.length, 2);
  assert.ok(passEvents.every((payload) => payload.automatic === true));
  assert.deepEqual(
    passEvents.map((payload) => payload.playerId),
    biddingOrder.slice(1),
  );

  const automaticPasses = finished.log.filter(
    (entry) => entry.type === 'pass'
      && entry.automatic === true
      && entry.dealNumber === finished.dealNumber,
  );

  assert.equal(automaticPasses.length, 2);
  assert.ok(automaticPasses.every((entry) => entry.playerId !== openerId));

  finished = game.takePrikup(openerId);

  assert.equal(finished.phase, PHASES.GIVING);
  assert.equal(finished.prikupTaken, true);
  assert.equal(getStatePlayer(finished, openerId).hand.length, 10);
});
