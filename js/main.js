const PLAYERS = [
  { id: 'alice', name: 'Алиса', initial: 'А', isHuman: false },
  { id: 'boris', name: 'Борис', initial: 'Б', isHuman: false },
  { id: 'human', name: 'Вы', initial: 'В', isHuman: true },
];

/**
 * Creates an element with an optional class name and text.
 * @param {string} tag
 * @param {string} [className]
 * @param {string} [text]
 * @returns {HTMLElement}
 */
function createElement(tag, className, text) {
  const element = document.createElement(tag);

  if (className) {
    element.className = className;
  }

  if (text) {
    element.textContent = text;
  }

  return element;
}

/**
 * Renders a player summary panel.
 * @param {{ id: string, name: string, initial: string, isHuman: boolean }} player
 * @returns {HTMLElement}
 */
function renderPlayerPanel(player) {
  const panel = createElement('article', 'player-card');
  panel.dataset.playerId = player.id;

  if (player.isHuman) {
    panel.classList.add('player-card--human');
  }

  const avatar = createElement('div', 'player-card__avatar', player.initial);
  avatar.setAttribute('aria-hidden', 'true');

  const body = createElement('div', 'player-card__body');
  const head = createElement('div', 'player-card__head');
  const name = createElement('h2', 'player-card__name', player.name);

  head.append(name);

  const stats = createElement('div', 'player-card__stats');

  const score = createElement('div', 'score');
  const scoreValue = createElement('span', 'score__value', '0');
  const scoreLabel = createElement('span', 'score__label', 'очков');
  score.append(scoreValue, scoreLabel);

  const cardCount = createElement('span', 'card-count', '0 карт');

  const bolts = createElement('div', 'bolts');
  bolts.setAttribute('aria-label', 'Болты: 0 из 3');
  bolts.append(createElement('span', 'bolts__label', 'Болты'));

  for (let index = 0; index < 3; index += 1) {
    const bolt = createElement('span', 'bolt');
    bolt.setAttribute('aria-hidden', 'true');
    bolts.append(bolt);
  }

  stats.append(score, cardCount, bolts);
  body.append(head, stats);
  panel.append(avatar, body);

  return panel;
}

/**
 * Renders the decorative center of the table.
 * @returns {HTMLElement}
 */
function renderTableCenter() {
  const emblem = createElement('div', 'table-emblem');
  const fan = createElement('div', 'card-fan');
  fan.setAttribute('aria-hidden', 'true');

  const cards = [
    { rank: 'A', suit: '♠', isRed: false },
    { rank: 'K', suit: '♥', isRed: true },
    { rank: 'Q', suit: '♦', isRed: true },
  ];

  for (const card of cards) {
    const cardElement = createElement('div', 'hero-card');
    cardElement.classList.toggle('hero-card--red', card.isRed);
    cardElement.append(
      createElement('span', 'hero-card__rank', card.rank),
      createElement('span', 'hero-card__suit', card.suit),
    );
    fan.append(cardElement);
  }

  const eyebrow = createElement('p', 'table-emblem__eyebrow', 'Классическая игра');
  const title = createElement('h2', 'table-emblem__title', 'Тысяча');
  const meta = createElement('p', 'table-emblem__meta', '24 карты · 3 игрока · 8 взяток');
  const hint = createElement('p', 'table-emblem__hint', 'Стол готов к первой раздаче');

  emblem.append(fan, eyebrow, title, meta, hint);
  return emblem;
}

/**
 * Renders the player's hand placeholder.
 * @returns {HTMLElement}
 */
function renderHand() {
  const head = createElement('div', 'hand__head');
  head.append(
    createElement('h2', 'hand__title', 'Ваши карты'),
    createElement('span', 'hand__count', '0 карт'),
  );

  const empty = createElement('p', 'hand__empty', 'После раздачи здесь появятся ваши карты.');

  const fragment = document.createDocumentFragment();
  fragment.append(head, empty);
  return fragment;
}

/**
 * Renders the event log placeholder.
 * @returns {HTMLElement}
 */
function renderLogEmptyState() {
  return createElement(
    'p',
    'game-log__empty',
    'Ставки, взятки и итоги раздач будут появляться здесь.',
  );
}

function bootstrap() {
  const opponents = document.getElementById('opponents');
  const humanPanel = document.getElementById('human-panel');
  const tableCenter = document.getElementById('table-center');
  const hand = document.getElementById('hand');
  const gameLog = document.getElementById('game-log');

  if (!opponents || !humanPanel || !tableCenter || !hand || !gameLog) {
    return;
  }

  for (const player of PLAYERS) {
    if (player.isHuman) {
      humanPanel.append(renderPlayerPanel(player));
    } else {
      opponents.append(renderPlayerPanel(player));
    }
  }

  tableCenter.append(renderTableCenter());
  hand.append(renderHand());
  gameLog.append(renderLogEmptyState());

  document.body.dataset.appState = 'ready';
}

bootstrap();
