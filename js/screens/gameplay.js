// ════════════════════════════════════════════════════════════════════
// BandSync — 2-Player Gameplay Screen
// ════════════════════════════════════════════════════════════════════
// First real screen of the prototype. Composes piano renderer + drum
// renderer + shared clock + two scorers + two MIDI device routes.
//
// Layout:
//   - P1 (piano) panel on top, purple accent
//   - P2 (drums) panel on bottom, teal accent
//   - One shared song clock + count-off drives both panels
//   - Two independent score cards
//
// MIDI routing:
//   - Auto-detect: device names matching piano-ish keywords → P1,
//     drum-ish keywords → P2. Falls back to first/second device.
//   - User can override via two dropdowns at the top.
//   - Same device for both players is allowed but produces duplicate
//     events (each player processes the same input). Tolerable for v1.
//
// Limitations of this first version (will improve):
//   - MIDI file loading auto-assigns tracks by roleHint. No track
//     picker UI yet — if a song has multiple piano tracks we just
//     pick the first.
//   - Calibration during a session pauses gameplay logic (no concurrent
//     calibrate + play).
//   - 3- and 4-player layouts come later.
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
// Each player has their own object so two players never share gameplay
// state. The shared parts (clock, speed, hit-window) live in the
// Clock module.

const P1 = {
  role:           'piano',
  color:          PLAYER_COLORS[0],
  renderer:       null,                 // built below
  scorer:         createScorer(),
  scheduledNotes: [],
  fallingBlocks:  [],
  heldNotes:      new Set(),
  userOffset:     0,
  deviceName:     'unknown',
  feedbackTimer:  null,
};

const P2 = {
  role:           'drums',
  color:          PLAYER_COLORS[1],
  renderer:       null,
  scorer:         createScorer(),
  scheduledNotes: [],
  fallingBlocks:  [],
  laneFlash:      {},
  drumMapping:    {},
  userOffset:     0,
  deviceName:     'unknown',
  feedbackTimer:  null,
};


// ════════════════════════════════════════════════════════════════
// SHARED STATE
// ════════════════════════════════════════════════════════════════

let songDuration  = 0;       // longest of the two players' notes + buffer
let songName      = '—';
let alwaysSound   = true;
let lastTime      = 0;
let allMidiInputs = [];      // refreshed on state change


// ════════════════════════════════════════════════════════════════
// RENDERERS
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

P2.renderer = createDrumRenderer(
  document.getElementById('p2-canvas'),
  {
    color:       P2.color,
    onLaneClick: (abstractName) => handleP2LaneClick(abstractName, 80),
  },
);


// ════════════════════════════════════════════════════════════════
// INPUT HANDLERS
// ════════════════════════════════════════════════════════════════

function handleP1KeyDown(note, velocity) {
  if (calOpen) {
    if (calPlayer === P1) registerCalTap();
    return;
  }
  P1.heldNotes.add(note);
  if (alwaysSound) playPianoNote(note, velocity);
  if (Clock.isPlaying() && !Clock.isPaused() && Clock.isCountoffDone()) {
    if (!alwaysSound) playPianoNote(note, velocity);
    checkHitPiano(note);
  }
}

function handleP2LaneClick(abstractName, velocity) {
  if (calOpen) {
    if (calPlayer === P2) registerCalTap();
    return;
  }
  P2.laneFlash[abstractName] = performance.now();
  if (alwaysSound) playDrumSound(abstractName, velocity);
  if (Clock.isPlaying() && !Clock.isPaused() && Clock.isCountoffDone()) {
    checkHitDrums(abstractName, velocity);
  }
}


// ════════════════════════════════════════════════════════════════
// MIDI ROUTING — auto-detect + dropdown override
// ════════════════════════════════════════════════════════════════

const PIANO_HINTS = /piano|keyboard|keys|mpk|cdp|kawai|yamaha|roland\s?keys|casio|epiano/i;
const DRUM_HINTS  = /drum|sd5x|simmons|td-?\d|roland\s?td|kit|alesis|nitro/i;

function autoDetect(inputs) {
  if (inputs.length === 0) return { p1: null, p2: null };
  let p1 = inputs.find(i => PIANO_HINTS.test(i.name));
  let p2 = inputs.find(i => DRUM_HINTS.test(i.name) && i.id !== (p1 && p1.id));
  if (!p1) p1 = inputs[0];
  if (!p2) p2 = inputs.find(i => p1 && i.id !== p1.id) || null;
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
    setStatus('No MIDI devices — connect one and refresh (mouse input still works)', 'yellow');
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
  if (p1Input) Midi.attachListener(p1Input.id, onP1Midi);
  if (p2Input && (!p1Input || p2Input.id !== p1Input.id)) Midi.attachListener(p2Input.id, onP2Midi);
}

