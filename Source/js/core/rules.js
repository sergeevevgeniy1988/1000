import { BIDDING, MARRIAGE_BONUSES, MAX_CONTRACT, SUITS } from './constants.js';
import { getCardById } from './deck.js';
import { GameError } from './errors.js';

/**
 * @typedef {import('./deck.js').Card} Card
 * @typedef {Card | string} CardLike
 */

const SUIT_SET = new Set(SUITS);

/**
 * Resolves a card object or a stable card id to a canonical deck card.
 *
 * @param {CardLike} cardLike
 * @returns {Card}
 * @throws {GameError} When the card is malformed or unknown.
 */
function resolveCard(cardLike) {
  if (typeof cardLike === 'string') {
    return getCardById(cardLike);
  }

  if (cardLike && typeof cardLike === 'object' && typeof cardLike.id === 'string') {
    return getCardById(cardLike.id);
  }

  throw new GameError('INVALID_CARD', 'Карта должна быть объектом или стабильным идентификатором.');
}

/**
 * Resolves a hand of cards without mutating the source array.
 *
 * @param {ReadonlyArray<CardLike>} hand
 * @returns {Card[]}
 * @throws {GameError} When the hand is not an array.
 */
function resolveHand(hand) {
  if (!Array.isArray(hand)) {
    throw new GameError('INVALID_ARGUMENT', 'Рука должна быть массивом карт.');
  }

  return hand.map(resolveCard);
}

/**
 * Validates an optional suit id. `null` and `undefined` mean "no suit".
 *
 * @param {string | null | undefined} suit
 * @param {string} argumentName
 * @returns {string | null}
 * @throws {GameError} When the suit id is not recognized.
 */
function resolveSuit(suit, argumentName) {
  if (suit === null || suit === undefined) {
    return null;
  }

  if (typeof suit !== 'string' || !SUIT_SET.has(suit)) {
    throw new GameError('INVALID_SUIT', `Некорректная масть в аргументе ${argumentName}: ${String(suit)}.`, {
      argumentName,
      suit,
    });
  }

  return suit;
}

/**
 * Validates a list of declared marriage suits.
 *
 * @param {ReadonlyArray<string> | null | undefined} declaredMarriages
 * @returns {Set<string>}
 * @throws {GameError} When the list contains an unknown suit.
 */
function resolveDeclaredMarriages(declaredMarriages) {
  if (declaredMarriages === null || declaredMarriages === undefined) {
    return new Set();
  }

  if (!Array.isArray(declaredMarriages)) {
    throw new GameError('INVALID_ARGUMENT', 'Объявленные марьяжи должны быть массивом мастей.');
  }

  const result = new Set();

  for (const suit of declaredMarriages) {
    const normalized = resolveSuit(suit, 'declaredMarriages');

    if (normalized === null) {
      throw new GameError('INVALID_SUIT', 'Масть объявленного марьяжа не может быть пустой.');
    }

    result.add(normalized);
  }

  return result;
}

/**
 * Extracts the card from a trick entry. Supports both `cardId` and `card`
 * fields as well as a bare card or card id.
 *
 * @param {object | string} entry
 * @returns {Card}
 * @throws {GameError} When the entry does not contain a valid card.
 */
function resolveTrickCard(entry) {
  if (typeof entry === 'string') {
    return getCardById(entry);
  }

  if (entry && typeof entry === 'object') {
    if (entry.cardId !== undefined) {
      return resolveCard(entry.cardId);
    }

    if (entry.card !== undefined) {
      return resolveCard(entry.card);
    }

    if (entry.id !== undefined) {
      return resolveCard(entry.id);
    }
  }

  throw new GameError('INVALID_TRICK', 'В записи взятки отсутствует корректная карта.');
}

/**
 * Returns true when the challenger beats the current winning card.
 *
 * @param {Card} challenger
 * @param {Card} current
 * @param {string | null} trumpSuit
 * @returns {boolean}
 */
function beatsCurrentCard(challenger, current, trumpSuit) {
  if (challenger.suit === current.suit) {
    return challenger.strength > current.strength;
  }

  if (trumpSuit !== null) {
    if (challenger.suit === trumpSuit) {
      return true;
    }

    if (current.suit === trumpSuit) {
      return false;
    }
  }

  // A card of another non-trump suit can never beat the led suit.
  return false;
}

