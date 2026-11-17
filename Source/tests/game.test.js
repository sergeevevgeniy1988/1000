import test from 'node:test';
import assert from 'node:assert/strict';

import { BIDDING, GAME_EVENTS, PHASES } from '../js/core/constants.js';
import { createDeck } from '../js/core/deck.js';
import { GameError } from '../js/core/errors.js';
import { Game } from '../js/core/game.js';
import { mulberry32 } from '../js/core/rng.js';
import {
  createFixedGame,
  getStatePlayer,
  playFirstLegal,
  PLAYERS,
} from './helpers.js';

const MARRIAGE_HANDS = {
  alice: ['HK', 'HQ', 'DK', 'DQ', 'SA', 'HA', 'DA'],
  boris: ['SJ', 'SQ', 'SK', 'S10', 'D9', 'D10', 'HJ'],
  human: ['C9', 'CQ', 'CK', 'CA', 'DJ', 'H9', 'H10'],
};
const MARRIAGE_PRIKUP = ['CJ', 'S9', 'C10'];

const DOMINATING_HANDS = {
  alice: ['SA', 'HA', 'DA', 'CA', 'S10', 'H10', 'D10'],
  boris: ['SJ', 'SQ', 'SK', 'D9', 'DJ', 'H9', 'HJ'],
  human: ['CJ', 'CQ', 'CK', 'DQ', 'DK', 'HQ', 'HK'],
};
const DOMINATING_PRIKUP = ['C10', 'S9', 'C9'];

const TIE_HANDS = {
  alice: ['SA', 'HA', 'DA', 'CA', 'SQ', 'HQ', 'DQ'],
  boris: ['HK', 'DK', 'CK', 'S10', 'D10', 'HJ', 'CJ'],
  human: ['H9', 'D9', 'C9', 'SJ', 'DJ', 'H10', 'C10'],
};
const TIE_PRIKUP = ['CQ', 'SK', 'S9'];

function expectError(action, code) {
  assert.throws(
    action,
    (error) => error instanceof GameError && error.code === code,
    `Expected GameError with code ${code}.`,
  );
}

function bidForAlice(game) {
  game.bid('alice', BIDDING.MIN);
  game.bid('boris', 'pass');
  return game.bid('human', 'pass');
}

function startGivingForAlice(game) {
  bidForAlice(game);
  return game.takePrikup('alice');
}

function playDeal(game) {
  while (game.getState().phase === PHASES.PLAYING) {
    playFirstLegal(game);
  }
}

function resultFor(dealResult, playerId) {
  return dealResult.players.find((entry) => entry.id === playerId);
}

function scoreSum(state) {
  return state.players.reduce((sum, player) => sum + player.trickPoints, 0);
}

function createSeededGame(seed, targetScore = 1000) {
  const game = new Game({
    players: PLAYERS.map((player) => ({ ...player })),
    rng: mulberry32(seed),
    targetScore,
  });

  game.start();
  return game;
}

test('constructor validates players, target score, RNG and fixed deck', () => {
  const goodPlayers = PLAYERS.map((player) => ({ ...player }));

  expectError(
    () => new Game({ players: goodPlayers.slice(0, 2) }),
    'INVALID_ARGUMENT',
  );
  expectError(
    () => new Game({
      players: [goodPlayers[0], goodPlayers[1], { ...goodPlayers[2], id: goodPlayers[0].id }],
    }),
    'INVALID_ARGUMENT',
  );
  expectError(
    () => new Game({ players: goodPlayers.map((player) => ({ ...player, name: '' })) }),
    'INVALID_ARGUMENT',
  );
  expectError(
    () => new Game({ players: goodPlayers, rng: 42 }),
    'INVALID_ARGUMENT',
  );
  expectError(
    () => new Game({ players: goodPlayers, targetScore: 0 }),
    'INVALID_ARGUMENT',
  );
  expectError(
    () => new Game({ players: goodPlayers, deck: createDeck().slice(0, 23) }),
    'INVALID_DECK',
  );

  const duplicateDeck = [...createDeck().slice(0, 23), createDeck()[0]];
  expectError(
    () => new Game({ players: goodPlayers, deck: duplicateDeck }),
    'INVALID_DECK',
  );

  const unknownDeck = [...createDeck().slice(0, 23), 'X9'];
  expectError(
    () => new Game({ players: goodPlayers, deck: unknownDeck }),
    'INVALID_DECK',
  );
});

