// ════════════════════════════════════════════════════════════════════
// BandSync — Computer Keyboard Input
// ════════════════════════════════════════════════════════════════════
// Maps QWERTY keys to MIDI note numbers and dispatches synthetic
// noteOn / noteOff events for the gameplay engine. Lets a player whose
// "MIDI device" is set to DEVICE_ID_KEYBOARD play with their laptop
// keyboard.
//
// Default mapping covers two octaves and follows the de-facto piano-sim
// layout (Garageband / Logic / Ableton): lower octave on the z/q row,
// upper octave on the q/digit row. The same MIDI note can only be held
// by one keyboard key at a time, so multi-octave key collisions are
// not possible inside one mapping.
//
// Only one slot per page may listen (enforced by the picker). When two
// players sat at one machine want to use a keyboard, that's a future
// "split keyboard" feature; not built today.
// ════════════════════════════════════════════════════════════════════

// Lower octave (C4 = MIDI 60) on the asdf row → garageband-ish.
// Upper octave (C5 = MIDI 72) on the qwer row.
//   z s x d c v g b h n j m   → C C# D D# E F F# G G# A A# B (octave 4)
//   q 2 w 3 e r 5 t 6 y 7 u   → C C# D D# E F F# G G# A A# B (octave 5)
export const DEFAULT_KEYBOARD_MAP = {
  // Lower octave
  KeyZ: 60, KeyS: 61, KeyX: 62, KeyD: 63, KeyC: 64,
  KeyV: 65, KeyG: 66, KeyB: 67, KeyH: 68, KeyN: 69,
  KeyJ: 70, KeyM: 71,
  // Upper octave
  KeyQ: 72, Digit2: 73, KeyW: 74, Digit3: 75, KeyE: 76,
  KeyR: 77, Digit5: 78, KeyT: 79, Digit6: 80, KeyY: 81,
  Digit7: 82, KeyU: 83,
};

// 'KeyZ' → 'Z', 'Digit2' → '2'
function codeToLabel(code) {
  if (code.startsWith('Key'))   return code.slice(3).toUpperCase();
  if (code.startsWith('Digit')) return code.slice(5);
  return code;
}


export function createKeyboardInput({ map = DEFAULT_KEYBOARD_MAP, onEvent } = {}) {
  // Build the inverse lookup (midi-note → display label) once.
  const labelByNote = {};
  for (const [code, note] of Object.entries(map)) {
    labelByNote[note] = codeToLabel(code);
  }

  const held = new Set();
  let attached = false;

  function onKeyDown(e) {
    // Ignore when the user is typing in a form field anywhere on the page.
    if (isFormTarget(e.target)) return;
    const note = map[e.code];
    if (note == null) return;
    e.preventDefault();
    if (held.has(note)) return;     // suppress OS key-repeat
    held.add(note);
    onEvent?.({ type: 'noteOn', note, velocity: 100 });
  }

  function onKeyUp(e) {
    if (isFormTarget(e.target)) return;
    const note = map[e.code];
    if (note == null) return;
    e.preventDefault();
    if (!held.has(note)) return;
    held.delete(note);
    onEvent?.({ type: 'noteOff', note, velocity: 0 });
  }

  function isFormTarget(el) {
    if (!el || !el.tagName) return false;
    const tag = el.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
  }

  return {
    attach() {
      if (attached) return;
      window.addEventListener('keydown', onKeyDown);
      window.addEventListener('keyup',   onKeyUp);
      attached = true;
    },
    detach() {
      if (!attached) return;
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup',   onKeyUp);
      held.clear();
      attached = false;
    },
    // For renderer label lookup: returns 'Z' / '2' / null.
    labelFor(midiNote) {
      return labelByNote[midiNote] ?? null;
    },
  };
}
