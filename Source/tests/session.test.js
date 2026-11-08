import test from 'node:test';
import assert from 'node:assert/strict';

import { BIDDING, GAME_EVENTS, PHASES } from '../js/core/constants.js';
import { getCardById } from '../js/core/deck.js';
import { getLegalCards } from '../js/core/rules.js';
import { createAI } from '../js/ai/ai.js';
import { LocalSession } from '../js/session/local-session.js';

const PLAYERS = Object.freeze([
  Object.freeze({ id: 'host', name: 'Иван', isHuman: true }),
  Object.freeze({ id: 'alice', name: 'Алиса', isHuman: false }),
  Object.freeze({ id: 'boris', name: 'Борис', isHuman: false }),
]);

const MULTI_HUMAN_PLAYERS = Object.freeze([
  Object.freeze({ id: 'host', name: 'Иван', isHuman: true }),
  Object.freeze({ id: 'guest', name: 'Анна', isHuman: true }),
  Object.freeze({ id: 'ai', name: 'Борис', isHuman: false }),
]);

/**
 * @param {object} [overrides]
 * @returns {LocalSession}
 */
function createSession(overrides = {}) {
  return new LocalSession({
    players: PLAYERS,
    humanId: 'host',
    seed: 33,
    targetScore: 1000,
    ...overrides,
  });
}

/**
 * @param {object} state
 * @param {string} playerId
 * @returns {object}
 */
function getPlayer(state, playerId) {
  return state.players.find((player) => player.id === playerId);
}

/**
 * @param {object} view
 * @returns {import('../js/core/deck.js').Card[]}
 */
function legalCardsFromView(view) {
  const self = getPlayer(view, view.currentPlayerId);
  const leadSuit = view.currentTrick.length === 0
    ? null
    : getCardById(view.currentTrick[0].cardId).suit;

  return getLegalCards(self.hand, leadSuit, view.trumpSuit);
}

test('LocalSession exposes only the viewer player view', () => {
  const session = createSession();

  assert.equal(session.getState(), null);
  session.start();

  const state = session.getState();

  assert.equal(state.viewerId, 'host');
  assert.equal(getPlayer(state, 'host').hand.length, 7);
  assert.deepEqual(getPlayer(state, 'alice').hand, []);
  assert.deepEqual(getPlayer(state, 'boris').hand, []);
  assert.equal(getPlayer(state, 'alice').cardCount, 7);
  assert.equal(getPlayer(state, 'alice').isAI, true);
  assert.equal(getPlayer(state, 'boris').isAI, true);
  assert.equal(getPlayer(state, 'host').isAI, false);
  assert.deepEqual(state.prikup, []);
  assert.equal(state.log.some((entry) => entry.type === 'dealstarted'), true);

  const aliceView = session.getPlayerView('alice');

  assert.equal(aliceView.viewerId, 'alice');
  assert.equal(getPlayer(aliceView, 'alice').hand.length, 7);
  assert.deepEqual(getPlayer(aliceView, 'host').hand, []);
  assert.deepEqual(getPlayer(aliceView, 'boris').hand, []);
});

test('LocalSession filters hands for a second live person in the same room', () => {
  const session = new LocalSession({
    players: MULTI_HUMAN_PLAYERS,
    humanId: 'host',
    seed: 5,
  });

  session.start();

  const hostView = session.getState();

  assert.equal(hostView.viewerId, 'host');
  assert.deepEqual(getPlayer(hostView, 'guest').hand, []);
  assert.equal(getPlayer(hostView, 'guest').cardCount, 7);
  assert.equal(getPlayer(hostView, 'guest').isAI, false);
  assert.equal(getPlayer(hostView, 'ai').isAI, true);

  const guestView = session.getPlayerView('guest');

  assert.equal(guestView.viewerId, 'guest');
  assert.equal(getPlayer(guestView, 'guest').hand.length, 7);
  assert.deepEqual(getPlayer(guestView, 'host').hand, []);
});

test('LocalSession shares card counts, revealed prikup and the public log', () => {
  const session = createSession();

  session.start();

  let state = session.getState();
  const openerId = state.currentBidderId;

  session.bid(openerId, BIDDING.MIN);

  while (session.getState().phase === PHASES.BIDDING) {
    session.bid(session.getState().currentBidderId, 'pass');
  }

  state = session.getState();

  assert.equal(state.phase, PHASES.PRIKUP);
  assert.equal(state.prikup.length, 3);
  assert.equal(state.prikupRevealed, true);
  assert.equal(state.prikupTaken, false);

  const declarerId = state.declarerId;
  const otherId = PLAYERS.find((player) => player.id !== declarerId).id;
  const otherView = session.getPlayerView(otherId);

  assert.equal(otherView.viewerId, otherId);
  assert.deepEqual(otherView.prikup, state.prikup);

  for (const player of otherView.players) {
    if (player.id !== otherId) {
      assert.deepEqual(player.hand, []);
    }
  }

  const logTypes = state.log.map((entry) => entry.type);

  assert.ok(logTypes.includes('dealstarted'));
  assert.ok(logTypes.includes('bid'));
  assert.ok(logTypes.includes('pass'));
  assert.ok(logTypes.includes('prikuprevealed'));

  if (declarerId === session.humanId) {
    assert.equal(getPlayer(state, declarerId).hand.length, 7);
  } else {
    assert.equal(getPlayer(state, declarerId).cardCount, 7);
    assert.deepEqual(getPlayer(state, declarerId).hand, []);
  }

  session.takePrikup(declarerId);

  state = session.getState();

  assert.equal(state.prikupTaken, true);
  assert.equal(state.prikup.length, 3);
  assert.equal(state.log.some((entry) => entry.type === 'prikup'), true);
});

