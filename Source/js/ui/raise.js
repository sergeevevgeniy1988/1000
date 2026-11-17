import { BIDDING } from '../core/constants.js';

/**
 * Returns every legal contract raise above the current contract. Raises may
 * jump, but must stay divisible by the bidding step and no higher than the
 * maximum contract.
 *
 * @param {number} contract Current contract.
 * @returns {number[]}
 */
export function getRaiseOptions(contract) {
  if (
    !Number.isFinite(contract)
    || contract < BIDDING.MIN
    || contract >= BIDDING.MAX
  ) {
    return [];
  }

  const options = [];
  const base = Math.floor(contract / BIDDING.STEP) * BIDDING.STEP;

  for (
    let amount = base + BIDDING.STEP;
    amount <= BIDDING.MAX;
    amount += BIDDING.STEP
  ) {
    options.push(amount);
  }

  return options;
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
