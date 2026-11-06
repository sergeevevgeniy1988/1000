import { DEAL, MARRIAGE_BONUSES, RANK_INFO, SUITS } from '../core/constants.js';
import { getCardById } from '../core/deck.js';
import { GameError } from '../core/errors.js';

/**
 * @typedef {import('../core/deck.js').Card} Card
 * @typedef {Card | string} CardLike
 */

/**
 * How often a card of the given rank is expected to win the trick it is
 * played into. These values are deliberately rough: AI uses them as heuristics,
 * never as a full-deck calculation.
 */
const CAPTURE_PROBABILITY = Object.freeze({
  A: 0.92,
  '10': 0.8,
  K: 0.48,
  Q: 0.28,
  J: 0.14,
  '9': 0.05,
});

/**
 * Resolves a card object or its stable id to a canonical deck card.
 *
 * @param {CardLike} cardLike
 * @returns {Card}
 * @throws {GameError} When the value is not a valid card.
 */
export function resolveCard(cardLike) {
  if (typeof cardLike === 'string') {
    return getCardById(cardLike);
  }

  if (cardLike && typeof cardLike === 'object' && typeof cardLike.id === 'string') {
    return getCardById(cardLike.id);
  }

  throw new GameError('INVALID_CARD', 'Карта должна быть объектом или стабильным идентификатором.');
}

/**
 * Resolves a hand without mutating the source array.
 *
 * @param {ReadonlyArray<CardLike>} cards
 * @returns {Card[]}
 * @throws {GameError} When the hand is not an array.
 */
export function resolveCards(cards) {
  if (!Array.isArray(cards)) {
    throw new GameError('INVALID_ARGUMENT', 'Рука должна быть массивом карт.');
  }

  return cards.map(resolveCard);
}

/**
 * Counts cards per suit.
 *
 * @param {ReadonlyArray<CardLike>} cards
 * @returns {Record<string, number>}
 */
export function getSuitLengths(cards) {
  const resolved = resolveCards(cards);
  const lengths = Object.fromEntries(SUITS.map((suit) => [suit, 0]));

  for (const card of resolved) {
    lengths[card.suit] += 1;
  }

  return lengths;
}

/**
 * Lists king-queen pairs that can still become marriages.
 *
 * @param {ReadonlyArray<CardLike>} cards
 * @returns {{ suit: string, value: number }[]}
 */
export function getPotentialMarriages(cards) {
  const resolved = resolveCards(cards);
  const ranksBySuit = new Map();

  for (const card of resolved) {
    const ranks = ranksBySuit.get(card.suit) ?? new Set();
    ranks.add(card.rank);
    ranksBySuit.set(card.suit, ranks);
  }

  return SUITS.filter((suit) => {
    const ranks = ranksBySuit.get(suit);

    return Boolean(ranks && ranks.has('K') && ranks.has('Q'));
  }).map((suit) => ({
    suit,
    value: MARRIAGE_BONUSES[suit],
  }));
}

/**
 * Estimates how many tricks the hand can win. The estimate is based only on
 * the cards in the hand and their ranks; it does not look at other hands.
 *
 * @param {ReadonlyArray<CardLike>} cards
 * @returns {number} Expected tricks, from 0 to 8.
 */
export function estimateWinningTricks(cards) {
  const resolved = resolveCards(cards);
  let tricks = 0;

  for (const suit of SUITS) {
    const suitCards = resolved.filter((card) => card.suit === suit);
    const ranks = new Set(suitCards.map((card) => card.rank));
    const hasAce = ranks.has('A');
    const hasTen = ranks.has('10');
    const hasKing = ranks.has('K');
    const hasQueen = ranks.has('Q');

    if (hasAce) {
      tricks += 1;
    }

    if (hasTen) {
      tricks += hasAce ? 0.9 : 0.8;
    }

    if (hasKing) {
      tricks += hasAce || hasTen ? 0.25 : 0.55;
    }

    if (hasQueen) {
      tricks += hasKing || hasAce || hasTen ? 0.1 : 0.25;
    }

    if (suitCards.length >= 4 && (hasAce || hasTen)) {
      tricks += 0.2;
    }
  }

  return Math.min(DEAL.TRICKS, Math.round(tricks * 100) / 100);
}

