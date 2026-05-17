// ════════════════════════════════════════════════════════════════════
// BandSync — 2-Player Gameplay Screen
// ════════════════════════════════════════════════════════════════════
// Composes renderers + engine modules. P1 is always piano. P2's role
// is switchable at runtime: drums (default) or piano. The drum work
// stays intact; the toggle just decides which P2 renderer is active.
//
// Roles are persisted in localStorage so the toggle survives refresh.
//
// Layout:
//   - P1 (piano) panel on top, purple accent
//   - P2 panel on bottom — drum highway OR piano, depending on role
//   - One shared song clock + count-off drives both panels
//   - Two independent score cards
//
// MIDI routing auto-detects piano-ish vs drum-ish device names; user
// can override via dropdowns. When P2 is set to piano, the drum
// keywords still get the lower priority for P2 device assignment.
// ════════════════════════════════════════════════════════════════════

import {
  PIANO_NOTE_MIN, PIANO_NOTE_MAX,
  HIGHWAY_H,
  BEAT_MS,
  CAL_ROUNDS, CAL_ROUND_MS, CAL_BEAT_MS, CAL_FLASH_MS,
  DEFAULT_SPEED_LEVEL, DEFAULT_HIT_WINDOW_LEVEL,
  PLAYER_COLORS,
} from '../config.js';

import * as Clock from '../core/timing.js';
import { playPianoNote, playDrumSound, playClick } from '../core/audio.js';
import { createScorer } from '../core/scoring.js';
import * as Midi from '../core/midi.js';
import { loadOffset, saveOffset, calcRoundOffset } from '../core/calibration.js';
import { loadMapping, hasMapping, lookupAbstractName } from '../core/drum-mapping.js';
import { parseMIDIFile } from '../core/midi-parser.js';
import { createPianoRenderer } from '../render/piano.js';
import { createDrumRenderer } from '../render/drums.js';


// ════════════════════════════════════════════════════════════════
// PER-PLAYER STATE
// ════════════════════════════════════════════════════════════════

const P1 = {
  role:           'piano', // P1 is always piano in this screen
  color:          PLAYER_COLORS[0],
  renderer:       null,
  scorer:         createScorer(),
  scheduledNotes: [],
  fallingBlocks:  [],
  heldNotes:      new Set(),
  userOffset:     0,
  deviceName:     'unknown',
  feedbackTimer:  null,
};

// P2 has BOTH a piano renderer and a drum renderer ready; .role
// determines which is active. Drum-only state (laneFlash, drumMapping)
// and piano-only state (heldNotes) coexist; only the active set is
// updated during gameplay.
const P2 = {
  role:           localStorage.getItem('bandsync_p2_role') || 'drums',
  color:          PLAYER_COLORS[1],
  rendererPiano:  null,
  rendererDrums:  null,
  scorer:         createScorer(),
  scheduledNotes: [],
  fallingBlocks:  [],
  heldNotes:      new Set(),
  laneFlash:      {},
  drumMapping:    {},
  userOffset:     0,
  deviceName:     'unknown',
  feedbackTimer:  null,
};


// ════════════════════════════════════════════════════════════════
// SHARED STATE
// ════════════════════════════════════════════════════════════════

let songDuration  = 0;
let songName      = '—';
let alwaysSound   = true;
let lastTime      = 0;
let allMidiInputs = [];


// ════════════════════════════════════════════════════════════════
// RENDERERS — build both P2 renderers at init
// ════════════════════════════════════════════════════════════════

P1.renderer = createPianoRenderer(
  document.getElementById('p1-canvas'),
  {
    noteMin:   PIANO_NOTE_MIN,
    noteMax:   PIANO_NOTE_MAX,
    color:     P1.color,
    onKeyDown: (note) => handleP1KeyDown(note, 80),
    onKeyUp:   (note) => P1.heldNotes.delete(note),
  },
);

P2.rendererDrums = createDrumRenderer(
  document.getElementById('p2-canvas-drums'),
  {
    color:       P2.color,
    onLaneClick: (abstractName) => handleP2LaneClick(abstractName, 80),
  },
);

P2.rendererPiano = createPianoRenderer(
  document.getElementById('p2-canvas-piano'),
  {
    noteMin:   PIANO_NOTE_MIN,
    noteMax:   PIANO_NOTE_MAX,
    color:     P2.color,
    onKeyDown: (note) => handleP2KeyDown(note, 80),
    onKeyUp:   (note) => P2.heldNotes.delete(note),
  },
);


// ════════════════════════════════════════════════════════════════
// P2 ROLE TOGGLE
// ════════════════════════════════════════════════════════════════

function applyP2Role(role) {
  P2.role = role;
  localStorage.setItem('bandsync_p2_role', role);

  // Clear any in-flight gameplay state — switching mid-song would mix
  // scheduled-note shapes (note vs abstractName), so we hard-reset.
  Clock.stopSong();
  P2.scheduledNotes = [];
  P2.fallingBlocks  = [];
  P2.heldNotes.clear();
  P2.laneFlash = {};
  P2.scorer.reset();
  P1.scheduledNotes = [];
  P1.fallingBlocks  = [];
  P1.scorer.reset();
  resetSongUI();

  // Show the right canvas (toggle the canvas elements directly — the
  // new split-screen layout has both canvases inside one .canvas-stage)
  document.getElementById('p2-canvas-drums').style.display = role === 'drums' ? '' : 'none';
  document.getElementById('p2-canvas-piano').style.display = role === 'piano' ? '' : 'none';

  // Update labels
  document.getElementById('p2-panel-title').textContent = 'P2 · ' + (role === 'piano' ? 'PIANO' : 'DRUMS');
  document.getElementById('p2-role-label').textContent  = 'P2 ' + (role === 'piano' ? 'PIANO' : 'DRUMS');

  // Swap the visible test pattern buttons
  document.querySelectorAll('.pd-only').forEach(el => el.style.display = role === 'drums' ? '' : 'none');
  document.querySelectorAll('.pp-only').forEach(el => el.style.display = role === 'piano' ? '' : 'none');

  // Toggle button highlight
  document.getElementById('btn-p2-drums').className = 'mode-btn' + (role === 'drums' ? ' active' : '');
  document.getElementById('btn-p2-piano').className = 'mode-btn' + (role === 'piano' ? ' active' : '');

  // Re-pick a sensible MIDI device for P2 under the new role
  if (allMidiInputs.length > 0) {
    const { p2 } = autoDetect(allMidiInputs);
    assignP2Device(p2 ? p2.name : null);
  }

  setStatus('P2 role: ' + (role === 'piano' ? 'PIANO' : 'DRUMS') + ' — pick a test pattern', 'neutral');
}


