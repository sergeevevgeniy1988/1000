import test from 'node:test';
import assert from 'node:assert/strict';

import { BIDDING, GAME_EVENTS, PHASES } from '../js/core/constants.js';
import { GameError } from '../js/core/errors.js';
import { scoreDeal } from '../js/core/scoring.js';
import { createAI } from '../js/ai/ai.js';
import { getRaiseOptions, isLegalRaiseAmount } from '../js/ui/raise.js';
import {
  createAllNegativeBiddingGame,
  createFixedGame,
  getStatePlayer,
  playFirstLegal,
} from './helpers.js';

const HANDS = {
  alice: ['HK', 'HQ', 'DK', 'DQ', 'SA', 'HA', 'DA'],
  boris: ['SJ', 'SQ', 'SK', 'S10', 'D9', 'D10', 'HJ'],
  human: ['C9', 'CQ', 'CK', 'CA', 'DJ', 'H9', 'H10'],
};
const PRIKUP = ['CJ', 'S9', 'C10'];

const DOMINATING_HANDS = {
  alice: ['SA', 'HA', 'DA', 'CA', 'S10', 'H10', 'D10'],
  boris: ['SJ', 'SQ', 'SK', 'D9', 'DJ', 'H9', 'HJ'],
  human: ['CJ', 'CQ', 'CK', 'DQ', 'DK', 'HQ', 'HK'],
};
const DOMINATING_PRIKUP = ['C10', 'S9', 'C9'];

const STRONG_TEN = ['SA', 'HA', 'DA', 'CA', 'S10', 'H10', 'D10', 'C10', 'S9', 'C9'];
const WEAK_TEN = ['S9', 'SJ', 'SQ', 'SK', 'H9', 'HJ', 'HQ', 'D9', 'DJ', 'D10'];

function expectError(action, code) {
  assert.throws(
    action,
    (error) => error instanceof GameError && error.code === code,
    `Expected GameError with code ${code}.`,
  );
}

function startGivingForAlice({
  hands = HANDS,
  prikup = PRIKUP,
} = {}) {
  const game = createFixedGame({ hands, prikup, dealerIndex: 0 });

  game.bid('alice', BIDDING.MIN);
  game.bid('boris', 'pass');
  game.bid('human', 'pass');
  game.takePrikup('alice');

  return game;
}

function startGivingForBorisWithContract85() {
  const game = createFixedGame({ hands: HANDS, prikup: PRIKUP, dealerIndex: 0 });

  game.bid('alice', BIDDING.MIN);
  game.bid('boris', 85);
  game.bid('human', 'pass');
  game.bid('alice', 'pass');
  game.takePrikup('boris');

  return game;
}

function createGivingView({
  hand = STRONG_TEN,
  score = 0,
  contract = BIDDING.MIN,
  raiseDecided = false,
  givenCards = [],
} = {}) {
  return {
    phase: PHASES.GIVING,
    contract,
    declarerId: 'alice',
    raiseDecided,
    givenCards,
    currentTrick: [],
    completedTricks: [],
    log: [],
    players: [
      {
        id: 'alice',
        name: 'Алиса',
        isHuman: false,
        score,
        hand,
        cardCount: hand.length,
        bid: contract,
        passed: false,
        tricksWon: 0,
        trickPoints: 0,
        marriagePoints: 0,
        declaredMarriages: [],
        isDeclarer: true,
      },
      {
        id: 'boris',
        name: 'Борис',
        isHuman: false,
        score: 0,
        hand: [],
        cardCount: 7,
        bid: null,
        passed: true,
        tricksWon: 0,
        trickPoints: 0,
        marriagePoints: 0,
        declaredMarriages: [],
        isDeclarer: false,
      },
      {
        id: 'human',
        name: 'Вы',
        isHuman: true,
        score: 0,
        hand: [],
        cardCount: 7,
        bid: null,
        passed: true,
        tricksWon: 0,
        trickPoints: 0,
        marriagePoints: 0,
        declaredMarriages: [],
        isDeclarer: false,
      },
    ],
  };
}

function resultFor(dealResult, playerId) {
  return dealResult.players.find((entry) => entry.id === playerId);
}

test('raise options cover every legal contract above the current one', () => {
  assert.deepEqual(getRaiseOptions(80), [85, 90, 95, 100, 105, 110, 115, 120]);
  assert.deepEqual(getRaiseOptions(85), [90, 95, 100, 105, 110, 115, 120]);
  assert.deepEqual(getRaiseOptions(82), [85, 90, 95, 100, 105, 110, 115, 120]);
  assert.deepEqual(getRaiseOptions(115), [120]);
  assert.deepEqual(getRaiseOptions(120), []);
  assert.deepEqual(getRaiseOptions(Number.NaN), []);
});

