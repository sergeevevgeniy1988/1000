import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BIDDING,
  BOLTS,
  DEAL,
  GAME_EVENTS,
  MARRIAGE_BONUSES,
  MAX_CONTRACT,
  PHASES,
  RANK_INFO,
  RANKS,
  SUITS,
  SUIT_INFO,
  TARGET_SCORE,
} from '../js/core/constants.js';
import { createDeck, deal, getCardById, shuffle } from '../js/core/deck.js';
import { GameError } from '../js/core/errors.js';
import { mulberry32, randomSeed } from '../js/core/rng.js';

test('createDeck returns 24 unique cards', () => {
  const deck = createDeck();
  const ids = deck.map((card) => card.id);

  assert.equal(deck.length, DEAL.CARD_COUNT);
  assert.equal(new Set(ids).size, DEAL.CARD_COUNT);
  assert.ok(deck.every((card) => Object.isFrozen(card)));
});

test('the deck is worth 120 points and every suit is worth 30', () => {
  const deck = createDeck();
  const totalValue = deck.reduce((sum, card) => sum + card.value, 0);

  assert.equal(totalValue, 120);

  for (const suit of SUITS) {
    const suitValue = deck
      .filter((card) => card.suit === suit)
      .reduce((sum, card) => sum + card.value, 0);

    assert.equal(suitValue, 30, `Suit ${suit} must be worth 30 points.`);
  }
});

test('every suit contains all six ranks exactly once', () => {
  const deck = createDeck();

  for (const suit of SUITS) {
    const suitCards = deck.filter((card) => card.suit === suit);

    assert.equal(suitCards.length, DEAL.CARDS_PER_SUIT);
    assert.deepEqual(
      suitCards.map((card) => card.rank),
      [...RANKS],
    );
  }
});

test('card ids are stable and derived from suit and rank', () => {
  const deck = createDeck();
  const ids = new Set(deck.map((card) => card.id));

  for (const card of deck) {
    assert.equal(card.id, `${card.suit}${card.rank}`);
  }

  for (const expectedId of ['S9', 'SJ', 'SQ', 'SK', 'S10', 'SA', 'H9', 'H10', 'HA', 'C9', 'D9']) {
    assert.ok(ids.has(expectedId), `Missing card ${expectedId}.`);
  }
});

test('card strengths and values match the rules', () => {
  const expected = {
    9: { strength: 1, value: 0 },
    J: { strength: 2, value: 2 },
    Q: { strength: 3, value: 3 },
    K: { strength: 4, value: 4 },
    10: { strength: 5, value: 10 },
    A: { strength: 6, value: 11 },
  };

  for (const card of createDeck()) {
    assert.equal(card.strength, expected[card.rank].strength, `Wrong strength for ${card.id}.`);
    assert.equal(card.value, expected[card.rank].value, `Wrong value for ${card.id}.`);
  }

  for (const [rank, info] of Object.entries(RANK_INFO)) {
    assert.equal(info.strength, expected[rank].strength);
    assert.equal(info.value, expected[rank].value);
  }
});

test('game constants are frozen and contain the expected limits', () => {
  const frozenObjects = [
    SUITS,
    SUIT_INFO,
    MARRIAGE_BONUSES,
    RANKS,
    RANK_INFO,
    PHASES,
    BIDDING,
    DEAL,
    BOLTS,
    GAME_EVENTS,
  ];

  for (const value of frozenObjects) {
    assert.ok(Object.isFrozen(value));
  }

  for (const suit of SUITS) {
    assert.ok(Object.isFrozen(SUIT_INFO[suit]));
    assert.equal(SUIT_INFO[suit].id, suit);
  }

  for (const rank of RANKS) {
    assert.ok(Object.isFrozen(RANK_INFO[rank]));
    assert.equal(RANK_INFO[rank].id, rank);
  }

  assert.deepEqual(Object.values(MARRIAGE_BONUSES), [40, 60, 80, 100]);
  assert.equal(BIDDING.MIN, 80);
  assert.equal(BIDDING.MAX, 120);
  assert.equal(BIDDING.STEP, 5);
  assert.equal(MAX_CONTRACT, 400);
  assert.equal(TARGET_SCORE, 1000);
  assert.equal(BOLTS.LIMIT, 3);
  assert.equal(BOLTS.PENALTY, 120);
  assert.equal(DEAL.CARD_COUNT, 24);
  assert.equal(DEAL.INITIAL_HAND_SIZE, 7);
  assert.equal(DEAL.PRIKUP_SIZE, 3);
  assert.equal(DEAL.PLAYING_HAND_SIZE, 8);
  assert.equal(DEAL.TRICKS, 8);
});

