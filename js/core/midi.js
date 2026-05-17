// ════════════════════════════════════════════════════════════════════
// BandSync — MIDI Engine
// ════════════════════════════════════════════════════════════════════
// Thin wrapper around the Web MIDI API. Hides raw status-byte parsing
// behind a clean event object, and gives callers control over which
// device(s) they listen to (so two players can have independent routing).
//
// Usage:
//   import { initMIDI, getInputs, attachListener } from './midi.js';
//
//   const result = await initMIDI();
//   if (!result.ok) { /* show "MIDI not supported" or "denied" */ }
//
//   const inputs = getInputs();           // [{ id, name, port }, ...]
//   attachListener(inputs[0].id, (evt) => {
//     // evt = { type: 'noteOn'|'noteOff', note, velocity, deviceName, deviceId, raw }
//   });
//
//   onStateChange((inputs) => { /* device list changed */ });
//
// Chrome only. Web MIDI is not supported in Firefox or Safari.
// ════════════════════════════════════════════════════════════════════


// ── Module state ────────────────────────────────────────────────
let _midi = null;                       // MIDIAccess object
let _listeners = new Map();             // input.id → callback
let _stateChangeListeners = [];         // callbacks for device connect/disconnect
let _initialized = false;


// ════════════════════════════════════════════════════════════════
// INIT
// ════════════════════════════════════════════════════════════════

// Request MIDI access. Returns { ok, reason?, inputCount }.
//   ok=false, reason='unsupported' — Web MIDI not in this browser
//   ok=false, reason='denied'      — user (or system) blocked the request
//   ok=true                         — _midi is set, listeners can attach
//
// Safe to call multiple times — subsequent calls return the cached state.
export async function initMIDI() {
  if (_initialized) {
    return { ok: !!_midi, inputCount: _midi ? [..._midi.inputs.values()].length : 0 };
  }
  _initialized = true;

  if (!navigator.requestMIDIAccess) {
    return { ok: false, reason: 'unsupported' };
  }

  try {
    _midi = await navigator.requestMIDIAccess({ sysex: false });

    // Wire up the global state-change handler. Re-attach existing
    // per-device listeners when the device list shifts (e.g. unplug
    // and replug — same name, new port object).
    _midi.onstatechange = () => {
      const inputs = getInputs();
      // Re-attach existing listeners to new port objects with matching id
      for (const [id, cb] of _listeners.entries()) {
        const input = inputs.find(i => i.id === id);
        if (input) input.port.onmidimessage = makeHandler(input, cb);
      }
      _stateChangeListeners.forEach(fn => fn(inputs));
    };

    return { ok: true, inputCount: [..._midi.inputs.values()].length };
  } catch (e) {
    return { ok: false, reason: 'denied' };
  }
}


// ════════════════════════════════════════════════════════════════
// DEVICE DISCOVERY
// ════════════════════════════════════════════════════════════════

// Returns the current list of input devices as plain objects:
//   [{ id, name, port }, ...]
// The 'port' is the underlying MIDIInput; pass the id to attach/detach.
export function getInputs() {
  if (!_midi) return [];
  return [..._midi.inputs.values()].map(p => ({
    id:   p.id,
    name: p.name,
    port: p,
  }));
}

// Find an input by name (substring, case-insensitive). Useful for the
// auto-detect logic that matches "piano", "drums", etc.
export function findInput(nameSubstring) {
  const needle = nameSubstring.toLowerCase();
  return getInputs().find(i => i.name.toLowerCase().includes(needle)) || null;
}


// ════════════════════════════════════════════════════════════════
// LISTENERS
// ════════════════════════════════════════════════════════════════

// Attach a callback to a single input device, identified by id.
// Replaces any previous listener on that device.
export function attachListener(inputId, callback) {
  const input = getInputs().find(i => i.id === inputId);
  if (!input) return false;
  _listeners.set(inputId, callback);
  input.port.onmidimessage = makeHandler(input, callback);
  return true;
}

// Detach the callback from a single input device.
export function detachListener(inputId) {
  const input = getInputs().find(i => i.id === inputId);
  if (input) input.port.onmidimessage = null;
  _listeners.delete(inputId);
}

// Detach every listener.
export function detachAll() {
  for (const id of [..._listeners.keys()]) detachListener(id);
}

// Subscribe to device connect/disconnect events. The callback receives
// the updated input list.
export function onStateChange(callback) {
  _stateChangeListeners.push(callback);
}


// ════════════════════════════════════════════════════════════════
// INTERNAL
// ════════════════════════════════════════════════════════════════

// Wrap the raw onmidimessage event in a parsed object before dispatch.
function makeHandler(input, callback) {
  return (e) => {
    const [status, note, vel] = e.data;
    const type = status & 0xF0;

    let evt = null;
    if (type === 0x90 && vel > 0) {
      evt = { type: 'noteOn',  note, velocity: vel };
    } else if (type === 0x80 || (type === 0x90 && vel === 0)) {
      evt = { type: 'noteOff', note, velocity: 0 };
    }

    // Other event types (CC, pitch bend, etc.) — ignore for now.
    if (!evt) return;

    evt.deviceName = input.name;
    evt.deviceId   = input.id;
    evt.raw        = e.data;
    callback(evt);
  };
}