/**
 * Returns the cards a player is allowed to play.
 *
 * Priority: follow the led suit, otherwise play a trump when one is declared,
 * otherwise any card is legal. When there is no led suit, every card is legal.
 *
 * @param {ReadonlyArray<CardLike>} hand
 * @param {string | null | undefined} leadSuit Suit of the first card in the trick.
 * @param {string | null | undefined} trumpSuit Current trump suit, if declared.
 * @returns {Card[]}
 * @throws {GameError} When the hand or a suit is invalid.
 */
export function getLegalCards(hand, leadSuit, trumpSuit) {
  const cards = resolveHand(hand);
  const normalizedLeadSuit = resolveSuit(leadSuit, 'leadSuit');
  const normalizedTrumpSuit = resolveSuit(trumpSuit, 'trumpSuit');

  if (normalizedLeadSuit === null) {
    return cards;
  }

  const ledSuitCards = cards.filter((card) => card.suit === normalizedLeadSuit);

  if (ledSuitCards.length > 0) {
    return ledSuitCards;
  }

  if (normalizedTrumpSuit !== null) {
    const trumpCards = cards.filter((card) => card.suit === normalizedTrumpSuit);

    if (trumpCards.length > 0) {
      return trumpCards;
    }
  }

  return cards;
}

/**
 * Checks whether a card belongs to the set of legal cards for the player.
 *
 * @param {ReadonlyArray<CardLike>} hand
 * @param {CardLike} card
 * @param {string | null | undefined} leadSuit
 * @param {string | null | undefined} trumpSuit
 * @returns {boolean}
 */
export function isCardLegal(hand, card, leadSuit, trumpSuit) {
  const targetCard = resolveCard(card);

  return getLegalCards(hand, leadSuit, trumpSuit).some(
    (legalCard) => legalCard.id === targetCard.id,
  );
}

/**
 * Determines the player who wins a trick.
 *
 * The trick must contain entries with a `playerId` and either `cardId` or
 * `card`. The winner is the highest trump when any trump was played, otherwise
 * the highest card of the led suit.
 *
 * @param {ReadonlyArray<{ playerId: string, cardId?: CardLike, card?: CardLike }>} trick
 * @param {string | null | undefined} trumpSuit
 * @returns {string} Id of the winning player.
 * @throws {GameError} When the trick is empty, malformed or contains duplicate players.
 */
export function getTrickWinner(trick, trumpSuit) {
  if (!Array.isArray(trick) || trick.length === 0) {
    throw new GameError('INVALID_TRICK', 'Взятка должна содержать хотя бы одну карту.');
  }

  const normalizedTrumpSuit = resolveSuit(trumpSuit, 'trumpSuit');
  const entries = trick.map((entry) => {
    const playerId = entry && typeof entry === 'object' ? entry.playerId : undefined;

    if (typeof playerId !== 'string' || playerId.length === 0) {
      throw new GameError('INVALID_TRICK', 'В записи взятки отсутствует идентификатор игрока.');
    }

    return { playerId, card: resolveTrickCard(entry) };
  });

  const playerIds = new Set(entries.map((entry) => entry.playerId));

  if (playerIds.size !== entries.length) {
    throw new GameError('INVALID_TRICK', 'Один игрок не может положить две карты в одну взятку.');
  }

  let winner = entries[0];

  for (let index = 1; index < entries.length; index += 1) {
    const challenger = entries[index];

    if (beatsCurrentCard(challenger.card, winner.card, normalizedTrumpSuit)) {
      winner = challenger;
    }
  }

  return winner.playerId;
}

/**
 * Sums the point values of all cards in a trick.
 *
 * @param {ReadonlyArray<{ cardId?: CardLike, card?: CardLike } | CardLike>} trick
 * @returns {number}
 * @throws {GameError} When the trick contains an invalid card.
 */
export function getTrickPoints(trick) {
  if (!Array.isArray(trick)) {
    throw new GameError('INVALID_ARGUMENT', 'Взятка должна быть массивом карт.');
  }

  return trick.reduce((sum, entry) => sum + resolveTrickCard(entry).value, 0);
}

/**
 * Lists marriages available to a player: suits where the hand still contains
 * both king and queen and the suit has not been declared in this deal.
 *
 * @param {ReadonlyArray<CardLike>} hand
 * @param {ReadonlyArray<string> | null | undefined} [declaredMarriages]
 * @returns {{ suit: string, value: number }[]}
 * @throws {GameError} When the hand or declared suits are invalid.
 */
