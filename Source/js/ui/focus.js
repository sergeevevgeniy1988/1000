/**
 * Focus helpers used after the controller re-renders the board. Rebuilding the
 * action bar and hand would otherwise drop keyboard focus back to `<body>`.
 */

const FOCUS_ID_ATTRIBUTES = [
  'data-card-id',
  'data-action',
  'data-bid',
  'data-suit',
  'data-target-id',
];

/**
 * @param {string} value
 * @returns {string}
 */
function escapeAttribute(value) {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }

  return String(value).replace(/["\\]/g, '\\$&');
}

/**
 * @param {HTMLElement} element
 * @returns {boolean}
 */
function isFocusable(element) {
  return element instanceof HTMLElement
    && !element.matches(':disabled')
    && element.getAttribute('aria-disabled') !== 'true'
    && !element.closest('[inert]');
}

/**
 * Captures enough information to find the same control after a re-render.
 *
 * @param {HTMLElement} root
 * @param {Element | null} [active]
 * @returns {{ selector: string, kind: string } | null}
 */
export function captureFocus(root, active = document.activeElement) {
  if (!root || !(active instanceof HTMLElement) || !root.contains(active)) {
    return null;
  }

  for (const attribute of FOCUS_ID_ATTRIBUTES) {
    const holder = active.closest(`[${attribute}]`);

    if (holder instanceof HTMLElement) {
      const value = holder.getAttribute(attribute);

      if (value !== null) {
        return {
          selector: `[${attribute}="${escapeAttribute(value)}"]`,
          kind: attribute,
        };
      }
    }
  }

  if (active.id) {
    return {
      selector: `#${escapeAttribute(active.id)}`,
      kind: 'id',
    };
  }

  return null;
}

/**
 * Restores focus to the captured control. Returns false when the previous
 * control no longer exists, so the caller can choose a sensible fallback.
 *
 * @param {HTMLElement} root
 * @param {{ selector: string } | null} snapshot
 * @returns {boolean}
 */
export function restoreFocus(root, snapshot) {
  if (!root || !snapshot) {
    return false;
  }

  const target = root.querySelector(snapshot.selector);

  if (!isFocusable(target)) {
    return false;
  }

  target.focus();
  return true;
}

/**
 * Focuses the first legal card in the human hand, if any.
 *
 * @param {HTMLElement} root
 * @returns {boolean}
 */
export function focusFirstLegalCard(root) {
  const card = root?.querySelector('button.card--legal:not([aria-disabled="true"])');

  if (!isFocusable(card)) {
    return false;
  }

  card.focus();
  return true;
}
