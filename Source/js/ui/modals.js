import { BOLTS } from '../core/constants.js';
import { playScoreAnimation } from './animations.js';
import { createElement } from './dom.js';
import {
  formatBolts,
  formatPoints,
  formatScore,
  formatSignedScore,
  formatTricks,
} from './format.js';

let currentModal = null;
let modalCounter = 0;
let toastCounter = 0;
const toastTimers = new Set();

/**
 * Keeps the application behind a modal out of the tab order and away from
 * screen readers. The modal root itself lives outside `.app`.
 *
 * @param {boolean} inert
 * @returns {void}
 */
function setAppInert(inert) {
  const app = document.querySelector('.app');

  if (app instanceof HTMLElement) {
    app.inert = inert;
  }
}

/**
 * @typedef {object} ModalAction
 * @property {string} label
 * @property {() => void} onClick
 * @property {'primary' | 'ghost'} [variant]
 * @property {string} [action]
 * @property {boolean} [autofocus]
 */

/**
 * @typedef {object} ModalOptions
 * @property {string} title
 * @property {Node} body
 * @property {string} [kind] Stable identifier used by the controller.
 * @property {string} [subtitle]
 * @property {Node | null} [footer]
 * @property {ModalAction[]} [actions]
 * @property {boolean} [dismissible]
 * @property {boolean} [wide]
 * @property {string} [className]
 * @property {(() => void) | null} [onClose]
 */

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
 * Closes the currently open modal.
 *
 * @param {object} [options]
 * @param {boolean} [options.silent] Do not call the modal's onClose callback.
 * @returns {void}
 */
export function closeModal({ silent = false } = {}) {
  if (!currentModal) {
    return;
  }

  const modal = currentModal;
  currentModal = null;

  document.removeEventListener('keydown', modal.onKeydown, true);
  modal.overlay.remove();
  document.body.classList.remove('has-modal');
  setAppInert(false);

  if (!silent) {
    modal.onClose?.();
  }

  if (modal.previousFocus instanceof HTMLElement && modal.previousFocus.isConnected) {
    modal.previousFocus.focus({ preventScroll: true });
  }
}

/**
 * @returns {string | null} Kind of the currently open modal, if any.
 */
export function getOpenModalKind() {
  return currentModal ? currentModal.kind : null;
}

/**
 * Opens a modal dialog. Only one modal is visible at a time.
 *
 * @param {ModalOptions} options
 * @returns {{ element: HTMLElement, close: () => void } | null}
 */
export function openModal({
  title,
  body,
  kind = 'generic',
  subtitle = '',
  footer = null,
  actions = [],
  dismissible = true,
  wide = false,
  className = '',
  onClose = null,
}) {
  const root = document.getElementById('modal-root');

  if (!root) {
    return null;
  }

  closeModal({ silent: true });

  modalCounter += 1;
  const titleId = `modal-title-${modalCounter}`;
  const subtitleId = subtitle ? `modal-subtitle-${modalCounter}` : null;
  const previousFocus = document.activeElement;

  const overlay = createElement('div', { className: 'modal-backdrop' });
  const dialog = createElement('div', {
    className: ['modal', wide ? 'modal--wide' : '', className].filter(Boolean),
    attrs: {
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': titleId,
      'aria-describedby': subtitleId,
      tabindex: '-1',
    },
  });
  const header = createElement('div', { className: 'modal__header' });
  const heading = createElement('div', { className: 'modal__heading' });
  const titleEl = createElement('h2', {
    className: 'modal__title',
    text: title,
    attrs: { id: titleId },
  });

  heading.append(titleEl);

  if (subtitle) {
    heading.append(createElement('p', {
      className: 'modal__subtitle',
      text: subtitle,
      attrs: { id: subtitleId },
    }));
  }

  header.append(heading);

  if (dismissible) {
    const closeButton = createElement('button', {
      className: 'modal__close',
      text: '×',
      attrs: { type: 'button', 'aria-label': 'Закрыть окно' },
    });

    closeButton.addEventListener('click', () => closeModal());
    header.append(closeButton);
  }

  const bodyEl = createElement('div', { className: 'modal__body' });
  bodyEl.append(body);

  dialog.append(header, bodyEl);

  if (footer || actions.length > 0) {
    const footerWrap = createElement('div', { className: 'modal__footer' });

    if (footer) {
      footerWrap.append(footer);
    }

    if (actions.length > 0) {
      const actionRow = createElement('div', { className: 'modal__actions' });

      for (const action of actions) {
        const button = createElement('button', {
          className: action.variant === 'primary' ? 'button' : 'button button--ghost',
          text: action.label,
          attrs: { type: 'button' },
          dataset: action.action ? { action: action.action } : {},
        });

        if (action.autofocus) {
          button.dataset.autofocus = 'true';
        }

        button.addEventListener('click', action.onClick);
        actionRow.append(button);
      }

      footerWrap.append(actionRow);
    }

    dialog.append(footerWrap);
  }

  overlay.append(dialog);

  const onKeydown = (event) => {
    if (event.key === 'Escape') {
      if (dismissible) {
        event.preventDefault();
        closeModal();
      }

      return;
    }

    if (event.key !== 'Tab') {
      return;
    }

    const focusable = getFocusable(dialog);

    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus({ preventScroll: true });
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;

    if (!dialog.contains(active)) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay && dismissible) {
      closeModal();
    }
  });

  root.append(overlay);
  document.body.classList.add('has-modal');
  setAppInert(true);
  document.addEventListener('keydown', onKeydown, true);

  currentModal = {
    overlay,
    dialog,
    kind,
    dismissible,
    onClose,
    previousFocus,
    onKeydown,
  };

  const autofocus = dialog.querySelector('[data-autofocus="true"]');
  const focusTarget = autofocus ?? getFocusable(dialog)[0] ?? dialog;

  if (focusTarget instanceof HTMLElement) {
    focusTarget.focus({ preventScroll: true });
  }

  return {
    element: dialog,
    close: () => closeModal(),
  };
}

