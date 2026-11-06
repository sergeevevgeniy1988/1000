import test from 'node:test';
import assert from 'node:assert/strict';

import { BOLTS } from '../js/core/constants.js';
import { GameError } from '../js/core/errors.js';
import { checkGameOver, roundToFive, scoreDeal } from '../js/core/scoring.js';

function player(id, overrides = {}) {
  return {
    id,
    score: 0,
    bolts: 0,
    tricksWon: 0,
    trickPoints: 0,
    marriagePoints: 0,
    ...overrides,
  };
}

function resultFor(dealScore, id) {
  return dealScore.players.find((result) => result.id === id);
}

test('roundToFive follows the standard half-up examples', () => {
  const examples = [
    [12, 10],
    [13, 15],
    [17, 15],
    [18, 20],
    [22, 20],
    [23, 25],
    [0, 0],
    [2, 0],
    [2.5, 5],
  ];

  for (const [input, expected] of examples) {
    assert.equal(roundToFive(input), expected, `${input} must round to ${expected}.`);
  }

  assert.equal(roundToFive(1000), 1000);
});

test('a successful contract awards the full contract to the declarer', () => {
  const dealScore = scoreDeal({
    players: [
      player('human', {
        score: 200,
        tricksWon: 4,
        trickPoints: 75,
        marriagePoints: 100,
      }),
      player('alice', {
        score: 50,
        tricksWon: 2,
        trickPoints: 25,
        marriagePoints: 40,
      }),
      player('boris', {
        score: 30,
        tricksWon: 2,
        trickPoints: 20,
      }),
    ],
    declarerId: 'human',
    contract: 110,
  });

  assert.equal(dealScore.declarerTotal, 175);
  assert.equal(dealScore.contractMet, true);

  const human = resultFor(dealScore, 'human');
  const alice = resultFor(dealScore, 'alice');
  const boris = resultFor(dealScore, 'boris');

  assert.equal(human.total, 175);
  assert.equal(human.rounded, null);
  assert.equal(human.contractMet, true);
  assert.equal(human.delta, 110);
  assert.equal(human.scoreAfter, 310);

  assert.equal(alice.total, 65);
  assert.equal(alice.rounded, 65);
  assert.equal(alice.contractMet, null);
  assert.equal(alice.delta, 65);
  assert.equal(alice.scoreAfter, 115);

  assert.equal(boris.total, 20);
  assert.equal(boris.rounded, 20);
  assert.equal(boris.delta, 20);
  assert.equal(boris.scoreAfter, 50);

  assert.deepEqual(dealScore.boltsAwarded, []);
  assert.deepEqual(dealScore.boltsReset, []);
});

test('a missed contract costs the full contract', () => {
  const dealScore = scoreDeal({
    players: [
      player('human', { tricksWon: 3, trickPoints: 70, marriagePoints: 40 }),
      player('alice', { tricksWon: 3, trickPoints: 30 }),
      player('boris', { tricksWon: 2, trickPoints: 20 }),
    ],
    declarerId: 'human',
    contract: 115,
  });

  const human = resultFor(dealScore, 'human');
  const alice = resultFor(dealScore, 'alice');
  const boris = resultFor(dealScore, 'boris');

  assert.equal(dealScore.declarerTotal, 110);
  assert.equal(dealScore.contractMet, false);
  assert.equal(human.delta, -115);
  assert.equal(human.scoreAfter, -115);
  assert.equal(alice.delta, 30);
  assert.equal(boris.delta, 20);
});

test('opponents add their rounded totals to their scores', () => {
  const dealScore = scoreDeal({
    players: [
      player('human', { tricksWon: 5, trickPoints: 95 }),
      player('alice', { tricksWon: 2, trickPoints: 12 }),
      player('boris', { tricksWon: 1, trickPoints: 13 }),
    ],
    declarerId: 'human',
    contract: 100,
  });

  const alice = resultFor(dealScore, 'alice');
  const boris = resultFor(dealScore, 'boris');

  assert.equal(dealScore.contractMet, false);
  assert.equal(resultFor(dealScore, 'human').delta, -100);
  assert.equal(alice.total, 12);
  assert.equal(alice.rounded, 10);
  assert.equal(alice.delta, 10);
  assert.equal(boris.total, 13);
  assert.equal(boris.rounded, 15);
  assert.equal(boris.delta, 15);
});