// ════════════════════════════════════════════════════════════════
// INPUT HANDLERS
// ════════════════════════════════════════════════════════════════

function handleP1KeyDown(note, velocity) {
  if (calOpen) { if (calPlayer === P1) registerCalTap(); return; }
  P1.heldNotes.add(note);
  if (alwaysSound) playPianoNote(note, velocity);
  if (Clock.isPlaying() && !Clock.isPaused() && Clock.isCountoffDone()) {
    if (!alwaysSound) playPianoNote(note, velocity);
    checkHitPiano(P1, note);
  }
}

function handleP2KeyDown(note, velocity) {
  // Only fires when P2 is in piano mode
  if (P2.role !== 'piano') return;
  if (calOpen) { if (calPlayer === P2) registerCalTap(); return; }
  P2.heldNotes.add(note);
  if (alwaysSound) playPianoNote(note, velocity);
  if (Clock.isPlaying() && !Clock.isPaused() && Clock.isCountoffDone()) {
    if (!alwaysSound) playPianoNote(note, velocity);
    checkHitPiano(P2, note);
  }
}

function handleP2LaneClick(abstractName, velocity) {
  // Only fires when P2 is in drum mode
  if (P2.role !== 'drums') return;
  if (calOpen) { if (calPlayer === P2) registerCalTap(); return; }
  P2.laneFlash[abstractName] = performance.now();
  if (alwaysSound) playDrumSound(abstractName, velocity);
  if (Clock.isPlaying() && !Clock.isPaused() && Clock.isCountoffDone()) {
    checkHitDrums(P2, abstractName, velocity);
  }
}


// ════════════════════════════════════════════════════════════════
// MIDI ROUTING — auto-detect + dropdown override
// ════════════════════════════════════════════════════════════════

const PIANO_HINTS = /piano|keyboard|keys|mpk|cdp|kawai|yamaha|roland\s?keys|casio|epiano/i;
const DRUM_HINTS  = /drum|sd5x|simmons|td-?\d|roland\s?td|kit|alesis|nitro/i;

function autoDetect(inputs) {
  if (inputs.length === 0) return { p1: null, p2: null };

  // P1 wants a piano-ish device first
  let p1 = inputs.find(i => PIANO_HINTS.test(i.name)) || inputs[0];

  // P2: if drum mode, prefer a drum-ish device; otherwise prefer a
  // *different* piano-ish device, falling back to second input.
  let p2 = null;
  if (P2.role === 'drums') {
    p2 = inputs.find(i => DRUM_HINTS.test(i.name) && i.id !== p1.id);
  } else {
    p2 = inputs.find(i => PIANO_HINTS.test(i.name) && i.id !== p1.id);
  }
  if (!p2) p2 = inputs.find(i => i.id !== p1.id) || null;

  return { p1, p2 };
}

async function setupMIDI() {
  const result = await Midi.initMIDI();
  if (!result.ok) {
    setStatus(result.reason === 'unsupported'
      ? 'Web MIDI not supported — use Chrome'
      : 'MIDI access denied — check Chrome permissions',
      'red');
    return;
  }
  rescanInputs();
  Midi.onStateChange(rescanInputs);
}

function rescanInputs() {
  allMidiInputs = Midi.getInputs();
  if (allMidiInputs.length === 0) {
    setStatus('No MIDI devices — mouse/click input works (P2 role: ' + P2.role.toUpperCase() + ')', 'yellow');
  } else {
    setStatus(allMidiInputs.length + ' MIDI device(s) connected', 'green');
  }

  const { p1, p2 } = autoDetect(allMidiInputs);
  assignP1Device(p1 ? p1.name : null);
  assignP2Device(p2 ? p2.name : null);

  populateSelector('p1-device-select', allMidiInputs, P1.deviceName);
  populateSelector('p2-device-select', allMidiInputs, P2.deviceName);
}

function findInputByName(name) {
  return allMidiInputs.find(i => i.name === name) || null;
}

function rebindAllListeners() {
  Midi.detachAll();
  const p1Input = findInputByName(P1.deviceName);
  const p2Input = findInputByName(P2.deviceName);

  // Same physical device for both players: multiplex one MIDI handler
  // into both onP1Midi and onP2Midi. (Useful when there's only one
  // keyboard plugged in — both pianos receive the same input.)
  if (p1Input && p2Input && p1Input.id === p2Input.id) {
    Midi.attachListener(p1Input.id, evt => { onP1Midi(evt); onP2Midi(evt); });
    return;
  }

  if (p1Input) Midi.attachListener(p1Input.id, onP1Midi);
  if (p2Input) Midi.attachListener(p2Input.id, onP2Midi);
}

function assignP1Device(name) {
  P1.deviceName = name || 'unknown';
  P1.userOffset = loadOffset(P1.deviceName);
  document.getElementById('p1-device-name').textContent =
    P1.deviceName === 'unknown' ? '(no device — mouse only)' : P1.deviceName;
  document.getElementById('p1-offset').textContent = formatOffset(P1.userOffset);
  rebindAllListeners();
}