test('state snapshots are frozen copies and player views hide private data', () => {
  const game = createFixedGame({
    hands: MARRIAGE_HANDS,
    prikup: MARRIAGE_PRIKUP,
    dealerIndex: 0,
  });
  const state = game.getState();

  assert.equal(state.viewerId, null);
  assert.equal(Object.isFrozen(state), true);
  assert.equal(Object.isFrozen(state.players), true);
  assert.equal(Object.isFrozen(state.players[0]), true);
  assert.equal(Object.isFrozen(state.players[0].hand), true);
  assert.equal(getStatePlayer(state, 'human').isAI, false);
  assert.equal(getStatePlayer(state, 'alice').isAI, true);
  assert.equal(getStatePlayer(state, 'boris').isAI, true);
  assert.throws(() => {
    state.players[0].hand.push('X9');
  }, TypeError);
  assert.throws(() => {
    state.players[0].score = 999;
  }, TypeError);

  const secondSnapshot = game.getState();
  assert.notStrictEqual(state, secondSnapshot);
  assert.deepEqual(state, secondSnapshot);

  assert.deepEqual(state.availableMarriages, [
    { suit: 'D', value: 80 },
    { suit: 'H', value: 100 },
  ]);

  const humanView = game.getPlayerView('human');

  assert.equal(humanView.phase, PHASES.BIDDING);
  assert.equal(humanView.viewerId, 'human');
  assert.equal(getStatePlayer(humanView, 'human').isAI, false);
  assert.equal(getStatePlayer(humanView, 'alice').isAI, true);
  assert.equal(getStatePlayer(humanView, 'boris').isAI, true);
  assert.equal(humanView.prikup.length, 0);
  assert.equal(humanView.prikupRevealed, false);
  assert.equal(humanView.prikupTaken, false);
  assert.deepEqual(getStatePlayer(humanView, 'human').hand, getStatePlayer(state, 'human').hand);
  assert.deepEqual(getStatePlayer(humanView, 'alice').hand, []);
  assert.deepEqual(getStatePlayer(humanView, 'boris').hand, []);
  assert.equal(getStatePlayer(humanView, 'alice').cardCount, 7);
  assert.deepEqual(humanView.availableMarriages, [{ suit: 'C', value: 60 }]);
  assert.equal(Object.hasOwn(humanView, 'deck'), false);
  assert.equal(Object.isFrozen(humanView), true);

  expectError(() => game.getPlayerView('nobody'), 'UNKNOWN_PLAYER');
});