test('marriage bonuses count towards the deal total and the contract', () => {
  const dealScore = scoreDeal({
    players: [
      player('human', { tricksWon: 4, trickPoints: 50, marriagePoints: 60 }),
      player('alice', { tricksWon: 2, trickPoints: 40 }),
      player('boris', { tricksWon: 2, trickPoints: 30 }),
    ],
    declarerId: 'human',
    contract: 110,
  });

  const human = resultFor(dealScore, 'human');

  assert.equal(human.trickPoints, 50);
  assert.equal(human.marriagePoints, 60);
  assert.equal(human.total, 110);
  assert.equal(dealScore.contractMet, true);
  assert.equal(human.delta, 110);
});

test('a player with no tricks receives a bolt', () => {
  const dealScore = scoreDeal({
    players: [
      player('human', { tricksWon: 8, trickPoints: 120 }),
      player('alice', { score: 40, tricksWon: 0, trickPoints: 0 }),
      player('boris', { tricksWon: 0, trickPoints: 0 }),
    ],
    declarerId: 'human',
    contract: 100,
  });

  const alice = resultFor(dealScore, 'alice');
  const boris = resultFor(dealScore, 'boris');

  assert.equal(alice.boltEarned, true);
  assert.equal(alice.boltsBefore, 0);
  assert.equal(alice.boltsAfter, 1);
  assert.equal(alice.boltPenalty, 0);
  assert.equal(alice.delta, 0);
  assert.equal(alice.scoreAfter, 40);

  assert.equal(boris.boltEarned, true);
  assert.deepEqual(dealScore.boltsAwarded, ['alice', 'boris']);
  assert.deepEqual(dealScore.boltsReset, []);
});

test('a trick made of nines prevents a bolt', () => {
  const dealScore = scoreDeal({
    players: [
      player('human', { tricksWon: 7, trickPoints: 120 }),
      player('alice', { tricksWon: 1, trickPoints: 0 }),
      player('boris', { tricksWon: 0, trickPoints: 0 }),
    ],
    declarerId: 'human',
    contract: 100,
  });

  assert.equal(resultFor(dealScore, 'alice').boltEarned, false);
  assert.equal(resultFor(dealScore, 'alice').boltsAfter, 0);
});

test('the third bolt costs 120 points after the normal scoring and resets the counter', () => {
  const dealScore = scoreDeal({
    players: [
      player('human', { tricksWon: 8, trickPoints: 120 }),
      player('alice', {
        score: 500,
        bolts: 2,
        tricksWon: 0,
        trickPoints: 0,
        marriagePoints: 40,
      }),
      player('boris', { tricksWon: 0, trickPoints: 0 }),
    ],
    declarerId: 'human',
    contract: 100,
  });

  const alice = resultFor(dealScore, 'alice');

  assert.equal(alice.total, 40);
  assert.equal(alice.rounded, 40);
  assert.equal(alice.baseDelta, 40);
  assert.equal(alice.boltEarned, true);
  assert.equal(alice.boltReset, true);
  assert.equal(alice.boltPenalty, BOLTS.PENALTY);
  assert.equal(alice.delta, -80);
  assert.equal(alice.scoreAfter, 420);
  assert.equal(alice.boltsAfter, 0);
  assert.deepEqual(dealScore.boltsReset, ['alice']);
});

test('a declarer can lose the contract and the third-bolt penalty together', () => {
  const dealScore = scoreDeal({
    players: [
      player('human', { score: 50, bolts: 2, tricksWon: 0, trickPoints: 0 }),
      player('alice', { tricksWon: 4, trickPoints: 60 }),
      player('boris', { tricksWon: 4, trickPoints: 60 }),
    ],
    declarerId: 'human',
    contract: 100,
  });

  const human = resultFor(dealScore, 'human');

  assert.equal(dealScore.contractMet, false);
  assert.equal(human.baseDelta, -100);
  assert.equal(human.boltPenalty, 120);
  assert.equal(human.delta, -220);
  assert.equal(human.scoreAfter, -170);
  assert.equal(human.boltsAfter, 0);
});

