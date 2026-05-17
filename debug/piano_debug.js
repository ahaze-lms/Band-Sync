// ════════════════════════════════════════════════════════════════════
// BandSync — Piano Debug Screen
// ════════════════════════════════════════════════════════════════════
// Standalone piano debug tool. Composes the shared engine + renderer
// modules with a debug-panel HUD that the gameplay screen doesn't have.
//
// Modules in play:
//   - /js/core/timing      — song clock, count-off
//   - /js/core/audio       — playPianoNote, playClick
//   - /js/core/scoring     — createScorer factory
//   - /js/core/midi        — Web MIDI access and per-device routing
//   - /js/core/calibration — offset storage + round math
//   - /js/core/midi-parser — multi-track .mid parser
//   - /js/render/piano     — canvas drawing + key click input
//
// The piano renderer owns the canvas; this file just orchestrates
// gameplay state, hit detection, calibration overlay, and the debug
// panel HUD.
// ════════════════════════════════════════════════════════════════════

import {
  PIANO_NOTE_MIN, PIANO_NOTE_MAX,
  HIGHWAY_H,
  BEAT_MS,
  CAL_ROUNDS, CAL_ROUND_MS, CAL_BEAT_MS, CAL_FLASH_MS,
  DEFAULT_SPEED_LEVEL, DEFAULT_HIT_WINDOW_LEVEL,
  PLAYER_COLORS,
} from '../js/config.js';

import * as Clock from '../js/core/timing.js';
import { playPianoNote, playClick } from '../js/core/audio.js';
import { createScorer } from '../js/core/scoring.js';
import * as Midi from '../js/core/midi.js';
import { loadOffset, saveOffset, calcRoundOffset } from '../js/core/calibration.js';
import { parseMIDIFile } from '../js/core/midi-parser.js';
import { createPianoRenderer, midiToName } from '../js/render/piano.js';


// ════════════════════════════════════════════════════════════════
// RENDERER
// ════════════════════════════════════════════════════════════════

const piano = createPianoRenderer(
  document.getElementById('highway'),
  {
    noteMin:   PIANO_NOTE_MIN,
    noteMax:   PIANO_NOTE_MAX,
    color:     PLAYER_COLORS[0], // P1 purple
    onKeyDown: handleKeyDown,
    onKeyUp:   handleKeyUp,
  },
);


// ════════════════════════════════════════════════════════════════
// SCREEN STATE
// ════════════════════════════════════════════════════════════════

const scorer         = createScorer();
let scheduledNotes   = [];
let fallingBlocks    = [];
const heldNotes      = new Set();
let offsetLog        = [];
let songDuration     = 0;
let userOffset       = 0;
let activeDeviceName = 'unknown';
let alwaysSound      = true;
let feedbackTimer    = null;
let lastTime         = 0;
let songName         = '—';


// ════════════════════════════════════════════════════════════════
// INPUT HANDLERS (called by renderer for mouse, by MIDI module for keys)
// ════════════════════════════════════════════════════════════════

function handleKeyDown(note, velocity = 80) {
  if (calOpen) { registerCalTap(); return; }
  heldNotes.add(note);
  if (alwaysSound) playPianoNote(note, velocity);
  if (Clock.isPlaying() && !Clock.isPaused() && Clock.isCountoffDone()) {
    if (!alwaysSound) playPianoNote(note, velocity);
    checkHit(note);
  }
}

function handleKeyUp(note) {
  heldNotes.delete(note);
}


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
  handleKeyDown(evt.note, evt.velocity);
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
  songName      = name;

  document.getElementById('file-label').className   = 'file-btn ready';
  document.getElementById('start-btn').className    = 'start-btn enabled';
  document.getElementById('start-btn').textContent  = 'START →';
  document.getElementById('offset-log').innerHTML   = '<div style="color:#444;font-size:10px">— no hits yet —</div>';
  document.getElementById('d-songname').textContent = name;
}

