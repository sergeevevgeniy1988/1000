import { BIDDING } from '../core/constants.js';
import { createElement } from './dom.js';
import { nameDative } from './format.js';
import { createCard, sortHand } from './hand.js';
import { openModal } from './modals.js';
import { getRaiseOptions } from './raise.js';

/**
 * Opens the mandatory public prikup reveal modal. The three cards are visible
 * to every player and stay out of the declarer's hand until the action button
 * is pressed.
 *
 * @param {object} options
 * @param {object} options.state Full state snapshot.
 * @param {() => void} options.onTakePrikup Called when the prikup is taken.
 * @returns {{ element: HTMLElement, close: () => void } | null}
 */
export function openPrikupRevealModal({ state, onTakePrikup }) {
  const declarer = state.players.find((player) => player.id === state.declarerId);

  if (!declarer || !Array.isArray(state.prikup) || state.prikup.length === 0) {
    return null;
  }

  const body = createElement('div', { className: 'prikup' });
  const intro = createElement('p', {
    className: 'prikup__intro',
    text: declarer.isHuman
      ? 'Прикуп раскрыт всем игрокам. Заберите три карты, затем при желании повысьте заказ и отдайте по одной карте каждому сопернику.'
      : `${declarer.name} раскрывает прикуп. Три карты видны всем игрокам; после продолжения ${declarer.name} заберёт их, решит, повышать ли заказ, и отдаст карты соперникам.`,
  });
  const section = createElement('section', {
    className: 'prikup__section',
    attrs: { 'aria-label': 'Карты прикупа' },
  });
  const sectionTitle = createElement('h3', {
    className: 'prikup__section-title',
    text: 'Прикуп',
  });
  const cards = createElement('div', { className: 'prikup__prikup-cards' });

  for (const cardId of state.prikup) {
    cards.append(createCard(cardId));
  }

  section.append(sectionTitle, cards);
  body.append(intro, section);

  const footer = createElement('div', { className: 'prikup__footer' });

  footer.append(createElement('p', {
    className: 'prikup__footer-hint',
    text: 'Карты прикупа видны всем игрокам.',
  }));

  return openModal({
    kind: 'prikup-reveal',
    title: 'Прикуп',
    subtitle: 'Три карты раскрыты всем игрокам',
    body,
    footer,
    actions: [{
      label: declarer.isHuman ? 'Забрать прикуп' : 'Продолжить',
      onClick: () => onTakePrikup?.(),
      variant: 'primary',
      action: 'take-prikup',
      autofocus: true,
    }],
    dismissible: false,
    className: 'modal--prikup',
  });
}

/**
 * Opens the single contract-raise window for a human declarer after the prikup
 * is taken and before the first gift.
 *
 * @param {object} options
 * @param {object} options.state Full state snapshot.
 * @param {string} options.humanId Human player id.
 * @param {(amount: number) => void} options.onRaise
 * @param {() => void} options.onDecline
 * @returns {{ element: HTMLElement, close: () => void } | null}
 */
export function openRaiseModal({ state, humanId, onRaise, onDecline }) {
  const declarer = state.players.find((player) => player.id === state.declarerId);

  if (!declarer || declarer.id !== humanId) {
    return null;
  }

  const negative = Number.isFinite(declarer.score) && declarer.score < 0;
  const options = negative ? [] : getRaiseOptions(state.contract);
  const body = createElement('div', { className: 'prikup' });
  let introText;

  if (negative) {
    introText = 'Повышение недоступно: отрицательный счёт.';
  } else if (options.length === 0) {
    introText = `Текущий заказ — ${state.contract}. Заказ уже максимальный: повышать некуда.`;
  } else {
    introText = `Текущий заказ — ${state.contract}. Можно один раз повысить его до первой карты отдара, но не выше ${BIDDING.MAX}.`;
  }

  body.append(createElement('p', {
    className: 'prikup__intro',
    text: introText,
  }));

  const actions = [];

  if (!negative) {
    for (const amount of options) {
      actions.push({
        label: String(amount),
        onClick: () => onRaise?.(amount),
        variant: 'ghost',
        action: `raise-${amount}`,
      });
    }
  }

  actions.push({
    label: negative ? 'Продолжить' : 'Оставить заказ',
    onClick: () => onDecline?.(),
    variant: 'primary',
    action: 'decline-raise',
    autofocus: true,
  });

  return openModal({
    kind: 'raise',
    title: 'Повысить заказ?',
    subtitle: negative ? 'Повышение недоступно' : 'Один раз до первой карты отдара',
    body,
    actions,
    dismissible: false,
    className: 'modal--prikup',
  });
}

