/**
 * Small visual-effects helper. All timing lives here so the controller can
 * disable animations in one place, including for `prefers-reduced-motion`.
 */

/** How long the third card of a trick stays on the table before collection. */
export const TRICK_REVEAL_MS = 720;

/** Deal animation duration. */
export const DEAL_ANIMATION_MS = 520;

/** Score modal highlight duration. */
export const SCORE_ANIMATION_MS = 700;

const timers = new WeakMap();

/**
 * @returns {boolean} True when the user asked the system to reduce motion.
 */
export function prefersReducedMotion() {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Runs a callback after a class-based animation and keeps only one timer per
 * element, so repeated renders cannot stack timers.
 *
 * @param {HTMLElement} element
 * @param {string} className
 * @param {number} duration
 * @param {() => void} cleanup
 * @returns {void}
 */
function animateClass(element, className, duration, cleanup) {
  if (!element || typeof window === 'undefined') {
    return;
  }

  const previous = timers.get(element);

  if (previous !== undefined) {
    window.clearTimeout(previous);
  }

  cleanup();
  element.classList.add(className);

  const timer = window.setTimeout(() => {
    timers.delete(element);
    cleanup();
  }, duration);

  timers.set(element, timer);
}

/**
 * Animates a fresh deal: the hand cards and opponent panels slide in.
 *
 * @param {HTMLElement} boardEl
 * @returns {void}
 */
export function playDealAnimation(boardEl) {
  if (!boardEl || prefersReducedMotion()) {
    return;
  }

  // Restart the animation even when two deals start back-to-back.
  boardEl.classList.remove('is-dealing');
  void boardEl.offsetWidth;

  animateClass(
    boardEl,
    'is-dealing',
    DEAL_ANIMATION_MS,
    () => boardEl.classList.remove('is-dealing'),
  );
}

/**
 * Starts the trick collection animation. All cards fly towards the winner's
 * seat while the controller keeps the trick visible for a short pause.
 *
 * @param {HTMLElement | null} trickEl
 * @param {'left' | 'right' | 'bottom' | 'center'} winnerPosition
 * @returns {void}
 */
export function playTrickCollect(trickEl, winnerPosition) {
  if (!trickEl || prefersReducedMotion()) {
    return;
  }

  const vectors = {
    left: ['-90px', '-36px'],
    right: ['90px', '-36px'],
    bottom: ['0px', '78px'],
    center: ['0px', '-10px'],
  };
  const [x, y] = vectors[winnerPosition] ?? vectors.center;

  trickEl.style.setProperty('--collect-x', x);
  trickEl.style.setProperty('--collect-y', y);
  trickEl.classList.add('trick--collecting');
}

/**
 * Highlights the deal results panel when it opens.
 *
 * @param {HTMLElement | null} modalEl
 * @returns {void}
 */
export function playScoreAnimation(modalEl) {
  if (!modalEl || prefersReducedMotion()) {
    return;
  }

  animateClass(modalEl, 'modal--scored', SCORE_ANIMATION_MS, () => {
    modalEl.classList.remove('modal--scored');
  });
}

/**
 * Removes every animation class and inline property left by a previous game.
 *
 * @param {HTMLElement | null} boardEl
 * @param {HTMLElement | null} tableCenterEl
 * @returns {void}
 */
export function cancelAnimations(boardEl, tableCenterEl) {
  if (boardEl) {
    boardEl.classList.remove('is-dealing');
  }

  const tricks = tableCenterEl
    ? [...tableCenterEl.querySelectorAll('.trick--collecting')]
    : [];

  for (const trick of tricks) {
    trick.classList.remove('trick--collecting');
    trick.style.removeProperty('--collect-x');
    trick.style.removeProperty('--collect-y');
  }

  if (typeof document !== 'undefined') {
    for (const modal of document.querySelectorAll('.modal--scored')) {
      modal.classList.remove('modal--scored');
    }
  }
}