function assignP1Device(name) {
  P1.deviceName = name || 'unknown';
  P1.userOffset = loadOffset(P1.deviceName);
  document.getElementById('p1-device-name').textContent = P1.deviceName === 'unknown'
    ? '(no device — mouse only)'
    : P1.deviceName;
  document.getElementById('p1-offset').textContent =
    (P1.userOffset > 0 ? '+' : '') + P1.userOffset + 'ms';
  rebindAllListeners();
}

function assignP2Device(name) {
  P2.deviceName  = name || 'unknown';
  P2.drumMapping = name ? loadMapping(P2.deviceName) : {};
  P2.userOffset  = loadOffset(P2.deviceName);
  document.getElementById('p2-device-name').textContent = P2.deviceName === 'unknown'
    ? '(no device — click lanes)'
    : (P2.deviceName + (hasMapping(P2.deviceName) ? '' : ' · no mapping!'));
  document.getElementById('p2-offset').textContent =
    (P2.userOffset > 0 ? '+' : '') + P2.userOffset + 'ms';
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
  if (evt.type !== 'noteOn') return;
  const abstractName = lookupAbstractName(P2.drumMapping, evt.note);
  if (calOpen) {
    if (calPlayer === P2) registerCalTap();
    return;
  }
  if (!abstractName) {
    // Unmapped pad — count as wrong if mid-song, ignore otherwise
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
    checkHitDrums(abstractName, evt.velocity);
  }
}


// ════════════════════════════════════════════════════════════════
// HIT DETECTION (per role)
// ════════════════════════════════════════════════════════════════

function checkHitPiano(note) {
  const songTime = Clock.getSongTime();
  if (songTime < 0) return;
  const fallTimeMs = Clock.getFallTimeMs();
  const hw = Clock.getHitWindow();

  let best = null, bestDiff = Infinity;
  for (const sn of P1.scheduledNotes) {
    if (sn.note !== note || sn.hit || sn.missed || !sn.spawned) continue;
    const expected = sn.startMs + fallTimeMs + P1.userOffset;
    const diff = Math.abs(songTime - expected);
    if (diff < bestDiff) { bestDiff = diff; best = sn; }
  }

  if (!best) {
    P1.scorer.registerWrong();
    showFeedback(P1, 'WRONG', 'wrong');
    return;
  }

  const quality = bestDiff <= hw.perfect ? 'perfect'
                : bestDiff <= hw.good    ? 'good' : null;

  if (quality) {
    best.hit = true;
    if (best.block) { best.block.hitQuality = quality; best.block.hitTime = performance.now(); }
    playPianoNote(best.note, best.vel || 80);
    P1.scorer.registerHit(quality);
    showFeedback(P1, quality === 'perfect' ? 'PERFECT' : 'GOOD', quality);
  }
}

function checkHitDrums(abstractName, velocity) {
  const songTime = Clock.getSongTime();
  if (songTime < 0) return;
  const fallTimeMs = Clock.getFallTimeMs();
  const hw = Clock.getHitWindow();

  let best = null, bestDiff = Infinity;
  for (const sn of P2.scheduledNotes) {
    if (sn.abstractName !== abstractName || sn.hit || sn.missed || !sn.spawned) continue;
    const expected = sn.startMs + fallTimeMs + P2.userOffset;
    const diff = Math.abs(songTime - expected);
    if (diff < bestDiff) { bestDiff = diff; best = sn; }
  }

  if (!best) {
    P2.scorer.registerWrong();
    showFeedback(P2, 'WRONG', 'wrong');
    return;
  }

  const quality = bestDiff <= hw.perfect ? 'perfect'
                : bestDiff <= hw.good    ? 'good' : null;

  if (quality) {
    best.hit = true;
    if (best.block) { best.block.hitQuality = quality; best.block.hitTime = performance.now(); }
    P2.scorer.registerHit(quality);
    showFeedback(P2, quality === 'perfect' ? 'PERFECT' : 'GOOD', quality);
  }
}

function registerMissPiano(sn) {
  if (!sn.spawned) return;
  sn.missed = true;
  P1.scorer.registerMiss();
  showFeedback(P1, 'MISS', 'miss');
}

