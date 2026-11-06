import { BIDDING, PHASES } from '../js/core/constants.js';
import { createDeck, getCardById } from '../js/core/deck.js';
import { Game } from '../js/core/game.js';
import { mulberry32 } from '../js/core/rng.js';
import { getLegalCards } from '../js/core/rules.js';

/** The canonical three-player seating order used by the game. */
export const PLAYERS = Object.freeze([
  Object.freeze({ id: 'human', name: 'Вы', isHuman: true }),
  Object.freeze({ id: 'alice', name: 'Алиса', isHuman: false }),
  Object.freeze({ id: 'boris', name: 'Борис', isHuman: false }),
]);

const HAND_SIZE = 7;
const PRIKUP_SIZE = 3;
const CARD_COUNT = 24;

/**
 * Builds a complete deck in deal order for the given hands and dealer.
 *
 * Deal order starts with the player to the left of the dealer, then goes
 * clockwise one card at a time. The last three cards form the prikup.
 *
 * @param {object} options
 * @param {Record<string, string[]>} options.hands Seven card ids per player.
 * @param {string[]} options.prikup Three card ids.
 * @param {number} [options.dealerIndex]
 * @returns {string[]}
 */
export function buildDeck({ hands, prikup, dealerIndex = 0 }) {
  if (!Number.isInteger(dealerIndex) || dealerIndex < 0 || dealerIndex >= PLAYERS.length) {
    throw new Error(`Invalid dealer index: ${dealerIndex}.`);
  }

  if (!Array.isArray(prikup) || prikup.length !== PRIKUP_SIZE) {
    throw new Error(`Prikup must contain ${PRIKUP_SIZE} cards.`);
  }

  for (const player of PLAYERS) {
    if (!Array.isArray(hands?.[player.id]) || hands[player.id].length !== HAND_SIZE) {
      throw new Error(`Player ${player.id} must have exactly ${HAND_SIZE} cards.`);
    }
  }

  const allIds = [
    ...PLAYERS.flatMap((player) => hands[player.id]),
    ...prikup,
  ];

  if (allIds.length !== CARD_COUNT) {
    throw new Error(`The deck must contain ${CARD_COUNT} cards.`);
  }

  const uniqueIds = new Set(allIds);

  if (uniqueIds.size !== CARD_COUNT) {
    throw new Error('The deck contains duplicate cards.');
  }

  const standardIds = new Set(createDeck().map((card) => card.id));

  for (const cardId of allIds) {
    if (!standardIds.has(cardId)) {
      throw new Error(`Unknown card id: ${cardId}.`);
    }

    getCardById(cardId);
  }

  if ([...standardIds].some((cardId) => !uniqueIds.has(cardId))) {
    throw new Error('The deck is incomplete.');
  }

  const firstIndex = (dealerIndex + 1) % PLAYERS.length;
  const deck = [];

  for (let round = 0; round < HAND_SIZE; round += 1) {
    for (let offset = 0; offset < PLAYERS.length; offset += 1) {
      const player = PLAYERS[(firstIndex + offset) % PLAYERS.length];
      deck.push(hands[player.id][round]);
    }
  }

  deck.push(...prikup);
  return deck;
}

/**
 * Creates and starts a game with a fully controlled deck.
 *
 * @param {object} options
 * @param {Record<string, string[]>} options.hands
 * @param {string[]} options.prikup
 * @param {number} [options.dealerIndex]
 * @param {number} [options.targetScore]
 * @returns {Game}
 */
export function createFixedGame({
  hands,
  prikup,
  dealerIndex = 0,
  targetScore = 1000,
}) {
  const deck = buildDeck({ hands, prikup, dealerIndex });
  const rng = () => (dealerIndex + 0.5) / PLAYERS.length;
  const game = new Game({
    players: PLAYERS.map((player) => ({ ...player })),
    rng,
    targetScore,
    deck,
  });

  game.start();
  return game;
}

/**
 * Creates and starts a game with the standard deck order. Hand contents are
 * irrelevant for bidding tests; only the deterministic dealer matters.
 *
 * @param {object} [options]
 * @param {number} [options.dealerIndex]
 * @param {number} [options.targetScore]
 * @returns {Game}
 */
export function createBiddingGame({ dealerIndex = 0, targetScore = 1000 } = {}) {
  const rng = () => (dealerIndex + 0.5) / PLAYERS.length;
  const game = new Game({
    players: PLAYERS.map((player) => ({ ...player })),
    rng,
    targetScore,
    deck: createDeck(),
  });

  game.start();
  return game;
}

