import test from 'node:test';
import assert from 'node:assert/strict';

import { getCardById } from '../js/core/deck.js';
import { GameError } from '../js/core/errors.js';
import {
  canDeclareMarriage,
  getAvailableMarriages,
  getLegalCards,
  getMarriageConfirmationCards,
  getMaxContract,
  getTrickPoints,
  getTrickWinner,
  isCardLegal,
  isMarriageConfirmationCard,
} from '../js/core/rules.js';

const card = (id) => getCardById(id);
const cards = (...ids) => ids.map(card);
const ids = (hand) => hand.map((entry) => entry.id);
const trick = (...entries) => entries.map(([playerId, cardId]) => ({ playerId, cardId }));

test('getLegalCards requires following the led suit', () => {
  const hand = cards('S9', 'S10', 'H9', 'HA');
  const legal = getLegalCards(hand, 'S', 'H');

  assert.deepEqual(ids(legal), ['S9', 'S10']);
  assert.equal(isCardLegal(hand, 'S10', 'S', 'H'), true);
  assert.equal(isCardLegal(hand, 'H9', 'S', 'H'), false);
});

test('getLegalCards requires a trump when the led suit is absent', () => {
  const hand = cards('H9', 'H10', 'C9', 'D9');
  const legal = getLegalCards(hand, 'S', 'H');

  assert.deepEqual(ids(legal), ['H9', 'H10']);
});

test('getLegalCards allows any card when there is no led-suit card and no trump', () => {
  const handWithoutTrump = cards('C9', 'D9', 'DJ');
  const handWithTrump = cards('C9', 'D9', 'DJ');

  assert.deepEqual(ids(getLegalCards(handWithoutTrump, 'S', 'H')), ['C9', 'D9', 'DJ']);
  assert.deepEqual(ids(getLegalCards(handWithTrump, 'S', null)), ['C9', 'D9', 'DJ']);
  assert.deepEqual(ids(getLegalCards(handWithoutTrump, 'S', undefined)), ['C9', 'D9', 'DJ']);
});

test('the trick leader may play any card', () => {
  const hand = cards('S9', 'H9', 'C9');

  assert.deepEqual(ids(getLegalCards(hand, null, 'H')), ['S9', 'H9', 'C9']);
  assert.deepEqual(ids(getLegalCards(hand, undefined, null)), ['S9', 'H9', 'C9']);
});

test('when the led suit is trump, the player must follow trump', () => {
  const hand = cards('H9', 'HK', 'S9', 'SA');

  assert.deepEqual(ids(getLegalCards(hand, 'H', 'H')), ['H9', 'HK']);
});

test('a trump beats a non-trump led suit', () => {
  const winner = getTrickWinner(
    trick(['human', 'CA'], ['alice', 'H9'], ['boris', 'CK']),
    'H',
  );

  assert.equal(winner, 'alice');
});

test('the highest trump wins the trick', () => {
  const winner = getTrickWinner(
    trick(['human', 'H9'], ['alice', 'H10'], ['boris', 'HK']),
    'H',
  );

  assert.equal(winner, 'alice');
});

test('the ten beats the king of the same suit', () => {
  const winner = getTrickWinner(
    trick(['human', 'H9'], ['alice', 'HK'], ['boris', 'H10']),
    'H',
  );

  assert.equal(winner, 'boris');
});

test('without a trump the highest card of the led suit wins', () => {
  const winner = getTrickWinner(
    trick(['human', 'S10'], ['alice', 'SA'], ['boris', 'SK']),
    null,
  );

  assert.equal(winner, 'alice');
});

test('a non-trump card of another suit can never win the trick', () => {
  const winner = getTrickWinner(
    trick(['human', 'S9'], ['alice', 'CA'], ['boris', 'SK']),
    'H',
  );

  assert.equal(winner, 'boris');
});

test('trick entries may carry card objects instead of card ids', () => {
  const winner = getTrickWinner(
    [
      { playerId: 'human', card: card('CA') },
      { playerId: 'alice', card: card('H9') },
      { playerId: 'boris', card: card('CK') },
    ],
    'H',
  );

  assert.equal(winner, 'alice');
});

test('getTrickPoints sums card values, including zero for nines', () => {
  assert.equal(getTrickPoints(cards('S10', 'HA', 'D9')), 21);
  assert.equal(getTrickPoints([]), 0);
  assert.equal(
    getTrickPoints(trick(['human', 'H10'], ['alice', 'HA'], ['boris', 'H9'])),
    21,
  );
});