test('the declarer takes the prikup and must give exactly one card to each opponent', () => {
  const game = createFixedGame({
    hands: MARRIAGE_HANDS,
    prikup: MARRIAGE_PRIKUP,
    dealerIndex: 0,
  });
  const revealed = bidForAlice(game);

  assert.equal(revealed.phase, PHASES.PRIKUP);
  assert.equal(revealed.declarerId, 'alice');
  assert.equal(revealed.currentPlayerId, 'alice');
  assert.equal(revealed.prikupRevealed, true);
  assert.equal(revealed.prikupTaken, false);
  assert.equal(revealed.raiseDecided, false);
  assert.equal(revealed.prikup.length, 3);
  assert.equal(getStatePlayer(revealed, 'alice').hand.length, 7);
  assert.equal(getStatePlayer(revealed, 'alice').isDeclarer, true);
  assert.equal(getStatePlayer(revealed, 'human').hand.length, 7);

  for (const player of PLAYERS) {
    const view = game.getPlayerView(player.id);

    assert.deepEqual(view.prikup, revealed.prikup);
    assert.equal(view.prikupRevealed, true);
    assert.equal(view.prikupTaken, false);
  }

  expectError(() => game.takePrikup('human'), 'NOT_DECLARER');
  expectError(() => game.giveCard('boris', 'S9'), 'INVALID_PHASE');
  expectError(() => game.playCard('alice', 'SA'), 'INVALID_PHASE');

  const state = game.takePrikup('alice');

  assert.equal(state.phase, PHASES.GIVING);
  assert.equal(state.currentPlayerId, 'alice');
  assert.equal(state.prikupRevealed, true);
  assert.equal(state.prikupTaken, true);
  assert.equal(state.raiseDecided, false);
  assert.equal(state.prikup.length, 3);
  assert.equal(getStatePlayer(state, 'alice').hand.length, 10);
  assert.equal(getStatePlayer(state, 'human').hand.length, 7);

  const humanView = game.getPlayerView('human');
  const aliceView = game.getPlayerView('alice');

  assert.deepEqual(humanView.prikup, state.prikup);
  assert.deepEqual(aliceView.prikup, state.prikup);
  assert.deepEqual(getStatePlayer(humanView, 'alice').hand, []);
  assert.equal(getStatePlayer(humanView, 'alice').cardCount, 10);
  assert.equal(getStatePlayer(aliceView, 'alice').hand.length, 10);
  assert.deepEqual(getStatePlayer(aliceView, 'human').hand, []);

  const revealLog = state.log.find((entry) => entry.type === 'prikuprevealed');
  assert.ok(revealLog);
  assert.equal(revealLog.cards.length, 3);

  const prikupLog = state.log.find((entry) => entry.type === 'prikup');
  assert.ok(prikupLog);
  assert.equal(prikupLog.count, 3);
  assert.equal(Object.hasOwn(prikupLog, 'cards'), false);

  expectError(() => game.takePrikup('alice'), 'PRIKUP_ALREADY_TAKEN');
  expectError(() => game.giveCard('alice', 'S9'), 'INVALID_TARGET');
  expectError(() => game.giveCard('nobody', 'S9'), 'UNKNOWN_PLAYER');
  expectError(() => game.giveCard('boris', 'SJ'), 'CARD_NOT_IN_HAND');

  let nextState = game.giveCard('boris', 'S9');

  assert.equal(nextState.phase, PHASES.GIVING);
  assert.equal(nextState.raiseDecided, true);
  assert.equal(getStatePlayer(nextState, 'alice').hand.length, 9);
  assert.equal(getStatePlayer(nextState, 'boris').hand.length, 8);
  assert.deepEqual(nextState.givenCards, [
    { fromId: 'alice', toId: 'boris', cardId: 'S9' },
  ]);
  assert.deepEqual(getStatePlayer(game.getPlayerView('boris'), 'boris').hand.includes('S9'), true);

  const giftLog = nextState.log.find((entry) => entry.type === 'gift');

  assert.deepEqual(giftLog, {
    fromId: 'alice',
    toId: 'boris',
    type: 'gift',
    dealNumber: 1,
  });
  assert.equal(Object.hasOwn(giftLog, 'cardId'), false, 'the public log must hide the gifted card');
  assert.deepEqual(game.getPlayerView('alice').givenCards, [
    { fromId: 'alice', toId: 'boris', cardId: 'S9' },
  ]);
  assert.deepEqual(game.getPlayerView('boris').givenCards, [
    { fromId: 'alice', toId: 'boris', cardId: 'S9' },
  ]);
  assert.deepEqual(game.getPlayerView('human').givenCards, [
    { fromId: 'alice', toId: 'boris', cardId: null },
  ]);

  for (const view of [
    nextState,
    game.getPlayerView('alice'),
    game.getPlayerView('boris'),
    game.getPlayerView('human'),
  ]) {
    for (const entry of view.log.filter((item) => item.type === 'gift')) {
      assert.equal(Object.hasOwn(entry, 'cardId'), false);
    }
  }

  expectError(() => game.giveCard('boris', 'CJ'), 'TARGET_ALREADY_RECEIVED');
  expectError(() => game.giveCard('human', 'S9'), 'CARD_NOT_IN_HAND');

  nextState = game.giveCard('human', 'CJ');

  assert.equal(nextState.phase, PHASES.PLAYING);
  assert.equal(nextState.currentPlayerId, 'alice');
  assert.equal(nextState.trickLeaderId, 'alice');
  assert.deepEqual(nextState.currentTrick, []);
  assert.equal(getStatePlayer(nextState, 'alice').hand.length, 8);
  assert.equal(getStatePlayer(nextState, 'boris').hand.length, 8);
  assert.equal(getStatePlayer(nextState, 'human').hand.length, 8);

  const allIds = nextState.players.flatMap((player) => player.hand);
  assert.equal(allIds.length, 24);
  assert.equal(new Set(allIds).size, 24);
  assert.deepEqual(getStatePlayer(game.getPlayerView('human'), 'alice').hand, []);

  assert.deepEqual(game.getPlayerView('boris').givenCards, [
    { fromId: 'alice', toId: 'boris', cardId: 'S9' },
    { fromId: 'alice', toId: 'human', cardId: null },
  ]);
  assert.deepEqual(game.getPlayerView('human').givenCards, [
    { fromId: 'alice', toId: 'boris', cardId: null },
    { fromId: 'alice', toId: 'human', cardId: 'CJ' },
  ]);

  expectError(() => game.giveCard('human', 'C10'), 'INVALID_PHASE');
});