function registerMissDrums(sn) {
  if (!sn.spawned) return;
  sn.missed = true;
  P2.scorer.registerMiss();
  showFeedback(P2, 'MISS', 'miss');
}

function showFeedback(player, text, cls) {
  const el = document.getElementById((player === P1 ? 'p1' : 'p2') + '-feedback');
  if (!el) return;
  el.textContent = text;
  el.className   = 'sc-feedback ' + cls;
  clearTimeout(player.feedbackTimer);
  player.feedbackTimer = setTimeout(() => { el.className = 'sc-feedback hidden'; }, 500);
}


// ════════════════════════════════════════════════════════════════
// TEST PATTERNS — combined piano + drums
// ════════════════════════════════════════════════════════════════

function makeCombined(name) {
  const B = BEAT_MS, E = B / 2, S = B / 4;

  if (name === 'mary_rock') {
    const piano = [
      {note:64,startMs:0*B,durMs:E},{note:62,startMs:1*B,durMs:E},{note:60,startMs:2*B,durMs:E},{note:62,startMs:3*B,durMs:E},
      {note:64,startMs:4*B,durMs:E},{note:64,startMs:5*B,durMs:E},{note:64,startMs:6*B,durMs:B},
      {note:62,startMs:8*B,durMs:E},{note:62,startMs:9*B,durMs:E},{note:62,startMs:10*B,durMs:B},
      {note:64,startMs:12*B,durMs:E},{note:67,startMs:13*B,durMs:E},{note:67,startMs:14*B,durMs:B},
      {note:64,startMs:16*B,durMs:E},{note:62,startMs:17*B,durMs:E},{note:60,startMs:18*B,durMs:E},{note:62,startMs:19*B,durMs:E},
      {note:64,startMs:20*B,durMs:E},{note:64,startMs:21*B,durMs:E},{note:64,startMs:22*B,durMs:E},{note:64,startMs:23*B,durMs:E},
      {note:62,startMs:24*B,durMs:E},{note:62,startMs:25*B,durMs:E},{note:64,startMs:26*B,durMs:E},{note:62,startMs:27*B,durMs:E},
      {note:60,startMs:28*B,durMs:B},
    ];
    const drums = [];
    for (let bar = 0; bar < 8; bar++) {
      const o = bar * 4 * B;
      for (let i = 0; i < 8; i++) drums.push({ abstractName: 'HH_CLOSED', startMs: o + i*E, durMs: S });
      drums.push({ abstractName: 'KICK',  startMs: o + 0*B, durMs: S });
      drums.push({ abstractName: 'KICK',  startMs: o + 2*B, durMs: S });
      drums.push({ abstractName: 'SNARE', startMs: o + 1*B, durMs: S });
      drums.push({ abstractName: 'SNARE', startMs: o + 3*B, durMs: S });
      if (bar === 0) drums.push({ abstractName: 'CRASH', startMs: 0, durMs: S });
    }
    return { name: 'Mary Had a Little Lamb + Rock Beat', piano, drums };
  }

  if (name === 'scale_hihat') {
    const piano = [60, 62, 64, 65, 67, 69, 71, 72].map((note, i) => ({ note, startMs: i * B, durMs: E }));
    const drums = [];
    for (let bar = 0; bar < 2; bar++) {
      const o = bar * 4 * B;
      for (let i = 0; i < 8; i++) {
        const hh = i % 2 === 0 ? 'HH_CLOSED' : 'HH_OPEN';
        drums.push({ abstractName: hh, startMs: o + i*E, durMs: S });
      }
      drums.push({ abstractName: 'KICK',     startMs: o + 0*B, durMs: S });
      drums.push({ abstractName: 'KICK',     startMs: o + 2*B, durMs: S });
      drums.push({ abstractName: 'SNARE',    startMs: o + 1*B, durMs: S });
      drums.push({ abstractName: 'SNARE',    startMs: o + 3*B, durMs: S });
      drums.push({ abstractName: 'HH_PEDAL', startMs: o + 1*B, durMs: S });
      drums.push({ abstractName: 'HH_PEDAL', startMs: o + 3*B, durMs: S });
    }
    return { name: 'C Scale + Hi-Hat Drill', piano, drums };
  }

  if (name === 'metro_kick') {
    const piano = [];
    for (let i = 0; i < 16; i++) piano.push({ note: 60, startMs: i * B, durMs: E });
    const drums = [];
    for (let i = 0; i < 16; i++) {
      drums.push({ abstractName: 'KICK',  startMs: i * B,        durMs: S });
      drums.push({ abstractName: 'SNARE', startMs: i * B + B / 2, durMs: S });
    }
    return { name: 'Metronome + Kick/Snare', piano, drums };
  }

  return null;
}