test('getAvailableMarriages lists undeclared king-queen pairs with bonuses', () => {
  const hand = cards('SK', 'SQ', 'HK', 'HQ', 'CK', 'D10');
  const available = getAvailableMarriages(hand);

  assert.deepEqual(available, [
    { suit: 'S', value: 40 },
    { suit: 'H', value: 100 },
  ]);

  assert.deepEqual(getAvailableMarriages(hand, ['S']), [{ suit: 'H', value: 100 }]);
  assert.deepEqual(getAvailableMarriages(cards('SK', 'HQ'), []), []);
});

test('getMaxContract adds marriage bonuses on top of the top bid', () => {
  assert.equal(getMaxContract([]), 120);
  assert.equal(getMaxContract(cards('SA', 'HA', 'DA', 'CA')), 120);
  assert.equal(getMaxContract(cards('HK', 'HQ', 'S9', 'C9')), 220);
  assert.equal(getMaxContract(cards('HK', 'HQ', 'SK', 'SQ', 'S9')), 260);
  assert.equal(
    getMaxContract(cards('SK', 'SQ', 'HK', 'HQ', 'DK', 'DQ', 'CK', 'CQ', 'S9', 'H9')),
    400,
  );
});

test('getMaxContract does not mutate the hand', () => {
  const hand = cards('HK', 'HQ', 'SK', 'SQ', 'D9');
  const snapshot = ids(hand);

  assert.equal(getMaxContract(hand), 260);
  assert.deepEqual(ids(hand), snapshot);
});

test('marriage confirmation helpers return the king and queen of a suit', () => {
  const hand = cards('SK', 'SQ', 'HK', 'HA', 'D10');

  assert.deepEqual(ids(getMarriageConfirmationCards(hand, 'S')), ['SK', 'SQ']);
  assert.deepEqual(ids(getMarriageConfirmationCards(hand, 'H')), []);
  assert.deepEqual(ids(getMarriageConfirmationCards(cards('SK'), 'S')), []);

  assert.equal(isMarriageConfirmationCard(card('SK'), 'S'), true);
  assert.equal(isMarriageConfirmationCard(card('SQ'), 'S'), true);
  assert.equal(isMarriageConfirmationCard(card('SA'), 'S'), false);
  assert.equal(isMarriageConfirmationCard(card('HK'), 'S'), false);
  assert.equal(isMarriageConfirmationCard(card('SK'), 'H'), false);

  assert.throws(
    () => getMarriageConfirmationCards(hand, 'X'),
    (error) => error instanceof GameError && error.code === 'INVALID_SUIT',
  );
});

test('canDeclareMarriage checks all timing and hand conditions', () => {
  const hand = cards('SK', 'SQ', 'H9');

  assert.equal(canDeclareMarriage(hand, 'S', { isLeader: true, completedTricks: 1 }), true);

  assert.equal(canDeclareMarriage(hand, 'S', { isLeader: true, completedTricks: 0 }), false);
  assert.equal(canDeclareMarriage(hand, 'S', { isLeader: false, completedTricks: 1 }), false);
  assert.equal(
    canDeclareMarriage(hand, 'S', {
      isLeader: true,
      completedTricks: 1,
      declaredMarriages: ['S'],
    }),
    false,
  );
  assert.equal(
    canDeclareMarriage(hand, 'S', {
      isLeader: true,
      completedTricks: 1,
      marriagesThisTurn: 1,
    }),
    false,
  );
  assert.equal(canDeclareMarriage(cards('SK'), 'S', { isLeader: true, completedTricks: 1 }), false);
  assert.equal(canDeclareMarriage(hand, 'H', { isLeader: true, completedTricks: 1 }), false);
});

test('rules reject malformed input', () => {
  assert.throws(
    () => getLegalCards(cards('S9'), 'X', null),
    (error) => error instanceof GameError && error.code === 'INVALID_SUIT',
  );

  assert.throws(
    () => getTrickWinner(trick(['human', 'S9'], ['human', 'SA']), null),
    (error) => error instanceof GameError && error.code === 'INVALID_TRICK',
  );

  assert.throws(
    () => getTrickWinner([], null),
    (error) => error instanceof GameError && error.code === 'INVALID_TRICK',
  );
});