/**
 * Shows a short non-blocking notification above the table.
 *
 * @param {string} message
 * @param {'error' | 'info'} [variant]
 * @returns {void}
 */
export function showToast(message, variant = 'error') {
  const root = document.getElementById('toast-root');

  if (!root || typeof message !== 'string' || message.length === 0) {
    return;
  }

  toastCounter += 1;
  const toast = createElement('div', {
    className: ['toast', `toast--${variant}`],
    text: message,
    attrs: { role: variant === 'error' ? 'alert' : 'status' },
    dataset: { toastId: toastCounter },
  });

  root.append(toast);

  while (root.childElementCount > 3) {
    const oldest = root.firstElementChild;

    if (oldest) {
      oldest.remove();
    }
  }

  const hideTimer = window.setTimeout(() => {
    toastTimers.delete(hideTimer);
    toast.classList.add('toast--leaving');

    const removeTimer = window.setTimeout(() => {
      toastTimers.delete(removeTimer);
      toast.remove();
    }, 220);

    toastTimers.add(removeTimer);
  }, 3800);

  toastTimers.add(hideTimer);
}

/**
 * @param {object} state
 * @param {string} playerId
 * @returns {object | null}
 */
function findPlayer(state, playerId) {
  return state.players.find((player) => player.id === playerId) ?? null;
}

/**
 * @param {string | number} value
 * @param {string} label
 * @returns {HTMLElement}
 */
function createCell(value, label = '') {
  const cell = createElement('td', { text: String(value) });

  if (label) {
    cell.append(createElement('span', { className: 'result-cell__note', text: label }));
  }

  return cell;
}

/**
 * Builds the per-player breakdown of a finished deal.
 *
 * @param {object} state
 * @param {object} result Value of `lastDealResult`.
 * @returns {HTMLElement}
 */
function createDealResultTable(state, result) {
  const wrapper = createElement('div', { className: 'result-table-wrap' });
  const table = createElement('table', { className: 'result-table' });
  const head = createElement('thead');
  const headRow = createElement('tr');

  for (const label of ['Игрок', 'Взятки', 'Марьяжи', 'Итог', 'Заказ', 'Болт', 'Δ', 'Счёт']) {
    headRow.append(
      createElement('th', { text: label, attrs: { scope: 'col' } }),
    );
  }

  head.append(headRow);

  const body = createElement('tbody');

  for (const playerResult of result.players) {
    const player = findPlayer(state, playerResult.id);
    const row = createElement('tr', {
      className: [
        playerResult.isDeclarer ? 'result-row--declarer' : '',
        player?.isHuman ? 'result-row--human' : '',
      ].filter(Boolean),
    });
    const nameCell = createElement('th', {
      className: 'result-row__name',
      attrs: { scope: 'row' },
    });

    nameCell.append(
      createElement('span', { text: player?.name ?? playerResult.id }),
    );

    if (playerResult.isDeclarer) {
      nameCell.append(
        createElement('span', { className: 'result-row__badge', text: 'играющий' }),
      );
    }

    row.append(nameCell);
    row.append(createCell(
      formatTricks(playerResult.tricksWon),
      `${formatPoints(playerResult.trickPoints)} по картам`,
    ));
    row.append(createCell(
      playerResult.marriagePoints > 0 ? `+${playerResult.marriagePoints}` : '—',
    ));

    if (playerResult.rounded === null) {
      row.append(createCell(String(playerResult.total), 'без округления'));
    } else {
      row.append(createCell(
        String(playerResult.total),
        `→ ${playerResult.rounded}`,
      ));
    }

    if (playerResult.isDeclarer) {
      row.append(createElement('td', {}, ...[
        createElement('span', {
          className: [
            'result-badge',
            playerResult.contractMet ? 'result-badge--success' : 'result-badge--fail',
          ],
          text: playerResult.contractMet ? 'выполнен' : 'не выполнен',
        }),
        createElement('span', {
          className: 'result-cell__note',
          text: `заказ ${result.contract}`,
        }),
      ]));
    } else {
      row.append(createCell('—'));
    }

    if (playerResult.boltReset) {
      row.append(createElement('td', {}, ...[
        createElement('span', {
          className: 'result-badge result-badge--fail',
          text: `3-й болт −${BOLTS.PENALTY}`,
        }),
      ]));
    } else if (playerResult.boltEarned) {
      row.append(createCell('+1', 'болт'));
    } else {
      row.append(createCell('—'));
    }

    row.append(createElement('td', {
      className: [
        'result-delta',
        playerResult.delta > 0 ? 'result-delta--plus' : '',
        playerResult.delta < 0 ? 'result-delta--minus' : '',
      ].filter(Boolean),
      text: formatSignedScore(playerResult.delta),
    }));
    row.append(createElement('td', {
      className: 'result-score',
      text: formatScore(playerResult.scoreAfter),
    }));

    body.append(row);
  }

  table.append(head, body);
  wrapper.append(table);

  return wrapper;
}