test('scores may become negative without a bolt', () => {
  const dealScore = scoreDeal({
    players: [
      player('human', { score: 10, tricksWon: 1, trickPoints: 0 }),
      player('alice', { tricksWon: 4, trickPoints: 60 }),
      player('boris', { tricksWon: 3, trickPoints: 60 }),
    ],
    declarerId: 'human',
    contract: 100,
  });

  const human = resultFor(dealScore, 'human');

  assert.equal(human.boltEarned, false);
  assert.equal(human.delta, -100);
  assert.equal(human.scoreAfter, -90);
});

test('scoreDeal does not mutate the input players', () => {
  const players = [
    player('human', { score: 100, tricksWon: 4, trickPoints: 60 }),
    player('alice', { score: 50, bolts: 1, tricksWon: 2, trickPoints: 40 }),
    player('boris', { score: 0, bolts: 2, tricksWon: 2, trickPoints: 20 }),
  ];
  const snapshot = structuredClone(players);

  scoreDeal({ players, declarerId: 'human', contract: 100 });

  assert.deepEqual(players, snapshot);
});

test('scoreDeal rejects malformed input', () => {
  const validPlayers = [
    player('human'),
    player('alice'),
    player('boris'),
  ];

  assert.throws(
    () => scoreDeal({ players: validPlayers, declarerId: 'human', contract: 107 }),
    (error) => error instanceof GameError && error.code === 'INVALID_ARGUMENT',
  );

  assert.throws(
    () => scoreDeal({ players: validPlayers, declarerId: 'unknown', contract: 100 }),
    (error) => error instanceof GameError && error.code === 'INVALID_ARGUMENT',
  );

  assert.throws(
    () => scoreDeal({
      players: [player('human'), player('alice', { bolts: 3 }), player('boris')],
      declarerId: 'human',
      contract: 100,
    }),
    (error) => error instanceof GameError && error.code === 'INVALID_ARGUMENT',
  );
});

test('roundToFive rejects non-numeric values', () => {
  assert.throws(
    () => roundToFive('12'),
    (error) => error instanceof GameError && error.code === 'INVALID_ARGUMENT',
  );

  assert.throws(
    () => roundToFive(Number.NaN),
    (error) => error instanceof GameError && error.code === 'INVALID_ARGUMENT',
  );
});

test('checkGameOver ignores scores below the target', () => {
  const result = checkGameOver([
    { id: 'human', score: 900 },
    { id: 'alice', score: 500 },
    { id: 'boris', score: 100 },
  ]);

  assert.equal(result.isOver, false);
  assert.equal(result.winnerId, null);
  assert.equal(result.targetReached, false);
  assert.equal(result.isTie, false);
  assert.equal(result.topScore, 900);
  assert.deepEqual(result.leaderIds, ['human']);
});

test('checkGameOver detects an outright winner at or above the target', () => {
  const result = checkGameOver([
    { id: 'human', score: 1000 },
    { id: 'alice', score: 990 },
    { id: 'boris', score: 1010 },
  ]);

  assert.equal(result.isOver, true);
  assert.equal(result.winnerId, 'boris');
  assert.equal(result.targetReached, true);
  assert.equal(result.isTie, false);
  assert.deepEqual(result.leaderIds, ['boris']);
});

test('a tie at or above the target keeps the game going', () => {
  const result = checkGameOver([
    { id: 'human', score: 1000 },
    { id: 'alice', score: 1000 },
    { id: 'boris', score: 900 },
  ]);

  assert.equal(result.isOver, false);
  assert.equal(result.winnerId, null);
  assert.equal(result.targetReached, true);
  assert.equal(result.isTie, true);
  assert.deepEqual(result.leaderIds, ['human', 'alice']);
});

test('a tie below the target is not a game-over tie', () => {
  const result = checkGameOver([
    { id: 'human', score: 900 },
    { id: 'alice', score: 900 },
    { id: 'boris', score: 800 },
  ]);

  assert.equal(result.isOver, false);
  assert.equal(result.winnerId, null);
  assert.equal(result.targetReached, false);
  assert.equal(result.isTie, true);
});

test('checkGameOver supports a custom target score', () => {
  const result = checkGameOver([
    { id: 'human', score: 500 },
    { id: 'alice', score: 100 },
    { id: 'boris', score: 200 },
  ], 500);

  assert.equal(result.isOver, true);
  assert.equal(result.winnerId, 'human');
  assert.equal(result.targetScore, 500);
});
