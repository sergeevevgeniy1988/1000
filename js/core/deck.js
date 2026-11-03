import { DEAL, RANKS, RANK_INFO, SUITS } from './constants.js';
import { GameError } from './errors.js';

/**
 * @typedef {object} Card
 * @property {string} id Stable card id in the form suit + rank, for example "S10".
 * @property {string} suit Suit id: S, C, D or H.
 * @property {string} rank Rank id: 9, J, Q, K, 10 or A.
 * @property {number} value Point value used when scoring tricks.
 * @property {number} strength Relative strength used when comparing cards.
 */

const CARD_TEMPLATE = Object.freeze(
  SUITS.flatMap((suit) =>
    RANKS.map((rank) => {
      const rankInfo = RANK_INFO[rank];

      return Object.freeze({
        id: `${suit}${rank}`,
        suit,
        rank,
        value: rankInfo.value,
        strength: rankInfo.strength,
      });
    }),
  ),
);

const CARD_BY_ID = new Map(CARD_TEMPLATE.map((card) => [card.id, card]));

/**
 * Creates a fresh array containing all 24 cards of the game deck.
 * Card objects are immutable and shared between decks.
 *
 * @returns {Card[]}
 */
export function createDeck() {
  return [...CARD_TEMPLATE];
}

/**
 * Returns an immutable card by its stable id.
 *
 * @param {string} cardId
 * @returns {Card}
 * @throws {GameError} When the id does not belong to the deck.
 */
export function getCardById(cardId) {
  const card = CARD_BY_ID.get(cardId);

  if (!card) {
    throw new GameError('UNKNOWN_CARD', `Неизвестная карта: ${cardId}.`, {
      cardId,
    });
  }

  return card;
}

/**
 * Returns a shuffled copy of the given cards using the Fisher-Yates algorithm.
 * The source array and its order are never mutated.
 *
 * @param {ReadonlyArray<Card>} cards
 * @param {() => number} [rng] Generator returning numbers in the range [0, 1).
 * @returns {Card[]}
 * @throws {GameError} When the input is not an array or the RNG is not a function.
 */
export function shuffle(cards, rng = Math.random) {
  if (!Array.isArray(cards)) {
    throw new GameError('INVALID_ARGUMENT', 'Колода должна быть массивом.');
  }

  if (typeof rng !== 'function') {
    throw new GameError('INVALID_ARGUMENT', 'Генератор случайных чисел должен быть функцией.');
  }

  const result = [...cards];

  for (let index = result.length - 1; index > 0; index -= 1) {
    const randomValue = rng();
    const swapIndex = Math.floor(randomValue * (index + 1));
    const temporary = result[index];
    result[index] = result[swapIndex];
    result[swapIndex] = temporary;
  }

  return result;
}

/**
 * Deals cards one by one in a circle to the players and puts the remaining
 * cards into the prikup. The input deck must already be shuffled.
 *
 * @param {ReadonlyArray<Card>} cards
 * @param {object} [options]
 * @param {number} [options.playerCount] Number of hands to deal.
 * @param {number} [options.handSize] Cards per player before the prikup.
 * @param {number} [options.prikupSize] Number of cards placed into the prikup.
 * @returns {{ hands: Card[][], prikup: Card[] }}
 * @throws {GameError} When the configuration is invalid or there are not enough cards.
 */
export function deal(cards, options = {}) {
  if (!Array.isArray(cards)) {
    throw new GameError('INVALID_ARGUMENT', 'Колода должна быть массивом.');
  }

  const playerCount = options.playerCount ?? DEAL.PLAYER_COUNT;
  const handSize = options.handSize ?? DEAL.INITIAL_HAND_SIZE;
  const prikupSize = options.prikupSize ?? DEAL.PRIKUP_SIZE;

  if (!Number.isInteger(playerCount) || playerCount <= 0) {
    throw new GameError('INVALID_ARGUMENT', 'Количество игроков должно быть положительным целым числом.');
  }

  if (!Number.isInteger(handSize) || handSize <= 0) {
    throw new GameError('INVALID_ARGUMENT', 'Размер руки должен быть положительным целым числом.');
  }

  if (!Number.isInteger(prikupSize) || prikupSize < 0) {
    throw new GameError('INVALID_ARGUMENT', 'Размер прикупа должен быть неотрицательным целым числом.');
  }

  const requiredCards = playerCount * handSize + prikupSize;

  if (cards.length < requiredCards) {
    throw new GameError(
      'NOT_ENOUGH_CARDS',
      `Для раздачи нужно ${requiredCards} карт, а в колоде ${cards.length}.`,
      { requiredCards, availableCards: cards.length },
    );
  }

  const hands = Array.from({ length: playerCount }, () => []);
  let cardIndex = 0;

  for (let round = 0; round < handSize; round += 1) {
    for (let playerIndex = 0; playerIndex < playerCount; playerIndex += 1) {
      hands[playerIndex].push(cards[cardIndex]);
      cardIndex += 1;
    }
  }

  const prikup = cards.slice(cardIndex, cardIndex + prikupSize);

  return { hands, prikup };
}