test('marriages switch trump, add bonuses and the deal is scored through nextDeal', () => {
  const game = createFixedGame({
    hands: MARRIAGE_HANDS,
    prikup: MARRIAGE_PRIKUP,
    dealerIndex: 0,
  });
  const events = { gifts: 0, marriages: 0, declared: 0 };

  game.on(GAME_EVENTS.GIFT, () => {
    events.gifts += 1;
  });
  game.on(GAME_EVENTS.MARRIAGE, () => {
    events.marriages += 1;
  });
  game.on(GAME_EVENTS.MARRIAGE_DECLARED, () => {
    events.declared += 1;
  });

  startGivingForAlice(game);
  game.giveCard('boris', 'S9');
  game.giveCard('human', 'CJ');

  let state = game.getState();
  assert.equal(state.phase, PHASES.PLAYING);
  assert.equal(state.trumpSuit, null);
  assert.equal(state.completedTricks.length, 0);

  expectError(() => game.declareMarriage('alice', 'H'), 'MARRIAGE_NOT_ALLOWED');

  game.playCard('alice', 'SA');
  state = game.getState();
  assert.equal(state.currentPlayerId, 'boris');
  assert.equal(state.currentTrick.length, 1);
  expectError(() => game.declareMarriage('boris', 'S'), 'MARRIAGE_NOT_ALLOWED');
  expectError(() => game.playCard('boris', 'D9'), 'ILLEGAL_CARD');

  game.playCard('boris', 'SJ');
  game.playCard('human', 'C9');

  state = game.getState();
  assert.equal(state.completedTricks.length, 1);
  assert.equal(state.completedTricks[0].winnerId, 'alice');
  assert.equal(state.completedTricks[0].points, 13);
  assert.equal(state.currentPlayerId, 'alice');
  assert.equal(state.trickLeaderId, 'alice');
  assert.equal(state.trumpSuit, null);
  expectError(() => game.declareMarriage('human', 'H'), 'NOT_YOUR_TURN');

  state = game.declareMarriage('alice', 'H');
  assert.equal(state.trumpSuit, null);
  assert.equal(state.trumpDeclaredBy, null);
  assert.equal(getStatePlayer(state, 'alice').marriagePoints, 0);
  assert.deepEqual(getStatePlayer(state, 'alice').declaredMarriages, []);
  assert.deepEqual(state.pendingMarriage, { playerId: 'alice', suit: 'H', value: 100 });
  assert.deepEqual(
    game.getPlayerView('human').pendingMarriage,
    state.pendingMarriage,
  );
  assert.deepEqual(
    game.getPlayerView('boris').pendingMarriage,
    state.pendingMarriage,
  );
  assert.deepEqual(state.availableMarriages, [
    { suit: 'D', value: 80 },
    { suit: 'H', value: 100 },
  ]);
  assert.equal(state.log.filter((entry) => entry.type === 'marriage').length, 0);

  expectError(() => game.declareMarriage('alice', 'D'), 'MARRIAGE_PENDING');
  expectError(() => game.playCard('alice', 'DA'), 'MARRIAGE_CARD_REQUIRED');

  const afterRejectedCard = game.getState();

  assert.equal(afterRejectedCard.trumpSuit, null);
  assert.equal(getStatePlayer(afterRejectedCard, 'alice').marriagePoints, 0);
  assert.deepEqual(getStatePlayer(afterRejectedCard, 'alice').declaredMarriages, []);
  assert.deepEqual(afterRejectedCard.pendingMarriage, state.pendingMarriage);
  assert.equal(
    afterRejectedCard.log.filter((entry) => entry.type === 'marriage').length,
    0,
  );
  expectError(() => game.cancelMarriage('boris'), 'NOT_MARRIAGE_OWNER');

  state = game.cancelMarriage('alice');
  assert.equal(state.pendingMarriage, null);
  assert.equal(game.getPlayerView('human').pendingMarriage, null);
  assert.equal(state.trumpSuit, null);
  assert.equal(getStatePlayer(state, 'alice').marriagePoints, 0);
  assert.deepEqual(getStatePlayer(state, 'alice').declaredMarriages, []);
  expectError(() => game.cancelMarriage('alice'), 'NO_PENDING_MARRIAGE');

  state = game.declareMarriage('alice', 'H');
  assert.equal(state.pendingMarriage.suit, 'H');

  state = game.playCard('alice', 'HK');
  assert.equal(state.pendingMarriage, null);
  assert.equal(state.trumpSuit, 'H');
  assert.equal(state.trumpDeclaredBy, 'alice');
  assert.equal(getStatePlayer(state, 'alice').marriagePoints, 100);
  assert.deepEqual(getStatePlayer(state, 'alice').declaredMarriages, ['H']);
  assert.deepEqual(
    game.getPlayerView('alice').availableMarriages,
    [{ suit: 'D', value: 80 }],
  );

  game.playCard('boris', 'HJ');
  game.playCard('human', 'H9');

  state = game.getState();
  assert.equal(state.completedTricks.length, 2);
  assert.equal(state.completedTricks[1].winnerId, 'alice');
  assert.equal(state.completedTricks[1].points, 6);
  assert.equal(state.currentPlayerId, 'alice');

  expectError(() => game.declareMarriage('alice', 'H'), 'MARRIAGE_ALREADY_DECLARED');

  state = game.declareMarriage('alice', 'D');
  assert.equal(state.pendingMarriage.suit, 'D');
  assert.equal(state.trumpSuit, 'H');
  assert.equal(getStatePlayer(state, 'alice').marriagePoints, 100);
  assert.deepEqual(getStatePlayer(state, 'alice').declaredMarriages, ['H']);

  state = game.playCard('alice', 'DK');
  assert.equal(state.pendingMarriage, null);
  assert.equal(state.trumpSuit, 'D');
  assert.equal(state.trumpDeclaredBy, 'alice');
  assert.equal(getStatePlayer(state, 'alice').marriagePoints, 180);
  assert.deepEqual(getStatePlayer(state, 'alice').declaredMarriages, ['H', 'D']);

  game.playCard('boris', 'D9');
  game.playCard('human', 'DJ');

  state = game.getState();
  assert.equal(state.completedTricks.length, 3);
  assert.equal(state.completedTricks[2].winnerId, 'alice');
  assert.equal(state.completedTricks[2].points, 6);

  playDeal(game);
  state = game.getState();

  assert.equal(state.phase, PHASES.DEAL_END);
  assert.equal(state.completedTricks.length, 8);
  assert.equal(state.players.reduce((sum, player) => sum + player.tricksWon, 0), 8);
  assert.equal(scoreSum(state), 120);
  assert.equal(getStatePlayer(state, 'alice').marriagePoints, 180);
  assert.equal(state.lastDealResult.dealNumber, 1);
  assert.equal(state.lastDealResult.declarerId, 'alice');
  assert.equal(state.lastDealResult.contract, BIDDING.MIN);
  assert.equal(state.lastDealResult.contractMet, true);
  assert.equal(resultFor(state.lastDealResult, 'alice').delta, BIDDING.MIN);
  assert.equal(getStatePlayer(state, 'alice').score, BIDDING.MIN);

  for (const player of state.players) {
    const result = resultFor(state.lastDealResult, player.id);
    assert.equal(result.trickPoints, player.trickPoints);
    assert.equal(result.marriagePoints, player.marriagePoints);
    assert.equal(result.scoreAfter, player.score);
    assert.equal(result.boltsAfter, player.bolts);
    assert.equal(result.scoreAfter, result.scoreBefore + result.delta);
  }

  assert.equal(state.log.filter((entry) => entry.type === 'marriage').length, 2);
  assert.equal(state.log.filter((entry) => entry.type === 'trickwon').length, 8);
  assert.equal(state.log.filter((entry) => entry.type === 'scored').length, 1);
  assert.equal(events.gifts, 2);
  assert.equal(events.marriages, 2);
  assert.equal(events.declared, 3);

  const scoresBeforeNextDeal = state.players.map((player) => ({
    id: player.id,
    score: player.score,
    bolts: player.bolts,
  }));

  state = game.nextDeal();
  assert.equal(state.phase, PHASES.BIDDING);
  assert.equal(state.dealNumber, 2);
  assert.equal(state.dealerIndex, 1);
  assert.equal(state.dealerId, 'alice');
  assert.equal(state.firstBidderId, 'boris');
  assert.equal(state.currentBidderId, 'boris');
  assert.equal(state.lastDealResult, null);
  assert.equal(state.prikupRevealed, false);
  assert.equal(state.prikupTaken, false);
  assert.equal(state.raiseDecided, false);
  assert.equal(state.pendingMarriage, null);
  assert.equal(state.trumpSuit, null);
  assert.equal(state.completedTricks.length, 0);

  for (const player of state.players) {
    const previous = scoresBeforeNextDeal.find((entry) => entry.id === player.id);
    assert.equal(player.score, previous.score);
    assert.equal(player.bolts, previous.bolts);
    assert.equal(player.hand.length, 7);
    assert.deepEqual(player.declaredMarriages, []);
  }

  assert.equal(state.prikup.length, 3);
  expectError(() => game.nextDeal(), 'INVALID_PHASE');
});