function loadCombinedPattern(name) {
  const p = makeCombined(name);
  if (!p) return;
  loadSong(p);
}

function loadSong({ name, piano, drums }) {
  P1.scheduledNotes = (piano || []).map(n => ({ ...n, hit: false, missed: false, block: null, spawned: false }));
  P2.scheduledNotes = (drums || []).map(n => ({ ...n, hit: false, missed: false, block: null, spawned: false }));

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

function loadMIDIFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const parsed = parseMIDIFile(e.target.result);
    // Auto-assign: first track with roleHint='piano' → P1, first 'drums' → P2
    const pianoTrack = parsed.tracks.find(t => t.roleHint === 'piano');
    const drumTrack  = parsed.tracks.find(t => t.roleHint === 'drums');

    // Filter piano notes to keyboard range
    const pianoNotes = pianoTrack
      ? pianoTrack.notes.filter(n => P1.renderer.noteInRange(n.note))
      : [];

    // For drums, map MIDI notes to abstract names using P2's drum mapping
    // (or skip if no mapping — we'll alert)
    let drumNotes = [];
    if (drumTrack) {
      drumNotes = drumTrack.notes
        .map(n => {
          const abstractName = lookupAbstractName(P2.drumMapping, n.note);
          if (!abstractName) return null;
          return { abstractName, startMs: n.startMs, durMs: n.durMs, vel: n.vel };
        })
        .filter(Boolean);
    }

    let report = `Loaded: ${file.name}`;
    if (pianoTrack) report += `  ·  P1=${pianoTrack.name} (${pianoNotes.length} notes)`;
    if (drumTrack) {
      report += `  ·  P2=${drumTrack.name} (${drumNotes.length} mapped`;
      if (drumTrack.notes.length > drumNotes.length) {
        report += `, ${drumTrack.notes.length - drumNotes.length} unmapped`;
      }
      report += `)`;
    }
    if (!pianoTrack && !drumTrack) {
      report = 'No piano or drum tracks detected. Try a different MIDI file.';
      setStatus(report, 'yellow');
      return;
    }
    setStatus(report, 'green');

    loadSong({
      name: file.name.replace(/\.midi?$/i, ''),
      piano: pianoNotes,
      drums: drumNotes,
    });
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

function resetSong() {
  Clock.stopSong();
  [P1, P2].forEach(p => {
    p.scheduledNotes.forEach(n => { n.hit = false; n.missed = false; n.block = null; n.spawned = false; });
    p.fallingBlocks = [];
    p.scorer.reset();
  });
  document.getElementById('start-btn').style.display = 'inline-block';
  document.getElementById('start-btn').className     = 'start-btn enabled';
  document.getElementById('start-btn').textContent   = 'START →';
  document.getElementById('btn-pause').style.display = 'none';
  document.getElementById('btn-reset').style.display = 'none';
  document.getElementById('btn-pause').textContent   = '⏸ PAUSE';
  document.getElementById('btn-pause').className     = '';
  document.getElementById('p1-feedback').className   = 'sc-feedback hidden';
  document.getElementById('p2-feedback').className   = 'sc-feedback hidden';
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
    document.getElementById(prefix + '-pgmw').textContent  =
      `${stats.perfect}/${stats.good}/${stats.miss}/${stats.wrong}`;
  });
}