function assignP2Device(name) {
  P2.deviceName  = name || 'unknown';
  P2.userOffset  = loadOffset(P2.deviceName);
  if (P2.role === 'drums') {
    P2.drumMapping = name ? loadMapping(P2.deviceName) : {};
    document.getElementById('p2-device-name').textContent =
      P2.deviceName === 'unknown'
        ? '(no device — click lanes)'
        : (P2.deviceName + (hasMapping(P2.deviceName) ? '' : ' · no mapping!'));
  } else {
    document.getElementById('p2-device-name').textContent =
      P2.deviceName === 'unknown' ? '(no device — mouse only)' : P2.deviceName;
  }
  document.getElementById('p2-offset').textContent = formatOffset(P2.userOffset);
  rebindAllListeners();
}

function populateSelector(id, inputs, currentName) {
  const sel = document.getElementById(id);
  sel.innerHTML = '';
  const blank = document.createElement('option');
  blank.value = '';
  blank.textContent = '(none)';
  sel.appendChild(blank);
  inputs.forEach(i => {
    const opt = document.createElement('option');
    opt.value = i.name;
    opt.textContent = i.name;
    if (i.name === currentName) opt.selected = true;
    sel.appendChild(opt);
  });
}

function onP1Midi(evt) {
  if (evt.type === 'noteOff') { P1.heldNotes.delete(evt.note); return; }
  if (evt.type !== 'noteOn') return;
  handleP1KeyDown(evt.note, evt.velocity);
}

function onP2Midi(evt) {
  if (P2.role === 'piano') {
    if (evt.type === 'noteOff') { P2.heldNotes.delete(evt.note); return; }
    if (evt.type !== 'noteOn') return;
    handleP2KeyDown(evt.note, evt.velocity);
    return;
  }

  // Drums
  if (evt.type !== 'noteOn') return;
  const abstractName = lookupAbstractName(P2.drumMapping, evt.note);
  if (calOpen) { if (calPlayer === P2) registerCalTap(); return; }
  if (!abstractName) {
    if (Clock.isPlaying() && !Clock.isPaused() && Clock.isCountoffDone()) {
      P2.scorer.registerWrong();
      showFeedback(P2, 'WRONG', 'wrong');
    }
    return;
  }
  P2.laneFlash[abstractName] = performance.now();
  if (alwaysSound) playDrumSound(abstractName, evt.velocity);
  if (Clock.isPlaying() && !Clock.isPaused() && Clock.isCountoffDone()) {
    if (!alwaysSound) playDrumSound(abstractName, evt.velocity);
    checkHitDrums(P2, abstractName, evt.velocity);
  }
}


// ════════════════════════════════════════════════════════════════
// HIT DETECTION — one per role
// ════════════════════════════════════════════════════════════════

function checkHitPiano(player, note) {
  const songTime = Clock.getSongTime();
  if (songTime < 0) return;
  const fallTimeMs = Clock.getFallTimeMs();
  const hw = Clock.getHitWindow();

  let best = null, bestDiff = Infinity;
  for (const sn of player.scheduledNotes) {
    if (sn.note !== note || sn.hit || sn.missed || !sn.spawned) continue;
    const expected = sn.startMs + fallTimeMs + player.userOffset;
    const diff = Math.abs(songTime - expected);
    if (diff < bestDiff) { bestDiff = diff; best = sn; }
  }

  if (!best) {
    player.scorer.registerWrong();
    showFeedback(player, 'WRONG', 'wrong');
    return;
  }

  const quality = bestDiff <= hw.perfect ? 'perfect'
                : bestDiff <= hw.good    ? 'good' : null;

  if (quality) {
    best.hit = true;
    if (best.block) { best.block.hitQuality = quality; best.block.hitTime = performance.now(); }
    playPianoNote(best.note, best.vel || 80);
    player.scorer.registerHit(quality);
    showFeedback(player, quality === 'perfect' ? 'PERFECT' : 'GOOD', quality);
  }
}

function checkHitDrums(player, abstractName, velocity) {
  const songTime = Clock.getSongTime();
  if (songTime < 0) return;
  const fallTimeMs = Clock.getFallTimeMs();
  const hw = Clock.getHitWindow();

  let best = null, bestDiff = Infinity;
  for (const sn of player.scheduledNotes) {
    if (sn.abstractName !== abstractName || sn.hit || sn.missed || !sn.spawned) continue;
    const expected = sn.startMs + fallTimeMs + player.userOffset;
    const diff = Math.abs(songTime - expected);
    if (diff < bestDiff) { bestDiff = diff; best = sn; }
  }

  if (!best) {
    player.scorer.registerWrong();
    showFeedback(player, 'WRONG', 'wrong');
    return;
  }

  const quality = bestDiff <= hw.perfect ? 'perfect'
                : bestDiff <= hw.good    ? 'good' : null;

  if (quality) {
    best.hit = true;
    if (best.block) { best.block.hitQuality = quality; best.block.hitTime = performance.now(); }
    player.scorer.registerHit(quality);
    showFeedback(player, quality === 'perfect' ? 'PERFECT' : 'GOOD', quality);
  }
}

function registerMissPiano(player, sn) {
  if (!sn.spawned) return;
  sn.missed = true;
  player.scorer.registerMiss();
  showFeedback(player, 'MISS', 'miss');
}

function registerMissDrums(player, sn) {
  if (!sn.spawned) return;
  sn.missed = true;
  player.scorer.registerMiss();
  showFeedback(player, 'MISS', 'miss');
}

