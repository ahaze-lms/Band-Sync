// ════════════════════════════════════════════════════════════════════
// BandSync — Piano Debug Screen
// ════════════════════════════════════════════════════════════════════
// Refactored to use the shared engine modules under /js. The piano view
// itself (keyboard layout, canvas drawing, mouse-click handling) still
// lives here for now; it'll move into /js/render/piano.js in Stage 5
// once the 2-player gameplay screen needs it.
//
// All non-piano-specific logic (clock, audio, scoring, MIDI, calibration
// storage, MIDI parsing) is imported from /js/core.
// ════════════════════════════════════════════════════════════════════

import {
  PIANO_NOTE_MIN, PIANO_NOTE_MAX, NOTE_NAMES, KEY_PATTERN,
  HIGHWAY_H, HIT_Y, PREVIEW_ZONE,
  COUNTOFF_BEATS, BEAT_MS, COUNTOFF_TOTAL_MS,
  CAL_ROUNDS, CAL_ROUND_MS, CAL_BEAT_MS, CAL_FLASH_MS,
  DEFAULT_SPEED_LEVEL, DEFAULT_HIT_WINDOW_LEVEL,
  FALL_TIMES_MS, HIT_WINDOWS,
  PLAYER_COLORS,
} from '../js/config.js';

import * as Clock from '../js/core/timing.js';
import { playPianoNote, playClick } from '../js/core/audio.js';
import { createScorer } from '../js/core/scoring.js';
import * as Midi from '../js/core/midi.js';
import { loadOffset, saveOffset, calcRoundOffset } from '../js/core/calibration.js';
import { parseMIDIFile } from '../js/core/midi-parser.js';


// ════════════════════════════════════════════════════════════════
// PIANO LAYOUT — local until extracted to render/piano.js
// ════════════════════════════════════════════════════════════════

const WHITE_KEY_W = 22, WHITE_KEY_H = 72;
const BLACK_KEY_W = 14, BLACK_KEY_H = 44;

const midiToName = n => NOTE_NAMES[n % 12] + Math.floor(n / 12 - 1);
const isBlack    = n => KEY_PATTERN[n % 12] === 1;

const whiteKeys = [];
for (let n = PIANO_NOTE_MIN; n <= PIANO_NOTE_MAX; n++) {
  if (!isBlack(n)) whiteKeys.push(n);
}
const CANVAS_W = whiteKeys.length * WHITE_KEY_W;
const CANVAS_H = HIGHWAY_H + WHITE_KEY_H;

// Map MIDI note → x-center on the canvas
const noteXCenter = {};
for (let i = 0; i < whiteKeys.length; i++) {
  noteXCenter[whiteKeys[i]] = i * WHITE_KEY_W + WHITE_KEY_W / 2;
}
for (let n = PIANO_NOTE_MIN; n <= PIANO_NOTE_MAX; n++) {
  if (isBlack(n)) {
    const L = noteXCenter[n - 1], R = noteXCenter[n + 1];
    if (L !== undefined && R !== undefined) noteXCenter[n] = (L + R) / 2;
  }
}
const noteWidth = n => isBlack(n) ? BLACK_KEY_W * 0.85 : WHITE_KEY_W * 0.8;


// ════════════════════════════════════════════════════════════════
// CANVAS + MOUSE INPUT
// ════════════════════════════════════════════════════════════════

const canvas = document.getElementById('highway');
const ctx    = canvas.getContext('2d');
canvas.width  = CANVAS_W;
canvas.height = CANVAS_H;

// Build clickable rects for white/black keys
const whiteKeyRects = whiteKeys.map((note, i) => ({
  note, x: i * WHITE_KEY_W + 1, y: HIGHWAY_H + 1, w: WHITE_KEY_W - 2, h: WHITE_KEY_H - 4,
}));
const blackKeyRects = [];
for (let n = PIANO_NOTE_MIN; n <= PIANO_NOTE_MAX; n++) {
  if (!isBlack(n)) continue;
  const cx = noteXCenter[n];
  if (cx == null) continue;
  blackKeyRects.push({ note: n, x: cx - BLACK_KEY_W / 2, y: HIGHWAY_H, w: BLACK_KEY_W, h: BLACK_KEY_H });
}

const mouseHeldNotes = new Set();