/**
 * Creates the summary banner above the deal breakdown.
 *
 * @param {object} state
 * @param {object} result
 * @returns {HTMLElement}
 */
function createDealSummary(state, result) {
  const summary = createElement('div', {
    className: [
      'result-summary',
      result.contractMet ? 'result-summary--success' : 'result-summary--fail',
    ],
  });
  const declarer = findPlayer(state, result.declarerId);

  summary.append(
    createElement('span', {
      className: 'result-summary__title',
      text: `Заказ ${result.contract}`,
    }),
    createElement('span', {
      className: 'result-summary__text',
      text: result.contractMet
        ? `выполнен · играющий ${declarer?.name ?? '—'}`
        : `не выполнен · играющий ${declarer?.name ?? '—'}`,
    }),
    createElement('span', {
      className: 'result-summary__note',
      text: `Итог играющего: ${result.declarerTotal}`,
    }),
  );

  return summary;
}

/**
 * Opens the mandatory deal-results modal.
 *
 * @param {object} state
 * @param {object} options
 * @param {() => void} options.onNextDeal
 * @returns {{ element: HTMLElement, close: () => void } | null}
 */
export function openDealResultsModal(state, { onNextDeal }) {
  const result = state.lastDealResult;

  if (!result) {
    return null;
  }

  const body = createElement('div', { className: 'results' });
  const note = createElement('p', {
    className: 'results__note',
    text: 'Соперники получают округлённый итог раздачи. Играющий получает заказ '
      + 'или полный штраф, а болты применяются после подсчёта.',
  });

  body.append(createDealSummary(state, result), createDealResultTable(state, result), note);

  const footer = createElement('div', { className: 'modal__footer-row' });
  const nextButton = createElement('button', {
    className: 'button',
    text: 'Следующая раздача',
    attrs: { type: 'button', 'data-autofocus': 'true' },
    dataset: { action: 'next-deal' },
  });

  nextButton.addEventListener('click', onNextDeal);
  footer.append(nextButton);

  const modal = openModal({
    kind: 'results',
    title: `Итоги раздачи ${state.dealNumber}`,
    subtitle: 'Проверьте взятки, марьяжи, заказ и болты',
    body,
    footer,
    dismissible: false,
    wide: true,
    className: 'modal--results',
  });

  if (modal) {
    playScoreAnimation(modal.element);
  }

  return modal;
}

/**
 * Builds the final score table.
 *
 * @param {object} state
 * @returns {HTMLElement}
 */
function createFinalTable(state) {
  const wrapper = createElement('div', { className: 'result-table-wrap' });
  const table = createElement('table', { className: 'result-table result-table--final' });
  const head = createElement('thead');
  const headRow = createElement('tr');

  for (const label of ['Игрок', 'Счёт', 'Болты', 'Раздачи']) {
    headRow.append(createElement('th', { text: label, attrs: { scope: 'col' } }));
  }

  head.append(headRow);

  const body = createElement('tbody');
  const sorted = [...state.players].sort((left, right) => right.score - left.score);

  for (const player of sorted) {
    const row = createElement('tr', {
      className: player.id === state.winnerId ? 'result-row--winner' : '',
    });
    const nameCell = createElement('th', {
      className: 'result-row__name',
      attrs: { scope: 'row' },
    });

    nameCell.append(createElement('span', { text: player.name }));

    if (player.id === state.winnerId) {
      nameCell.append(
        createElement('span', { className: 'result-row__badge', text: 'победитель' }),
      );
    }

    row.append(
      nameCell,
      createElement('td', { className: 'result-score', text: formatScore(player.score) }),
      createCell(formatBolts(player.bolts)),
      createCell(String(state.dealNumber)),
    );
    body.append(row);
  }

  table.append(head, body);
  wrapper.append(table);

  return wrapper;
}

