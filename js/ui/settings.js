import { prefersReducedMotion, setAnimationsEnabled } from './animations.js';
import { createElement } from './dom.js';
import { closeModal, openModal } from './modals.js';
import { playSound, setSoundEnabled } from './sound.js';

/** localStorage key for the player's UI preferences. */
export const SETTINGS_KEY = '1000.settings.v1';

/** Defaults used on the first visit and when stored data is invalid. */
export const DEFAULT_SETTINGS = Object.freeze({
  sound: true,
  animations: true,
});

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
 * Keeps only known boolean fields and fills missing values with defaults.
 *
 * @param {unknown} value
 * @returns {{ sound: boolean, animations: boolean }}
 */
export function normalizeSettings(value) {
  const source = value && typeof value === 'object' ? value : {};

  return Object.freeze({
    sound: typeof source.sound === 'boolean' ? source.sound : DEFAULT_SETTINGS.sound,
    animations: typeof source.animations === 'boolean'
      ? source.animations
      : DEFAULT_SETTINGS.animations,
  });
}

/**
 * @param {Storage | null} [storage]
 * @returns {{ sound: boolean, animations: boolean }}
 */
export function loadSettings(storage = getDefaultStorage()) {
  if (!storage) {
    return normalizeSettings(null);
  }

  try {
    const raw = storage.getItem(SETTINGS_KEY);

    if (raw === null) {
      return normalizeSettings(null);
    }

    return normalizeSettings(JSON.parse(raw));
  } catch {
    return normalizeSettings(null);
  }
}

/**
 * @param {object} settings
 * @param {Storage | null} [storage]
 * @returns {{ sound: boolean, animations: boolean }} The normalized value.
 */
export function saveSettings(settings, storage = getDefaultStorage()) {
  const normalized = normalizeSettings(settings);

  if (!storage) {
    return normalized;
  }

  try {
    storage.setItem(SETTINGS_KEY, JSON.stringify(normalized));
  } catch {
    // Private mode and a full quota must not break the game.
  }

  return normalized;
}

/**
 * Applies settings to the animation and sound modules. Called on startup and
 * immediately when a switch changes.
 *
 * @param {object} settings
 * @returns {{ sound: boolean, animations: boolean }} The normalized value.
 */
export function applySettings(settings) {
  const normalized = normalizeSettings(settings);

  setSoundEnabled(normalized.sound);
  setAnimationsEnabled(normalized.animations);

  if (typeof document !== 'undefined') {
    document.documentElement.dataset.animations = normalized.animations ? 'on' : 'off';
  }

  return normalized;
}

/**
 * @param {object} options
 * @param {string} options.id
 * @param {string} options.title
 * @param {string} options.description
 * @param {string | null} options.note
 * @param {boolean} options.checked
 * @param {boolean} options.disabled
 * @param {(checked: boolean) => void} options.onChange
 * @returns {HTMLElement}
 */
function createSettingRow({
  id,
  title,
  description,
  note,
  checked,
  disabled,
  onChange,
}) {
  const descriptionId = `${id}-description`;
  const row = createElement('label', {
    className: ['setting-row', disabled ? 'setting-row--disabled' : ''],
    attrs: { for: id },
  });
  const copy = createElement('span', { className: 'setting-row__copy' });

  copy.append(
    createElement('span', { className: 'setting-row__title', text: title }),
    createElement('span', {
      className: 'setting-row__description',
      text: description,
      attrs: { id: descriptionId },
    }),
  );

  if (note) {
    copy.append(createElement('span', { className: 'setting-row__note', text: note }));
  }

  const input = createElement('input', {
    className: 'switch',
    attrs: {
      id,
      type: 'checkbox',
      'aria-describedby': descriptionId,
    },
  });

  input.checked = checked;
  input.disabled = disabled;
  input.addEventListener('change', () => onChange(input.checked));

  row.append(copy, input);
  return row;
}

/**
 * Opens the settings dialog. Every switch is applied and persisted at once.
 *
 * @param {object} [options]
 * @param {object} [options.settings]
 * @param {((settings: { sound: boolean, animations: boolean }) => void) | null} [options.onChange]
 * @param {(() => void) | null} [options.onClose]
 * @returns {{ element: HTMLElement, close: () => void } | null}
 */
export function openSettingsModal({
  settings = DEFAULT_SETTINGS,
  onChange = null,
  onClose = null,
} = {}) {
  let current = normalizeSettings(settings);
  const reducedMotion = prefersReducedMotion();
  const body = createElement('div', { className: 'settings' });

  body.append(createElement('p', {
    className: 'settings__intro',
    text: 'Настройки сохраняются в этом браузере и применяются сразу.',
  }));

  const commit = (patch) => {
    current = normalizeSettings({ ...current, ...patch });
    applySettings(current);
    onChange?.(current);
  };

  body.append(
    createSettingRow({
      id: 'setting-sound',
      title: 'Звук',
      description: 'Короткие сигналы за карты, взятки, марьяжи и итоги раздачи.',
      note: null,
      checked: current.sound,
      disabled: false,
      onChange: (checked) => {
        commit({ sound: checked });

        if (checked) {
          playSound('settings');
        }
      },
    }),
    createSettingRow({
      id: 'setting-animations',
      title: 'Анимации',
      description: 'Раздача, выкладывание карт, сбор взятки и подсветка подсчёта.',
      note: reducedMotion
        ? 'Система просит уменьшить движение — анимации отключены до изменения настройки Windows.'
        : null,
      checked: reducedMotion ? false : current.animations,
      disabled: reducedMotion,
      onChange: (checked) => commit({ animations: checked }),
    }),
  );

  body.append(createElement('p', {
    className: 'settings__footnote',
    text: 'При выключенных анимациях игра работает быстрее и не отвлекает от карт.',
  }));

  return openModal({
    kind: 'settings',
    title: 'Настройки',
    subtitle: 'Звук и визуальные эффекты',
    body,
    actions: [
      {
        label: 'Готово',
        variant: 'primary',
        onClick: () => closeModal(),
      },
    ],
    dismissible: true,
    className: 'modal--settings',
    onClose,
  });
}