canvas.addEventListener('mousedown', e => {
  const r  = canvas.getBoundingClientRect();
  const mx = (e.clientX - r.left) * (CANVAS_W / r.width);
  const my = (e.clientY - r.top)  * (CANVAS_H / r.height);
  if (my < HIGHWAY_H) return; // clicks above the keyboard ignored

  let hit = null;
  for (const kr of blackKeyRects) {
    if (mx >= kr.x && mx <= kr.x + kr.w && my >= kr.y && my <= kr.y + kr.h) { hit = kr.note; break; }
  }
  if (hit === null) {
    for (const kr of whiteKeyRects) {
      if (mx >= kr.x && mx <= kr.x + kr.w && my >= kr.y && my <= kr.y + kr.h) { hit = kr.note; break; }
    }
  }
  if (hit === null) return;

  if (calOpen) { registerCalTap(); return; }
  mouseHeldNotes.add(hit);
  heldNotes.add(hit);
  if (alwaysSound) playPianoNote(hit, 80);
  if (Clock.isPlaying() && !Clock.isPaused() && Clock.isCountoffDone()) {
    if (!alwaysSound) playPianoNote(hit, 80);
    checkHit(hit);
  }
});

const releaseMouseNotes = () => {
  mouseHeldNotes.forEach(n => heldNotes.delete(n));
  mouseHeldNotes.clear();
};
canvas.addEventListener('mouseup',    releaseMouseNotes);
canvas.addEventListener('mouseleave', releaseMouseNotes);


// ════════════════════════════════════════════════════════════════
// SCREEN STATE
// ════════════════════════════════════════════════════════════════

const scorer         = createScorer();
let scheduledNotes   = [];
let fallingBlocks    = [];
const heldNotes      = new Set();
let notePreview      = {};
let offsetLog        = [];
let songDuration     = 0;
let userOffset       = 0;
let activeDeviceName = 'unknown';
let alwaysSound      = true;
let feedbackTimer    = null;
let lastTime         = 0;
let songName         = '—';

// P1 colour palette
const P1 = {
  fill:      PLAYER_COLORS[0].fill,
  stroke:    PLAYER_COLORS[0].stroke,
  key:       PLAYER_COLORS[0].stroke,
  keyStroke: PLAYER_COLORS[0].accent,
};


// ════════════════════════════════════════════════════════════════
// MIDI
// ════════════════════════════════════════════════════════════════

async function setupMIDI() {
  const dot = document.getElementById('sdot');
  const txt = document.getElementById('stext');

  const result = await Midi.initMIDI();
  if (!result.ok) {
    dot.className = 'sdot red';
    txt.textContent = result.reason === 'unsupported'
      ? 'Web MIDI not supported — use Chrome'
      : 'MIDI access denied — check Chrome permissions';
    return;
  }

  function attachToFirstInput() {
    const inputs = Midi.getInputs();
    Midi.detachAll();
    if (inputs.length === 0) {
      dot.className = 'sdot yellow';
      txt.textContent = 'No MIDI devices — connect one and refresh';
      activeDeviceName = 'unknown';
      userOffset = loadOffset(activeDeviceName);
      updateOffsetDisplay();
      return;
    }
    dot.className = 'sdot green';
    txt.textContent = 'Connected: ' + inputs.map(i => i.name).join(', ');
    Midi.attachListener(inputs[0].id, onMidiEvent);
    activeDeviceName = inputs[0].name;
    userOffset = loadOffset(activeDeviceName);
    updateOffsetDisplay();
  }

  attachToFirstInput();
  Midi.onStateChange(() => attachToFirstInput());
}

function onMidiEvent(evt) {
  if (evt.type === 'noteOff') {
    heldNotes.delete(evt.note);
    return;
  }
  if (evt.type !== 'noteOn') return;

  if (calOpen) { registerCalTap(); return; }
  heldNotes.add(evt.note);
  if (alwaysSound) playPianoNote(evt.note, evt.velocity);
  if (Clock.isPlaying() && !Clock.isPaused() && Clock.isCountoffDone()) {
    if (!alwaysSound) playPianoNote(evt.note, evt.velocity);
    checkHit(evt.note);
  }
}


// ════════════════════════════════════════════════════════════════
// HIT DETECTION
// ════════════════════════════════════════════════════════════════

function checkHit(note) {
  const songTime = Clock.getSongTime();
  if (songTime < 0) return;
  const fallTimeMs = Clock.getFallTimeMs();
  const hw = Clock.getHitWindow();

  let best = null, bestDiff = Infinity;
  for (const sn of scheduledNotes) {
    if (sn.note !== note || sn.hit || sn.missed || !sn.spawned) continue;
    const expected = sn.startMs + fallTimeMs + userOffset;
    const diff = Math.abs(songTime - expected);
    if (diff < bestDiff) { bestDiff = diff; best = sn; }
  }

  if (!best) {
    scorer.registerWrong();
    showFeedback('WRONG', 'wrong');
    return;
  }

  const expected = best.startMs + fallTimeMs + userOffset;
  const offset   = Math.round(songTime - expected);
  const quality  = bestDiff <= hw.perfect ? 'perfect'
                 : bestDiff <= hw.good    ? 'good' : null;

  offsetLog.push({ offset, note, quality: quality || 'miss_early' });
  if (offsetLog.length > 10) offsetLog.shift();
  updateOffsetLog();

  if (quality) registerHitOk(best, quality);
}

