import { DEAL } from './constants.js';
import { getCardById } from './deck.js';
import { GameError } from './errors.js';

const PLAYER_COUNT = DEAL.PLAYER_COUNT;
const CARD_COUNT = DEAL.CARD_COUNT;

/**
 * @typedef {import('./deck.js').Card} Card
 */

/**
 * Recursively freezes an object graph. Snapshots returned by the game are
 * frozen so callers cannot mutate the internal state through them.
 *
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }

  Object.freeze(value);

  for (const key of Object.keys(value)) {
    deepFreeze(value[key]);
  }

  return value;
}

/**
 * Validates constructor players and creates independent internal records.
 *
 * @param {ReadonlyArray<{ id: string, name: string, isHuman?: boolean }>} players
 * @returns {object[]}
 * @throws {GameError} When the player list is malformed.
 */
export function normalizePlayers(players) {
  if (!Array.isArray(players) || players.length !== PLAYER_COUNT) {
    throw new GameError(
      'INVALID_ARGUMENT',
      `Для игры нужны ровно ${PLAYER_COUNT} игрока.`,
    );
  }

  const ids = new Set();

  return players.map((player, index) => {
    if (!player || typeof player !== 'object') {
      throw new GameError('INVALID_ARGUMENT', `Игрок #${index + 1} должен быть объектом.`);
    }

    if (typeof player.id !== 'string' || player.id.length === 0) {
      throw new GameError('INVALID_ARGUMENT', `У игрока #${index + 1} отсутствует идентификатор.`);
    }

    if (ids.has(player.id)) {
      throw new GameError('INVALID_ARGUMENT', `Идентификатор игрока ${player.id} повторяется.`);
    }

    ids.add(player.id);

    if (typeof player.name !== 'string' || player.name.length === 0) {
      throw new GameError('INVALID_ARGUMENT', `У игрока ${player.id} отсутствует имя.`);
    }

    return {
      id: player.id,
      name: player.name,
      isHuman: player.isHuman === true,
      hand: /** @type {Card[]} */ ([]),
      score: 0,
      bolts: 0,
      bid: null,
      passed: false,
      tricksWon: 0,
      trickPoints: 0,
      marriagePoints: 0,
      declaredMarriages: /** @type {string[]} */ ([]),
      isDeclarer: false,
    };
  });
}

/**
 * Validates and copies a fixed deck used by tests and deterministic scenarios.
 *
 * @param {ReadonlyArray<Card | string>} deck
 * @returns {Card[]}
 * @throws {GameError} When the deck is incomplete or contains duplicates.
 */
export function normalizeDeck(deck) {
  if (!Array.isArray(deck) || deck.length !== CARD_COUNT) {
    throw new GameError(
      'INVALID_DECK',
      `Фиксированная колода должна содержать ровно ${CARD_COUNT} карт.`,
    );
  }

  const cards = deck.map((entry, index) => {
    const cardId = typeof entry === 'string'
      ? entry
      : (entry && typeof entry === 'object' && typeof entry.id === 'string' ? entry.id : null);

    if (cardId === null) {
      throw new GameError('INVALID_DECK', `Карта #${index + 1} в колоде некорректна.`);
    }

    try {
      return getCardById(cardId);
    } catch {
      throw new GameError('INVALID_DECK', `Карта ${cardId} отсутствует в стандартной колоде.`);
    }
  });

  const uniqueIds = new Set(cards.map((card) => card.id));

  if (uniqueIds.size !== CARD_COUNT) {
    throw new GameError('INVALID_DECK', 'Фиксированная колода содержит повторяющиеся карты.');
  }

  return cards;
}
