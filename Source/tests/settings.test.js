import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  loadSettings,
  normalizeSettings,
  saveSettings,
} from '../js/ui/settings.js';
import {
  ONBOARDING_KEY,
  hasSeenOnboarding,
  markOnboardingSeen,
} from '../js/ui/onboarding.js';

/**
 * @param {Record<string, string>} [initial]
 * @returns {Storage}
 */
function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));

  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, String(value)),
  };
}

test('settings default to sound and animations enabled', () => {
  assert.deepEqual(DEFAULT_SETTINGS, { sound: true, animations: true });
  assert.deepEqual(normalizeSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(
    normalizeSettings({ sound: 'yes', animations: 1 }),
    DEFAULT_SETTINGS,
  );
});

test('normalization keeps known booleans and fills missing fields', () => {
  assert.deepEqual(
    normalizeSettings({ sound: false }),
    { sound: false, animations: true },
  );
  assert.deepEqual(
    normalizeSettings({ animations: false, extra: 'ignored' }),
    { sound: true, animations: false },
  );
});

test('settings persist in localStorage-compatible storage', () => {
  const storage = createStorage();
  const saved = saveSettings({ sound: false, animations: false }, storage);

  assert.deepEqual(saved, { sound: false, animations: false });
  assert.equal(
    storage.getItem(SETTINGS_KEY),
    JSON.stringify({ sound: false, animations: false }),
  );
  assert.deepEqual(loadSettings(storage), { sound: false, animations: false });
});

test('invalid or missing stored settings fall back to defaults', () => {
  assert.deepEqual(loadSettings(createStorage()), DEFAULT_SETTINGS);
  assert.deepEqual(
    loadSettings(createStorage({ [SETTINGS_KEY]: '{broken' })),
    DEFAULT_SETTINGS,
  );
  assert.deepEqual(
    loadSettings(createStorage({ [SETTINGS_KEY]: 'null' })),
    DEFAULT_SETTINGS,
  );
  assert.deepEqual(loadSettings(null), DEFAULT_SETTINGS);
});

test('onboarding is marked as seen exactly once', () => {
  const storage = createStorage();

  assert.equal(hasSeenOnboarding(storage), false);
  assert.equal(markOnboardingSeen(storage), true);
  assert.equal(hasSeenOnboarding(storage), true);
  assert.equal(storage.getItem(ONBOARDING_KEY), '1');
  assert.equal(hasSeenOnboarding(createStorage({ [ONBOARDING_KEY]: '0' })), false);
});
