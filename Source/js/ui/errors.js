/**
 * Human-friendly messages for engine error codes. The engine still exposes
 * precise technical messages, but the interface never shows internal card ids
 * or phase names to the player.
 */

const ERROR_MESSAGES = Object.freeze({
  PLAYER_PASSED: 'Этот игрок уже спасовал в текущей раздаче.',
  NOT_YOUR_TURN: 'Сейчас не ваш ход. Дождитесь своей очереди.',
  CANNOT_PASS: 'Открывающий торги обязан сказать 80 и не может пасовать.',
  NEGATIVE_SCORE_CANNOT_BID: 'При отрицательном счёте нельзя повышать ставку или пасовать. Можно только открыть 80.',
  INVALID_BID: 'Такую ставку сделать нельзя. Выберите одну из доступных кнопок.',
  INVALID_TARGET: 'Карту нужно отдать одному из соперников.',
  TARGET_ALREADY_RECEIVED: 'Этому сопернику карта уже отдана. Выберите другого.',
  NOT_DECLARER: 'Это действие доступно только играющему.',
  INVALID_RAISE: 'Заказ можно повысить только до числа больше текущего, кратного 5 и не выше 120.',
  NEGATIVE_SCORE_NO_RAISE: 'При отрицательном счёте повышать заказ нельзя.',
  RAISE_ALREADY_DECIDED: 'Решение о повышении заказа уже принято.',
  RAISE_WINDOW_CLOSED: 'Повысить заказ можно только до первой отданной карты.',
  CARD_NOT_IN_HAND: 'Этой карты уже нет в вашей руке.',
  MARRIAGE_NOT_ALLOWED: 'Марьяж объявляется только перед первым ходом взятки после первой завершённой взятки.',
  MARRIAGE_LIMIT: 'За один ход можно объявить только один марьяж.',
  MARRIAGE_ALREADY_DECLARED: 'Этот марьяж уже объявлен в текущей раздаче.',
  MARRIAGE_UNAVAILABLE: 'Для этого марьяжа нужны король и дама на руке.',
  MARRIAGE_PENDING: 'Сначала подтвердите или отмените объявленный марьяж.',
  MARRIAGE_CARD_REQUIRED: 'После объявления марьяжа нужно выйти королём или дамой этой масти.',
  NO_PENDING_MARRIAGE: 'Нет объявленного марьяжа для отмены.',
  NOT_MARRIAGE_OWNER: 'Отменить марьяж может только объявивший его игрок.',
  INVALID_SUIT: 'Эта масть сейчас недоступна для марьяжа.',
  ILLEGAL_CARD: 'Этой картой сейчас ходить нельзя: следуйте масти, а при её отсутствии — козырю.',
  INVALID_PHASE: 'Действие сейчас недоступно. Дождитесь нужной фазы игры.',
  INVALID_CARD: 'Не удалось распознать карту. Попробуйте ещё раз.',
  UNKNOWN_PLAYER: 'Не удалось определить игрока. Начните новую игру.',
});

/**
 * @param {unknown} error
 * @returns {string}
 */
export function getActionErrorMessage(error) {
  if (!error || typeof error !== 'object') {
    return 'Не удалось выполнить действие. Попробуйте ещё раз.';
  }

  const code = typeof error.code === 'string' ? error.code : '';
  const message = typeof error.message === 'string' ? error.message.trim() : '';

  return ERROR_MESSAGES[code] ?? (message || 'Не удалось выполнить действие. Попробуйте ещё раз.');
}
