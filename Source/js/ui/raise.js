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