/**
 * Opens the gift modal for a human declarer after the prikup has been taken.
 * The declarer chooses exactly one card for each opponent.
 *
 * @param {object} options
 * @param {object} options.state Full state snapshot.
 * @param {string} options.humanId Human player id.
 * @param {(gifts: { toPlayerId: string, cardId: string }[]) => void} options.onConfirm
 * @returns {{ element: HTMLElement, close: () => void } | null}
 */
export function openGiftModal({ state, humanId, onConfirm }) {
  const human = state.players.find((player) => player.id === humanId);

  if (!human) {
    return null;
  }

  const opponents = state.players.filter((player) => player.id !== humanId);

  if (opponents.length !== 2) {
    return null;
  }

  const prikupSet = new Set(state.prikup);
  const selections = new Map(opponents.map((player) => [player.id, null]));
  const cardNodes = new Map();
  let activeTargetId = opponents[0].id;

  const body = createElement('div', { className: 'prikup' });
  const intro = createElement('p', {
    className: 'prikup__intro',
    text: `Заказ ${state.contract}. Вы забрали прикуп. Отдайте ровно по одной карте `
      + 'Алисе и Борису: сначала выберите карту для одного соперника, затем для другого. '
      + 'Нажмите на слот соперника, чтобы перевыбрать карту.',
  });

  const handSection = createElement('section', {
    className: 'prikup__section',
    attrs: { 'aria-label': 'Ваша рука' },
  });
  const handTitle = createElement('h3', {
    className: 'prikup__section-title',
    text: 'Ваша рука — 10 карт',
  });
  const handCards = createElement('div', {
    className: 'prikup__hand',
    attrs: { role: 'group', 'aria-label': 'Выберите карты для отдара' },
  });

  for (const card of sortHand(human.hand)) {
    const wrap = createElement('div', { className: 'prikup__card-wrap' });
    const button = createCard(card, {
      interactive: true,
      onSelect: () => selectCard(card.id),
    });

    button.setAttribute('aria-pressed', 'false');

    if (prikupSet.has(card.id)) {
      button.classList.add('card--from-prikup');
    }

    wrap.append(button);

    if (prikupSet.has(card.id)) {
      wrap.append(
        createElement('span', { className: 'prikup__origin', text: 'из прикупа' }),
      );
    }

    cardNodes.set(card.id, { wrap, button });
    handCards.append(wrap);
  }

  handSection.append(handTitle, handCards);

  const giftSection = createElement('section', {
    className: 'prikup__section',
    attrs: { 'aria-label': 'Карты для соперников' },
  });
  const giftTitle = createElement('h3', {
    className: 'prikup__section-title',
    text: 'Кому какую карту',
  });
  const giftSlots = createElement('div', { className: 'gift-slots' });

  giftSection.append(giftTitle, giftSlots);
  body.append(intro, handSection, giftSection);

  const footer = createElement('div', { className: 'prikup__footer' });
  const footerInfo = createElement('p', {
    className: 'prikup__footer-hint',
    attrs: { 'aria-live': 'polite' },
  });
  const footerActions = createElement('div', { className: 'modal__actions' });
  const resetButton = createElement('button', {
    className: 'button button--ghost',
    text: 'Сбросить',
    attrs: { type: 'button' },
    dataset: { action: 'reset-gifts' },
  });
  const confirmButton = createElement('button', {
    className: 'button',
    text: 'Подтвердить отдар',
    attrs: { type: 'button' },
    dataset: { action: 'confirm-gifts' },
  });

  resetButton.addEventListener('click', () => {
    for (const target of opponents) {
      selections.set(target.id, null);
    }

    activeTargetId = opponents[0].id;
    refresh();
  });

  confirmButton.addEventListener('click', () => {
    const gifts = opponents.map((target) => ({
      toPlayerId: target.id,
      cardId: selections.get(target.id),
    }));

    if (gifts.some((gift) => gift.cardId === null)) {
      return;
    }

    onConfirm(gifts);
  });

  footerActions.append(resetButton, confirmButton);
  footer.append(footerInfo, footerActions);

  /**
   * @param {string} cardId
   */
  function selectCard(cardId) {
    const other = opponents.find((player) => player.id !== activeTargetId);

    if (other && selections.get(other.id) === cardId) {
      const current = selections.get(activeTargetId);
      selections.set(activeTargetId, cardId);
      selections.set(other.id, current);
    } else {
      selections.set(activeTargetId, cardId);
    }

    if (other && !selections.get(other.id)) {
      activeTargetId = other.id;
    }

    refresh();
  }

  /**
   * Rebuilds gift slots and updates card selection visuals.
   */
  function refresh() {
    const hadSlotFocus = giftSlots.contains(document.activeElement);

    giftSlots.replaceChildren();

    for (const target of opponents) {
      const selectedCardId = selections.get(target.id);
      const isActive = activeTargetId === target.id;
      const slot = createElement('div', {
        className: [
          'gift-slot',
          isActive ? 'gift-slot--active' : '',
          selectedCardId ? 'gift-slot--filled' : '',
        ].filter(Boolean),
        attrs: {
          role: 'button',
          tabindex: '0',
          'aria-pressed': isActive ? 'true' : 'false',
          'aria-label': `Карта для ${nameDative(target.name)}`,
        },
        dataset: { targetId: target.id },
      });
      const slotHead = createElement('span', { className: 'gift-slot__head' });
      const slotLabel = createElement('span', {
        className: 'gift-slot__name',
        text: target.name,
      });

      slotHead.append(slotLabel);

      if (isActive) {
        slotHead.append(
          createElement('span', { className: 'gift-slot__active', text: 'выбираем' }),
        );
      }

      const slotBody = createElement('span', { className: 'gift-slot__body' });

      if (selectedCardId) {
        slotBody.append(createCard(selectedCardId, { compact: true }));
      } else {
        slotBody.append(
          createElement('span', { className: 'gift-slot__empty', text: 'Выберите карту' }),
        );
      }

      slot.append(slotHead, slotBody);
      slot.addEventListener('click', () => {
        activeTargetId = target.id;
        refresh();
      });
      slot.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          activeTargetId = target.id;
          refresh();
        }
      });
      giftSlots.append(slot);
    }

    for (const [cardId, node] of cardNodes) {
      const selectedFor = opponents.find((target) => selections.get(target.id) === cardId);
      const selected = Boolean(selectedFor);

      node.button.classList.toggle('card--selected', selected);
      node.button.setAttribute('aria-pressed', selected ? 'true' : 'false');
      node.wrap.dataset.selectedFor = selectedFor ? selectedFor.id : '';
    }

    confirmButton.disabled = [...selections.values()].some((cardId) => cardId === null);

    const activeTarget = opponents.find((target) => target.id === activeTargetId);

    if (!confirmButton.disabled) {
      footerInfo.textContent = 'Обе карты выбраны. Можно подтвердить отдар.';
    } else if (activeTarget) {
      footerInfo.textContent = `Выберите карту для ${nameDative(activeTarget.name)}.`;
    }

    if (hadSlotFocus) {
      const activeSlot = giftSlots.querySelector(`[data-target-id="${activeTargetId}"]`);

      if (activeSlot instanceof HTMLElement) {
        activeSlot.focus({ preventScroll: true });
      }
    }
  }

  refresh();

  return openModal({
    kind: 'prikup',
    title: 'Отдар',
    subtitle: 'Одна карта Алисе, одна карта Борису',
    body,
    footer,
    dismissible: false,
    wide: true,
    className: 'modal--prikup',
  });
}