test('LocalSession delegates actions and returns a fresh player view', () => {
  const session = createSession();

  session.start();

  const state = session.getState();
  const openerId = state.currentBidderId;
  const afterBid = session.bid(openerId, BIDDING.MIN);

  assert.equal(afterBid.viewerId, 'host');
  assert.equal(afterBid.currentBid, BIDDING.MIN);
  assert.deepEqual(getPlayer(afterBid, 'alice').hand, []);
});

test('LocalSession keeps listeners across restart and forwards only views', () => {
  const session = createSession();
  const states = [];
  const bids = [];
  const unsubscribe = session.subscribe((state) => {
    states.push(state);
    assert.equal(state.viewerId, 'host');
    assert.deepEqual(getPlayer(state, 'alice').hand, []);
  });
  const offBid = session.on(GAME_EVENTS.BID, (payload) => bids.push(payload));

  session.start();

  assert.ok(states.length >= 1);

  session.bid(session.getState().currentBidderId, BIDDING.MIN);

  assert.equal(bids.length, 1);
  assert.equal(bids[0].amount, BIDDING.MIN);

  const statesBeforeRestart = states.length;

  session.restart();

  assert.equal(session.gameIndex, 1);
  assert.ok(states.length > statesBeforeRestart);
  assert.equal(session.getState().viewerId, 'host');
  assert.equal(session.getState().dealNumber, 1);

  unsubscribe();
  offBid();
});

test('LocalSession createAIRng is deterministic per player and game index', () => {
  const session = createSession();

  session.start();

  const aliceA = session.createAIRng('alice');
  const aliceB = session.createAIRng('alice');
  const boris = session.createAIRng('boris');
  const aliceValues = [aliceA(), aliceA(), aliceA(), aliceA()];
  const aliceRepeat = [aliceB(), aliceB(), aliceB(), aliceB()];
  const borisValues = [boris(), boris(), boris(), boris()];

  assert.deepEqual(aliceValues, aliceRepeat);
  assert.notDeepEqual(aliceValues, borisValues);

  session.restart();

  const nextIndex = session.createAIRng('alice');
  const nextValues = [nextIndex(), nextIndex(), nextIndex(), nextIndex()];

  assert.notDeepEqual(aliceValues, nextValues);
});

test('LocalSession dispose releases the game and stops forwarding', () => {
  const session = createSession();
  let changes = 0;
  const unsubscribe = session.subscribe(() => {
    changes += 1;
  });

  session.start();

  const changesBeforeDispose = changes;

  session.dispose();

  assert.equal(session.getState(), null);
  assert.equal(session.started, false);
  assert.equal(changes, changesBeforeDispose);
  assert.throws(() => session.getPlayerView('host'), /не начата/);

  unsubscribe();
});

test('a local game driven through LocalSession reaches the end', () => {
  const session = new LocalSession({
    players: PLAYERS,
    humanId: 'host',
    seed: 42,
    targetScore: BIDDING.MIN,
  });
  const ais = Object.fromEntries(
    PLAYERS.map((player) => [
      player.id,
      createAI({ playerId: player.id, rng: session.createAIRng(player.id) }),
    ]),
  );

  session.start();

  let deals = 1;
  let actions = 0;

  while (session.getState().phase !== PHASES.GAME_OVER) {
    const state = session.getState();

    switch (state.phase) {
      case PHASES.BIDDING: {
        const playerId = state.currentBidderId;
        const view = session.getPlayerView(playerId);
        const amount = ais[playerId].chooseBid(view, state.currentBid);

        session.bid(playerId, amount === null ? 'pass' : amount);
        break;
      }

      case PHASES.PRIKUP:
        session.takePrikup(state.declarerId);
        break;

      case PHASES.GIVING: {
        const playerId = state.declarerId;
        const view = session.getPlayerView(playerId);

        if (!state.raiseDecided && state.givenCards.length === 0) {
          session.raiseContract(playerId, ais[playerId].chooseContractRaise(view));
          break;
        }

        const gifts = ais[playerId].chooseCardsToGive(view);

        for (const gift of gifts) {
          session.giveCard(gift.toPlayerId, gift.cardId);
        }

        break;
      }

      case PHASES.PLAYING: {
        const playerId = state.currentPlayerId;
        let view = session.getPlayerView(playerId);
        const suit = ais[playerId].chooseMarriage(view);

        if (suit !== null) {
          session.declareMarriage(playerId, suit);
          view = session.getPlayerView(playerId);
        }

        const card = ais[playerId].chooseCard(view, legalCardsFromView(view));

        session.playCard(playerId, card.id);
        break;
      }

      case PHASES.DEAL_END:
        deals += 1;
        assert.ok(deals <= 200, 'The local game must finish within 200 deals.');
        session.nextDeal();
        break;

      default:
        throw new Error(`Unexpected phase ${state.phase}.`);
    }

    actions += 1;
    assert.ok(actions < 50000, 'The local game must finish within 50000 actions.');
  }

  const finalState = session.getState();

  assert.equal(finalState.phase, PHASES.GAME_OVER);
  assert.ok(finalState.winnerId);
  assert.ok(finalState.players.every((player) => Number.isInteger(player.score)));
});