export function getAvailableMarriages(hand, declaredMarriages = []) {
  const cards = resolveHand(hand);
  const declared = resolveDeclaredMarriages(declaredMarriages);
  const suitsInHand = new Map();

  for (const card of cards) {
    const ranks = suitsInHand.get(card.suit) ?? new Set();
    ranks.add(card.rank);
    suitsInHand.set(card.suit, ranks);
  }

  return SUITS.filter((suit) => {
    if (declared.has(suit)) {
      return false;
    }

    const ranks = suitsInHand.get(suit);

    return Boolean(ranks && ranks.has('K') && ranks.has('Q'));
  }).map((suit) => ({
    suit,
    value: MARRIAGE_BONUSES[suit],
  }));
}

/**
 * Returns the highest contract a player may raise to: the top bid plus the
 * bonuses of every marriage still available in the hand. Declared marriages are
 * ignored because a raise happens before any marriage is declared.
 *
 * @param {ReadonlyArray<CardLike>} hand
 * @returns {number}
 * @throws {GameError} When the hand is invalid.
 */
export function getMaxContract(hand) {
  const bonus = getAvailableMarriages(hand)
    .reduce((sum, marriage) => sum + marriage.value, 0);

  return Math.min(MAX_CONTRACT, BIDDING.MAX + bonus);
}

/**
 * Returns the king and queen of the given suit when both are in the hand.
 * An incomplete pair returns an empty array.
 *
 * @param {ReadonlyArray<CardLike>} hand
 * @param {string} suit
 * @returns {Card[]}
 * @throws {GameError} When the hand or suit is invalid.
 */
export function getMarriageConfirmationCards(hand, suit) {
  const cards = resolveHand(hand);
  const normalizedSuit = resolveSuit(suit, 'suit');

  if (normalizedSuit === null) {
    return [];
  }

  const king = cards.find((card) => card.suit === normalizedSuit && card.rank === 'K');
  const queen = cards.find((card) => card.suit === normalizedSuit && card.rank === 'Q');

  return king && queen ? [king, queen] : [];
}

/**
 * Checks whether the card is a king or queen of the given suit.
 *
 * @param {CardLike} card
 * @param {string} suit
 * @returns {boolean}
 * @throws {GameError} When the card or suit is invalid.
 */
export function isMarriageConfirmationCard(card, suit) {
  const resolvedCard = resolveCard(card);
  const normalizedSuit = resolveSuit(suit, 'suit');

  return normalizedSuit !== null
    && resolvedCard.suit === normalizedSuit
    && (resolvedCard.rank === 'K' || resolvedCard.rank === 'Q');
}

/**
 * Checks whether a player may declare a marriage right now.
 *
 * @param {ReadonlyArray<CardLike>} hand
 * @param {string} suit
 * @param {object} [context]
 * @param {boolean} [context.isLeader] Player is leading the current trick.
 * @param {number} [context.completedTricks] Tricks already completed in this deal.
 * @param {ReadonlyArray<string>} [context.declaredMarriages] Suits already declared by the player.
 * @param {number} [context.marriagesThisTurn] Marriages declared during the current trick.
 * @returns {boolean}
 * @throws {GameError} When the hand or context is invalid.
 */
export function canDeclareMarriage(hand, suit, context = {}) {
  if (typeof suit !== 'string' || !SUIT_SET.has(suit)) {
    return false;
  }

  const {
    isLeader = false,
    completedTricks = 0,
    declaredMarriages = [],
    marriagesThisTurn = 0,
  } = context;

  if (!Number.isInteger(completedTricks) || completedTricks < 0) {
    throw new GameError('INVALID_ARGUMENT', 'Количество завершённых взяток должно быть неотрицательным целым числом.');
  }

  if (!Number.isInteger(marriagesThisTurn) || marriagesThisTurn < 0) {
    throw new GameError('INVALID_ARGUMENT', 'Количество марьяжей за ход должно быть неотрицательным целым числом.');
  }

  if (isLeader !== true || completedTricks < 1 || marriagesThisTurn > 0) {
    return false;
  }

  const declared = resolveDeclaredMarriages(declaredMarriages);

  if (declared.has(suit)) {
    return false;
  }

  return getAvailableMarriages(hand, declaredMarriages).some(
    (marriage) => marriage.suit === suit,
  );
}