test('a gifted marriage card disappears from the declarer options', () => {
  const game = createFixedGame({
    hands: MARRIAGE_HANDS,
    prikup: MARRIAGE_PRIKUP,
    dealerIndex: 0,
  });
  startGivingForAlice(game);
  game.giveCard('boris', 'HQ');
  game.giveCard('human', 'CJ');

  let state = game.getState();
  assert.equal(state.phase, PHASES.PLAYING);
  assert.equal(getStatePlayer(state, 'boris').hand.includes('HQ'), true);
  assert.deepEqual(state.givenCards[0], {
    fromId: 'alice',
    toId: 'boris',
    cardId: 'HQ',
  });

  game.playCard('alice', 'SA');
  game.playCard('boris', 'SJ');
  game.playCard('human', 'C9');

  state = game.getState();
  assert.equal(state.completedTricks.length, 1);
  assert.equal(state.completedTricks[0].winnerId, 'alice');
  expectError(() => game.declareMarriage('alice', 'H'), 'MARRIAGE_UNAVAILABLE');

  state = game.declareMarriage('alice', 'D');
  assert.equal(state.pendingMarriage.suit, 'D');
  assert.equal(state.trumpSuit, null);
  assert.equal(getStatePlayer(state, 'alice').marriagePoints, 0);

  state = game.playCard('alice', 'DK');
  assert.equal(state.pendingMarriage, null);
  assert.equal(state.trumpSuit, 'D');
  assert.equal(getStatePlayer(state, 'alice').marriagePoints, 80);
  assert.deepEqual(getStatePlayer(state, 'alice').declaredMarriages, ['D']);
});

