import assert from 'node:assert/strict';
import test from 'node:test';

import { getBidOptions } from '../js/ui/bidding.js';

test('opening bidding offers exactly 100', () => {
  assert.deepEqual(getBidOptions(0), [100]);
});

test('every legal raise is offered with a step of five', () => {
  assert.deepEqual(getBidOptions(100), [105, 110, 115, 120]);
  assert.deepEqual(getBidOptions(105), [110, 115, 120]);
  assert.deepEqual(getBidOptions(110), [115, 120]);
  assert.deepEqual(getBidOptions(115), [120]);
});

test('no raises are offered at the maximum bid', () => {
  assert.deepEqual(getBidOptions(120), []);
});

test('bid options tolerate a missing or invalid current bid', () => {
  assert.deepEqual(getBidOptions(Number.NaN), [100]);
  assert.deepEqual(getBidOptions(undefined), [100]);
});