function registerHitOk(sn, quality) {
  sn.hit = true;
  playPianoNote(sn.note, sn.vel || 80);
  if (sn.block) { sn.block.hitQuality = quality; sn.block.hitTime = performance.now(); }
  scorer.registerHit(quality);
  showFeedback(quality === 'perfect' ? 'PERFECT' : 'GOOD', quality);
}

function registerMiss(sn) {
  if (!sn.spawned) return;
  sn.missed = true;
  scorer.registerMiss();
  showFeedback('MISS', 'miss');
  offsetLog.push({ offset: 'MISS', note: sn.note, quality: 'miss' });
  if (offsetLog.length > 10) offsetLog.shift();
  updateOffsetLog();
}

function showFeedback(text, cls) {
  const el = document.getElementById('hit-feedback');
  el.textContent = text;
  el.className   = 'hit-feedback ' + cls;
  clearTimeout(feedbackTimer);
  feedbackTimer = setTimeout(() => { el.className = 'hit-feedback hidden'; }, 600);
}


// ════════════════════════════════════════════════════════════════
// SONG CONTROL
// ════════════════════════════════════════════════════════════════

function setupSong(notes, name) {
  scheduledNotes = notes;
  songDuration   = Math.max(...notes.map(n => n.startMs + n.durMs)) + 5000;
  scorer.reset();
  offsetLog     = [];
  fallingBlocks = [];
  notePreview   = {};
  songName      = name;

  document.getElementById('file-label').className     = 'file-btn ready';
  document.getElementById('start-btn').className      = 'start-btn enabled';
  document.getElementById('start-btn').textContent    = 'START →';
  document.getElementById('offset-log').innerHTML     = '<div style="color:#444;font-size:10px">— no hits yet —</div>';
  document.getElementById('d-songname').textContent   = name;
}

function startSong() {
  if (!scheduledNotes.length) return;
  scheduledNotes.forEach(n => { n.hit = false; n.missed = false; n.block = null; n.spawned = false; });
  fallingBlocks = [];
  notePreview   = {};
  offsetLog     = [];
  scorer.reset();
  Clock.startSong();

  document.getElementById('start-btn').style.display = 'none';
  document.getElementById('btn-pause').style.display = 'inline-block';
  document.getElementById('btn-reset').style.display = 'inline-block';
  document.getElementById('hit-feedback').className  = 'hit-feedback hidden';
  document.getElementById('offset-log').innerHTML    = '<div style="color:#444;font-size:10px">— no hits yet —</div>';
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
  scheduledNotes.forEach(n => { n.hit = false; n.missed = false; n.block = null; n.spawned = false; });
  fallingBlocks = [];
  notePreview   = {};
  offsetLog     = [];
  scorer.reset();

  document.getElementById('start-btn').style.display = 'inline-block';
  document.getElementById('start-btn').className     = 'start-btn enabled';
  document.getElementById('start-btn').textContent   = 'START →';
  document.getElementById('btn-pause').style.display = 'none';
  document.getElementById('btn-reset').style.display = 'none';
  document.getElementById('btn-pause').textContent   = '⏸ PAUSE';
  document.getElementById('btn-pause').className     = '';
  document.getElementById('hit-feedback').className  = 'hit-feedback hidden';
  document.getElementById('offset-log').innerHTML    = '<div style="color:#444;font-size:10px">— no hits yet —</div>';
}

function showSongComplete() {
  const stats = scorer.getStats();
  const fb = document.getElementById('hit-feedback');
  fb.textContent = 'SONG COMPLETE!  ' + (stats.grade || '—') + '  ' + (stats.accuracy ?? 0) + '%';
  fb.className   = 'hit-feedback complete';
  document.getElementById('btn-pause').style.display = 'none';
  document.getElementById('start-btn').style.display = 'inline-block';
  document.getElementById('start-btn').textContent   = '↺ PLAY AGAIN';
  document.getElementById('start-btn').className     = 'start-btn enabled';
}


// ════════════════════════════════════════════════════════════════
// TEST SONGS
// ════════════════════════════════════════════════════════════════