test('a player who takes no tricks receives a bolt and the engine keeps scores', () => {
  const game = createFixedGame({
    hands: DOMINATING_HANDS,
    prikup: DOMINATING_PRIKUP,
    dealerIndex: 0,
  });
  startGivingForAlice(game);
  game.giveCard('boris', 'S9');
  game.giveCard('human', 'C9');
  playDeal(game);

  const state = game.getState();

  assert.equal(state.phase, PHASES.DEAL_END);
  assert.equal(getStatePlayer(state, 'alice').tricksWon, 8);
  assert.equal(getStatePlayer(state, 'alice').trickPoints, 120);
  assert.equal(getStatePlayer(state, 'boris').tricksWon, 0);
  assert.equal(getStatePlayer(state, 'human').tricksWon, 0);
  assert.equal(getStatePlayer(state, 'alice').score, BIDDING.MIN);
  assert.equal(getStatePlayer(state, 'boris').score, 0);
  assert.equal(getStatePlayer(state, 'human').score, 0);
  assert.equal(getStatePlayer(state, 'boris').bolts, 1);
  assert.equal(getStatePlayer(state, 'human').bolts, 1);
  assert.deepEqual(state.lastDealResult.boltsAwarded, ['human', 'boris']);
  assert.deepEqual(state.lastDealResult.boltsReset, []);
  assert.equal(state.lastDealResult.gameResult.isOver, false);
  assert.equal(scoreSum(state), 120);
});

