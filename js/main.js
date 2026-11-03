import { TARGET_SCORE } from './core/constants.js';
import { Game } from './core/game.js';
import { renderHand } from './ui/hand.js';
import { renderLog } from './ui/log.js';
import { renderTable } from './ui/table.js';

const PLAYERS = [
  { id: 'alice', name: 'Алиса', isHuman: false },
  { id: 'boris', name: 'Борис', isHuman: false },
  { id: 'human', name: 'Вы', isHuman: true },
];

const HUMAN_ID = 'human';

/**
 * Updates static deal metadata in the header.
 *
 * @param {object} state
 * @param {HTMLElement | null} targetScoreEl
 * @param {HTMLElement | null} dealNumberEl
 */
function renderHeader(state, targetScoreEl, dealNumberEl) {
  if (targetScoreEl) {
    targetScoreEl.textContent = String(state.targetScore);
  }

  if (dealNumberEl) {
    dealNumberEl.textContent = state.dealNumber > 0 ? String(state.dealNumber) : '—';
  }
}

function bootstrap() {
  const opponents = document.getElementById('opponents');
  const humanPanel = document.getElementById('human-panel');
  const tableCenter = document.getElementById('table-center');
  const hand = document.getElementById('hand');
  const gameLog = document.getElementById('game-log');
  const targetScoreEl = document.getElementById('target-score');
  const dealNumberEl = document.getElementById('deal-number');

  if (!opponents || !humanPanel || !tableCenter || !hand || !gameLog) {
    return;
  }

  const game = new Game({
    players: PLAYERS,
    targetScore: TARGET_SCORE,
  });

  game.subscribe((state) => {
    renderTable(state, { opponents, humanPanel, tableCenter });
    renderHand(state, { handEl: hand, playerId: HUMAN_ID });
    renderLog(state, gameLog);
    renderHeader(state, targetScoreEl, dealNumberEl);
    document.body.dataset.phase = state.phase;
  });

  game.start();
  document.body.dataset.appState = 'ready';
}

bootstrap();