function makeTestSongs() {
  const B = BEAT_MS, E = B / 2;
  const metronome = [];
  for (let i = 0; i < 8; i++) metronome.push({ note: 60, startMs: i * B, durMs: E });

  const scale = [60, 62, 64, 65, 67, 69, 71, 72].map((note, i) => ({ note, startMs: i * B, durMs: E }));

  const mary = [
    {note:64,startMs:0*B,durMs:E},{note:62,startMs:1*B,durMs:E},{note:60,startMs:2*B,durMs:E},{note:62,startMs:3*B,durMs:E},
    {note:64,startMs:4*B,durMs:E},{note:64,startMs:5*B,durMs:E},{note:64,startMs:6*B,durMs:B},
    {note:62,startMs:8*B,durMs:E},{note:62,startMs:9*B,durMs:E},{note:62,startMs:10*B,durMs:B},
    {note:64,startMs:12*B,durMs:E},{note:67,startMs:13*B,durMs:E},{note:67,startMs:14*B,durMs:B},
    {note:64,startMs:16*B,durMs:E},{note:62,startMs:17*B,durMs:E},{note:60,startMs:18*B,durMs:E},{note:62,startMs:19*B,durMs:E},
    {note:64,startMs:20*B,durMs:E},{note:64,startMs:21*B,durMs:E},{note:64,startMs:22*B,durMs:E},{note:64,startMs:23*B,durMs:E},
    {note:62,startMs:24*B,durMs:E},{note:62,startMs:25*B,durMs:E},{note:64,startMs:26*B,durMs:E},{note:62,startMs:27*B,durMs:E},
    {note:60,startMs:28*B,durMs:B},
  ];
  return { metronome, scale, mary };
}
const TEST_SONGS = makeTestSongs();
const SONG_LABELS = { metronome: 'Metronome — 8×C4', scale: 'C Major Scale', mary: 'Mary Had a Little Lamb' };

function loadTest(name) {
  const raw = TEST_SONGS[name];
  if (!raw) return;
  setupSong(raw.map(n => ({ ...n, hit: false, missed: false, block: null, spawned: false })), SONG_LABELS[name]);
}

function loadMIDIFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const parsed = parseMIDIFile(e.target.result);
    const notes = parsed.tracks
      .flatMap(t => t.notes)
      .filter(n => n.note >= PIANO_NOTE_MIN && n.note <= PIANO_NOTE_MAX)
      .map(n => ({ ...n, hit: false, missed: false, block: null, spawned: false }))
      .sort((a, b) => a.startMs - b.startMs);
    if (!notes.length) {
      alert('No playable notes found in range C3–C6. Try a different MIDI file.');
      return;
    }
    setupSong(notes, file.name.replace(/\.midi?$/i, ''));
  };
  reader.readAsArrayBuffer(file);
}


// ════════════════════════════════════════════════════════════════
// SETTINGS
// ════════════════════════════════════════════════════════════════

function updateSpeedUI(level) {
  Clock.setSpeedLevel(level);
  const s = (Clock.getFallTimeMs() / 1000).toFixed(1);
  document.getElementById('speed-val').textContent = level + ' — ' + s + 's';
  document.getElementById('d-speed').textContent   = level + ' (' + s + 's fall)';
}

function updateHitWindowUI(level) {
  Clock.setHitWindowLevel(level);
  const w = Clock.getHitWindow();
  document.getElementById('hitwin-val').textContent = w.name;
  document.getElementById('d-window').textContent   = w.name + ' ±' + w.perfect + '/' + w.good + 'ms';
}

function toggleAlwaysSound() {
  alwaysSound = !alwaysSound;
  const btn = document.getElementById('sound-toggle');
  btn.textContent = alwaysSound ? 'ALWAYS' : 'ON HIT';
  btn.className   = alwaysSound ? 'active' : '';
}


// ════════════════════════════════════════════════════════════════
// DEBUG PANEL UPDATE
// ════════════════════════════════════════════════════════════════

function updateOffsetDisplay() {
  const el = document.getElementById('d-useroffset');
  if (el) el.textContent = (userOffset > 0 ? '+' : '') + userOffset + 'ms';
}

function updateOffsetLog() {
  const log = document.getElementById('offset-log');
  log.innerHTML = '';
  const nums = offsetLog.filter(e => typeof e.offset === 'number').map(e => e.offset);
  offsetLog.slice().reverse().forEach(e => {
    const div = document.createElement('div');
    div.className = 'offset-entry ' + (e.quality || 'miss');
    const offStr = typeof e.offset === 'number'
      ? (e.offset > 0 ? '+' : '') + e.offset + 'ms'
      : e.offset;
    div.textContent = `${midiToName(e.note)}  ${offStr}  [${e.quality}]`;
    log.appendChild(div);
  });
  if (nums.length > 0) {
    const avg = Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
    document.getElementById('d-avgoffset').textContent =
      (avg > 0 ? '+' : '') + avg + 'ms';
    document.getElementById('d-suggestion').textContent =
        avg < -30 ? 'hitting too early — wait longer'
      : avg >  30 ? 'hitting too late — press sooner'
      :             'timing looks good! ✓';
  }
}

