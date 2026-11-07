import test from 'node:test';
import assert from 'node:assert/strict';

import { BIDDING, PHASES } from '../js/core/constants.js';
import { getCardById } from '../js/core/deck.js';
import { Game } from '../js/core/game.js';
import { mulberry32 } from '../js/core/rng.js';
import { getLegalCards } from '../js/core/rules.js';
import { createAI, chooseCard } from '../js/ai/ai.js';
import { evaluateHand } from '../js/ai/evaluate.js';
import { createFixedGame, getStatePlayer, PLAYERS } from './helpers.js';

const MARRIAGE_HANDS = {
  alice: ['HK', 'HQ', 'DK', 'DQ', 'SA', 'HA', 'DA'],
  boris: ['SJ', 'SQ', 'SK', 'S10', 'D9', 'D10', 'HJ'],
  human: ['C9', 'CQ', 'CK', 'CA', 'DJ', 'H9', 'H10'],
};
const MARRIAGE_PRIKUP = ['CJ', 'S9', 'C10'];

function createSeededGame(seed, targetScore = 1000) {
  const game = new Game({
    players: PLAYERS.map((player) => ({ ...player })),
    rng: mulberry32(seed),
    targetScore,
  });

  game.start();
  return game;
}

function createAIs(seed) {
  return Object.fromEntries(
    PLAYERS.map((player, index) => [
      player.id,
      createAI({
        playerId: player.id,
        rng: mulberry32(seed * 101 + index + 1),
      }),
    ]),
  );
}

function createBiddingView({ currentBid = 0, score = 0 } = {}) {
  return {
    phase: PHASES.BIDDING,
    currentBid,
    currentBidderId: 'alice',
    contract: null,
    declarerId: null,
    trumpSuit: null,
    completedTricks: [],
    currentTrick: [],
    givenCards: [],
    log: [],
    players: [
      {
        id: 'alice',
        name: 'Алиса',
        isHuman: false,
        score,
        hand: ['S9', 'SJ', 'SQ', 'SK', 'S10', 'SA', 'H9'],
        cardCount: 7,
        bid: null,
        passed: false,
        tricksWon: 0,
        trickPoints: 0,
        marriagePoints: 0,
        declaredMarriages: [],
        isDeclarer: false,
      },
      {
        id: 'boris',
        name: 'Борис',
        isHuman: false,
        score: 0,
        hand: [],
        cardCount: 7,
        bid: null,
        passed: false,
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
        passed: false,
        tricksWon: 0,
        trickPoints: 0,
        marriagePoints: 0,
        declaredMarriages: [],
        isDeclarer: false,
      },
    ],
  };
}