function showFeedback(player, text, cls) {
  const el = document.getElementById((player === P1 ? 'p1' : 'p2') + '-feedback');
  if (!el) return;
  el.textContent = text;
  el.className   = 'feedback-overlay show ' + cls;
  clearTimeout(player.feedbackTimer);
  player.feedbackTimer = setTimeout(() => { el.className = 'feedback-overlay ' + cls; }, 550);
}


// ════════════════════════════════════════════════════════════════
// TEST PATTERNS
// ════════════════════════════════════════════════════════════════

// Mary Had a Little Lamb (8 bars at 80 BPM)
const MARY_NOTES = (() => {
  const B = BEAT_MS, E = B / 2;
  return [
    {note:64,startMs:0*B,durMs:E},{note:62,startMs:1*B,durMs:E},{note:60,startMs:2*B,durMs:E},{note:62,startMs:3*B,durMs:E},
    {note:64,startMs:4*B,durMs:E},{note:64,startMs:5*B,durMs:E},{note:64,startMs:6*B,durMs:B},
    {note:62,startMs:8*B,durMs:E},{note:62,startMs:9*B,durMs:E},{note:62,startMs:10*B,durMs:B},
    {note:64,startMs:12*B,durMs:E},{note:67,startMs:13*B,durMs:E},{note:67,startMs:14*B,durMs:B},
    {note:64,startMs:16*B,durMs:E},{note:62,startMs:17*B,durMs:E},{note:60,startMs:18*B,durMs:E},{note:62,startMs:19*B,durMs:E},
    {note:64,startMs:20*B,durMs:E},{note:64,startMs:21*B,durMs:E},{note:64,startMs:22*B,durMs:E},{note:64,startMs:23*B,durMs:E},
    {note:62,startMs:24*B,durMs:E},{note:62,startMs:25*B,durMs:E},{note:64,startMs:26*B,durMs:E},{note:62,startMs:27*B,durMs:E},
    {note:60,startMs:28*B,durMs:B},
  ];
})();

// C major scale (one octave, eight beats)
const SCALE_NOTES = [60, 62, 64, 65, 67, 69, 71, 72].map((note, i) => ({ note, startMs: i * BEAT_MS, durMs: BEAT_MS / 2 }));

function rockBeatDrums(bars) {
  const B = BEAT_MS, E = B / 2, S = B / 4;
  const drums = [];
  for (let bar = 0; bar < bars; bar++) {
    const o = bar * 4 * B;
    for (let i = 0; i < 8; i++) drums.push({ abstractName: 'HH_CLOSED', startMs: o + i*E, durMs: S });
    drums.push({ abstractName: 'KICK',  startMs: o + 0*B, durMs: S });
    drums.push({ abstractName: 'KICK',  startMs: o + 2*B, durMs: S });
    drums.push({ abstractName: 'SNARE', startMs: o + 1*B, durMs: S });
    drums.push({ abstractName: 'SNARE', startMs: o + 3*B, durMs: S });
    if (bar === 0) drums.push({ abstractName: 'CRASH', startMs: 0, durMs: S });
  }
  return drums;
}

// ── PIANO + DRUMS patterns ──────────────────────────────────────
const TEST_PATTERNS_PD = {
  mary_rock: {
    name:  'Mary Had a Little Lamb + Rock Beat',
    p1:    MARY_NOTES.slice(),
    p2:    rockBeatDrums(8),
  },
  scale_hihat: {
    name:  'C Scale + Hi-Hat Drill',
    p1:    SCALE_NOTES.slice(),
    p2:    (() => {
      const B = BEAT_MS, E = B / 2, S = B / 4;
      const drums = [];
      for (let bar = 0; bar < 2; bar++) {
        const o = bar * 4 * B;
        for (let i = 0; i < 8; i++) drums.push({ abstractName: i % 2 === 0 ? 'HH_CLOSED' : 'HH_OPEN', startMs: o + i*E, durMs: S });
        drums.push({ abstractName: 'KICK',     startMs: o + 0*B, durMs: S });
        drums.push({ abstractName: 'KICK',     startMs: o + 2*B, durMs: S });
        drums.push({ abstractName: 'SNARE',    startMs: o + 1*B, durMs: S });
        drums.push({ abstractName: 'SNARE',    startMs: o + 3*B, durMs: S });
        drums.push({ abstractName: 'HH_PEDAL', startMs: o + 1*B, durMs: S });
        drums.push({ abstractName: 'HH_PEDAL', startMs: o + 3*B, durMs: S });
      }
      return drums;
    })(),
  },
  metro_kick: {
    name:  'Metronome + Kick/Snare',
    p1:    (() => { const a=[]; for(let i=0;i<16;i++) a.push({note:60,startMs:i*BEAT_MS,durMs:BEAT_MS/2}); return a; })(),
    p2:    (() => {
      const a=[];
      for(let i=0;i<16;i++){
        a.push({abstractName:'KICK',  startMs:i*BEAT_MS,           durMs:BEAT_MS/4});
        a.push({abstractName:'SNARE', startMs:i*BEAT_MS + BEAT_MS/2, durMs:BEAT_MS/4});
      }
      return a;
    })(),
  },
};

// ── PIANO + PIANO patterns ──────────────────────────────────────
// Note range: P1 uses original notes; P2 may be transposed but must
// land in the C3–C6 keyboard range (clamped if needed).
const TEST_PATTERNS_PP = {
  mary_unison: {
    name: 'Mary (Both Players Unison)',
    p1:   MARY_NOTES.slice(),
    p2:   MARY_NOTES.slice(),
  },
  mary_octaves: {
    name: 'Mary — P1 Melody, P2 Octave Below',
    p1:   MARY_NOTES.slice(),
    p2:   MARY_NOTES.map(n => ({ ...n, note: n.note - 12 })),
  },
  scale_thirds: {
    name: 'C Scale — P1 Root, P2 Major Third',
    p1:   SCALE_NOTES.slice(),
    p2:   SCALE_NOTES.map(n => ({ ...n, note: n.note + 4 })),
  },
};

