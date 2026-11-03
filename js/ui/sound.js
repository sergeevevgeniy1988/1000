/**
 * Tiny synthesized sound effects with the Web Audio API. No audio files, no
 * autoplay: the audio context is created only after the first user gesture.
 */

const SOUND_DEFINITIONS = Object.freeze({
  deal: {
    type: 'triangle',
    volume: 0.035,
    notes: [
      [196, 0, 0.07],
      [247, 0.06, 0.07],
      [330, 0.12, 0.09],
    ],
  },
  bid: {
    type: 'triangle',
    volume: 0.03,
    notes: [[523, 0, 0.05]],
  },
  pass: {
    type: 'sine',
    volume: 0.035,
    notes: [[220, 0, 0.09]],
  },
  prikup: {
    type: 'triangle',
    volume: 0.03,
    notes: [
      [262, 0, 0.06],
      [392, 0.05, 0.08],
    ],
  },
  gift: {
    type: 'triangle',
    volume: 0.028,
    notes: [[330, 0, 0.05], [294, 0.05, 0.06]],
  },
  card: {
    type: 'square',
    volume: 0.018,
    notes: [[420, 0, 0.025]],
  },
  trick: {
    type: 'triangle',
    volume: 0.03,
    notes: [
      [392, 0, 0.05],
      [523, 0.055, 0.07],
    ],
  },
  marriage: {
    type: 'sine',
    volume: 0.035,
    notes: [
      [440, 0, 0.09],
      [554, 0.09, 0.09],
      [659, 0.18, 0.12],
    ],
  },
  score: {
    type: 'triangle',
    volume: 0.032,
    notes: [
      [330, 0, 0.07],
      [440, 0.07, 0.08],
      [554, 0.15, 0.1],
    ],
  },
  win: {
    type: 'triangle',
    volume: 0.04,
    notes: [
      [392, 0, 0.1],
      [494, 0.1, 0.1],
      [587, 0.2, 0.12],
      [784, 0.32, 0.22],
    ],
  },
  error: {
    type: 'sawtooth',
    volume: 0.025,
    notes: [
      [180, 0, 0.1],
      [140, 0.11, 0.16],
    ],
  },
  settings: {
    type: 'sine',
    volume: 0.028,
    notes: [
      [660, 0, 0.05],
      [880, 0.06, 0.08],
    ],
  },
});

let soundEnabled = true;
let audioContext = null;
let audioUnlocked = false;
let unlockInstalled = false;

/**
 * @returns {AudioContext | null}
 */
function getAudioContext() {
  if (!audioUnlocked || typeof window === 'undefined') {
    return null;
  }

  if (audioContext === null) {
    const AudioContextClass = window.AudioContext ?? window.webkitAudioContext;

    if (typeof AudioContextClass !== 'function') {
      return null;
    }

    try {
      audioContext = new AudioContextClass();
    } catch {
      return null;
    }
  }

  return audioContext;
}

/**
 * Creates or resumes the audio context. Must be called inside a user gesture.
 *
 * @returns {AudioContext | null}
 */
export function unlockSound() {
  const context = getAudioContext();

  if (context && context.state === 'suspended') {
    context.resume().catch(() => {});
  }

  audioUnlocked = true;
  return context ?? getAudioContext();
}

/**
 * Installs one-time gesture listeners. Until a gesture happens, sounds are
 * silently ignored, so browsers never block or warn about autoplay.
 *
 * @param {Window | null} [target]
 * @returns {() => void} Removes the listeners if they are still pending.
 */
export function installSoundUnlock(target = typeof window !== 'undefined' ? window : null) {
  if (!target || unlockInstalled || typeof target.addEventListener !== 'function') {
    return () => {};
  }

  unlockInstalled = true;

  const unlock = () => {
    audioUnlocked = true;
    unlockSound();
    target.removeEventListener('pointerdown', unlock);
    target.removeEventListener('keydown', unlock);
  };

  target.addEventListener('pointerdown', unlock, { passive: true });
  target.addEventListener('keydown', unlock);

  return () => {
    target.removeEventListener('pointerdown', unlock);
    target.removeEventListener('keydown', unlock);
  };
}

/**
 * @param {boolean} enabled
 * @returns {void}
 */
export function setSoundEnabled(enabled) {
  soundEnabled = Boolean(enabled);

  if (audioContext === null) {
    return;
  }

  if (soundEnabled && audioContext.state === 'suspended') {
    audioContext.resume().catch(() => {});
  }

  if (!soundEnabled && audioContext.state === 'running') {
    audioContext.suspend().catch(() => {});
  }
}

/**
 * @returns {boolean}
 */
export function isSoundEnabled() {
  return soundEnabled;
}

/**
 * @param {AudioContext} context
 * @param {number} frequency
 * @param {number} offset
 * @param {number} duration
 * @param {OscillatorType} type
 * @param {number} volume
 * @returns {void}
 */
function scheduleTone(context, frequency, offset, duration, type, volume) {
  const start = context.currentTime + offset;
  const oscillator = context.createOscillator();
  const gain = context.createGain();

  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, start);

  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(volume, start + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.03);
}

/**
 * Plays a named sound effect. Unknown names and calls before the first gesture
 * are ignored.
 *
 * @param {string} name
 * @returns {boolean} True when the sound was scheduled.
 */
export function playSound(name) {
  if (!soundEnabled) {
    return false;
  }

  const definition = SOUND_DEFINITIONS[name];

  if (!definition) {
    return false;
  }

  const context = getAudioContext();

  if (!context) {
    return false;
  }

  if (context.state === 'suspended') {
    context.resume().catch(() => {});
  }

  for (const [frequency, offset, duration] of definition.notes) {
    scheduleTone(
      context,
      frequency,
      offset,
      duration,
      definition.type,
      definition.volume,
    );
  }

  return true;
}
