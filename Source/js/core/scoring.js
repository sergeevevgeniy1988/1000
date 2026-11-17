import { BIDDING, BOLTS, MAX_CONTRACT, TARGET_SCORE } from './constants.js';
import { GameError } from './errors.js';

/**
 * @typedef {object} ScoringPlayerInput
 * @property {string} id Stable player id.
 * @property {number} score Current score before the deal is scored.
 * @property {number} bolts Current bolt count (0, 1 or 2).
 * @property {number} tricksWon Number of tricks taken in the deal.
 * @property {number} trickPoints Card points collected in taken tricks.
 * @property {number} [marriagePoints] Points from marriages declared in the deal.
 */

/**
 * @typedef {object} PlayerDealScore
 * @property {string} id
 * @property {boolean} isDeclarer
 * @property {number} tricksWon
 * @property {number} trickPoints
 * @property {number} marriagePoints
 * @property {number} total Raw deal total including marriage bonuses.
 * @property {number | null} rounded Rounded total for opponents, null for the declarer.
 * @property {boolean | null} contractMet Contract result for the declarer, null for opponents.
 * @property {number} baseDelta Points earned or lost before the bolt penalty.
 * @property {boolean} boltEarned Whether the player took no tricks in this deal.
 * @property {number} boltPenalty Bolt penalty applied after the normal scoring.
 * @property {boolean} boltReset Whether the third bolt was reached and the counter reset.
 * @property {number} boltsBefore
 * @property {number} boltsAfter
 * @property {number} scoreBefore
 * @property {number} delta Final score change including the bolt penalty.
 * @property {number} scoreAfter
 */

/**
 * @typedef {object} DealScore
 * @property {string} declarerId
 * @property {number} contract
 * @property {number} declarerTotal Raw total of the declarer including marriages.
 * @property {boolean} contractMet
 * @property {PlayerDealScore[]} players Results in the same order as the input.
 * @property {string[]} boltsAwarded Players who received a bolt in this deal.
 * @property {string[]} boltsReset Players whose third bolt was applied.
 */

/**
 * Rounds a number to the nearest multiple of five, with halves rounded up.
 * This matches the standard `Math.round(total / 5) * 5` formula from the rules.
 *
 * @param {number} value
 * @returns {number}
 * @throws {GameError} When the value is not a finite number.
 */
export function roundToFive(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new GameError('INVALID_ARGUMENT', 'Округляемое значение должно быть конечным числом.', {
      value,
    });
  }

  const rounded = Math.round(value / 5) * 5;

  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * Validates a player entry passed to {@link scoreDeal}.
 *
 * @param {ScoringPlayerInput} player
 * @param {number} index
 * @throws {GameError} When the player data is malformed.
 */
function validatePlayer(player, index) {
  if (!player || typeof player !== 'object') {
    throw new GameError('INVALID_ARGUMENT', `Игрок #${index + 1} должен быть объектом.`);
  }

  if (typeof player.id !== 'string' || player.id.length === 0) {
    throw new GameError('INVALID_ARGUMENT', `У игрока #${index + 1} отсутствует идентификатор.`);
  }

  if (!Number.isInteger(player.score)) {
    throw new GameError('INVALID_ARGUMENT', `Счёт игрока ${player.id} должен быть целым числом.`);
  }

  if (!Number.isInteger(player.bolts) || player.bolts < 0 || player.bolts >= BOLTS.LIMIT) {
    throw new GameError(
      'INVALID_ARGUMENT',
      `Количество болтов игрока ${player.id} должно быть от 0 до ${BOLTS.LIMIT - 1}.`,
    );
  }

  if (!Number.isInteger(player.tricksWon) || player.tricksWon < 0) {
    throw new GameError('INVALID_ARGUMENT', `Количество взяток игрока ${player.id} должно быть неотрицательным целым числом.`);
  }

  if (!Number.isInteger(player.trickPoints) || player.trickPoints < 0) {
    throw new GameError('INVALID_ARGUMENT', `Очки взяток игрока ${player.id} должны быть неотрицательным целым числом.`);
  }

  const marriagePoints = player.marriagePoints ?? 0;

  if (!Number.isInteger(marriagePoints) || marriagePoints < 0) {
    throw new GameError('INVALID_ARGUMENT', `Бонусы марьяжей игрока ${player.id} должны быть неотрицательным целым числом.`);
  }
}

/**
 * Scores one completed deal.
 *
 * Opponents add their rounded deal total to their score. The declarer either
 * gains the contract or loses it in full; their raw total is never added to the
 * score. Bolts are applied afterwards: a player with no tricks receives a bolt,
 * and the third bolt costs 120 points and resets the counter.
 *
 * @param {object} input
 * @param {ReadonlyArray<ScoringPlayerInput>} input.players
 * @param {string} input.declarerId
 * @param {number} input.contract
 * @returns {DealScore}
 * @throws {GameError} When the input is malformed.
 */