function loadPattern(set, key) {
  const p = set[key];
  if (!p) return;
  loadSong({ name: p.name, p1Notes: p.p1, p2Notes: p.p2 });
}

function loadSong({ name, p1Notes, p2Notes }) {
  P1.scheduledNotes = (p1Notes || []).map(n => ({ ...n, hit: false, missed: false, block: null, spawned: false }));
  P2.scheduledNotes = (p2Notes || []).map(n => ({ ...n, hit: false, missed: false, block: null, spawned: false }));

  P1.scorer.reset();
  P2.scorer.reset();
  P1.fallingBlocks = [];
  P2.fallingBlocks = [];

  const allTimes = [
    ...P1.scheduledNotes.map(n => n.startMs + n.durMs),
    ...P2.scheduledNotes.map(n => n.startMs + n.durMs),
    0,
  ];
  songDuration = Math.max(...allTimes) + 4000;
  songName     = name;

  document.getElementById('song-label').textContent = name;
  document.getElementById('start-btn').className   = 'start-btn enabled';
  document.getElementById('start-btn').textContent = 'START →';
}


// ════════════════════════════════════════════════════════════════
// MIDI FILE LOADING
// ════════════════════════════════════════════════════════════════

function loadMIDIFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const parsed = parseMIDIFile(e.target.result);

    const pianoTracks = parsed.tracks.filter(t => t.roleHint === 'piano');
    const drumTracks  = parsed.tracks.filter(t => t.roleHint === 'drums');

    if (P2.role === 'piano') {
      // 2-piano mode: first piano track → P1, second piano track → P2.
      // Fallback: both players share the first piano track (unison).
      const t1 = pianoTracks[0] || null;
      const t2 = pianoTracks[1] || t1;
      if (!t1) {
        setStatus('No piano tracks detected. Try a different MIDI file.', 'yellow');
        return;
      }
      const p1Notes = t1.notes.filter(n => P1.renderer.noteInRange(n.note));
      const p2Notes = t2 ? t2.notes.filter(n => P2.rendererPiano.noteInRange(n.note)) : [];

      let report = `Loaded: ${file.name}  ·  P1=${t1.name} (${p1Notes.length})`;
      if (t2 && t2 !== t1) report += `  ·  P2=${t2.name} (${p2Notes.length})`;
      else                  report += `  ·  P2=${t1.name} (unison)`;
      setStatus(report, 'green');

      loadSong({ name: file.name.replace(/\.midi?$/i, ''), p1Notes, p2Notes });

    } else {
      // P+D mode (existing behavior)
      const pianoTrack = pianoTracks[0] || null;
      const drumTrack  = drumTracks[0]  || null;

      const p1Notes = pianoTrack ? pianoTrack.notes.filter(n => P1.renderer.noteInRange(n.note)) : [];
      let p2Notes = [];
      if (drumTrack) {
        p2Notes = drumTrack.notes
          .map(n => {
            const abstractName = lookupAbstractName(P2.drumMapping, n.note);
            return abstractName ? { abstractName, startMs: n.startMs, durMs: n.durMs, vel: n.vel } : null;
          })
          .filter(Boolean);
      }

      let report = `Loaded: ${file.name}`;
      if (pianoTrack) report += `  ·  P1=${pianoTrack.name} (${p1Notes.length} notes)`;
      if (drumTrack) {
        report += `  ·  P2=${drumTrack.name} (${p2Notes.length} mapped`;
        if (drumTrack.notes.length > p2Notes.length) {
          report += `, ${drumTrack.notes.length - p2Notes.length} unmapped`;
        }
        report += `)`;
      }
      if (!pianoTrack && !drumTrack) {
        setStatus('No piano or drum tracks detected. Try a different MIDI file.', 'yellow');
        return;
      }
      setStatus(report, 'green');

      loadSong({ name: file.name.replace(/\.midi?$/i, ''), p1Notes, p2Notes });
    }
  };
  reader.readAsArrayBuffer(file);
}


// ════════════════════════════════════════════════════════════════
// SONG CONTROL
// ════════════════════════════════════════════════════════════════

function startSong() {
  if (!P1.scheduledNotes.length && !P2.scheduledNotes.length) return;
  [P1, P2].forEach(p => {
    p.scheduledNotes.forEach(n => { n.hit = false; n.missed = false; n.block = null; n.spawned = false; });
    p.fallingBlocks = [];
    p.scorer.reset();
  });
  Clock.startSong();

  document.getElementById('start-btn').style.display = 'none';
  document.getElementById('btn-pause').style.display = 'inline-block';
  document.getElementById('btn-reset').style.display = 'inline-block';
}

function togglePause() {
  if (!Clock.isPlaying()) return;
  const nowPaused = Clock.togglePause();
  const btn = document.getElementById('btn-pause');
  btn.textContent = nowPaused ? '▶ RESUME' : '⏸ PAUSE';
  btn.className   = nowPaused ? 'active' : '';
}

function resetSongUI() {
  document.getElementById('start-btn').style.display = 'inline-block';
  document.getElementById('start-btn').className     = 'start-btn enabled';
  document.getElementById('start-btn').textContent   = 'START →';
  document.getElementById('btn-pause').style.display = 'none';
  document.getElementById('btn-reset').style.display = 'none';
  document.getElementById('btn-pause').textContent   = '⏸ PAUSE';
  document.getElementById('btn-pause').className     = '';
  document.getElementById('p1-feedback').className   = 'feedback-overlay';
  document.getElementById('p2-feedback').className   = 'feedback-overlay';
  if (!P1.scheduledNotes.length && !P2.scheduledNotes.length) {
    document.getElementById('start-btn').className = 'start-btn';
  }
}