/**
 * Finds a player entry in a state snapshot.
 *
 * @param {object} state
 * @param {string} playerId
 * @returns {object}
 */
export function getStatePlayer(state, playerId) {
  const player = state.players.find((entry) => entry.id === playerId);

  if (!player) {
    throw new Error(`Unknown player in state: ${playerId}.`);
  }

  return player;
}

/**
 * Plays the first legal card for the current player. Useful for running a
 * deterministic deal to completion without building an AI.
 *
 * @param {Game} game
 * @returns {object} The resulting state snapshot.
 */
export function playFirstLegal(game) {
  const state = game.getState();
  const playerId = state.currentPlayerId;

  if (!playerId) {
    throw new Error(`No acting player in phase ${state.phase}.`);
  }

  const player = getStatePlayer(state, playerId);
  const leadSuit = state.currentTrick.length === 0
    ? null
    : getCardById(state.currentTrick[0].cardId).suit;
  const legalCards = getLegalCards(player.hand, leadSuit, state.trumpSuit);

  if (legalCards.length === 0) {
    throw new Error(`Player ${playerId} has no legal cards.`);
  }

  return game.playCard(playerId, legalCards[0].id);
}

/**
 * @param {object} state
 * @returns {object}
 */
function chooseSimpleCard(state) {
  const player = state.players.find((entry) => entry.id === state.currentPlayerId);
  const leadSuit = state.currentTrick.length === 0
    ? null
    : getCardById(state.currentTrick[0].cardId).suit;
  const legal = getLegalCards(player.hand, leadSuit, state.trumpSuit)
    .sort((left, right) => left.strength - right.strength);

  return player.id === state.declarerId
    ? legal[0]
    : legal[legal.length - 1];
}

/**
 * Plays one deterministic deal: the opener wins with the minimum bid, the
 * declarer takes the prikup and gives cards, then cards are played to finish.
 *
 * @param {Game} game
 * @returns {void}
 */
function playSimpleDeal(game) {
  let actions = 0;

  while (game.getState().phase !== PHASES.DEAL_END) {
    const state = game.getState();

    if (state.phase === PHASES.BIDDING) {
      const bidder = state.players.find((player) => player.id === state.currentBidderId);

      if (state.currentBid === 0) {
        game.bid(state.currentBidderId, BIDDING.MIN);
      } else if (bidder.score >= 0) {
        game.bid(state.currentBidderId, BIDDING.MAX);
      } else {
        throw new Error('A negative player must be passed automatically.');
      }
    } else if (state.phase === PHASES.PRIKUP) {
      game.takePrikup(state.declarerId);
    } else if (state.phase === PHASES.GIVING) {
      const declarer = state.players.find((player) => player.id === state.declarerId);
      const received = new Set(state.givenCards.map((gift) => gift.toId));
      const target = state.players.find(
        (player) => player.id !== declarer.id && !received.has(player.id),
      );
      const givenCardIds = new Set(state.givenCards.map((gift) => gift.cardId));
      const cardId = declarer.hand.find((id) => !givenCardIds.has(id));

      game.giveCard(target.id, cardId);
    } else if (state.phase === PHASES.PLAYING) {
      game.playCard(state.currentPlayerId, chooseSimpleCard(state).id);
    } else {
      throw new Error(`Unexpected phase ${state.phase} while playing a simple deal.`);
    }

    actions += 1;

    if (actions >= 100) {
      throw new Error('A simple deal must finish.');
    }
  }
}

/**
 * Plays deterministic deals until every player has a negative score and a new
 * bidding phase starts. Used by negative-score scenarios in tests.
 *
 * @param {object} [options]
 * @param {number} [options.seed]
 * @param {number} [options.maxDeals]
 * @returns {Game}
 */
export function createAllNegativeBiddingGame({ seed = 1, maxDeals = 200 } = {}) {
  const game = new Game({
    players: PLAYERS.map((player) => ({ ...player })),
    rng: mulberry32(seed),
    targetScore: 1_000_000_000,
  });
  game.start();

  let deals = 0;

  while (deals < maxDeals) {
    const state = game.getState();

    if (
      state.phase === PHASES.BIDDING
      && state.players.every((player) => player.score < 0)
    ) {
      return game;
    }

    if (state.phase === PHASES.DEAL_END) {
      deals += 1;
      game.nextDeal();
    } else {
      playSimpleDeal(game);
    }
  }

  throw new Error('Could not reach a bidding state with all players negative.');
}