export function scoreDeal({ players, declarerId, contract }) {
  if (!Array.isArray(players) || players.length < 2) {
    throw new GameError('INVALID_ARGUMENT', 'Для подсчёта раздачи нужно минимум два игрока.');
  }

  players.forEach(validatePlayer);

  const playerIds = new Set(players.map((player) => player.id));

  if (playerIds.size !== players.length) {
    throw new GameError('INVALID_ARGUMENT', 'Идентификаторы игроков должны быть уникальными.');
  }

  if (typeof declarerId !== 'string' || !playerIds.has(declarerId)) {
    throw new GameError('INVALID_ARGUMENT', 'Играющий должен присутствовать в списке игроков.', {
      declarerId,
    });
  }

  if (
    !Number.isInteger(contract)
    || contract < BIDDING.MIN
    || contract > MAX_CONTRACT
    || contract % BIDDING.STEP !== 0
  ) {
    throw new GameError(
      'INVALID_ARGUMENT',
      `Заказ должен быть целым числом от ${BIDDING.MIN} до ${MAX_CONTRACT} с шагом ${BIDDING.STEP}.`,
      { contract },
    );
  }

  const declarer = players.find((player) => player.id === declarerId);
  const declarerTotal = declarer.trickPoints + (declarer.marriagePoints ?? 0);
  const contractMet = declarerTotal >= contract;

  /** @type {PlayerDealScore[]} */
  const results = players.map((player) => {
    const isDeclarer = player.id === declarerId;
    const marriagePoints = player.marriagePoints ?? 0;
    const total = player.trickPoints + marriagePoints;
    const boltEarned = player.tricksWon === 0;
    const boltsBefore = player.bolts;
    const pendingBolts = boltsBefore + (boltEarned ? 1 : 0);
    const boltReset = pendingBolts >= BOLTS.LIMIT;
    const boltsAfter = boltReset ? 0 : pendingBolts;
    const boltPenalty = boltReset ? BOLTS.PENALTY : 0;
    const rounded = isDeclarer ? null : roundToFive(total);
    const baseDelta = isDeclarer
      ? (contractMet ? contract : -contract)
      : rounded;
    const delta = baseDelta - boltPenalty;

    return {
      id: player.id,
      isDeclarer,
      tricksWon: player.tricksWon,
      trickPoints: player.trickPoints,
      marriagePoints,
      total,
      rounded,
      contractMet: isDeclarer ? contractMet : null,
      baseDelta,
      boltEarned,
      boltPenalty,
      boltReset,
      boltsBefore,
      boltsAfter,
      scoreBefore: player.score,
      delta,
      scoreAfter: player.score + delta,
    };
  });

  return {
    declarerId,
    contract,
    declarerTotal,
    contractMet,
    players: results,
    boltsAwarded: results.filter((result) => result.boltEarned).map((result) => result.id),
    boltsReset: results.filter((result) => result.boltReset).map((result) => result.id),
  };
}

/**
 * Checks whether the game is over.
 *
 * A player wins only with an outright lead at or above the target score. A tie
 * for first place at or above the target means the game continues for at least
 * one more deal.
 *
 * @param {ReadonlyArray<{ id: string, score: number }>} players
 * @param {number} [targetScore]
 * @returns {{
 *   isOver: boolean,
 *   winnerId: string | null,
 *   leaderIds: string[],
 *   isTie: boolean,
 *   targetReached: boolean,
 *   topScore: number,
 *   targetScore: number,
 * }}
 * @throws {GameError} When the input is malformed.
 */
export function checkGameOver(players, targetScore = TARGET_SCORE) {
  if (!Array.isArray(players) || players.length === 0) {
    throw new GameError('INVALID_ARGUMENT', 'Для проверки конца игры нужен хотя бы один игрок.');
  }

  if (!Number.isFinite(targetScore) || targetScore <= 0) {
    throw new GameError('INVALID_ARGUMENT', 'Целевой счёт должен быть положительным числом.');
  }

  players.forEach((player, index) => {
    if (!player || typeof player.id !== 'string' || player.id.length === 0) {
      throw new GameError('INVALID_ARGUMENT', `У игрока #${index + 1} отсутствует идентификатор.`);
    }

    if (!Number.isInteger(player.score)) {
      throw new GameError('INVALID_ARGUMENT', `Счёт игрока ${player.id} должен быть целым числом.`);
    }
  });

  const ids = new Set(players.map((player) => player.id));

  if (ids.size !== players.length) {
    throw new GameError('INVALID_ARGUMENT', 'Идентификаторы игроков должны быть уникальными.');
  }

  const topScore = Math.max(...players.map((player) => player.score));
  const leaderIds = players
    .filter((player) => player.score === topScore)
    .map((player) => player.id);
  const isTie = leaderIds.length > 1;
  const targetReached = topScore >= targetScore;
  const isOver = targetReached && !isTie;

  return {
    isOver,
    winnerId: isOver ? leaderIds[0] : null,
    leaderIds,
    isTie,
    targetReached,
    topScore,
    targetScore,
  };
}