test('isLegalRaiseAmount accepts only steps above the contract up to the hand maximum', () => {
  const bounds = { contract: 120, max: 300 };

  assert.equal(isLegalRaiseAmount(125, bounds), true);
  assert.equal(isLegalRaiseAmount(300, bounds), true);
  assert.equal(isLegalRaiseAmount(305, bounds), false);
  assert.equal(isLegalRaiseAmount(120, bounds), false);
  assert.equal(isLegalRaiseAmount(80, bounds), false);
  assert.equal(isLegalRaiseAmount(82, bounds), false);
  assert.equal(isLegalRaiseAmount(130, { contract: 120, max: 120 }), false);
  assert.equal(isLegalRaiseAmount(125.5, bounds), false);
  assert.equal(isLegalRaiseAmount('125', bounds), false);
  assert.equal(isLegalRaiseAmount(Number.NaN, bounds), false);
  assert.equal(isLegalRaiseAmount(null, bounds), false);
  assert.equal(isLegalRaiseAmount(125, {}), false);
});

test('the declarer raises the contract to 85, 100 or 120 exactly once', () => {
  for (const target of [85, 100, 120]) {
    const game = startGivingForAlice();
    const eventPayloads = [];

    game.on(GAME_EVENTS.CONTRACT_RAISED, (payload) => eventPayloads.push(payload));

    let state = game.getState();
    assert.equal(state.raiseDecided, false);

    state = game.raiseContract('alice', target);

    assert.equal(state.contract, target);
    assert.equal(state.currentBid, target);
    assert.equal(state.raiseDecided, true);
    assert.equal(getStatePlayer(state, 'alice').bid, target);
    assert.equal(game.getPlayerView('alice').raiseDecided, true);
    assert.equal(eventPayloads.length, 1);
    assert.deepEqual(eventPayloads[0], {
      playerId: 'alice',
      amount: target,
      contract: target,
      previousContract: BIDDING.MIN,
    });

    const raiseLog = state.log.find((entry) => entry.type === 'contractraised');

    assert.ok(raiseLog);
    assert.equal(raiseLog.previousContract, BIDDING.MIN);
    assert.equal(raiseLog.contract, target);

    expectError(() => game.raiseContract('alice', 120), 'RAISE_ALREADY_DECIDED');
    expectError(() => game.declineRaise('alice'), 'RAISE_ALREADY_DECIDED');
  }
});

test('declining the raise keeps the contract and closes the window', () => {
  const game = startGivingForAlice();
  const state = game.declineRaise('alice');

  assert.equal(state.contract, BIDDING.MIN);
  assert.equal(state.currentBid, BIDDING.MIN);
  assert.equal(state.raiseDecided, true);
  assert.equal(state.log.filter((entry) => entry.type === 'contractraised').length, 0);

  expectError(() => game.raiseContract('alice', 85), 'RAISE_ALREADY_DECIDED');
});

test('the declarer may raise above 120 up to the marriage limit', () => {
  for (const target of [125, 220, 300]) {
    const game = startGivingForAlice();
    const state = game.raiseContract('alice', target);

    assert.equal(state.contract, target);
    assert.equal(state.raiseDecided, true);
    assert.equal(getStatePlayer(state, 'alice').bid, target);
  }
});

test('the raise window rejects invalid amounts without changing the contract', () => {
  const game = startGivingForAlice();

  for (const amount of [82, 80, 75, 79, 305]) {
    expectError(() => game.raiseContract('alice', amount), 'INVALID_RAISE');
  }

  const state = game.getState();

  assert.equal(state.contract, BIDDING.MIN);
  assert.equal(state.raiseDecided, false);
});

test('a marriage completed by the prikup raises the maximum', () => {
  const hands = {
    alice: ['SK', 'HA', 'DA', 'CA', 'H9', 'D9', 'S9'],
    boris: ['SJ', 'S10', 'HK', 'HJ', 'DK', 'DJ', 'CK'],
    human: ['SA', 'C9', 'CQ', 'DQ', 'D10', 'HQ', 'H10'],
  };
  const prikup = ['SQ', 'CJ', 'C10'];

  const legal = startGivingForAlice({ hands, prikup });
  const raised = legal.raiseContract('alice', 160);

  assert.equal(raised.contract, 160);

  const illegal = startGivingForAlice({ hands, prikup });

  expectError(() => illegal.raiseContract('alice', 165), 'INVALID_RAISE');
  assert.equal(illegal.getState().contract, BIDDING.MIN);
});