/**
 * Evaluates a hand for bidding and play. All returned metrics are derived from
 * the given cards only.
 *
 * @param {ReadonlyArray<CardLike>} cards
 * @returns {{
 *   cardCount: number,
 *   value: number,
 *   aces: number,
 *   tens: number,
 *   kings: number,
 *   queens: number,
 *   nines: number,
 *   highCardCount: number,
 *   suitLengths: Record<string, number>,
 *   longestSuit: string | null,
 *   longestSuitLength: number,
 *   potentialMarriages: { suit: string, value: number }[],
 *   marriageBonus: number,
 *   expectedTricks: number,
 *   captureEstimate: number,
 *   trickPointEstimate: number,
 *   estimatedPoints: number,
 * }}
 */
export function evaluateHand(cards) {
  const resolved = resolveCards(cards);
  const suitLengths = getSuitLengths(resolved);
  const potentialMarriages = getPotentialMarriages(resolved);
  const expectedTricks = estimateWinningTricks(resolved);

  let value = 0;
  let aces = 0;
  let tens = 0;
  let kings = 0;
  let queens = 0;
  let nines = 0;
  let captureEstimate = 0;

  for (const card of resolved) {
    value += card.value;
    captureEstimate += card.value * (CAPTURE_PROBABILITY[card.rank] ?? 0.2);

    switch (card.rank) {
      case 'A':
        aces += 1;
        break;
      case '10':
        tens += 1;
        break;
      case 'K':
        kings += 1;
        break;
      case 'Q':
        queens += 1;
        break;
      case '9':
        nines += 1;
        break;
      default:
        break;
    }
  }

  const longestSuit = SUITS.reduce((best, suit) => (
    best === null || suitLengths[suit] > suitLengths[best] ? suit : best
  ), null);
  const longestSuitLength = longestSuit === null ? 0 : suitLengths[longestSuit];
  const marriageBonus = potentialMarriages.reduce((sum, marriage) => sum + marriage.value, 0);
  const trickPointEstimate = captureEstimate + expectedTricks * 5.5;

  // The prikup is not visible during bidding, so every potential declarer gets
  // the same small expected bonus for the three cards they will receive.
  const prikupBonus = 8;
  const estimatedPoints = trickPointEstimate + marriageBonus * 0.85 + prikupBonus;

  return {
    cardCount: resolved.length,
    value,
    aces,
    tens,
    kings,
    queens,
    nines,
    highCardCount: aces + tens,
    suitLengths,
    longestSuit,
    longestSuitLength,
    potentialMarriages,
    marriageBonus,
    expectedTricks,
    captureEstimate: Math.round(captureEstimate * 10) / 10,
    trickPointEstimate: Math.round(trickPointEstimate * 10) / 10,
    estimatedPoints: Math.round(estimatedPoints * 10) / 10,
  };
}

/**
 * Returns ids of cards that are the highest remaining cards of their suit.
 * "Remaining" means not in the hand and not among already played cards.
 *
 * @param {ReadonlyArray<CardLike>} hand
 * @param {ReadonlyArray<CardLike>} [playedCards]
 * @returns {Set<string>}
 */
export function getBossCardIds(hand, playedCards = []) {
  const own = resolveCards(hand);
  const ownIds = new Set(own.map((card) => card.id));
  const playedIds = new Set();

  for (const entry of playedCards) {
    if (typeof entry === 'string') {
      playedIds.add(entry);
    } else if (entry && typeof entry === 'object' && typeof entry.id === 'string') {
      playedIds.add(entry.id);
    }
  }

  const bossIds = new Set();

  for (const card of own) {
    let hasUnseenHigher = false;

    for (const rank of Object.keys(RANK_INFO)) {
      if (RANK_INFO[rank].strength <= card.strength) {
        continue;
      }

      const strongerId = `${card.suit}${rank}`;

      if (!ownIds.has(strongerId) && !playedIds.has(strongerId)) {
        hasUnseenHigher = true;
        break;
      }
    }

    if (!hasUnseenHigher) {
      bossIds.add(card.id);
    }
  }

  return bossIds;
}