function updateDebug() {
  const songTime   = Clock.getSongTime();
  const fallTimeMs = Clock.getFallTimeMs();
  const hw         = Clock.getHitWindow();

  const set = (id, val, cls) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = val;
    if (cls) el.className = 'debug-val ' + cls;
  };

  const stateStr = Clock.isCountoffActive() ? 'COUNT-OFF'
                 : Clock.isCountoffDone() && Clock.isPlaying() ? 'PLAYING'
                 : Clock.isPaused() ? 'PAUSED'
                 : 'IDLE';
  set('d-state', stateStr,
      Clock.isCountoffActive() ? 'warn'
    : Clock.isCountoffDone() && Clock.isPlaying() ? 'good'
    : 'neutral');

  set('d-songtime',  songTime >= 0 ? songTime.toFixed(0) + 'ms' : '—',
      songTime >= 0 ? 'good' : 'neutral');
  set('d-falltime',  fallTimeMs + 'ms');
  set('d-songstart', Clock.getSongTime() >= 0 || Clock.isPlaying() ? 'YES ✓' : 'NO ✗',
      Clock.isPlaying() ? 'good' : 'bad');
  set('d-speed',     Clock.getSpeedLevel() + ' (' + (fallTimeMs / 1000).toFixed(1) + 's fall)');
  set('d-window',    hw.name + ' ±' + hw.perfect + '/' + hw.good + 'ms');
  const spawned = scheduledNotes.filter(n => n.spawned).length;
  set('d-blocks',    fallingBlocks.length + ' / ' + spawned);

  // Note table (first 8 upcoming)
  const tbody = document.getElementById('note-table');
  tbody.innerHTML = '<tr><th>note</th><th>startMs</th><th>hitAt</th><th>until</th><th>status</th><th>Y</th></tr>';
  scheduledNotes.slice(0, 8).forEach(sn => {
    const hitAt     = (sn.startMs + fallTimeMs).toFixed(0);
    const timeUntil = songTime >= 0 ? ((sn.startMs + fallTimeMs) - songTime).toFixed(0) : '—';
    const status    = sn.hit ? 'HIT✓' : sn.missed ? 'MISS' : sn.block ? 'FALL' : sn.spawned ? 'spawn' : 'wait';
    const blockY    = sn.block ? sn.block.y.toFixed(0) : '—';
    const tr = document.createElement('tr');
    tr.className = sn.hit ? 'hit' : sn.missed ? 'missed' : sn.block ? 'active' : 'upcoming';
    tr.innerHTML = `<td>${midiToName(sn.note)}</td><td>${sn.startMs.toFixed(0)}</td><td>${hitAt}</td><td>${timeUntil}</td><td>${status}</td><td>${blockY}</td>`;
    tbody.appendChild(tr);
  });

  // Score
  const s = scorer.getStats();
  set('d-perfect', s.perfect, 'good');
  set('d-good',    s.good);
  set('d-miss',    s.miss,  s.miss  > 0 ? 'bad'  : 'neutral');
  set('d-wrong',   s.wrong, s.wrong > 0 ? 'warn' : 'neutral');
  set('d-acc',     s.accuracy !== null ? s.accuracy + '%' : '—');
}


// ════════════════════════════════════════════════════════════════
// KEY PREVIEW GLOW
// ════════════════════════════════════════════════════════════════

function computePreview() {
  notePreview = {};
  for (const block of fallingBlocks) {
    const dist = HIT_Y - block.y;
    if (dist >= 0 && dist <= PREVIEW_ZONE) {
      const intensity = 1 - (dist / PREVIEW_ZONE);
      if (!notePreview[block.note] || intensity > notePreview[block.note]) {
        notePreview[block.note] = intensity;
      }
    }
  }
}


// ════════════════════════════════════════════════════════════════
// DRAW
// ════════════════════════════════════════════════════════════════

