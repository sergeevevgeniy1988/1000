import { DEAL, PHASES } from '../core/constants.js';
import {
  formatGenitiveNames,
  formatPoints,
  getPhaseName,
  getSuitNameLower,
  nameGenitive,
  resolveViewerId,
} from './format.js';

/**
 * @param {object} state
 * @param {string} playerId
 * @returns {object | null}
 */
function findPlayer(state, playerId) {
  return state.players.find((player) => player.id === playerId) ?? null;
}

/**
 * Builds a short Russian sentence for the persistent aria-live region. It
 * describes the phase and whose turn it is without exposing hidden data.
 *
 * @param {object} state
 * @param {object} [options]
 * @param {string | null} [options.humanId] Backward-compatible viewer id.
 * @param {{ winnerId: string, points: number } | null} [options.reveal]
 * @returns {string}
 */
export function getPhaseAnnouncement(state, { humanId = null, reveal = null } = {}) {
  if (reveal) {
    const winner = findPlayer(state, reveal.winnerId);

    return `Взятка: ${formatPoints(reveal.points)}. Победитель — ${winner?.name ?? 'неизвестен'}.`;
  }

  const viewerId = resolveViewerId(state, humanId);
  const actor = findPlayer(state, state.currentPlayerId);
  const declarer = findPlayer(state, state.declarerId);
  const trump = state.trumpSuit
    ? ` Козырь — ${getSuitNameLower(state.trumpSuit)}.`
    : ' Козырь не объявлен.';

  switch (state.phase) {
    case PHASES.IDLE:
      return 'Новая партия готовится.';
    case PHASES.DEALING:
      return `Раздача ${state.dealNumber}.`;
    case PHASES.BIDDING: {
      const turn = actor && actor.id === viewerId
        ? 'Ваш ход в торгах.'
        : (actor ? `Ход ${nameGenitive(actor.name)} в торгах.` : 'Торги.');
      const bid = state.currentBid > 0 ? ` Текущая ставка — ${state.currentBid}.` : '';

      return `${turn}${bid}`;
    }
    case PHASES.PRIKUP:
      return declarer && declarer.id === viewerId
        ? 'Прикуп раскрыт всем игрокам. Заберите три карты.'
        : `Прикуп раскрыт всем игрокам. ${declarer?.name ?? 'Играющий'} забирает карты.`;
    case PHASES.GIVING: {
      const contract = Number.isFinite(state.contract)
        ? ` Заказ — ${state.contract}.`
        : '';

      if (declarer && declarer.id === viewerId) {
        const opponents = state.players.filter((player) => player.id !== viewerId);
        const names = formatGenitiveNames(opponents.map((player) => player.name));

        return `Отдар.${contract} Выберите по одной карте для ${names || 'соперников'}.`;
      }

      return `Отдар.${contract} ${declarer?.name ?? 'Играющий'} отдаёт карты соперникам.`;
    }
    case PHASES.PLAYING: {
      const pending = state.pendingMarriage;

      if (pending) {
        const owner = findPlayer(state, pending.playerId);

        return owner && owner.id === viewerId
          ? `Марьяж: ${getSuitNameLower(pending.suit)}. Выйдите королём или дамой.`
          : `Марьяж: ${getSuitNameLower(pending.suit)}. ${owner?.name ?? 'Игрок'} выходит королём или дамой.`;
      }

      const trickNumber = Math.min(state.completedTricks.length + 1, DEAL.TRICKS);
      const turn = actor && actor.id === viewerId
        ? 'Ваш ход.'
        : (actor ? `Ход ${nameGenitive(actor.name)}.` : 'Розыгрыш.');

      return `${turn} Взятка ${trickNumber} из ${DEAL.TRICKS}.${trump}`;
    }
    case PHASES.SCORING:
      return 'Подсчёт очков.';
    case PHASES.DEAL_END: {
      const result = state.lastDealResult;
      const outcome = result?.contractMet ? 'выполнен' : 'не выполнен';

      return `Итоги раздачи ${state.dealNumber}. Заказ ${result?.contract ?? '—'} ${outcome}.`;
    }
    case PHASES.GAME_OVER: {
      const winner = findPlayer(state, state.winnerId);

      return `Игра окончена. Победитель — ${winner?.name ?? 'не определён'}.`;
    }
    default:
      return getPhaseName(state.phase);
  }
}

/**
 * Wraps a persistent live region and avoids repeating identical messages.
 *
 * @param {HTMLElement | null} element
 * @returns {{ announce: (text: string) => void, reset: () => void }}
 */
export function createAnnouncer(element) {
  let lastMessage = '';

  return {
    announce(text) {
      if (!element || typeof text !== 'string' || text.length === 0) {
        return;
      }

      if (text === lastMessage) {
        return;
      }

      lastMessage = text;
      element.textContent = text;
    },
    reset() {
      lastMessage = '';

      if (element) {
        element.textContent = '';
      }
    },
  };
}
