/**
 * Turns the event log into a slide-out drawer on narrow screens. On desktop
 * the same sidebar stays in the grid and the drawer controls are hidden.
 */

const NARROW_QUERY = '(max-width: 900px)';
const FOCUSABLE_SELECTOR = [
  'button:not(:disabled)',
  '[href]',
  'input:not(:disabled)',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * @param {HTMLElement} root
 * @returns {HTMLElement[]}
 */
function getFocusable(root) {
  return [...root.querySelectorAll(FOCUSABLE_SELECTOR)]
    .filter((element) => element instanceof HTMLElement && !element.hidden);
}

/**
 * @param {object} options
 * @param {HTMLElement | null} options.sidebar
 * @param {HTMLButtonElement | null} options.toggleButton
 * @param {HTMLButtonElement | null} options.closeButton
 * @param {HTMLElement | null} options.backdrop
 * @returns {{
 *   open: () => void,
 *   close: (options?: { restoreFocus?: boolean }) => void,
 *   isOpen: () => boolean,
 *   destroy: () => void,
 * } | null}
 */
export function createLogDrawer({
  sidebar,
  toggleButton,
  closeButton,
  backdrop,
}) {
  if (!sidebar || !toggleButton) {
    return null;
  }

  const mediaQuery = typeof window.matchMedia === 'function'
    ? window.matchMedia(NARROW_QUERY)
    : null;
  let open = false;
  let destroyed = false;
  let focusTimer = null;

  const isNarrow = () => (mediaQuery ? mediaQuery.matches : false);

  const sync = () => {
    const narrow = isNarrow();
    const visible = open && narrow;

    sidebar.classList.toggle('sidebar--open', visible);
    sidebar.toggleAttribute('inert', narrow && !visible);
    sidebar.setAttribute('aria-hidden', String(narrow && !visible));
    toggleButton.setAttribute('aria-expanded', String(visible));
    document.body.classList.toggle('has-drawer', visible);

    if (backdrop) {
      backdrop.hidden = !visible;
    }
  };

  const close = ({ restoreFocus = true } = {}) => {
    if (focusTimer !== null) {
      window.clearTimeout(focusTimer);
      focusTimer = null;
    }

    if (!open) {
      return;
    }

    open = false;
    sync();

    if (restoreFocus) {
      toggleButton.focus({ preventScroll: true });
    }
  };

  const openDrawer = () => {
    if (destroyed || !isNarrow()) {
      return;
    }

    open = true;
    sync();

    // Wait until the click/keyup default action finishes before moving focus.
    focusTimer = window.setTimeout(() => {
      focusTimer = null;

      if (open) {
        closeButton?.focus({ preventScroll: true });
      }
    }, 40);
  };

  const onKeydown = (event) => {
    if (!open || !isNarrow()) {
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }

    if (event.key !== 'Tab') {
      return;
    }

    const focusable = getFocusable(sidebar);
    const active = document.activeElement;

    if (focusable.length === 0) {
      event.preventDefault();
      sidebar.focus?.({ preventScroll: true });
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (event.shiftKey && (active === first || !sidebar.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !sidebar.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  };

  const onMediaChange = () => {
    if (!isNarrow()) {
      open = false;
    }

    sync();
  };

  const onToggleClick = () => {
    if (open) {
      close();
    } else {
      openDrawer();
    }
  };

  const onCloseClick = () => close();
  const onBackdropClick = () => close();

  toggleButton.addEventListener('click', onToggleClick);
  closeButton?.addEventListener('click', onCloseClick);
  backdrop?.addEventListener('click', onBackdropClick);
  document.addEventListener('keydown', onKeydown);

  if (mediaQuery) {
    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', onMediaChange);
    } else if (typeof mediaQuery.addListener === 'function') {
      mediaQuery.addListener(onMediaChange);
    }
  }

  sync();

  return {
    open: openDrawer,
    close,
    isOpen: () => open && isNarrow(),
    destroy: () => {
      destroyed = true;

      if (focusTimer !== null) {
        window.clearTimeout(focusTimer);
        focusTimer = null;
      }

      open = false;
      sync();
      toggleButton.removeEventListener('click', onToggleClick);
      closeButton?.removeEventListener('click', onCloseClick);
      backdrop?.removeEventListener('click', onBackdropClick);
      document.removeEventListener('keydown', onKeydown);

      if (mediaQuery) {
        if (typeof mediaQuery.removeEventListener === 'function') {
          mediaQuery.removeEventListener('change', onMediaChange);
        } else if (typeof mediaQuery.removeListener === 'function') {
          mediaQuery.removeListener(onMediaChange);
        }
      }
    },
  };
}