function drawHighway() {
  ctx.fillStyle = '#0d0d14';
  ctx.fillRect(0, 0, CANVAS_W, HIGHWAY_H);
  for (let i = 0; i < whiteKeys.length; i++) {
    ctx.fillStyle = i % 2 === 0 ? '#0d0d14' : '#0f0f18';
    ctx.fillRect(i * WHITE_KEY_W, 0, WHITE_KEY_W, HIGHWAY_H);
  }
  ctx.strokeStyle = '#1a1a24'; ctx.lineWidth = 0.5;
  for (let i = 0; i <= whiteKeys.length; i++) {
    ctx.beginPath();
    ctx.moveTo(i * WHITE_KEY_W, 0);
    ctx.lineTo(i * WHITE_KEY_W, HIGHWAY_H);
    ctx.stroke();
  }

  // Held-key column highlight
  heldNotes.forEach(n => {
    if (n < PIANO_NOTE_MIN || n > PIANO_NOTE_MAX) return;
    const cx = noteXCenter[n];
    const nw = isBlack(n) ? BLACK_KEY_W : WHITE_KEY_W;
    ctx.fillStyle = 'rgba(127,119,221,0.1)';
    ctx.fillRect(cx - nw / 2, 0, nw, HIGHWAY_H);
  });

  // Falling blocks
  const now = performance.now();
  fallingBlocks.forEach(block => {
    let fill = block.black ? '#7F77DD' : P1.fill;
    let stroke = block.black ? '#AFA9EC' : P1.stroke;
    let alpha = 0.9;
    if (block.hitQuality) {
      const age = now - block.hitTime;
      if (age < 250) {
        fill   = block.hitQuality === 'perfect' ? '#1D9E75' : '#5DCAA5';
        stroke = '#9FE1CB';
        alpha  = 1 - (age / 250) * 0.6;
      }
    }
    ctx.globalAlpha = alpha;
    ctx.fillStyle = fill;
    ctx.beginPath(); ctx.roundRect(block.x, block.y, block.w, block.h, 2); ctx.fill();
    ctx.strokeStyle = stroke; ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.roundRect(block.x, block.y, block.w, block.h, 2); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    ctx.beginPath(); ctx.roundRect(block.x + 1, block.y + 1, block.w - 2, 3, 1); ctx.fill();
    ctx.globalAlpha = 1;
  });

  // Hit zone
  ctx.fillStyle = 'rgba(127,119,221,0.35)';
  ctx.fillRect(0, HIT_Y, CANVAS_W, 3);
  ctx.fillStyle = 'rgba(127,119,221,0.3)';
  ctx.font = '9px Segoe UI'; ctx.textAlign = 'left';
  ctx.fillText('HIT ZONE', 4, HIT_Y - 4);
  ctx.fillStyle = '#1e1e2a';
  ctx.fillRect(0, HIGHWAY_H - 1, CANVAS_W, 1);
}

