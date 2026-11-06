/**
 * Creates a small, fast, deterministic 32-bit random number generator.
 * The same seed always produces the same sequence in every environment.
 *
 * @param {number | string} seed
 * @returns {() => number} A function returning values in the range [0, 1).
 */
export function mulberry32(seed) {
  let state = Number(seed) >>> 0;

  return function nextRandom() {
    state = (state + 0x6d2b79f5) >>> 0;

    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);

    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Returns a random unsigned 32-bit seed suitable for {@link mulberry32}.
 * Uses the Web Crypto API when available and falls back to Math.random.
 *
 * @returns {number}
 */
export function randomSeed() {
  const cryptoApi = globalThis.crypto;

  if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') {
    const buffer = new Uint32Array(1);
    cryptoApi.getRandomValues(buffer);
    return buffer[0];
  }

  return Math.floor(Math.random() * 0x100000000) >>> 0;
}