test('a raise below the current contract is rejected', () => {
  const game = startGivingForBorisWithContract85();

  assert.equal(game.getState().contract, 85);

  expectError(() => game.raiseContract('boris', 80), 'INVALID_RAISE');
  expectError(() => game.raiseContract('boris', 85), 'INVALID_RAISE');

  const state = game.raiseContract('boris', 90);

  assert.equal(state.contract, 90);
  assert.equal(state.raiseDecided, true);
});

test('only the declarer may raise or decline the contract', () => {
  const game = startGivingForAlice();

  expectError(() => game.raiseContract('human', 85), 'NOT_DECLARER');
  expectError(() => game.raiseContract('boris', 85), 'NOT_DECLARER');
  expectError(() => game.declineRaise('human'), 'NOT_DECLARER');
  expectError(() => game.declineRaise('boris'), 'NOT_DECLARER');
});

test('the first gift closes the raise window even without an explicit decision', () => {
  const game = startGivingForAlice();

  const state = game.giveCard('boris', 'S9');

  assert.equal(state.raiseDecided, true);
  expectError(() => game.raiseContract('alice', 85), 'RAISE_WINDOW_CLOSED');
  expectError(() => game.declineRaise('alice'), 'RAISE_WINDOW_CLOSED');
});

test('a negative declarer cannot raise but may decline and continue', () => {
  const game = createAllNegativeBiddingGame();
  const bidding = game.getState();
  const openerId = bidding.currentBidderId;

  game.bid(openerId, BIDDING.MIN);

  const revealed = game.getState();
  const declarerId = revealed.declarerId;

  assert.equal(getStatePlayer(revealed, declarerId).score < 0, true);

  game.takePrikup(declarerId);

  expectError(() => game.raiseContract(declarerId, 85), 'NEGATIVE_SCORE_NO_RAISE');

  const declined = game.declineRaise(declarerId);

  assert.equal(declined.raiseDecided, true);
  assert.equal(declined.contract, BIDDING.MIN);
  assert.equal(declined.phase, PHASES.GIVING);
});

test('scoring accepts every legal raised contract', () => {
  const players = [
    { id: 'human', score: 0, bolts: 0, tricksWon: 1, trickPoints: 0 },
    { id: 'alice', score: 0, bolts: 0, tricksWon: 4, trickPoints: 60 },
    { id: 'boris', score: 0, bolts: 0, tricksWon: 3, trickPoints: 60 },
  ];

  for (const contract of [85, 100, 120]) {
    const result = scoreDeal({ players, declarerId: 'human', contract });

    assert.equal(result.contract, contract);
  }
});

test('the final contract is used by deal scoring', () => {
  const game = startGivingForAlice({
    hands: DOMINATING_HANDS,
    prikup: DOMINATING_PRIKUP,
  });

  game.raiseContract('alice', 100);
  game.giveCard('boris', 'S9');
  game.giveCard('human', 'C9');

  while (game.getState().phase === PHASES.PLAYING) {
    playFirstLegal(game);
  }

  const state = game.getState();

  assert.equal(state.phase, PHASES.DEAL_END);
  assert.equal(state.lastDealResult.contract, 100);
  assert.equal(state.lastDealResult.contractMet, true);
  assert.equal(resultFor(state.lastDealResult, 'alice').delta, 100);
  assert.equal(getStatePlayer(state, 'alice').score, 100);
});

test('AI raises on a strong hand and declines on a weak or negative hand', () => {
  const ai = createAI({ playerId: 'alice', personality: 'balanced', rng: () => 0.5 });
  const strongAmount = ai.chooseContractRaise(createGivingView({ hand: STRONG_TEN }));

  assert.ok(Number.isInteger(strongAmount));
  assert.ok(strongAmount > BIDDING.MIN && strongAmount <= BIDDING.MAX);
  assert.equal(strongAmount % BIDDING.STEP, 0);
  assert.equal(ai.chooseContractRaise(createGivingView({ hand: WEAK_TEN })), null);
  assert.equal(
    ai.chooseContractRaise(createGivingView({ hand: STRONG_TEN, score: -80 })),
    null,
  );
  assert.equal(
    ai.chooseContractRaise(createGivingView({ hand: STRONG_TEN, raiseDecided: true })),
    null,
  );
  assert.equal(
    ai.chooseContractRaise(createGivingView({
      hand: STRONG_TEN,
      givenCards: [{ toId: 'boris', cardId: 'S9' }],
    })),
    null,
  );
});
