import test from 'node:test';
import assert from 'node:assert/strict';

import { EventEmitter } from '../js/core/events.js';
import { GameError } from '../js/core/errors.js';

test('EventEmitter calls subscribed listeners with the payload', () => {
  const emitter = new EventEmitter();
  const received = [];

  emitter.on('bid', (payload) => received.push(payload));
  emitter.emit('bid', { playerId: 'alice', amount: 100 });
  emitter.emit('bid', { playerId: 'boris', amount: 105 });

  assert.deepEqual(received, [
    { playerId: 'alice', amount: 100 },
    { playerId: 'boris', amount: 105 },
  ]);
});

test('EventEmitter unsubscribe function removes the listener', () => {
  const emitter = new EventEmitter();
  let callCount = 0;
  const unsubscribe = emitter.on('pass', () => {
    callCount += 1;
  });

  emitter.emit('pass');
  unsubscribe();
  emitter.emit('pass');

  assert.equal(callCount, 1);
  assert.equal(emitter.listenerCount('pass'), 0);
});

test('EventEmitter off removes a listener and reports the result', () => {
  const emitter = new EventEmitter();
  const listener = () => {};

  emitter.on('dealstarted', listener);

  assert.equal(emitter.off('dealstarted', listener), true);
  assert.equal(emitter.off('dealstarted', listener), false);
  assert.equal(emitter.listenerCount('dealstarted'), 0);
});

test('EventEmitter ignores duplicate listeners', () => {
  const emitter = new EventEmitter();
  let callCount = 0;
  const listener = () => {
    callCount += 1;
  };

  emitter.on('scored', listener);
  emitter.on('scored', listener);
  emitter.emit('scored');

  assert.equal(callCount, 1);
  assert.equal(emitter.listenerCount('scored'), 1);
});

test('EventEmitter snapshots listeners before dispatching', () => {
  const emitter = new EventEmitter();
  const calls = [];
  const second = () => calls.push('second');
  const first = () => {
    calls.push('first');
    emitter.off('trickwon', second);
  };

  emitter.on('trickwon', first);
  emitter.on('trickwon', second);
  emitter.emit('trickwon');

  assert.deepEqual(calls, ['first', 'second']);
  assert.equal(emitter.listenerCount('trickwon'), 1);
});

test('EventEmitter clear removes listeners for one or all events', () => {
  const emitter = new EventEmitter();

  emitter.on('bid', () => {});
  emitter.on('pass', () => {});
  emitter.clear('bid');

  assert.equal(emitter.listenerCount('bid'), 0);
  assert.equal(emitter.listenerCount('pass'), 1);

  emitter.clear();

  assert.equal(emitter.listenerCount('pass'), 0);
});

test('EventEmitter validates event names and listeners', () => {
  const emitter = new EventEmitter();

  assert.throws(() => emitter.on('', () => {}), TypeError);
  assert.throws(() => emitter.on('bid', null), TypeError);
});

test('GameError carries a stable code and a human-readable message', () => {
  const error = new GameError('UNKNOWN_CARD', 'Неизвестная карта: XX.', { cardId: 'XX' });

  assert.ok(error instanceof Error);
  assert.ok(error instanceof GameError);
  assert.equal(error.name, 'GameError');
  assert.equal(error.code, 'UNKNOWN_CARD');
  assert.equal(error.message, 'Неизвестная карта: XX.');
  assert.deepEqual(error.details, { cardId: 'XX' });
});