function startSong() {
  if (!scheduledNotes.length) return;
  scheduledNotes.forEach(n => { n.hit = false; n.missed = false; n.block = null; n.spawned = false; });
  fallingBlocks = [];
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
const TEST_SONGS  = makeTestSongs();
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
      .filter(n => piano.noteInRange(n.note))
      .map(n => ({ ...n, hit: false, missed: false, block: null, spawned: false }))
      .sort((a, b) => a.startMs - b.startMs);
    if (!notes.length) {
      alert('No playable notes found in this keyboard range. Try a different MIDI file.');
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
// DEBUG PANEL
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
    document.getElementById('d-avgoffset').textContent = (avg > 0 ? '+' : '') + avg + 'ms';
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

  set('d-songtime',  songTime >= 0 ? songTime.toFixed(0) + 'ms' : '—', songTime >= 0 ? 'good' : 'neutral');
  set('d-falltime',  fallTimeMs + 'ms');
  set('d-songstart', Clock.isPlaying() ? 'YES ✓' : 'NO ✗', Clock.isPlaying() ? 'good' : 'bad');
  set('d-speed',     Clock.getSpeedLevel() + ' (' + (fallTimeMs / 1000).toFixed(1) + 's fall)');
  set('d-window',    hw.name + ' ±' + hw.perfect + '/' + hw.good + 'ms');
  set('d-blocks',    fallingBlocks.length + ' / ' + scheduledNotes.filter(n => n.spawned).length);

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

  // Score panel
  const s = scorer.getStats();
  set('d-perfect', s.perfect, 'good');
  set('d-good',    s.good);
  set('d-miss',    s.miss,  s.miss  > 0 ? 'bad'  : 'neutral');
  set('d-wrong',   s.wrong, s.wrong > 0 ? 'warn' : 'neutral');
  set('d-acc',     s.accuracy !== null ? s.accuracy + '%' : '—');
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

    // ── Spawn blocks ──────────────────────────────────────────
    for (const sn of scheduledNotes) {
      if (sn.hit || sn.missed || sn.block) continue;
      if (songTime >= sn.startMs) {
        if (!piano.noteInRange(sn.note)) continue;
        const cx = piano.noteToX(sn.note);
        const nw = piano.noteWidth(sn.note);
        const nh = piano.blockHeight(sn.note);
        const block = {
          x: cx - nw / 2, y: 0, w: nw, h: nh,
          note: sn.note, black: piano.isBlack(sn.note),
          hitQuality: null, hitTime: null,
        };
        sn.block   = block;
        sn.spawned = true;
        fallingBlocks.push(block);
      }
    }

    // ── Move blocks (delta-time corrected) ────────────────────
    fallingBlocks.forEach(b => { b.y += pxPerFrame * (delta / 16.67); });

    // ── Miss detection ────────────────────────────────────────
    for (const sn of scheduledNotes) {
      if (!sn.hit && !sn.missed && sn.spawned) {
        const expected = sn.startMs + fallTimeMs;
        if (songTime - expected > hw.good) registerMiss(sn);
      }
    }

    // ── Cleanup off-screen blocks ─────────────────────────────
    fallingBlocks = fallingBlocks.filter(b => b.y < HIGHWAY_H + b.h);

    // ── Tick count-off (auto-ends; null when not active) ──────
    const countoff = Clock.tickCountoff();

    // ── End-of-song ───────────────────────────────────────────
    if (Clock.isCountoffDone() && songTime > songDuration) {
      Clock.stopSong();
      showSongComplete();
    }

    piano.draw({ fallingBlocks, heldNotes, countoff });
  } else {
    piano.draw({ fallingBlocks, heldNotes });
  }

  updateDebug();
  requestAnimationFrame(update);
}


// ════════════════════════════════════════════════════════════════
// CALIBRATION OVERLAY
// ════════════════════════════════════════════════════════════════
// Storage + math live in core/calibration.js. The DOM-driven overlay
// state stays here for now.

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
  document.getElementById('cal-tap-count').textContent     = '';
  document.getElementById('cal-instruction').innerHTML     = 'Tap your instrument in time with each flash.<br>Keep going until the round ends.';

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

  document.getElementById('cal-final-val').textContent   = (overall > 0 ? '+' : '') + overall;
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

document.getElementById('speed').value  = DEFAULT_SPEED_LEVEL;
document.getElementById('hitwin').value = DEFAULT_HIT_WINDOW_LEVEL;
updateSpeedUI(DEFAULT_SPEED_LEVEL);
updateHitWindowUI(DEFAULT_HIT_WINDOW_LEVEL);

setupMIDI();
requestAnimationFrame(update);