/**
 * Estimates the danger of giving a card away during the prikup exchange.
 * Higher values mean the card should be kept.
 *
 * @param {CardLike} cardLike
 * @param {ReadonlyArray<CardLike>} hand
 * @param {object} [context]
 * @param {ReadonlyArray<string>} [context.declaredMarriages]
 * @param {string | null} [context.trumpSuit]
 * @returns {number}
 */
export function evaluateGiftRisk(cardLike, hand, context = {}) {
  const card = resolveCard(cardLike);
  const cards = resolveCards(hand);
  const declared = new Set(context.declaredMarriages ?? []);
  const sameSuit = cards.filter((entry) => entry.suit === card.suit);
  const hasPartner = (card.rank === 'K' && sameSuit.some((entry) => entry.rank === 'Q'))
    || (card.rank === 'Q' && sameSuit.some((entry) => entry.rank === 'K'));

  let risk = card.value * 8 + card.strength * 1.5;

  switch (card.rank) {
    case 'A':
      risk += 30;
      break;
    case '10':
      risk += 28;
      break;
    case 'K':
      risk += 8;
      break;
    case 'Q':
      risk += 6;
      break;
    case 'J':
      risk += 2;
      break;
    default:
      break;
  }

  if (!declared.has(card.suit) && hasPartner) {
    risk += 140;
  }

  if (context.trumpSuit === card.suit) {
    risk += 18;
  }

  if (sameSuit.length >= 3) {
    risk -= (sameSuit.length - 2) * 1.2;
  }

  if (sameSuit.length === 1 && card.value <= 4) {
    risk -= 3;
  }

  return Math.round(risk * 10) / 10;
}

/**
 * Estimates the danger of discarding a card during play. It extends the gift
 * risk with a stronger preference for keeping trump cards and high cards.
 *
 * @param {CardLike} cardLike
 * @param {ReadonlyArray<CardLike>} hand
 * @param {object} [context]
 * @param {ReadonlyArray<string>} [context.declaredMarriages]
 * @param {string | null} [context.trumpSuit]
 * @returns {number}
 */
export function evaluateDiscardRisk(cardLike, hand, context = {}) {
  const card = resolveCard(cardLike);
  let risk = evaluateGiftRisk(card, hand, context);

  if (context.trumpSuit && card.suit === context.trumpSuit) {
    risk += 24;
  }

  if (card.rank === 'A' || card.rank === '10') {
    risk += 12;
  }

  return Math.round(risk * 10) / 10;
}

/**
 * Scores a card for leading a new trick. Higher is better.
 *
 * @param {CardLike} cardLike
 * @param {ReadonlyArray<CardLike>} hand
 * @param {object} [context]
 * @param {string | null} [context.trumpSuit]
 * @param {ReadonlyArray<CardLike>} [context.playedCards]
 * @returns {number}
 */
export function evaluateLeadCard(cardLike, hand, context = {}) {
  const card = resolveCard(cardLike);
  const cards = resolveCards(hand);
  const sameSuit = cards.filter((entry) => entry.suit === card.suit);
  const bossIds = getBossCardIds(cards, context.playedCards ?? []);
  const isBoss = bossIds.has(card.id);
  const isTrump = Boolean(context.trumpSuit && card.suit === context.trumpSuit);

  let score = card.value * 1.5 + card.strength * 5;

  if (isBoss) {
    score += 32;
  }

  if (isBoss && (card.rank === 'A' || card.rank === '10')) {
    score += 12;
  }

  score += Math.min(sameSuit.length, 5) * 3;

  if (isTrump) {
    score += 6 + card.strength * 2;
  }

  if (card.rank === '9') {
    score -= 22;
  } else if (card.rank === 'J') {
    score -= 10;
  }

  if (sameSuit.length === 1 && card.value <= 4) {
    score -= 8;
  }

  return Math.round(score * 10) / 10;
}