test('getCardById returns cards and rejects unknown ids', () => {
  const card = getCardById('H10');

  assert.equal(card.suit, 'H');
  assert.equal(card.rank, '10');
  assert.equal(card.value, 10);
  assert.throws(
    () => getCardById('XX'),
    (error) => error instanceof GameError && error.code === 'UNKNOWN_CARD',
  );
});

test('mulberry32 is deterministic and stays inside [0, 1)', () => {
  const first = mulberry32(12345);
  const second = mulberry32(12345);

  for (let index = 0; index < 100; index += 1) {
    const firstValue = first();
    const secondValue = second();

    assert.equal(firstValue, secondValue);
    assert.ok(firstValue >= 0 && firstValue < 1);
  }
});

test('randomSeed returns an unsigned 32-bit integer', () => {
  const seed = randomSeed();

  assert.ok(Number.isInteger(seed));
  assert.ok(seed >= 0);
  assert.ok(seed <= 0xffffffff);
});

test('seeded shuffle is deterministic', () => {
  const deck = createDeck();
  const first = shuffle(deck, mulberry32(777));
  const second = shuffle(deck, mulberry32(777));

  assert.deepEqual(
    first.map((card) => card.id),
    second.map((card) => card.id),
  );
});

test('shuffle does not mutate the source deck and preserves all cards', () => {
  const deck = createDeck();
  const originalOrder = deck.map((card) => card.id);
  const shuffled = shuffle(deck, mulberry32(42));

  assert.notEqual(shuffled, deck);
  assert.deepEqual(
    deck.map((card) => card.id),
    originalOrder,
  );
  assert.equal(shuffled.length, DEAL.CARD_COUNT);
  assert.deepEqual(
    new Set(shuffled.map((card) => card.id)),
    new Set(originalOrder),
  );
});

test('deal gives seven cards to each player and three to the prikup', () => {
  const deck = shuffle(createDeck(), mulberry32(2026));
  const { hands, prikup } = deal(deck);

  assert.equal(hands.length, DEAL.PLAYER_COUNT);
  assert.deepEqual(
    hands.map((hand) => hand.length),
    [7, 7, 7],
  );
  assert.equal(prikup.length, DEAL.PRIKUP_SIZE);

  const dealtCards = [...hands.flat(), ...prikup];

  assert.equal(dealtCards.length, DEAL.CARD_COUNT);
  assert.equal(new Set(dealtCards.map((card) => card.id)).size, DEAL.CARD_COUNT);
  assert.deepEqual(
    new Set(dealtCards.map((card) => card.id)),
    new Set(deck.map((card) => card.id)),
  );
});

test('deal distributes cards one by one in a circle', () => {
  const deck = createDeck();
  const { hands, prikup } = deal(deck);

  assert.equal(hands[0][0], deck[0]);
  assert.equal(hands[1][0], deck[1]);
  assert.equal(hands[2][0], deck[2]);
  assert.equal(hands[0][1], deck[3]);
  assert.equal(hands[0][6], deck[18]);
  assert.equal(hands[2][6], deck[20]);
  assert.deepEqual(prikup, deck.slice(21));
});

test('deal rejects decks with too few cards', () => {
  const deck = createDeck().slice(0, DEAL.CARD_COUNT - 1);

  assert.throws(
    () => deal(deck),
    (error) => error instanceof GameError && error.code === 'NOT_ENOUGH_CARDS',
  );
});