function resetSong() {
  Clock.stopSong();
  [P1, P2].forEach(p => {
    p.scheduledNotes.forEach(n => { n.hit = false; n.missed = false; n.block = null; n.spawned = false; });
    p.fallingBlocks = [];
    p.scorer.reset();
  });
  resetSongUI();
}

function showSongComplete() {
  const s1 = P1.scorer.getStats();
  const s2 = P2.scorer.getStats();
  setStatus(
    `SONG COMPLETE  ·  P1: ${s1.grade || '—'} ${s1.accuracy ?? 0}%   ·   P2: ${s2.grade || '—'} ${s2.accuracy ?? 0}%`,
    'green',
  );
  document.getElementById('btn-pause').style.display = 'none';
  document.getElementById('start-btn').style.display = 'inline-block';
  document.getElementById('start-btn').textContent   = '↺ PLAY AGAIN';
  document.getElementById('start-btn').className     = 'start-btn enabled';
}


// ════════════════════════════════════════════════════════════════
// SETTINGS
// ════════════════════════════════════════════════════════════════

function updateSpeedUI(level) {
  Clock.setSpeedLevel(level);
  const s = (Clock.getFallTimeMs() / 1000).toFixed(1);
  document.getElementById('speed-val').textContent = level + ' — ' + s + 's';
}

function updateHitWindowUI(level) {
  Clock.setHitWindowLevel(level);
  document.getElementById('hitwin-val').textContent = Clock.getHitWindow().name;
}

function toggleAlwaysSound() {
  alwaysSound = !alwaysSound;
  const btn = document.getElementById('sound-toggle');
  btn.textContent = alwaysSound ? 'ALWAYS' : 'ON HIT';
  btn.className   = alwaysSound ? 'active' : '';
}


// ════════════════════════════════════════════════════════════════
// SCORE CARDS
// ════════════════════════════════════════════════════════════════

function updateScoreCards() {
  [P1, P2].forEach((p, i) => {
    const stats = p.scorer.getStats();
    const prefix = i === 0 ? 'p1' : 'p2';
    document.getElementById(prefix + '-score').textContent = stats.score;
    document.getElementById(prefix + '-combo').textContent = 'x' + stats.multiplier;
    document.getElementById(prefix + '-acc').textContent   = stats.accuracy !== null ? stats.accuracy + '%' : '—';
    document.getElementById(prefix + '-grade').textContent = stats.grade || '—';
    document.getElementById(prefix + '-pgmw').textContent  = `${stats.perfect}/${stats.good}/${stats.miss}/${stats.wrong}`;
  });
}

function setStatus(text, color = 'neutral') {
  const el = document.getElementById('status-msg');
  el.textContent = text;
  el.className   = 'status-msg ' + color;
}

function formatOffset(ms) {
  return (ms > 0 ? '+' : '') + ms + 'ms';
}


// ════════════════════════════════════════════════════════════════
// GAME LOOP
// ════════════════════════════════════════════════════════════════

function update(timestamp) {
  if (!lastTime) lastTime = timestamp;
  const delta = timestamp - lastTime;
  lastTime = timestamp;
  const pxPerFrame = Clock.getPxPerFrame();

  if (Clock.isPlaying() && !Clock.isPaused()) {
    const songTime   = Clock.getSongTime();
    const fallTimeMs = Clock.getFallTimeMs();
    const hw         = Clock.getHitWindow();

    // ── P1 (piano) ────────────────────────────────────────────
    spawnPianoBlocks(P1, songTime);
    P1.fallingBlocks.forEach(b => { b.y += pxPerFrame * (delta / 16.67); });
    for (const sn of P1.scheduledNotes) {
      if (!sn.hit && !sn.missed && sn.spawned) {
        if (songTime - (sn.startMs + fallTimeMs) > hw.good) registerMissPiano(P1, sn);
      }
    }
    P1.fallingBlocks = P1.fallingBlocks.filter(b => b.y < HIGHWAY_H + b.h);

    // ── P2 (piano or drums) ───────────────────────────────────
    if (P2.role === 'piano') {
      spawnPianoBlocks(P2, songTime);
    } else {
      spawnDrumBlocks(P2, songTime);
    }
    P2.fallingBlocks.forEach(b => { b.y += pxPerFrame * (delta / 16.67); });
    for (const sn of P2.scheduledNotes) {
      if (!sn.hit && !sn.missed && sn.spawned) {
        if (songTime - (sn.startMs + fallTimeMs) > hw.good) {
          if (P2.role === 'piano') registerMissPiano(P2, sn);
          else                      registerMissDrums(P2, sn);
        }
      }
    }
    P2.fallingBlocks = P2.fallingBlocks.filter(b =>
      P2.role === 'piano' ? b.y < HIGHWAY_H + b.h : b.y < HIGHWAY_H + 20,
    );

    // ── Count-off click + state ───────────────────────────────
    if (Clock.justCrossedBeat()) playClick();
    const countoff = Clock.tickCountoff();

    // ── End of song ───────────────────────────────────────────
    if (Clock.isCountoffDone() && songTime > songDuration) {
      Clock.stopSong();
      showSongComplete();
    }

    drawAll(countoff);
  } else {
    drawAll(null);
  }

  updateScoreCards();
  requestAnimationFrame(update);
}

function spawnPianoBlocks(player, songTime) {
  const renderer = player === P1 ? P1.renderer : P2.rendererPiano;
  for (const sn of player.scheduledNotes) {
    if (sn.hit || sn.missed || sn.block) continue;
    if (songTime >= sn.startMs) {
      if (!renderer.noteInRange(sn.note)) continue;
      const cx = renderer.noteToX(sn.note);
      const nw = renderer.noteWidth(sn.note);
      const nh = renderer.blockHeight(sn.note);
      const block = {
        x: cx - nw / 2, y: 0, w: nw, h: nh,
        note: sn.note, black: renderer.isBlack(sn.note),
        hitQuality: null, hitTime: null,
      };
      sn.block = block;
      sn.spawned = true;
      player.fallingBlocks.push(block);
    }
  }
}

