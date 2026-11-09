import { GAME_EVENTS, TARGET_SCORE } from './core/constants.js';
import { RelayClient } from './net/relay-client.js';
import {
  NetworkLobby,
  openNetworkLobbyModal,
} from './net/lobby.js';
import { isValidRoomCode, normalizeRoomCode } from './net/protocol.js';
import { GuestSession } from './session/guest-session.js';
import { HostSession } from './session/host-session.js';
import { LocalSession } from './session/local-session.js';
import { Controller } from './ui/controller.js';
import { createLogDrawer } from './ui/log-drawer.js';
import { showToast } from './ui/modals.js';
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

/**
 * Reads a room code from `?room=ABC234`. Only the code is ever placed in the
 * URL; tokens live in storage and request headers.
 *
 * @returns {string}
 */
function getRoomFromUrl() {
  const raw = new URLSearchParams(window.location.search).get('room');
  const code = normalizeRoomCode(raw);

  return isValidRoomCode(code) ? code : '';
}

/**
 * Reads a web storage object without throwing in private or restricted modes.
 *
 * @param {'sessionStorage' | 'localStorage'} name
 * @returns {Storage | null}
 */
function getWebStorage(name) {
  try {
    return window[name] ?? null;
  } catch {
    return null;
  }
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
    networkButton: document.getElementById('network'),
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

  const localSession = new LocalSession({
    players: PLAYERS,
    humanId: HUMAN_ID,
    seed: getSeedFromUrl(),
    targetScore: getTargetFromUrl(),
  });

  const controller = new Controller({
    session: localSession,
    elements: { ...elements, logDrawer },
  });

  let activeMode = 'local';
  let activeNetwork = null;
  let pendingNetwork = null;
  let networkModal = null;
  let openingNetwork = false;

  /**
   * Stops the network session (if any) and restores the local game without
   * losing the local seed/target settings.
   *
   * @returns {void}
   */
  function activateLocal() {
    if (pendingNetwork) {
      pendingNetwork.session?.dispose?.();
      pendingNetwork.lobby?.dispose?.();
      pendingNetwork = null;
    }

    if (activeNetwork) {
      activeNetwork.session?.dispose?.();
      activeNetwork.lobby?.dispose?.();
      activeNetwork = null;
    }

    if (activeMode !== 'local') {
      activeMode = 'local';
      controller.replaceSession(localSession);
    }

    if (elements.newGameButton) {
      elements.newGameButton.disabled = false;
    }
  }

  /**
   * Switches the controller to a host or guest session.
   *
   * @param {object} session
   * @param {NetworkLobby} lobby
   * @param {'host' | 'guest'} role
   * @returns {void}
   */
  function activateNetworkSession(session, lobby, role) {
    if (activeNetwork) {
      activeNetwork.session?.dispose?.();
      activeNetwork.lobby?.dispose?.();
    }

    activeNetwork = { session, lobby, role };
    activeMode = 'network';
    lobby.stopPolling();
    controller.replaceSession(session);

    if (elements.newGameButton) {
      elements.newGameButton.disabled = session.capabilities?.canRestart === false;
    }
  }

  /**
   * Explicit exit from a network game: closes or leaves the room, stops all
   * polls and returns to the local table.
   *
   * @returns {Promise<void>}
   */
  async function exitNetwork() {
    const network = activeNetwork;

    if (pendingNetwork) {
      pendingNetwork.session?.dispose?.();
      pendingNetwork.lobby?.dispose?.();
      pendingNetwork = null;
    }

    if (network?.lobby) {
      void network.lobby.leave().catch(() => {});
    }

    activateLocal();
    showToast('Вы вернулись в локальную игру.', 'info');
  }

  /**
   * Opens the network lobby modal. Health errors are rendered inside the modal
   * and never replace the local game.
   *
   * @param {string} [initialRoomCode]
   * @returns {Promise<void>}
   */
  async function openNetwork(initialRoomCode = '') {
    if (networkModal || openingNetwork) {
      return;
    }

    openingNetwork = true;
    controller.pause();

    const relay = new RelayClient();
    const lobby = new NetworkLobby({
      relay,
      sessionStorage: getWebStorage('sessionStorage'),
      localStorage: getWebStorage('localStorage'),
    });

    try {
      const handle = await openNetworkLobbyModal({
        lobby,
        initialRoomCode,
        onHostStart: async ({ lobby: networkLobby, close }) => {
          const host = new HostSession({
            relay,
            roomCode: networkLobby.roomCode,
            token: networkLobby.token,
            lobby: networkLobby.lobby,
            hostName: networkLobby.name,
            seed: getSeedFromUrl(),
            targetScore: getTargetFromUrl(),
          });

          networkModal = null;
          activateNetworkSession(host, networkLobby, 'host');
          await host.start();
          close();

          if (host.lastPublishError) {
            showToast('Партия началась, но гости не получили снимок. Проверьте сеть.');
          } else {
            showToast('Партия началась. Гости видят свой стол.', 'info');
          }
        },
        onGuestJoined: async ({ lobby: networkLobby, close }) => {
          const guest = new GuestSession({
            relay,
            roomCode: networkLobby.roomCode,
            token: networkLobby.token,
            playerId: networkLobby.playerId,
            name: networkLobby.name,
          });
          let activated = false;
          let offError = () => {};
          const off = guest.on(GAME_EVENTS.STATE_CHANGE, () => {
            if (activated) {
              return;
            }

            activated = true;
            off();
            offError();
            pendingNetwork = null;
            networkModal = null;
            activateNetworkSession(guest, networkLobby, 'guest');
            close();
            showToast('Вы за столом. Ждём остальных игроков.', 'info');
          });
          offError = guest.on(GAME_EVENTS.ERROR, (error) => {
            if (![401, 404, 410].includes(error?.status)) {
              return;
            }

            off();
            offError();
            pendingNetwork = null;
            networkModal = null;
            guest.dispose();
            close();
            activateLocal();
            controller.resume();
            showToast('Комната закрыта или недоступна. Вы вернулись в локальную игру.');
          });

          pendingNetwork = { session: guest, lobby: networkLobby };

          try {
            await guest.start();
          } catch (error) {
            off();
            offError();
            pendingNetwork = null;
            guest.dispose();
            showToast(
              error instanceof Error && error.message
                ? error.message
                : 'Не удалось подключиться к комнате.',
            );
          }
        },
        onExit: () => {
          networkModal = null;
          activateLocal();
          controller.resume();
        },
      });

      if (!handle) {
        lobby.dispose();
        controller.resume();
        return;
      }

      if (!handle.isClosed()) {
        networkModal = handle;
      }
    } catch (error) {
      lobby.dispose();
      controller.resume();
      console.error('[1000]', error);
      showToast('Не удалось открыть сетевое лобби.');
    } finally {
      openingNetwork = false;
    }
  }

  elements.networkButton?.addEventListener('click', () => {
    if (activeMode === 'network') {
      void exitNetwork();
      return;
    }

    void openNetwork();
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

  const roomFromUrl = getRoomFromUrl();

  if (hasSeenOnboarding()) {
    controller.start();

    if (roomFromUrl) {
      void openNetwork(roomFromUrl);
    }
  } else {
    openOnboarding({
      onStart: () => {
        controller.start();

        if (roomFromUrl) {
          void openNetwork(roomFromUrl);
        }
      },
    });
  }

  document.body.dataset.appState = 'ready';
}

bootstrap();