function setStatus(text, color = 'neutral') {
  const el = document.getElementById('status-msg');
  el.textContent = text;
  el.className   = 'status-msg ' + color;
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

    // ── P1 (piano) — spawn / move / miss / cleanup ────────────
    for (const sn of P1.scheduledNotes) {
      if (sn.hit || sn.missed || sn.block) continue;
      if (songTime >= sn.startMs) {
        if (!P1.renderer.noteInRange(sn.note)) continue;
        const cx = P1.renderer.noteToX(sn.note);
        const nw = P1.renderer.noteWidth(sn.note);
        const nh = P1.renderer.blockHeight(sn.note);
        const block = {
          x: cx - nw / 2, y: 0, w: nw, h: nh,
          note: sn.note, black: P1.renderer.isBlack(sn.note),
          hitQuality: null, hitTime: null,
        };
        sn.block = block;
        sn.spawned = true;
        P1.fallingBlocks.push(block);
      }
    }
    P1.fallingBlocks.forEach(b => { b.y += pxPerFrame * (delta / 16.67); });
    for (const sn of P1.scheduledNotes) {
      if (!sn.hit && !sn.missed && sn.spawned) {
        if (songTime - (sn.startMs + fallTimeMs) > hw.good) registerMissPiano(sn);
      }
    }
    P1.fallingBlocks = P1.fallingBlocks.filter(b => b.y < HIGHWAY_H + b.h);

    // ── P2 (drums) — same pattern ─────────────────────────────
    for (const sn of P2.scheduledNotes) {
      if (sn.hit || sn.missed || sn.block) continue;
      if (songTime >= sn.startMs) {
        if (!P2.renderer.isValidLane(sn.abstractName)) continue;
        const block = {
          x: P2.renderer.laneX(sn.abstractName), y: 0,
          laneIndex: P2.renderer.laneIndex(sn.abstractName),
          isKick:    P2.renderer.isKick(sn.abstractName),
          hitQuality: null, hitTime: null,
        };
        sn.block = block;
        sn.spawned = true;
        P2.fallingBlocks.push(block);
      }
    }
    P2.fallingBlocks.forEach(b => { b.y += pxPerFrame * (delta / 16.67); });
    for (const sn of P2.scheduledNotes) {
      if (!sn.hit && !sn.missed && sn.spawned) {
        if (songTime - (sn.startMs + fallTimeMs) > hw.good) registerMissDrums(sn);
      }
    }
    P2.fallingBlocks = P2.fallingBlocks.filter(b => b.y < HIGHWAY_H + 20);

    // ── Count-off click + state ───────────────────────────────
    if (Clock.justCrossedBeat()) playClick();
    const countoff = Clock.tickCountoff();

    // ── End of song ───────────────────────────────────────────
    if (Clock.isCountoffDone() && songTime > songDuration) {
      Clock.stopSong();
      showSongComplete();
    }

    P1.renderer.draw({ fallingBlocks: P1.fallingBlocks, heldNotes: P1.heldNotes, countoff });
    P2.renderer.draw({ fallingBlocks: P2.fallingBlocks, laneFlash: P2.laneFlash, countoff });
  } else {
    P1.renderer.draw({ fallingBlocks: P1.fallingBlocks, heldNotes: P1.heldNotes });
    P2.renderer.draw({ fallingBlocks: P2.fallingBlocks, laneFlash: P2.laneFlash });
  }

  updateScoreCards();
  requestAnimationFrame(update);
}


// ════════════════════════════════════════════════════════════════
// CALIBRATION OVERLAY — parameterized by player
// ════════════════════════════════════════════════════════════════

let calOpen          = false;
let calPlayer        = null;        // P1 or P2
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
  document.getElementById('cal-which').textContent =
    'CALIBRATING ' + (player === P1 ? 'P1 (PIANO)' : 'P2 (DRUMS)');
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
    if (dot) dot.className = 'cal-round-dot' +
      (i < calRound ? ' done' : i === calRound ? ' active' : '');
  }
  document.getElementById('cal-round-heading').textContent = 'ROUND ' + (calRound + 1) + ' OF ' + CAL_ROUNDS;
  document.getElementById('cal-tap-count').textContent     = '';
  document.getElementById('cal-instruction').innerHTML     =
    (calPlayer === P1 ? 'Tap your piano' : 'Hit your drum pad') +
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
    if (label)  label.textContent = calPlayer === P1 ? 'TAP' : 'HIT';
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
  document.getElementById(prefix + '-offset').textContent =
    (calPendingOffset > 0 ? '+' : '') + calPendingOffset + 'ms';
  closeCal();
}

function registerCalTap() {
  if (!calOpen || calRound >= CAL_ROUNDS) return;
  calTaps.push(performance.now());
}


// ════════════════════════════════════════════════════════════════
// DOM WIRING
// ════════════════════════════════════════════════════════════════

document.getElementById('btn-test-mary-rock')   .addEventListener('click', () => loadCombinedPattern('mary_rock'));
document.getElementById('btn-test-scale-hihat') .addEventListener('click', () => loadCombinedPattern('scale_hihat'));
document.getElementById('btn-test-metro-kick')  .addEventListener('click', () => loadCombinedPattern('metro_kick'));

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

setupMIDI();
requestAnimationFrame(update);