function spawnDrumBlocks(player, songTime) {
  for (const sn of player.scheduledNotes) {
    if (sn.hit || sn.missed || sn.block) continue;
    if (songTime >= sn.startMs) {
      if (!P2.rendererDrums.isValidLane(sn.abstractName)) continue;
      const block = {
        x: P2.rendererDrums.laneX(sn.abstractName), y: 0,
        laneIndex: P2.rendererDrums.laneIndex(sn.abstractName),
        isKick:    P2.rendererDrums.isKick(sn.abstractName),
        hitQuality: null, hitTime: null,
      };
      sn.block = block;
      sn.spawned = true;
      player.fallingBlocks.push(block);
    }
  }
}

function drawAll(countoff) {
  P1.renderer.draw({ fallingBlocks: P1.fallingBlocks, heldNotes: P1.heldNotes, countoff });
  if (P2.role === 'piano') {
    P2.rendererPiano.draw({ fallingBlocks: P2.fallingBlocks, heldNotes: P2.heldNotes, countoff });
  } else {
    P2.rendererDrums.draw({ fallingBlocks: P2.fallingBlocks, laneFlash: P2.laneFlash, countoff });
  }
}


// ════════════════════════════════════════════════════════════════
// CALIBRATION OVERLAY
// ════════════════════════════════════════════════════════════════

let calOpen          = false;
let calPlayer        = null;
let calRound         = 0;
let calRoundStart    = 0;
let calFlashTimes    = [];
let calTaps          = [];
let calRoundResults  = [];
let calPendingOffset = 0;
let calAnimId        = null;
let calNextFlash     = 0;

function openCal(player) {
  calPlayer = player;
  calOpen = true;
  calRound = 0;
  calRoundResults = [];
  document.getElementById('cal-overlay').classList.add('open');
  document.getElementById('cal-active').style.display = '';
  document.getElementById('cal-results').classList.remove('show');
  const role = player === P1 ? 'P1 (PIANO)' : 'P2 (' + (P2.role === 'piano' ? 'PIANO' : 'DRUMS') + ')';
  document.getElementById('cal-which').textContent = 'CALIBRATING ' + role;
  startCalRound();
}

function closeCal() {
  calOpen = false;
  calPlayer = null;
  document.getElementById('cal-overlay').classList.remove('open');
  if (calAnimId) { cancelAnimationFrame(calAnimId); calAnimId = null; }
}

function startCalRound() {
  calFlashTimes = [];
  calTaps = [];
  for (let i = 0; i < CAL_ROUNDS; i++) {
    const dot = document.getElementById('cal-dot-' + i);
    if (dot) dot.className = 'cal-round-dot' + (i < calRound ? ' done' : i === calRound ? ' active' : '');
  }
  document.getElementById('cal-round-heading').textContent = 'ROUND ' + (calRound + 1) + ' OF ' + CAL_ROUNDS;
  document.getElementById('cal-tap-count').textContent     = '';
  const isDrums = calPlayer === P2 && P2.role === 'drums';
  document.getElementById('cal-instruction').innerHTML =
    (isDrums ? 'Hit your drum pad' : 'Tap your piano') +
    ' in time with each flash.<br>Keep going until the round ends.';

  calRoundStart = performance.now() + 500;
  calNextFlash  = calRoundStart;
  if (calAnimId) cancelAnimationFrame(calAnimId);
  calAnimLoop(performance.now());
}

function calAnimLoop(now) {
  if (!calOpen) return;
  const elapsed   = now - calRoundStart;
  const remaining = Math.max(0, CAL_ROUND_MS - elapsed);
  document.getElementById('cal-timer').textContent = Math.ceil(remaining / 1000);

  if (now >= calNextFlash && elapsed < CAL_ROUND_MS) {
    calFlashTimes.push(calNextFlash);
    calNextFlash += CAL_BEAT_MS;
    playClick();
    const circle = document.getElementById('cal-circle');
    const label  = document.getElementById('cal-circle-label');
    if (circle) circle.classList.add('flash');
    if (label)  label.textContent = (calPlayer === P2 && P2.role === 'drums') ? 'HIT' : 'TAP';
    setTimeout(() => {
      const c = document.getElementById('cal-circle');
      if (c) c.classList.remove('flash');
    }, CAL_FLASH_MS);
  }

  document.getElementById('cal-tap-count').textContent =
    calTaps.length > 0 ? calTaps.length + ' taps recorded' : 'waiting for taps…';

  if (elapsed >= CAL_ROUND_MS) { finishCalRound(); return; }
  calAnimId = requestAnimationFrame(calAnimLoop);
}

function finishCalRound() {
  if (calAnimId) { cancelAnimationFrame(calAnimId); calAnimId = null; }
  const result = calcRoundOffset(calFlashTimes, calTaps, CAL_BEAT_MS / 2);
  calRoundResults.push(result);
  const dot = document.getElementById('cal-dot-' + calRound);
  if (dot) dot.className = 'cal-round-dot done';
  calRound++;

  if (calRound < CAL_ROUNDS) {
    document.getElementById('cal-round-heading').textContent = 'ROUND ' + calRound + ' DONE — get ready…';
    document.getElementById('cal-instruction').textContent =
      'Round ' + calRound + ': avg ' +
      (result.avg !== null ? (result.avg > 0 ? '+' : '') + result.avg + 'ms' : 'not enough taps') +
      ' · Starting next round…';
    document.getElementById('cal-timer').textContent = '3';
    setTimeout(startCalRound, 3000);
  } else {
    showCalResults();
  }
}