test('a tie at the target keeps the game going for another deal', () => {
  const game = createFixedGame({
    hands: TIE_HANDS,
    prikup: TIE_PRIKUP,
    dealerIndex: 0,
    targetScore: 30,
  });
  startGivingForAlice(game);
  game.giveCard('boris', 'SK');
  game.giveCard('human', 'S9');

  const plays = [
    ['alice', 'SA'], ['boris', 'SK'], ['human', 'S9'],
    ['alice', 'HA'], ['boris', 'HK'], ['human', 'H9'],
    ['alice', 'DA'], ['boris', 'DK'], ['human', 'D9'],
    ['alice', 'CA'], ['boris', 'CK'], ['human', 'C9'],
    ['alice', 'SQ'], ['boris', 'S10'], ['human', 'SJ'],
    ['boris', 'HJ'], ['human', 'H10'], ['alice', 'HQ'],
    ['human', 'C10'], ['alice', 'CQ'], ['boris', 'CJ'],
    ['human', 'DJ'], ['alice', 'DQ'], ['boris', 'D10'],
  ];

  for (const [playerId, cardId] of plays) {
    game.playCard(playerId, cardId);
  }

  const state = game.getState();

  assert.equal(state.phase, PHASES.DEAL_END);
  assert.equal(getStatePlayer(state, 'alice').trickPoints, 60);
  assert.equal(getStatePlayer(state, 'boris').trickPoints, 30);
  assert.equal(getStatePlayer(state, 'human').trickPoints, 30);
  assert.equal(getStatePlayer(state, 'alice').tricksWon, 4);
  assert.equal(getStatePlayer(state, 'boris').tricksWon, 2);
  assert.equal(getStatePlayer(state, 'human').tricksWon, 2);
  assert.equal(getStatePlayer(state, 'alice').score, -BIDDING.MIN);
  assert.equal(getStatePlayer(state, 'boris').score, 30);
  assert.equal(getStatePlayer(state, 'human').score, 30);
  assert.equal(state.lastDealResult.contractMet, false);
  assert.equal(state.lastDealResult.gameResult.isOver, false);
  assert.equal(state.lastDealResult.gameResult.isTie, true);
  assert.equal(state.lastDealResult.gameResult.targetReached, true);
  assert.equal(state.lastDealResult.gameResult.topScore, 30);
  assert.deepEqual(state.lastDealResult.gameResult.leaderIds, ['human', 'boris']);
  assert.equal(state.winnerId, null);

  const nextState = game.nextDeal();
  assert.equal(nextState.phase, PHASES.BIDDING);
  assert.equal(nextState.dealNumber, 2);
  assert.equal(nextState.dealerIndex, 1);
  assert.equal(getStatePlayer(nextState, 'alice').score, -BIDDING.MIN);
  assert.equal(getStatePlayer(nextState, 'boris').score, 30);
  assert.equal(getStatePlayer(nextState, 'human').score, 30);
});

