import { BIDDING, DEAL, TARGET_SCORE } from '../core/constants.js';
import { createElement } from './dom.js';
import { closeModal, openModal } from './modals.js';

/** localStorage key that remembers the completed first-run tour. */
export const ONBOARDING_KEY = '1000.onboarding.v1';

/** Three short steps shown once on the first visit. */
export const ONBOARDING_STEPS = Object.freeze([
  Object.freeze({
    title: 'Добро пожаловать за стол',
    text: `Вы играете против Алисы и Бориса. Ход идёт по часовой стрелке: Вы → Алиса → Борис. Цель — единолично набрать ${TARGET_SCORE} очков.`,
    points: Object.freeze([
      'Сдающий меняется после каждой раздачи, а первым в торгах говорит игрок слева от него.',
      'На старте у всех 0 очков и 0 болтов. Игра идёт до единоличной победы.',
    ]),
  }),
  Object.freeze({
    title: 'Торги, прикуп и отдар',
    text: `Первый игрок обязан открыть торги ставкой ${BIDDING.MIN}. Дальше ставки растут до ${BIDDING.MAX} с шагом ${BIDDING.STEP}.`,
    points: Object.freeze([
      `Победитель торгов забирает ${DEAL.PRIKUP_SIZE} карты прикупа и отдаёт по одной карте каждому сопернику.`,
      'После отдара у всех по 8 карт. Играющий делает первый ход, а его ставка становится заказом.',
      `Игрок с отрицательным счётом не торгуется: он может только открыть ${BIDDING.MIN}, а при следующей очереди пасует автоматически.`,
    ]),
  }),
  Object.freeze({
    title: 'Марьяжи, козырь и взятки',
    text: 'Король и дама одной масти — это марьяж. Он приносит от 40 до 100 очков и сразу делает свою масть козырем.',
    points: Object.freeze([
      'Козырь появляется только после объявления марьяжа. Без марьяжа раздача идёт без козыря.',
      `Разыгрывается ${DEAL.TRICKS} взяток. Следуйте масти, а при её отсутствии — козырю. Полные правила всегда доступны в шапке.`,
    ]),
  }),
]);

/**
 * @returns {Storage | null}
 */
function getDefaultStorage() {
  try {
    return typeof globalThis !== 'undefined' ? globalThis.localStorage ?? null : null;
  } catch {
    return null;
  }
}

/**
 * @param {Storage | null} [storage]
 * @returns {boolean}
 */
export function hasSeenOnboarding(storage = getDefaultStorage()) {
  if (!storage) {
    return false;
  }

  try {
    return storage.getItem(ONBOARDING_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * @param {Storage | null} [storage]
 * @returns {boolean} True when the flag was written.
 */
export function markOnboardingSeen(storage = getDefaultStorage()) {
  if (!storage) {
    return false;
  }

  try {
    storage.setItem(ONBOARDING_KEY, '1');
    return true;
  } catch {
    return false;
  }
}

/**
 * Opens the first-run tour. The game is expected to start from `onStart` after
 * the dialog closes, so the AI never plays behind the onboarding overlay.
 *
 * @param {object} options
 * @param {() => void} options.onStart
 * @returns {{ element: HTMLElement, close: () => void } | null}
 */
export function openOnboarding({ onStart }) {
  let stepIndex = 0;
  let finished = false;
  let nextButton = null;

  const finish = () => {
    if (finished) {
      return;
    }

    finished = true;
    markOnboardingSeen();
    onStart();
  };

  const body = createElement('div', { className: 'onboarding' });
  const progress = createElement('div', {
    className: 'onboarding__progress',
    attrs: { 'aria-hidden': 'true' },
  });
  const counter = createElement('span', { className: 'onboarding__counter' });
  const content = createElement('div', {
    className: 'onboarding__content',
    attrs: { 'aria-live': 'polite' },
  });

  body.append(
    createElement('div', { className: 'onboarding__progress-row' }, progress, counter),
    content,
  );

  const footer = createElement('div', { className: 'modal__footer-row onboarding__footer' });
  const backButton = createElement('button', {
    className: 'button button--ghost',
    text: 'Назад',
    attrs: { type: 'button' },
  });
  const skipButton = createElement('button', {
    className: 'button button--ghost',
    text: 'Пропустить',
    attrs: { type: 'button' },
  });
  const nextButtonEl = createElement('button', {
    className: 'button',
    text: 'Далее',
    attrs: { type: 'button', 'data-autofocus': 'true' },
  });

  nextButton = nextButtonEl;
  footer.append(backButton, skipButton, nextButtonEl);

  const renderStep = () => {
    const step = ONBOARDING_STEPS[stepIndex];

    progress.replaceChildren(
      ...ONBOARDING_STEPS.map((entry, index) => createElement('span', {
        className: [
          'onboarding__dot',
          index === stepIndex ? 'onboarding__dot--active' : '',
          index < stepIndex ? 'onboarding__dot--done' : '',
        ],
      })),
    );
    counter.textContent = `Шаг ${stepIndex + 1} из ${ONBOARDING_STEPS.length}`;
    content.replaceChildren(
      createElement('h3', { className: 'onboarding__title', text: step.title }),
      createElement('p', { className: 'onboarding__text', text: step.text }),
      createElement('ul', { className: 'onboarding__points' }, ...step.points.map(
        (point) => createElement('li', { text: point }),
      )),
    );

    backButton.disabled = stepIndex === 0;
    nextButtonEl.textContent = stepIndex === ONBOARDING_STEPS.length - 1
      ? 'Начать игру'
      : 'Далее';
  };

  backButton.addEventListener('click', () => {
    if (stepIndex === 0) {
      return;
    }

    stepIndex -= 1;
    renderStep();
    nextButton?.focus({ preventScroll: true });
  });

  skipButton.addEventListener('click', () => closeModal());

  nextButtonEl.addEventListener('click', () => {
    if (stepIndex === ONBOARDING_STEPS.length - 1) {
      closeModal();
      return;
    }

    stepIndex += 1;
    renderStep();
    nextButton?.focus({ preventScroll: true });
  });

  const modal = openModal({
    kind: 'onboarding',
    title: 'Как играть',
    subtitle: 'Три шага перед первой партией',
    body,
    footer,
    dismissible: true,
    className: 'modal--onboarding',
    onClose: finish,
  });

  if (!modal) {
    finish();
    return null;
  }

  renderStep();
  nextButton?.focus({ preventScroll: true });

  return modal;
}