function showCalResults() {
  document.getElementById('cal-active').style.display = 'none';
  document.getElementById('cal-results').classList.add('show');
  const container = document.getElementById('cal-round-results');
  container.innerHTML = '';
  const validAvgs = [];
  calRoundResults.forEach((r, i) => {
    const div = document.createElement('div');
    div.className = 'cal-round-result';
    const avgStr = r.avg !== null ? (r.avg > 0 ? '+' : '') + r.avg + 'ms' : '—';
    div.innerHTML =
      `<div class="rr-label">ROUND ${i + 1}</div>` +
      `<div class="rr-val">${avgStr}</div>` +
      `<div class="rr-taps">${r.taps} taps</div>`;
    container.appendChild(div);
    if (r.avg !== null) validAvgs.push(r.avg);
  });
  let overall = 0;
  if (validAvgs.length > 0) overall = Math.round(validAvgs.reduce((a, b) => a + b, 0) / validAvgs.length);
  calPendingOffset = overall;
  document.getElementById('cal-final-val').textContent   = (overall > 0 ? '+' : '') + overall;
  document.getElementById('cal-current-val').textContent = (overall > 0 ? '+' : '') + overall + 'ms';
  document.getElementById('cal-device-note').textContent = 'Will be saved for: ' + calPlayer.deviceName;
}

function nudgeOffset(delta) {
  calPendingOffset = Math.max(-200, Math.min(200, calPendingOffset + delta));
  const el = document.getElementById('cal-current-val');
  if (el) el.textContent = (calPendingOffset > 0 ? '+' : '') + calPendingOffset + 'ms';
}

function applyOffset() {
  saveOffset(calPlayer.deviceName, calPendingOffset);
  calPlayer.userOffset = calPendingOffset;
  const prefix = calPlayer === P1 ? 'p1' : 'p2';
  document.getElementById(prefix + '-offset').textContent = formatOffset(calPendingOffset);
  closeCal();
}

function registerCalTap() {
  if (!calOpen || calRound >= CAL_ROUNDS) return;
  calTaps.push(performance.now());
}


// ════════════════════════════════════════════════════════════════
// DOM WIRING
// ════════════════════════════════════════════════════════════════

// Mode toggle
document.getElementById('btn-p2-drums').addEventListener('click', () => applyP2Role('drums'));
document.getElementById('btn-p2-piano').addEventListener('click', () => applyP2Role('piano'));

// P+D test patterns
document.getElementById('btn-test-mary-rock')   .addEventListener('click', () => loadPattern(TEST_PATTERNS_PD, 'mary_rock'));
document.getElementById('btn-test-scale-hihat') .addEventListener('click', () => loadPattern(TEST_PATTERNS_PD, 'scale_hihat'));
document.getElementById('btn-test-metro-kick')  .addEventListener('click', () => loadPattern(TEST_PATTERNS_PD, 'metro_kick'));

// P+P test patterns
document.getElementById('btn-test-mary-unison') .addEventListener('click', () => loadPattern(TEST_PATTERNS_PP, 'mary_unison'));
document.getElementById('btn-test-mary-octaves').addEventListener('click', () => loadPattern(TEST_PATTERNS_PP, 'mary_octaves'));
document.getElementById('btn-test-scale-thirds').addEventListener('click', () => loadPattern(TEST_PATTERNS_PP, 'scale_thirds'));

document.getElementById('start-btn').addEventListener('click', startSong);
document.getElementById('btn-pause').addEventListener('click', togglePause);
document.getElementById('btn-reset').addEventListener('click', resetSong);
document.getElementById('btn-cal-p1').addEventListener('click', () => openCal(P1));
document.getElementById('btn-cal-p2').addEventListener('click', () => openCal(P2));

document.getElementById('file-input').addEventListener('change', loadMIDIFile);

document.getElementById('p1-device-select').addEventListener('change', e => assignP1Device(e.target.value || null));
document.getElementById('p2-device-select').addEventListener('change', e => assignP2Device(e.target.value || null));

document.getElementById('speed') .addEventListener('input', e => updateSpeedUI(parseInt(e.target.value)));
document.getElementById('hitwin').addEventListener('input', e => updateHitWindowUI(parseInt(e.target.value)));
document.getElementById('sound-toggle').addEventListener('click', toggleAlwaysSound);

document.getElementById('cal-nudge-m10').addEventListener('click', () => nudgeOffset(-10));
document.getElementById('cal-nudge-m1') .addEventListener('click', () => nudgeOffset(-1));
document.getElementById('cal-nudge-p1') .addEventListener('click', () => nudgeOffset(+1));
document.getElementById('cal-nudge-p10').addEventListener('click', () => nudgeOffset(+10));
document.getElementById('cal-cancel')   .addEventListener('click', closeCal);
document.getElementById('cal-apply')    .addEventListener('click', applyOffset);

document.addEventListener('keydown', e => {
  if (e.code === 'Space')  { e.preventDefault(); if (!calOpen) togglePause(); }
  if (e.code === 'KeyR')   { if (!calOpen) resetSong(); }
  if (e.code === 'Escape') { if (calOpen) closeCal(); }
});


// ════════════════════════════════════════════════════════════════
// INIT
// ════════════════════════════════════════════════════════════════

document.getElementById('speed').value  = DEFAULT_SPEED_LEVEL;
document.getElementById('hitwin').value = DEFAULT_HIT_WINDOW_LEVEL;
updateSpeedUI(DEFAULT_SPEED_LEVEL);
updateHitWindowUI(DEFAULT_HIT_WINDOW_LEVEL);

// Apply saved P2 role from localStorage (defaults to drums)
applyP2Role(P2.role);

setupMIDI();
requestAnimationFrame(update);