test('reaching the target with an outright lead finishes the game', () => {
  const game = createFixedGame({
    hands: DOMINATING_HANDS,
    prikup: DOMINATING_PRIKUP,
    dealerIndex: 0,
    targetScore: BIDDING.MIN,
  });
  const events = {
    cardPlayed: 0,
    tricksWon: 0,
    scored: 0,
    gameOver: 0,
  };

  game.on(GAME_EVENTS.CARD_PLAYED, () => {
    events.cardPlayed += 1;
  });
  game.on(GAME_EVENTS.TRICK_WON, () => {
    events.tricksWon += 1;
  });
  game.on(GAME_EVENTS.SCORED, () => {
    events.scored += 1;
  });
  game.on(GAME_EVENTS.GAME_OVER, () => {
    events.gameOver += 1;
  });

  startGivingForAlice(game);
  game.giveCard('boris', 'S9');
  game.giveCard('human', 'C9');
  playDeal(game);

  const state = game.getState();

  assert.equal(state.phase, PHASES.GAME_OVER);
  assert.equal(state.winnerId, 'alice');
  assert.equal(state.lastDealResult.gameResult.isOver, true);
  assert.equal(state.lastDealResult.gameResult.topScore, BIDDING.MIN);
  assert.equal(state.lastDealResult.gameResult.targetScore, BIDDING.MIN);
  assert.deepEqual(state.lastDealResult.gameResult.leaderIds, ['alice']);

  assert.equal(events.cardPlayed, 24);
  assert.equal(events.tricksWon, 8);
  assert.equal(events.scored, 1);
  assert.equal(events.gameOver, 1);
  assert.equal(state.log.filter((entry) => entry.type === 'gameover').length, 1);

  expectError(() => game.nextDeal(), 'INVALID_PHASE');
  expectError(() => game.bid('alice', BIDDING.MIN), 'INVALID_PHASE');
  expectError(() => game.declareMarriage('alice', 'H'), 'INVALID_PHASE');
});

test('seeded games with the same script produce identical full deals', () => {
  function playScriptedDeal(game) {
    let state = game.getState();
    const [opener, second, third] = state.activeBidderIds;

    game.bid(opener, BIDDING.MIN);
    game.bid(second, 'pass');
    game.bid(third, 'pass');

    state = game.getState();
    const declarerId = state.declarerId;
    const opponents = state.players
      .map((player) => player.id)
      .filter((playerId) => playerId !== declarerId);

    game.takePrikup(declarerId);
    state = game.getState();

    let declarerHand = getStatePlayer(state, declarerId).hand;
    game.giveCard(opponents[0], declarerHand[0]);

    state = game.getState();
    declarerHand = getStatePlayer(state, declarerId).hand;
    game.giveCard(opponents[1], declarerHand[0]);

    playDeal(game);
  }

  const gameA = createSeededGame(20261103);
  const gameB = createSeededGame(20261103);

  assert.equal(
    JSON.stringify(gameA.getState()),
    JSON.stringify(gameB.getState()),
    'Initial states must match for the same seed.',
  );

  playScriptedDeal(gameA);
  playScriptedDeal(gameB);

  const stateA = gameA.getState();
  const stateB = gameB.getState();

  assert.equal(
    JSON.stringify(stateA),
    JSON.stringify(stateB),
    'Full deal results must match for the same seed and script.',
  );
  assert.equal(stateA.phase, PHASES.DEAL_END);
  assert.equal(stateA.completedTricks.length, 8);
  assert.equal(scoreSum(stateA), 120);

  const dealtCards = stateA.completedTricks.flatMap((trick) =>
    trick.cards.map((entry) => entry.cardId));
  assert.equal(dealtCards.length, 24);
  assert.equal(new Set(dealtCards).size, 24);
});