function drawKeyboard() {
  const kyTop = HIGHWAY_H;
  // White keys
  for (let i = 0; i < whiteKeys.length; i++) {
    const n = whiteKeys[i], kx = i * WHITE_KEY_W;
    const held    = heldNotes.has(n);
    const preview = notePreview[n] || 0;
    ctx.fillStyle = held ? P1.key : '#e8e8e0';
    ctx.strokeStyle = held ? P1.keyStroke : '#999';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.roundRect(kx + 1, kyTop + 1, WHITE_KEY_W - 2, WHITE_KEY_H - 4, [0, 0, 3, 3]);
    ctx.fill(); ctx.stroke();
    if (!held && preview > 0) {
      ctx.globalAlpha = preview * 0.75;
      ctx.fillStyle = '#7F77DD';
      ctx.beginPath();
      ctx.roundRect(kx + 1, kyTop + 1, WHITE_KEY_W - 2, WHITE_KEY_H - 4, [0, 0, 3, 3]);
      ctx.fill();
      ctx.globalAlpha = 1;
      if (preview > 0.6) {
        ctx.strokeStyle = '#AFA9EC';
        ctx.lineWidth = preview;
        ctx.beginPath();
        ctx.roundRect(kx + 1, kyTop + 1, WHITE_KEY_W - 2, WHITE_KEY_H - 4, [0, 0, 3, 3]);
        ctx.stroke();
      }
    }
    if (n % 12 === 0) {
      ctx.fillStyle = (held || preview > 0.3) ? '#3C3489' : '#aaa';
      ctx.font = '8px Segoe UI'; ctx.textAlign = 'center';
      ctx.fillText(midiToName(n), kx + WHITE_KEY_W / 2, kyTop + WHITE_KEY_H - 8);
    }
  }
  // Black keys
  for (let n = PIANO_NOTE_MIN; n <= PIANO_NOTE_MAX; n++) {
    if (!isBlack(n)) continue;
    const cx = noteXCenter[n];
    if (cx == null) continue;
    const kx = cx - BLACK_KEY_W / 2;
    const held    = heldNotes.has(n);
    const preview = notePreview[n] || 0;
    ctx.fillStyle = held ? P1.fill : '#111';
    ctx.strokeStyle = held ? P1.stroke : '#333';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.roundRect(kx, kyTop, BLACK_KEY_W, BLACK_KEY_H, [0, 0, 3, 3]);
    ctx.fill(); ctx.stroke();
    if (!held && preview > 0) {
      ctx.globalAlpha = preview * 0.85;
      ctx.fillStyle = '#7F77DD';
      ctx.beginPath();
      ctx.roundRect(kx, kyTop, BLACK_KEY_W, BLACK_KEY_H, [0, 0, 3, 3]);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    if (!held && preview === 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.beginPath();
      ctx.roundRect(kx + 2, kyTop + 2, BLACK_KEY_W - 4, 6, 2);
      ctx.fill();
    }
  }
}

function drawCountoff(beatNum, beatProgress) {
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(0, 0, CANVAS_W, HIGHWAY_H);
  const beatStr = beatNum <= COUNTOFF_BEATS ? String(beatNum) : 'GO!';
  const scale = 1 - beatProgress * 0.25;
  ctx.save();
  ctx.translate(CANVAS_W / 2, HIGHWAY_H / 2);
  ctx.scale(scale, scale);
  ctx.fillStyle = beatNum <= COUNTOFF_BEATS ? '#3C3489' : '#085041';
  ctx.font = '500 108px Segoe UI'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(beatStr, 3, 3);
  ctx.fillStyle = beatNum <= COUNTOFF_BEATS ? '#AFA9EC' : '#9FE1CB';
  ctx.font = '500 100px Segoe UI';
  ctx.fillText(beatStr, 0, 0);
  ctx.restore();
  for (let i = 0; i < COUNTOFF_BEATS; i++) {
    ctx.beginPath();
    ctx.arc(CANVAS_W / 2 - ((COUNTOFF_BEATS - 1) / 2) * 24 + i * 24, HIGHWAY_H - 30, 5, 0, Math.PI * 2);
    ctx.fillStyle = i < beatNum ? '#7F77DD' : '#2a2a3a';
    ctx.fill();
  }
}


// ════════════════════════════════════════════════════════════════
// GAME LOOP
// ════════════════════════════════════════════════════════════════

function update(timestamp) {
  if (!lastTime) lastTime = timestamp;
  const delta = timestamp - lastTime;
  lastTime = timestamp;
  const pxPerFrame = Clock.getPxPerFrame();

  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

  if (Clock.isPlaying() && !Clock.isPaused()) {
    const songTime   = Clock.getSongTime();
    const fallTimeMs = Clock.getFallTimeMs();
    const hw         = Clock.getHitWindow();

    // Spawn blocks
    for (const sn of scheduledNotes) {
      if (sn.hit || sn.missed || sn.block) continue;
      if (songTime >= sn.startMs) {
        const cx = noteXCenter[sn.note];
        if (cx == null) continue;
        const nw = noteWidth(sn.note);
        const nh = isBlack(sn.note) ? 14 : 18;
        const block = {
          x: cx - nw / 2, y: 0, w: nw, h: nh,
          note: sn.note, black: isBlack(sn.note),
          hitQuality: null, hitTime: null,
        };
        sn.block = block;
        sn.spawned = true;
        fallingBlocks.push(block);
      }
    }

    // Move blocks
    fallingBlocks.forEach(b => { b.y += pxPerFrame * (delta / 16.67); });

    // Miss detection
    for (const sn of scheduledNotes) {
      if (!sn.hit && !sn.missed && sn.spawned) {
        const expected = sn.startMs + fallTimeMs;
        if (songTime - expected > hw.good) registerMiss(sn);
      }
    }

    // Cleanup off-screen blocks
    fallingBlocks = fallingBlocks.filter(b => b.y < HIGHWAY_H + b.h);

    // Tick count-off (auto-ends itself)
    Clock.tickCountoff();

    // End of song
    if (Clock.isCountoffDone() && songTime > songDuration) {
      Clock.stopSong();
      showSongComplete();
    }

    // Draw
    computePreview();
    drawHighway();
    drawKeyboard();

    // Count-off overlay
    if (Clock.isCountoffActive()) {
      // We already ticked it above; recompute the render values for this frame.
      const tick = Clock.tickCountoff();
      if (tick) drawCountoff(tick.beatNum, tick.beatProgress);
    }
  } else {
    computePreview();
    drawHighway();
    drawKeyboard();
  }

  updateDebug();
  requestAnimationFrame(update);
}


// ════════════════════════════════════════════════════════════════
// CALIBRATION OVERLAY
// ════════════════════════════════════════════════════════════════
// Storage and math live in core/calibration.js. The DOM-driven overlay
// state stays here for now — could move into a shared overlay module
// later if drum_debug and gameplay share the same overlay.

let calOpen          = false;
let calRound         = 0;
let calRoundStart    = 0;
let calFlashTimes    = [];
let calTaps          = [];
let calRoundResults  = [];
let calPendingOffset = 0;
let calAnimId        = null;
let calNextFlash     = 0;

function openCal() {
  calOpen = true;
  calRound = 0;
  calRoundResults = [];
  document.getElementById('cal-overlay').classList.add('open');
  document.getElementById('cal-active').style.display = '';
  document.getElementById('cal-results').classList.remove('show');
  startCalRound();
}

function closeCal() {
  calOpen = false;
  document.getElementById('cal-overlay').classList.remove('open');
  if (calAnimId) { cancelAnimationFrame(calAnimId); calAnimId = null; }
}

function startCalRound() {
  calFlashTimes = [];
  calTaps = [];

  for (let i = 0; i < CAL_ROUNDS; i++) {
    const dot = document.getElementById('cal-dot-' + i);
    if (dot) {
      dot.className = 'cal-round-dot' +
        (i < calRound ? ' done' : i === calRound ? ' active' : '');
    }
  }
  document.getElementById('cal-round-heading').textContent = 'ROUND ' + (calRound + 1) + ' OF ' + CAL_ROUNDS;
  document.getElementById('cal-tap-count').textContent = '';
  document.getElementById('cal-instruction').innerHTML = 'Tap your instrument in time with each flash.<br>Keep going until the round ends.';

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
    if (label)  label.textContent = 'TAP';
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
  if (validAvgs.length > 0) {
    overall = Math.round(validAvgs.reduce((a, b) => a + b, 0) / validAvgs.length);
  }
  calPendingOffset = overall;

  document.getElementById('cal-final-val').textContent = (overall > 0 ? '+' : '') + overall;
  document.getElementById('cal-current-val').textContent = (overall > 0 ? '+' : '') + overall + 'ms';
  document.getElementById('cal-device-note').textContent = 'Will be saved for: ' + activeDeviceName;
}

function nudgeOffset(delta) {
  calPendingOffset = Math.max(-200, Math.min(200, calPendingOffset + delta));
  const el = document.getElementById('cal-current-val');
  if (el) el.textContent = (calPendingOffset > 0 ? '+' : '') + calPendingOffset + 'ms';
}

function applyOffset() {
  saveOffset(activeDeviceName, calPendingOffset);
  userOffset = calPendingOffset;
  updateOffsetDisplay();
  closeCal();
}

function registerCalTap() {
  if (!calOpen || calRound >= CAL_ROUNDS) return;
  calTaps.push(performance.now());
}


// ════════════════════════════════════════════════════════════════
// DOM WIRING
// ════════════════════════════════════════════════════════════════

document.getElementById('btn-test-metronome').addEventListener('click', () => loadTest('metronome'));
document.getElementById('btn-test-scale')    .addEventListener('click', () => loadTest('scale'));
document.getElementById('btn-test-mary')     .addEventListener('click', () => loadTest('mary'));

document.getElementById('start-btn').addEventListener('click', startSong);
document.getElementById('btn-pause').addEventListener('click', togglePause);
document.getElementById('btn-reset').addEventListener('click', resetSong);
document.getElementById('btn-cal')  .addEventListener('click', openCal);

document.getElementById('file-input').addEventListener('change', loadMIDIFile);

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
  if (e.code === 'Space')   { e.preventDefault(); if (!calOpen) togglePause(); }
  if (e.code === 'KeyR')    { if (!calOpen) resetSong(); }
  if (e.code === 'KeyC')    { if (!calOpen) openCal(); }
  if (e.code === 'Escape')  { if (calOpen) closeCal(); }
});


// ════════════════════════════════════════════════════════════════
// INIT
// ════════════════════════════════════════════════════════════════

// Set defaults
Clock.setSpeedLevel(DEFAULT_SPEED_LEVEL);
Clock.setHitWindowLevel(DEFAULT_HIT_WINDOW_LEVEL);
document.getElementById('speed').value  = DEFAULT_SPEED_LEVEL;
document.getElementById('hitwin').value = DEFAULT_HIT_WINDOW_LEVEL;
updateSpeedUI(DEFAULT_SPEED_LEVEL);
updateHitWindowUI(DEFAULT_HIT_WINDOW_LEVEL);

setupMIDI();
requestAnimationFrame(update);
