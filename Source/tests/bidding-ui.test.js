import assert from 'node:assert/strict';
import test from 'node:test';

import { getBidOptions, getHumanBidState } from '../js/ui/bidding.js';

function createState(overrides = {}) {
  return {
    currentBid: 0,
    currentBidderId: 'human',
    players: [
      { id: 'alice', name: 'Алиса', isHuman: false, score: 0 },
      { id: 'boris', name: 'Борис', isHuman: false, score: 0 },
      { id: 'human', name: 'Вы', isHuman: true, score: 0 },
    ],
    ...overrides,
  };
}

test('opening bidding offers exactly 80', () => {
  assert.deepEqual(getBidOptions(0), [80]);
});

test('every legal raise is offered with a step of five', () => {
  assert.deepEqual(getBidOptions(80), [85, 90, 95, 100, 105, 110, 115, 120]);
  assert.deepEqual(getBidOptions(85), [90, 95, 100, 105, 110, 115, 120]);
  assert.deepEqual(getBidOptions(105), [110, 115, 120]);
  assert.deepEqual(getBidOptions(115), [120]);
});

test('no raises are offered at the maximum bid', () => {
  assert.deepEqual(getBidOptions(120), []);
});

test('bid options tolerate a missing or invalid current bid', () => {
  assert.deepEqual(getBidOptions(Number.NaN), [80]);
  assert.deepEqual(getBidOptions(undefined), [80]);
});

test('a negative-score opener sees only the forced 80 bid and no pass button', () => {
  const state = createState({
    players: [
      { id: 'alice', name: 'Алиса', isHuman: false, score: 0 },
      { id: 'boris', name: 'Борис', isHuman: false, score: 0 },
      { id: 'human', name: 'Вы', isHuman: true, score: -80 },
    ],
  });
  const bidState = getHumanBidState(state, 'human');

  assert.deepEqual(bidState.options, [80]);
  assert.equal(bidState.canPass, false);
  assert.equal(bidState.negative, true);
  assert.equal(bidState.notice, 'Отрицательный счёт: можно только открыть 80');
});

test('a negative-score non-opener sees no bidding buttons and an explanation', () => {
  const state = createState({
    currentBid: 80,
    currentBidderId: 'boris',
    players: [
      { id: 'alice', name: 'Алиса', isHuman: false, score: 0 },
      { id: 'boris', name: 'Борис', isHuman: false, score: 0 },
      { id: 'human', name: 'Вы', isHuman: true, score: -80 },
    ],
  });
  const bidState = getHumanBidState(state, 'human');

  assert.deepEqual(bidState.options, []);
  assert.equal(bidState.canPass, false);
  assert.equal(bidState.negative, true);
  assert.equal(bidState.notice, 'Отрицательный счёт: торги недоступны');
});

test('a positive-score human sees opening and raise options with a legal pass', () => {
  const opening = getHumanBidState(createState(), 'human');

  assert.deepEqual(opening.options, [80]);
  assert.equal(opening.canPass, false);
  assert.equal(opening.negative, false);
  assert.equal(opening.notice, null);

  const raising = getHumanBidState(
    createState({ currentBid: 80, currentBidderId: 'human' }),
    'human',
  );

  assert.deepEqual(raising.options, [85, 90, 95, 100, 105, 110, 115, 120]);
  assert.equal(raising.canPass, true);
  assert.equal(raising.negative, false);
  assert.equal(raising.notice, null);
});