function createPlayingView({
  hand = ['HK', 'HQ', 'HA', 'S9', 'SJ', 'SQ', 'H9', 'H10'],
  pendingMarriage = null,
} = {}) {
  return {
    phase: PHASES.PLAYING,
    currentPlayerId: 'alice',
    declarerId: 'alice',
    contract: BIDDING.MIN,
    trumpSuit: null,
    currentTrick: [],
    completedTricks: [{}],
    givenCards: [],
    pendingMarriage,
    log: [],
    players: [
      {
        id: 'alice',
        name: 'Алиса',
        isHuman: false,
        score: 0,
        hand,
        cardCount: hand.length,
        bid: BIDDING.MIN,
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
        cardCount: 8,
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
        cardCount: 8,
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

function legalCardsFromView(view) {
  const self = view.players.find((player) => player.id === view.currentPlayerId);
  const leadSuit = view.currentTrick.length === 0
    ? null
    : getCardById(view.currentTrick[0].cardId).suit;

  return getLegalCards(self.hand, leadSuit, view.trumpSuit);
}

function handFromView(view, playerId) {
  return getStatePlayer(view, playerId).hand.map((cardId) => getCardById(cardId));
}

function runBidding(game, ais) {
  let actions = 0;

  while (game.getState().phase === PHASES.BIDDING) {
    const state = game.getState();
    const playerId = state.currentBidderId;
    const view = game.getPlayerView(playerId);
    const amount = ais[playerId].chooseBid(view, view.currentBid);

    game.bid(playerId, amount === null ? 'pass' : amount);

    actions += 1;
    assert.ok(actions < 20, 'Bidding must terminate.');
  }

  return game.getState();
}

function runGifts(game, ais) {
  let state = game.getState();
  const declarerId = state.declarerId;

  if (state.phase === PHASES.PRIKUP) {
    game.takePrikup(declarerId);
    state = game.getState();
  }

  const view = game.getPlayerView(declarerId);
  const gifts = ais[declarerId].chooseCardsToGive(view);

  assert.equal(gifts.length, 2);

  for (const gift of gifts) {
    game.giveCard(gift.toPlayerId, gift.cardId);
  }

  assert.equal(game.getState().phase, PHASES.PLAYING);
}

/**
 * Runs a deterministic bidding round where the opener takes the minimum bid
 * and both opponents pass, then gives two lowest cards away.
 */
function dealToPlaying(game) {
  const openerId = game.getState().currentBidderId;
  game.bid(openerId, BIDDING.MIN);

  while (game.getState().phase === PHASES.BIDDING) {
    const state = game.getState();
    game.bid(state.currentBidderId, 'pass');
  }

  let state = game.getState();
  const declarerId = state.declarerId;

  game.takePrikup(declarerId);
  state = game.getState();

  const hand = getStatePlayer(state, declarerId).hand
    .map((cardId) => getCardById(cardId))
    .sort((left, right) => left.value - right.value || left.strength - right.strength);
  const opponents = state.players.filter((player) => player.id !== declarerId);

  game.giveCard(opponents[0].id, hand[0].id);
  game.giveCard(opponents[1].id, hand[1].id);

  return game;
}

function playRandomCards(game, count, rng) {
  for (let index = 0; index < count; index += 1) {
    const state = game.getState();

    if (state.phase !== PHASES.PLAYING) {
      break;
    }

    const playerId = state.currentPlayerId;
    const hand = handFromView(state, playerId);
    const leadSuit = state.currentTrick.length === 0
      ? null
      : getCardById(state.currentTrick[0].cardId).suit;
    const legal = getLegalCards(hand, leadSuit, state.trumpSuit);
    const card = legal[Math.floor(rng() * legal.length)];

    game.playCard(playerId, card.id);
  }
}

test('evaluateHand derives its metrics from the given cards only', () => {
  const hand = ['HK', 'HQ', 'SA', 'H10', 'C9', 'D9', 'S9'];
  const evaluation = evaluateHand(hand);

  assert.equal(evaluation.cardCount, 7);
  assert.equal(evaluation.value, 4 + 3 + 11 + 10 + 0 + 0 + 0);
  assert.equal(evaluation.aces, 1);
  assert.equal(evaluation.tens, 1);
  assert.deepEqual(evaluation.suitLengths, { S: 2, C: 1, D: 1, H: 3 });
  assert.deepEqual(evaluation.potentialMarriages, [{ suit: 'H', value: 100 }]);
  assert.equal(evaluation.longestSuit, 'H');
  assert.ok(evaluation.expectedTricks > 0);
  assert.ok(evaluation.estimatedPoints > evaluation.value);
  assert.equal(Object.isFrozen(hand), false);
  assert.deepEqual(hand, ['HK', 'HQ', 'SA', 'H10', 'C9', 'D9', 'S9']);
});

test('AI chooses only legal cards across 100 random positions', () => {
  for (let seed = 1; seed <= 100; seed += 1) {
    const game = createSeededGame(seed);
    dealToPlaying(game);
    playRandomCards(game, seed % 17, mulberry32(seed * 7919));

    const state = game.getState();

    if (state.phase !== PHASES.PLAYING) {
      continue;
    }

    const playerId = state.currentPlayerId;
    const ai = createAI({ playerId, rng: mulberry32(seed * 104729) });
    const view = game.getPlayerView(playerId);
    const legal = legalCardsFromView(view);
    const legalIds = new Set(legal.map((card) => card.id));
    const stateBefore = JSON.stringify(game.getState());

    const card = ai.chooseCard(view, legal);

    assert.ok(legalIds.has(card.id), `Seed ${seed}: ${card.id} is not legal.`);
    assert.equal(JSON.stringify(game.getState()), stateBefore);
    assert.equal(Object.isFrozen(view), true);

    for (const player of view.players) {
      if (player.id !== playerId) {
        assert.deepEqual(player.hand, []);
      }
    }
  }
});

test('AI bids within 80-120, in steps of five and never passes the opener', () => {
  for (let seed = 1; seed <= 100; seed += 1) {
    const game = createSeededGame(seed);
    const ais = createAIs(seed);
    let actions = 0;

    while (game.getState().phase === PHASES.BIDDING) {
      const state = game.getState();
      const playerId = state.currentBidderId;
      const view = game.getPlayerView(playerId);
      const amount = ais[playerId].chooseBid(view, view.currentBid);

      if (amount === null) {
        assert.notEqual(state.currentBid, 0, 'The opener may not pass.');
        game.bid(playerId, 'pass');
      } else {
        assert.ok(Number.isInteger(amount), `Seed ${seed}: bid must be an integer.`);
        assert.ok(amount >= BIDDING.MIN && amount <= BIDDING.MAX);
        assert.equal(amount % BIDDING.STEP, 0);

        if (state.currentBid === 0) {
          assert.equal(amount, BIDDING.MIN);
        } else {
          assert.ok(amount > state.currentBid);
          assert.equal((amount - state.currentBid) % BIDDING.STEP, 0);
        }

        game.bid(playerId, amount);
      }

      actions += 1;
      assert.ok(actions < 20);
    }

    const result = game.getState();

    assert.notEqual(result.phase, PHASES.BIDDING);
    assert.ok(result.contract >= BIDDING.MIN && result.contract <= BIDDING.MAX);
    assert.ok(result.declarerId);
  }
});

test('AI opens 80 with a negative score and refuses to raise afterwards', () => {
  const ai = createAI({ playerId: 'alice', rng: () => 0.5 });
  const openingView = createBiddingView({ currentBid: 0, score: -80 });
  const raiseView = createBiddingView({ currentBid: 80, score: -80 });

  assert.equal(ai.chooseBid(openingView, 0), BIDDING.MIN);
  assert.equal(ai.chooseBid(raiseView, 80), null);
});

test('AI gives exactly one card to each opponent and keeps its marriages', () => {
  for (let seed = 1; seed <= 100; seed += 1) {
    const game = createSeededGame(seed);
    const ais = createAIs(seed);

    runBidding(game, ais);

    let state = game.getState();
    const declarerId = state.declarerId;

    game.takePrikup(declarerId);
    state = game.getState();

    const view = game.getPlayerView(declarerId);
    const handIds = new Set(getStatePlayer(view, declarerId).hand);
    const opponents = state.players
      .filter((player) => player.id !== declarerId)
      .map((player) => player.id);
    const gifts = ais[declarerId].chooseCardsToGive(view);

    assert.equal(gifts.length, 2);
    assert.deepEqual(
      gifts.map((gift) => gift.toPlayerId).sort(),
      [...opponents].sort(),
    );
    assert.equal(new Set(gifts.map((gift) => gift.cardId)).size, 2);

    for (const gift of gifts) {
      assert.ok(handIds.has(gift.cardId), 'A gift must come from the declarer hand.');
      game.giveCard(gift.toPlayerId, gift.cardId);
    }

    assert.equal(game.getState().phase, PHASES.PLAYING);
  }

  const game = createFixedGame({
    hands: MARRIAGE_HANDS,
    prikup: MARRIAGE_PRIKUP,
    dealerIndex: 0,
  });
  game.bid('alice', BIDDING.MIN);
  game.bid('boris', 'pass');
  game.bid('human', 'pass');
  game.takePrikup('alice');

  const aliceAI = createAI({ playerId: 'alice', rng: () => 0.5 });
  const view = game.getPlayerView('alice');
  const gifts = aliceAI.chooseCardsToGive(view);

  for (const suit of ['D', 'H']) {
    for (const rank of ['K', 'Q']) {
      assert.equal(
        gifts.some((gift) => gift.cardId === `${suit}${rank}`),
        false,
        `AI must not break the ${suit} marriage.`,
      );
    }
  }
});

test('AI declares a marriage when leading after the first trick', () => {
  const game = createFixedGame({
    hands: MARRIAGE_HANDS,
    prikup: MARRIAGE_PRIKUP,
    dealerIndex: 0,
  });
  game.bid('alice', BIDDING.MIN);
  game.bid('boris', 'pass');
  game.bid('human', 'pass');
  game.takePrikup('alice');

  const aliceAI = createAI({ playerId: 'alice', rng: () => 0.5 });
  const gifts = aliceAI.chooseCardsToGive(game.getPlayerView('alice'));

  for (const gift of gifts) {
    game.giveCard(gift.toPlayerId, gift.cardId);
  }

  assert.equal(game.getState().currentPlayerId, 'alice');
  game.playCard('alice', 'SA');

  while (game.getState().completedTricks.length === 0) {
    const state = game.getState();
    const playerId = state.currentPlayerId;
    const legal = legalCardsFromView(game.getPlayerView(playerId));

    game.playCard(playerId, legal[0].id);
  }

  let state = game.getState();

  assert.equal(state.completedTricks.length, 1);
  assert.equal(state.currentPlayerId, 'alice');

  const view = game.getPlayerView('alice');
  const suit = aliceAI.chooseMarriage(view);

  assert.notEqual(suit, null);
  assert.ok(view.availableMarriages.some((marriage) => marriage.suit === suit));
  assert.deepEqual(view.prikup, ['CJ', 'S9', 'C10']);

  game.declareMarriage('alice', suit);

  state = game.getState();

  assert.equal(state.pendingMarriage.suit, suit);
  assert.equal(state.trumpSuit, null);
  assert.equal(getStatePlayer(state, 'alice').marriagePoints, 0);
  assert.equal(aliceAI.chooseMarriage(game.getPlayerView('alice')), null);

  const pendingView = game.getPlayerView('alice');
  const card = aliceAI.chooseCard(pendingView, legalCardsFromView(pendingView));

  assert.equal(card.suit, suit);
  assert.ok(card.rank === 'K' || card.rank === 'Q');

  state = game.playCard('alice', card.id);

  assert.equal(state.pendingMarriage, null);
  assert.equal(state.trumpSuit, suit);
  assert.equal(state.trumpDeclaredBy, 'alice');
  assert.ok(getStatePlayer(state, 'alice').marriagePoints > 0);
  assert.deepEqual(getStatePlayer(state, 'alice').declaredMarriages, [suit]);
});

test('AI fallback keeps a pending marriage limited to the king or queen', () => {
  const pendingMarriage = { playerId: 'alice', suit: 'H', value: 100 };
  const view = createPlayingView({ pendingMarriage });
  const ai = createAI({ playerId: 'alice', rng: () => 0.5 });
  const originalError = console.error;

  console.error = () => {};

  try {
    const card = chooseCard(view, ['X9']);

    assert.equal(card.suit, 'H');
    assert.ok(card.rank === 'K' || card.rank === 'Q');
    assert.equal(ai.chooseMarriage(view), null);
  } finally {
    console.error = originalError;
  }
});

test('AI sees no prikup during bidding but sees it after the public reveal', () => {
  for (let seed = 1; seed <= 25; seed += 1) {
    const game = createSeededGame(seed);
    const ais = createAIs(seed);
    const biddingState = game.getState();

    for (const player of biddingState.players) {
      const view = game.getPlayerView(player.id);

      assert.deepEqual(view.prikup, []);
      assert.equal(view.prikupRevealed, false);
      assert.equal(view.prikupTaken, false);
      assert.equal(view.players.filter((entry) => entry.hand.length > 0).length, 1);
      assert.equal(Object.hasOwn(view, 'deck'), false);
    }

    const revealedState = runBidding(game, ais);
    const declarerId = revealedState.declarerId;

    assert.equal(revealedState.phase, PHASES.PRIKUP);
    assert.equal(revealedState.prikupRevealed, true);
    assert.equal(revealedState.prikupTaken, false);

    for (const player of revealedState.players) {
      const view = game.getPlayerView(player.id);
      const visibleHands = view.players.filter((entry) => entry.hand.length > 0);

      assert.equal(visibleHands.length, 1);
      assert.equal(visibleHands[0].id, player.id);
      assert.equal(Object.hasOwn(view, 'deck'), false);
      assert.deepEqual(view.prikup, revealedState.prikup);
      assert.equal(view.prikup.length, 3);
      assert.equal(view.prikupRevealed, true);
      assert.equal(view.prikupTaken, false);
    }

    game.takePrikup(declarerId);

    for (const player of revealedState.players) {
      const view = game.getPlayerView(player.id);

      assert.deepEqual(view.prikup, revealedState.prikup);
      assert.equal(view.prikupTaken, true);
    }
  }
});

test('AI decisions do not mutate the game state', () => {
  const game = createSeededGame(777);
  const ais = createAIs(777);

  runBidding(game, ais);

  let state = game.getState();
  const declarerId = state.declarerId;

  game.takePrikup(declarerId);

  let view = game.getPlayerView(declarerId);
  let before = JSON.stringify(game.getState());

  ais[declarerId].chooseCardsToGive(view);
  assert.equal(JSON.stringify(game.getState()), before);

  runGifts(game, ais);

  state = game.getState();
  const playerId = state.currentPlayerId;
  view = game.getPlayerView(playerId);
  before = JSON.stringify(game.getState());

  ais[playerId].chooseMarriage(view);
  ais[playerId].chooseCard(view, legalCardsFromView(view));
  assert.equal(JSON.stringify(game.getState()), before);

  const freshGame = createSeededGame(778);
  const freshView = freshGame.getPlayerView(freshGame.getState().currentBidderId);
  const bidBefore = JSON.stringify(freshGame.getState());

  createAIs(778)[freshGame.getState().currentBidderId].chooseBid(freshView);
  assert.equal(JSON.stringify(freshGame.getState()), bidBefore);
});

test('AI falls back to the first legal card and logs an error', () => {
  const game = createSeededGame(999);
  dealToPlaying(game);

  const state = game.getState();
  const playerId = state.currentPlayerId;
  const view = game.getPlayerView(playerId);
  const legal = legalCardsFromView(view);
  const originalError = console.error;
  const errors = [];

  console.error = (...args) => {
    errors.push(args);
  };

  try {
    const card = chooseCard(view, ['X9']);

    assert.ok(legal.some((entry) => entry.id === card.id));
    assert.equal(errors.length, 1);
    // The fallback uses the legal list derived from the view.
    assert.equal(card.id, legal[0].id);
  } finally {
    console.error = originalError;
  }
});

test('a full AI game finishes within a reasonable deal limit', () => {
  const seeds = [1, 7, 42, 2026];

  for (const seed of seeds) {
    const game = createSeededGame(seed);
    const ais = createAIs(seed);
    let deals = 1;
    let actions = 0;

    while (game.getState().phase !== PHASES.GAME_OVER) {
      const state = game.getState();

      switch (state.phase) {
        case PHASES.BIDDING: {
          const playerId = state.currentBidderId;
          const view = game.getPlayerView(playerId);
          const amount = ais[playerId].chooseBid(view, view.currentBid);

          game.bid(playerId, amount === null ? 'pass' : amount);
          break;
        }

        case PHASES.PRIKUP:
          game.takePrikup(state.declarerId);
          break;

        case PHASES.GIVING: {
          const playerId = state.declarerId;
          const view = game.getPlayerView(playerId);

          if (!state.raiseDecided && state.givenCards.length === 0) {
            const amount = ais[playerId].chooseContractRaise(view);

            game.raiseContract(playerId, amount);
            break;
          }

          const gifts = ais[playerId].chooseCardsToGive(view);

          assert.equal(gifts.length, 2);

          for (const gift of gifts) {
            game.giveCard(gift.toPlayerId, gift.cardId);
          }

          break;
        }

        case PHASES.PLAYING: {
          const playerId = state.currentPlayerId;
          let view = game.getPlayerView(playerId);
          const suit = ais[playerId].chooseMarriage(view);

          if (suit !== null) {
            game.declareMarriage(playerId, suit);
            view = game.getPlayerView(playerId);
          }

          const card = ais[playerId].chooseCard(view, legalCardsFromView(view));

          game.playCard(playerId, card.id);
          break;
        }

        case PHASES.DEAL_END:
          deals += 1;
          assert.ok(deals <= 200, `Seed ${seed}: game took too many deals.`);
          game.nextDeal();
          break;

        default:
          throw new Error(`Seed ${seed}: unexpected phase ${state.phase}.`);
      }

      actions += 1;
      assert.ok(actions < 50000, `Seed ${seed}: too many actions.`);
    }

    const finalState = game.getState();

    assert.equal(finalState.phase, PHASES.GAME_OVER);
    assert.ok(finalState.winnerId);
    assert.ok(finalState.players.every((player) => Number.isInteger(player.score)));
  }
});