/**
 * Opens the final game-over modal.
 *
 * @param {object} state
 * @param {object} options
 * @param {() => void} options.onNewGame
 * @returns {{ element: HTMLElement, close: () => void } | null}
 */
export function openGameOverModal(state, { onNewGame }) {
  const winner = findPlayer(state, state.winnerId);
  const human = state.players.find((player) => player.isHuman) ?? null;
  const body = createElement('div', { className: 'game-over' });
  const hero = createElement('div', {
    className: [
      'game-over__hero',
      winner?.isHuman ? 'game-over__hero--human' : '',
    ].filter(Boolean),
  });

  hero.append(
    createElement('span', {
      className: 'game-over__eyebrow',
      text: `Цель — ${state.targetScore} очков`,
    }),
    createElement('h3', {
      className: 'game-over__title',
      text: winner?.isHuman ? 'Вы победили!' : `Победа: ${winner?.name ?? '—'}`,
    }),
    createElement('p', {
      className: 'game-over__text',
      text: winner?.isHuman
        ? `Партия завершена за ${formatDeals(state.dealNumber)}.`
        : `Партия завершена за ${formatDeals(state.dealNumber)}. Ваш счёт — ${formatScore(
          human?.score ?? 0,
        )}.`,
    }),
  );

  body.append(hero, createFinalTable(state));

  const footer = createElement('div', { className: 'modal__footer-row' });
  const newGameButton = createElement('button', {
    className: 'button',
    text: 'Новая игра',
    attrs: { type: 'button', 'data-autofocus': 'true' },
    dataset: { action: 'new-game' },
  });

  newGameButton.addEventListener('click', onNewGame);
  footer.append(newGameButton);

  const modal = openModal({
    kind: 'gameover',
    title: 'Игра окончена',
    subtitle: 'Итоговая таблица партии',
    body,
    footer,
    dismissible: false,
    wide: true,
    className: 'modal--gameover',
  });

  if (modal) {
    playScoreAnimation(modal.element);
  }

  return modal;
}

/**
 * @param {number} count
 * @returns {string} For example "7 раздач".
 */
function formatDeals(count) {
  const absolute = Math.abs(count) % 100;
  const lastDigit = absolute % 10;
  let word = 'раздач';

  if (absolute < 10 || absolute > 20) {
    if (lastDigit === 1) {
      word = 'раздачу';
    } else if (lastDigit >= 2 && lastDigit <= 4) {
      word = 'раздачи';
    }
  }

  return `${count} ${word}`;
}

/**
 * Opens the confirmation dialog for starting a new game.
 *
 * @param {object} options
 * @param {() => void} options.onConfirm
 * @param {() => void} options.onCancel
 * @returns {{ element: HTMLElement, close: () => void } | null}
 */
export function openConfirmNewGameModal({ onConfirm, onCancel }) {
  const body = createElement('div', { className: 'confirm' });

  body.append(
    createElement('p', {
      className: 'confirm__text',
      text: 'Текущая партия будет прервана. Счёт, болты и история раздач сбросятся.',
    }),
    createElement('p', {
      className: 'confirm__note',
      text: 'Продолжить текущую игру можно кнопкой «Продолжить».',
    }),
  );

  const footer = createElement('div', { className: 'modal__footer-row' });
  const cancelButton = createElement('button', {
    className: 'button button--ghost',
    text: 'Продолжить',
    attrs: { type: 'button', 'data-autofocus': 'true' },
    dataset: { action: 'cancel-new-game' },
  });
  const confirmButton = createElement('button', {
    className: 'button',
    text: 'Начать заново',
    attrs: { type: 'button' },
    dataset: { action: 'confirm-new-game' },
  });

  cancelButton.addEventListener('click', () => closeModal());
  confirmButton.addEventListener('click', onConfirm);
  footer.append(cancelButton, confirmButton);

  return openModal({
    kind: 'confirm',
    title: 'Новая игра?',
    body,
    footer,
    dismissible: true,
    className: 'modal--confirm',
    onClose: onCancel,
  });
}

/**
 * @returns {void}
 */
export function resetToasts() {
  for (const timer of toastTimers) {
    window.clearTimeout(timer);
  }

  toastTimers.clear();
  const root = document.getElementById('toast-root');

  if (root) {
    root.replaceChildren();
  }
}
