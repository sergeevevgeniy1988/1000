import { TARGET_SCORE } from './core/constants.js';
import { LocalSession } from './session/local-session.js';
import { Controller } from './ui/controller.js';
import { createLogDrawer } from './ui/log-drawer.js';
import { hasSeenOnboarding, openOnboarding } from './ui/onboarding.js';
import { openRulesModal } from './ui/rules-modal.js';
import {
  applySettings,
  loadSettings,
  openSettingsModal,
  saveSettings,
} from './ui/settings.js';
import { installSoundUnlock } from './ui/sound.js';

const PLAYERS = [
  { id: 'alice', name: 'Алиса', isHuman: false },
  { id: 'boris', name: 'Борис', isHuman: false },
  { id: 'human', name: 'Вы', isHuman: true },
];

const HUMAN_ID = 'human';

/**
 * Reads a deterministic seed from `?seed=12345`.
 *
 * @returns {number | null}
 */
function getSeedFromUrl() {
  const raw = new URLSearchParams(window.location.search).get('seed');

  if (raw === null || raw.trim() === '') {
    return null;
  }

  const value = Number(raw);

  return Number.isFinite(value) ? value >>> 0 : null;
}

/**
 * Reads an optional development target score from `?target=`.
 * The production default always remains 1000.
 *
 * @returns {number}
 */
function getTargetFromUrl() {
  const raw = new URLSearchParams(window.location.search).get('target');

  if (raw === null) {
    return TARGET_SCORE;
  }

  const value = Number(raw);

  if (!Number.isFinite(value) || value < 50 || value > 100000) {
    return TARGET_SCORE;
  }

  return Math.round(value);
}

function bootstrap() {
  const elements = {
    opponents: document.getElementById('opponents'),
    humanPanel: document.getElementById('human-panel'),
    tableCenter: document.getElementById('table-center'),
    hand: document.getElementById('hand'),
    gameLog: document.getElementById('game-log'),
    actionBar: document.getElementById('action-bar'),
    targetScore: document.getElementById('target-score'),
    dealNumber: document.getElementById('deal-number'),
    newGameButton: document.getElementById('new-game'),
    rulesButton: document.getElementById('rules'),
    settingsButton: document.getElementById('settings'),
    board: document.getElementById('game'),
    announcer: document.getElementById('game-announcer'),
    logSidebar: document.getElementById('game-log-panel'),
    logToggle: document.getElementById('log-toggle'),
    logClose: document.getElementById('log-close'),
    logBackdrop: document.getElementById('log-backdrop'),
  };

  if (
    !elements.opponents
    || !elements.humanPanel
    || !elements.tableCenter
    || !elements.hand
    || !elements.gameLog
    || !elements.actionBar
    || !elements.targetScore
    || !elements.dealNumber
    || !elements.board
  ) {
    return;
  }

  let settings = applySettings(loadSettings());
  installSoundUnlock();

  const logDrawer = createLogDrawer({
    sidebar: elements.logSidebar,
    toggleButton: elements.logToggle,
    closeButton: elements.logClose,
    backdrop: elements.logBackdrop,
  });

  const session = new LocalSession({
    players: PLAYERS,
    humanId: HUMAN_ID,
    seed: getSeedFromUrl(),
    targetScore: getTargetFromUrl(),
  });

  const controller = new Controller({
    session,
    elements: { ...elements, logDrawer },
  });

  elements.rulesButton?.addEventListener('click', () => {
    logDrawer?.close({ restoreFocus: false });
    controller.pause();
    const modal = openRulesModal({ onClose: () => controller.resume() });

    if (!modal) {
      controller.resume();
    }
  });

  elements.settingsButton?.addEventListener('click', () => {
    logDrawer?.close({ restoreFocus: false });
    controller.pause();
    const modal = openSettingsModal({
      settings,
      onChange: (nextSettings) => {
        settings = saveSettings(nextSettings);
      },
      onClose: () => controller.resume(),
    });

    if (!modal) {
      controller.resume();
    }
  });

  if (hasSeenOnboarding()) {
    controller.start();
  } else {
    openOnboarding({ onStart: () => controller.start() });
  }

  document.body.dataset.appState = 'ready';
}

bootstrap();
