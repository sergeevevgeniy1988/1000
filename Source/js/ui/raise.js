import { BIDDING } from '../core/constants.js';
import { getMaxContract } from '../core/rules.js';

/**
 * Returns the inclusive bounds for a contract raise. The minimum is the first
 * number above the current contract that is divisible by the bid step; the
 * maximum comes from the declarer's ten-card hand, so it may exceed
 * `BIDDING.MAX` when marriages are available.
 *
 * @param {{ contract?: number, hand?: unknown[] }} [options]
 * @returns {{ min: number, max: number, canRaise: boolean }}
 */
export function getRaiseBounds({ contract, hand } = {}) {
  const max = getMaxContract(Array.isArray(hand) ? hand : []);

  if (!Number.isFinite(contract)) {
    return { min: BIDDING.MIN, max, canRaise: false };
  }

  const base = Math.floor(contract / BIDDING.STEP) * BIDDING.STEP;
  const min = base + BIDDING.STEP;

  return { min, max, canRaise: min <= max };
}

/**
 * Describes the inline raise panel for the declarer. The window is open only
 * until the first gift and only when the declarer has a hand, a non-negative
 * score and room between the current contract and the hand maximum.
 *
 * @param {object} state Player view snapshot.
 * @param {string | null} viewerId Seat the UI shows.
 * @returns {{
 *   min: number,
 *   max: number,
 *   canRaise: boolean,
 *   negative: boolean,
 *   notice: string | null,
 * }}
 */
export function getRaiseState(state, viewerId) {
  const players = Array.isArray(state?.players) ? state.players : [];
  const viewer = players.find((player) => player && player.id === viewerId) ?? null;
  const hasHand = Array.isArray(viewer?.hand);
  const hand = hasHand ? viewer.hand : [];
  const bounds = getRaiseBounds({ contract: state?.contract, hand });
  const negative = Boolean(viewer && Number.isFinite(viewer.score) && viewer.score < 0);
  const decided = state?.raiseDecided === true;
  const giftsStarted = Array.isArray(state?.givenCards) && state.givenCards.length > 0;

  const result = (canRaise, notice) => ({
    min: bounds.min,
    max: bounds.max,
    canRaise,
    negative,
    notice,
  });

  if (negative) {
    return result(false, 'Повышение недоступно: отрицательный счёт.');
  }

  if (decided) {
    return result(false, 'Решение о повышении заказа уже принято.');
  }

  if (giftsStarted) {
    return result(false, 'Повысить заказ можно только до первой отданной карты.');
  }

  if (!hasHand || hand.length === 0) {
    return result(false, 'Рука недоступна: повышение невозможно.');
  }

  if (!bounds.canRaise) {
    return result(false, `Заказ ${state.contract} уже максимальный: повышать некуда.`);
  }

  return result(true, null);
}

/**
 * Checks one contract raise amount. The maximum comes from `getMaxContract()`
 * for the declarer's hand, so a raise may exceed `BIDDING.MAX` after the prikup.
 *
 * @param {unknown} amount
 * @param {{ contract?: number, max?: number }} [bounds]
 * @returns {boolean}
 */
export function isLegalRaiseAmount(amount, { contract, max } = {}) {
  if (
    typeof amount !== 'number'
    || !Number.isInteger(amount)
    || !Number.isFinite(contract)
    || !Number.isFinite(max)
  ) {
    return false;
  }

  return amount % BIDDING.STEP === 0
    && amount > contract
    && amount <= max;
}
