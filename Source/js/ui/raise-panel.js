import { createElement } from './dom.js';
import { getRaiseState, isLegalRaiseAmount } from './raise.js';

/**
 * Builds the inline contract-raise panel shown in the action bar for the human
 * declarer after the prikup and before the first gift. The panel replaces the
 * old mandatory raise modal and never covers the table or the hand.
 *
 * @param {object} options
 * @param {object} options.state Player view snapshot.
 * @param {string | null} options.viewerId Seat the UI shows.
 * @param {(amount: number) => void} [options.onRaise]
 * @param {() => void} [options.onDecline]
 * @returns {HTMLElement}
 */
export function createRaiseControls({
  state,
  viewerId,
  onRaise,
  onDecline,
}) {
  const raiseState = getRaiseState(state, viewerId);
  const contract = Number.isFinite(state?.contract) ? state.contract : 0;
  const container = createElement('div', {
    className: 'raise-controls',
    attrs: { role: 'group', 'aria-label': 'Повышение заказа' },
  });
  const info = createElement('div', { className: 'raise-controls__info' });

  info.append(
    createElement('span', {
      className: 'raise-controls__title',
      text: 'Повысить заказ?',
    }),
    createElement('span', {
      className: 'action-bar__status',
      text: `Заказ ${contract} · максимум ${raiseState.max}`,
    }),
  );
  container.append(info);

  const declineButton = createElement('button', {
    className: ['button', 'button--ghost'],
    text: raiseState.canRaise ? 'Оставить заказ' : 'Продолжить',
    attrs: { type: 'button' },
    dataset: { action: 'decline-raise' },
  });

  declineButton.addEventListener('click', () => onDecline?.());

  if (!raiseState.canRaise) {
    container.append(
      createElement('p', {
        className: 'raise-controls__hint',
        text: raiseState.notice ?? 'Повышение недоступно.',
      }),
      declineButton,
    );
    return container;
  }

  const hint = createElement('p', {
    className: 'raise-controls__hint',
    text: 'Максимум = 120 + бонусы марьяжей на руке.',
  });
  const input = createElement('input', {
    className: 'raise-controls__input',
    attrs: {
      type: 'number',
      min: raiseState.min,
      max: raiseState.max,
      step: 5,
      inputmode: 'numeric',
      placeholder: String(raiseState.min),
      'aria-label': 'Новая сумма заказа',
    },
    dataset: { action: 'raise-amount' },
  });
  const raiseButton = createElement('button', {
    className: ['button', 'raise-controls__submit'],
    text: 'Повысить',
    attrs: { type: 'button' },
    dataset: { action: 'raise-contract' },
  });
  const actions = createElement('div', { className: 'raise-controls__actions' });

  const readAmount = () => (input.value.trim() === '' ? Number.NaN : Number(input.value));
  const isValid = () => isLegalRaiseAmount(readAmount(), {
    contract,
    max: raiseState.max,
  });
  const refresh = () => {
    raiseButton.disabled = !isValid();
  };
  const submit = () => {
    const amount = readAmount();

    if (isLegalRaiseAmount(amount, { contract, max: raiseState.max })) {
      onRaise?.(amount);
    }
  };

  input.addEventListener('input', refresh);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submit();
    }
  });
  raiseButton.addEventListener('click', () => {
    if (!raiseButton.disabled) {
      submit();
    }
  });

  actions.append(input, raiseButton, declineButton);
  container.append(hint, actions);
  refresh();

  return container;
}
