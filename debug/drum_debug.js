// ════════════════════════════════════════════════════════════════════
// BandSync — Drum Debug Screen
// ════════════════════════════════════════════════════════════════════
// Drum highway with abstract-name hit detection. Refactored to use the
// shared engine modules under /js. The drum view itself (lane layout,
// canvas drawing, lane click input, mapping warning) still lives here
// for now; it'll move into /js/render/drums.js in Stage 5.
//
// Drum-specific concerns (not in piano_debug):
//   - Abstract-name lookup via per-device drumMapping
//   - Multi-device dropdown (kits often appear alongside other MIDI gear)
//   - Mapping warning banner + mapping debug section
//   - Count-off metronome clicks (every beat, audible)
// ════════════════════════════════════════════════════════════════════

import {
  HIGHWAY_H, HIT_Y,
  COUNTOFF_BEATS, BEAT_MS, COUNTOFF_TOTAL_MS,
  CAL_ROUNDS, CAL_ROUND_MS, CAL_BEAT_MS, CAL_FLASH_MS,
  DEFAULT_SPEED_LEVEL, DEFAULT_HIT_WINDOW_LEVEL,
} from '../js/config.js';

import * as Clock from '../js/core/timing.js';
import { playDrumSound, playClick } from '../js/core/audio.js';
import { createScorer } from '../js/core/scoring.js';
import * as Midi from '../js/core/midi.js';
import { loadOffset, saveOffset, calcRoundOffset } from '../js/core/calibration.js';
import {
  loadMapping, hasMapping, lookupAbstractName,
} from '../js/core/drum-mapping.js';


// ════════════════════════════════════════════════════════════════
// DRUM LANES — local until extracted to render/drums.js
// ════════════════════════════════════════════════════════════════

const LANES = [
  { name: 'HH_PEDAL',  color: '#5DCAA5', stroke: '#9FE1CB', label: 'HH\nPED' },
  { name: 'KICK',      color: '#E24B4A', stroke: '#F09595', label: 'KICK'    },
  { name: 'SNARE',     color: '#7F77DD', stroke: '#AFA9EC', label: 'SNR'     },
  { name: 'SNARE_RIM', color: '#534AB7', stroke: '#7F77DD', label: 'RIM'     },
  { name: 'HH_CLOSED', color: '#5DCAA5', stroke: '#9FE1CB', label: 'HH\nCLS' },
  { name: 'HH_OPEN',   color: '#1D9E75', stroke: '#5DCAA5', label: 'HH\nOPN' },
  { name: 'TOM_1',     color: '#EF9F27', stroke: '#FAC775', label: 'T1'      },
  { name: 'TOM_2',     color: '#BA7517', stroke: '#EF9F27', label: 'T2'      },
  { name: 'TOM_3',     color: '#854F0B', stroke: '#BA7517', label: 'T3'      },
  { name: 'CRASH',     color: '#AFA9EC', stroke: '#CECBF6', label: 'CRS'     },
  { name: 'RIDE',      color: '#888898', stroke: '#aaaabc', label: 'RIDE'    },
  { name: 'RIDE_BELL', color: '#555566', stroke: '#888898', label: 'BELL'    },
];

const LANE_W   = 60;
const NOTE_R   = 10;
const KICK_H   = 16;
const CANVAS_W = LANES.length * LANE_W;
const CANVAS_H = HIGHWAY_H + 48; // +48 for lane labels

const laneX     = i => i * LANE_W + LANE_W / 2;
const laneIndex = name => LANES.findIndex(l => l.name === name);


// ════════════════════════════════════════════════════════════════
// CANVAS + LANE CLICK INPUT
// ════════════════════════════════════════════════════════════════

const canvas = document.getElementById('highway');
const ctx    = canvas.getContext('2d');
canvas.width  = CANVAS_W;
canvas.height = CANVAS_H;

// Click in the lane-label area (below the highway) triggers that drum
// — useful for testing without a connected kit.
canvas.addEventListener('click', e => {
  const r  = canvas.getBoundingClientRect();
  const mx = (e.clientX - r.left) * (CANVAS_W / r.width);
  const my = (e.clientY - r.top)  * (CANVAS_H / r.height);
  if (my < HIGHWAY_H) return;

  const laneI = Math.floor(mx / LANE_W);
  if (laneI < 0 || laneI >= LANES.length) return;
  const lane = LANES[laneI];

  if (calOpen) { registerCalTap(); return; }

  laneFlash[lane.name] = performance.now();
  if (alwaysSound) playDrumSound(lane.name, 80);
  document.getElementById('d-lastnote').textContent = '(click)';
  document.getElementById('d-lastname').textContent = lane.name;
  if (Clock.isPlaying() && !Clock.isPaused() && Clock.isCountoffDone()) {
    checkHit(lane.name, null, 80);
  }
});


// ════════════════════════════════════════════════════════════════
// SCREEN STATE
// ════════════════════════════════════════════════════════════════

const scorer         = createScorer();
let scheduledNotes   = [];
let fallingBlocks    = [];
let songDuration     = 0;
let userOffset       = 0;
let activeDeviceName = 'unknown';
let drumMapping      = {};
let allMidiInputs    = {};         // { name: { id, name, port } }
let alwaysSound      = true;
let feedbackTimer    = null;
let lastTime         = 0;
const laneFlash      = {};         // { abstractName: timestamp } for hit-flash animation


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

  rescanInputs();
  Midi.onStateChange(() => rescanInputs());
}

function rescanInputs() {
  const dot    = document.getElementById('sdot');
  const txt    = document.getElementById('stext');
  const inputs = Midi.getInputs();

  // Refresh local map by name (for the dropdown)
  allMidiInputs = {};
  inputs.forEach(i => { allMidiInputs[i.name] = i; });

  dot.className = inputs.length > 0 ? 'sdot green' : 'sdot yellow';

  if (inputs.length === 0) {
    txt.textContent = 'No MIDI devices — connect one and refresh';
    activeDeviceName = 'unknown';
    drumMapping = {};
    populateDeviceSelector([]);
    refreshMappingDebug();
    return;
  }

  // Prefer a device that already has a saved drum mapping; otherwise first.
  let preferred = inputs.find(i => hasMapping(i.name)) || inputs[0];

  // Detach every device, attach only the preferred one.
  Midi.detachAll();
  Midi.attachListener(preferred.id, onMidiEvent);
  switchActiveDevice(preferred.name);

  txt.textContent = inputs.length === 1
    ? 'Connected: ' + preferred.name
    : inputs.length + ' devices — listening: ' + preferred.name;

  populateDeviceSelector(inputs);
}

function switchActiveDevice(name) {
  activeDeviceName = name;
  drumMapping      = loadMapping(name);
  userOffset       = loadOffset(name);
  updateOffsetDisplay();
  refreshMappingDebug();

  document.getElementById('map-warn').style.display =
    Object.keys(drumMapping).length === 0 ? 'block' : 'none';
}

function populateDeviceSelector(inputs) {
  const sel = document.getElementById('device-select');
  sel.innerHTML = '';
  inputs.forEach(i => {
    const opt = document.createElement('option');
    opt.value = i.name;
    opt.textContent = i.name;
    if (i.name === activeDeviceName) opt.selected = true;
    sel.appendChild(opt);
  });
  sel.style.display = inputs.length > 1 ? 'block' : 'none';
}

// User picked a different device from the dropdown.
function switchDevice(name) {
  if (!allMidiInputs[name]) return;
  Midi.detachAll();
  Midi.attachListener(allMidiInputs[name].id, onMidiEvent);
  switchActiveDevice(name);
  document.getElementById('stext').textContent = 'Listening: ' + name;
}

function onMidiEvent(evt) {
  if (evt.type !== 'noteOn') return;

  // Flash the signal indicator briefly
  const sig = document.getElementById('signal-flash');
  if (sig) {
    sig.style.color = '#1D9E75';
    setTimeout(() => { sig.style.color = '#1a1a26'; }, 100);
  }

  if (calOpen) { registerCalTap(); return; }

  const abstractName = lookupAbstractName(drumMapping, evt.note);
  document.getElementById('d-lastnote').textContent = evt.note;
  document.getElementById('d-lastname').textContent = abstractName || 'unmapped';

  if (alwaysSound && abstractName) playDrumSound(abstractName, evt.velocity);

  if (Clock.isPlaying() && !Clock.isPaused() && Clock.isCountoffDone()) {
    if (abstractName) checkHit(abstractName, evt.note, evt.velocity);
    else { scorer.registerWrong(); showFeedback('WRONG', 'wrong'); }
  }

  if (abstractName) laneFlash[abstractName] = performance.now();
}


// ════════════════════════════════════════════════════════════════
// HIT DETECTION
// ════════════════════════════════════════════════════════════════

function checkHit(abstractName, midiNote, vel) {
  const songTime = Clock.getSongTime();
  if (songTime < 0) return;
  const fallTimeMs = Clock.getFallTimeMs();
  const hw = Clock.getHitWindow();

  let best = null, bestDiff = Infinity;
  for (const sn of scheduledNotes) {
    if (sn.abstractName !== abstractName || sn.hit || sn.missed || !sn.spawned) continue;
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
  document.getElementById('d-lastoffset').textContent = (offset > 0 ? '+' : '') + offset + 'ms';
  const quality = bestDiff <= hw.perfect ? 'perfect'
                : bestDiff <= hw.good    ? 'good' : null;
  document.getElementById('d-lastquality').textContent = quality || 'outside window';

  if (quality) registerHitOk(best, quality, abstractName, vel);
}

function registerHitOk(sn, quality, abstractName, vel) {
  sn.hit = true;
  if (sn.block) { sn.block.hitQuality = quality; sn.block.hitTime = performance.now(); }
  laneFlash[abstractName] = performance.now();
  if (!alwaysSound) playDrumSound(abstractName, vel || 80);
  scorer.registerHit(quality);
  showFeedback(quality === 'perfect' ? 'PERFECT' : 'GOOD', quality);
}

function registerMiss(sn) {
  if (!sn.spawned) return;
  sn.missed = true;
  scorer.registerMiss();
  showFeedback('MISS', 'miss');
}

function showFeedback(text, cls) {
  const el = document.getElementById('hit-feedback');
  el.textContent = text;
  el.className   = 'hit-feedback ' + cls;
  clearTimeout(feedbackTimer);
  feedbackTimer = setTimeout(() => { el.className = 'hit-feedback hidden'; }, 500);
}


// ════════════════════════════════════════════════════════════════
// TEST PATTERNS
// ════════════════════════════════════════════════════════════════

function makePattern(name) {
  const B = BEAT_MS;
  const E = B / 2;     // 8th note
  const S = B / 4;     // 16th note
  const notes = [];

  if (name === 'rock') {
    for (let bar = 0; bar < 4; bar++) {
      const o = bar * 4 * B;
      for (let i = 0; i < 8; i++) notes.push({ abstractName: 'HH_CLOSED', startMs: o + i*E, durMs: S });
      notes.push({ abstractName: 'KICK',  startMs: o + 0*B, durMs: S });
      notes.push({ abstractName: 'KICK',  startMs: o + 2*B, durMs: S });
      notes.push({ abstractName: 'SNARE', startMs: o + 1*B, durMs: S });
      notes.push({ abstractName: 'SNARE', startMs: o + 3*B, durMs: S });
      if (bar === 0) notes.push({ abstractName: 'CRASH', startMs: 0, durMs: S });
    }
  } else if (name === 'hihat') {
    for (let bar = 0; bar < 4; bar++) {
      const o = bar * 4 * B;
      for (let i = 0; i < 8; i++) {
        const hh = i % 2 === 0 ? 'HH_CLOSED' : 'HH_OPEN';
        notes.push({ abstractName: hh, startMs: o + i*E, durMs: S });
      }
      notes.push({ abstractName: 'KICK',     startMs: o + 0*B, durMs: S });
      notes.push({ abstractName: 'KICK',     startMs: o + 2*B, durMs: S });
      notes.push({ abstractName: 'SNARE',    startMs: o + 1*B, durMs: S });
      notes.push({ abstractName: 'SNARE',    startMs: o + 3*B, durMs: S });
      notes.push({ abstractName: 'HH_PEDAL', startMs: o + 1*B, durMs: S });
      notes.push({ abstractName: 'HH_PEDAL', startMs: o + 3*B, durMs: S });
    }
  } else if (name === 'fills') {
    for (let bar = 0; bar < 3; bar++) {
      const o = bar * 4 * B;
      for (let i = 0; i < 8; i++) notes.push({ abstractName: 'HH_CLOSED', startMs: o + i*E, durMs: S });
      notes.push({ abstractName: 'KICK',  startMs: o + 0*B, durMs: S });
      notes.push({ abstractName: 'KICK',  startMs: o + 2*B, durMs: S });
      notes.push({ abstractName: 'SNARE', startMs: o + 1*B, durMs: S });
      notes.push({ abstractName: 'SNARE', startMs: o + 3*B, durMs: S });
    }
    // Bar 4 — tom fill
    const o = 3 * 4 * B;
    const tomFill = ['TOM_1','TOM_1','TOM_2','TOM_2','TOM_3','TOM_3','SNARE','SNARE'];
    tomFill.forEach((t, i) => notes.push({ abstractName: t, startMs: o + i*E, durMs: S }));
    notes.push({ abstractName: 'CRASH', startMs: o + 8*E, durMs: S });
    notes.push({ abstractName: 'KICK',  startMs: o + 8*E, durMs: S });
  }

  notes.sort((a, b) => a.startMs - b.startMs);
  return notes.map(n => ({ ...n, hit: false, missed: false, block: null, spawned: false }));
}

function loadPattern(name) {
  scheduledNotes = makePattern(name);
  songDuration   = Math.max(...scheduledNotes.map(n => n.startMs + (n.durMs || 0))) + 4000;
  scorer.reset();
  fallingBlocks = [];
  document.getElementById('start-btn').className   = 'start-btn enabled';
  document.getElementById('start-btn').textContent = 'START →';
}


// ════════════════════════════════════════════════════════════════
// SONG CONTROL
// ════════════════════════════════════════════════════════════════

function startSong() {
  if (!scheduledNotes.length) return;
  scheduledNotes.forEach(n => { n.hit = false; n.missed = false; n.block = null; n.spawned = false; });
  fallingBlocks = [];
  scorer.reset();
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
  scheduledNotes.forEach(n => { n.hit = false; n.missed = false; n.block = null; n.spawned = false; });
  fallingBlocks = [];
  scorer.reset();

  document.getElementById('start-btn').style.display = 'inline-block';
  document.getElementById('start-btn').className     = 'start-btn enabled';
  document.getElementById('start-btn').textContent   = 'START →';
  document.getElementById('btn-pause').style.display = 'none';
  document.getElementById('btn-reset').style.display = 'none';
  document.getElementById('btn-pause').textContent   = '⏸ PAUSE';
  document.getElementById('btn-pause').className     = '';
  document.getElementById('hit-feedback').className  = 'hit-feedback hidden';
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
// DEBUG PANEL
// ════════════════════════════════════════════════════════════════

function updateOffsetDisplay() {
  const el = document.getElementById('d-offset');
  if (el) el.textContent = (userOffset > 0 ? '+' : '') + userOffset + 'ms';
}

function refreshMappingDebug() {
  document.getElementById('d-mapcount').textContent = Object.keys(drumMapping).length;
  const list = document.getElementById('d-maplist');
  if (Object.keys(drumMapping).length === 0) {
    list.innerHTML = '<span style="color:#E24B4A;">no mapping — open mapping tool →</span>';
    return;
  }
  list.innerHTML = Object.entries(drumMapping)
    .map(([note, name]) => `<span style="color:#444;">note ${note}</span> → <span style="color:#1D9E75;">${name}</span>`)
    .join('<br>');
}

function reloadMapping() {
  drumMapping = loadMapping(activeDeviceName);
  refreshMappingDebug();
  document.getElementById('map-warn').style.display =
    Object.keys(drumMapping).length === 0 ? 'block' : 'none';
}

function updateDebug() {
  const songTime = Clock.getSongTime();
  const hw       = Clock.getHitWindow();
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
  set('d-state',    stateStr, Clock.isCountoffActive() ? 'warn' : null);
  set('d-songtime', songTime >= 0 ? songTime.toFixed(0) + 'ms' : '—');
  set('d-falltime', Clock.getFallTimeMs() + 'ms');
  set('d-speed',    Clock.getSpeedLevel() + ' (' + (Clock.getFallTimeMs() / 1000).toFixed(1) + 's)');
  set('d-window',   hw.name + ' ±' + hw.perfect + '/' + hw.good + 'ms');
  set('d-blocks',   fallingBlocks.length + ' / ' + scheduledNotes.filter(n => n.spawned).length);

  const s = scorer.getStats();
  set('d-perfect', s.perfect);
  set('d-good',    s.good);
  set('d-miss',    s.miss,  s.miss  > 0 ? 'bad'  : 'neutral');
  set('d-wrong',   s.wrong, s.wrong > 0 ? 'warn' : 'neutral');
  set('d-combo',   s.combo, 'purple');
  set('d-acc',     s.accuracy !== null ? s.accuracy + '%' : '—');
}


// ════════════════════════════════════════════════════════════════
// DRAW
// ════════════════════════════════════════════════════════════════

function drawHighway() {
  // Lane backgrounds
  ctx.fillStyle = '#0d0d14';
  ctx.fillRect(0, 0, CANVAS_W, HIGHWAY_H);
  LANES.forEach((lane, i) => {
    ctx.fillStyle = i % 2 === 0 ? '#0d0d14' : '#0f0f18';
    ctx.fillRect(i * LANE_W, 0, LANE_W, HIGHWAY_H);
    ctx.strokeStyle = '#1a1a24'; ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(i * LANE_W, 0);
    ctx.lineTo(i * LANE_W, HIGHWAY_H);
    ctx.stroke();
  });

  // Hit line
  ctx.fillStyle = 'rgba(29,158,117,0.4)';
  ctx.fillRect(0, HIT_Y, CANVAS_W, 3);

  // Falling blocks
  const now = performance.now();
  fallingBlocks.forEach(block => {
    const lane = LANES[block.laneIndex];
    let fill   = lane.color;
    let stroke = lane.stroke;
    let alpha  = 0.9;
    if (block.hitQuality) {
      const age = now - block.hitTime;
      if (age < 200) {
        fill   = '#1D9E75';
        stroke = '#5DCAA5';
        alpha  = 1 - (age / 200) * 0.5;
      }
    }
    ctx.globalAlpha = alpha;
    if (block.isKick) {
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.roundRect(block.x - LANE_W * 0.4, block.y - KICK_H / 2, LANE_W * 0.8, KICK_H, 3);
      ctx.fill();
      ctx.strokeStyle = stroke; ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.roundRect(block.x - LANE_W * 0.4, block.y - KICK_H / 2, LANE_W * 0.8, KICK_H, 3);
      ctx.stroke();
    } else {
      ctx.fillStyle = fill;
      ctx.beginPath(); ctx.arc(block.x, block.y, NOTE_R, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = stroke; ctx.lineWidth = 0.5;
      ctx.beginPath(); ctx.arc(block.x, block.y, NOTE_R, 0, Math.PI * 2); ctx.stroke();
      // Shine
      ctx.fillStyle = 'rgba(255,255,255,0.15)';
      ctx.beginPath(); ctx.arc(block.x - 3, block.y - 3, NOTE_R * 0.4, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  });

  // Hit zone label
  ctx.fillStyle = 'rgba(29,158,117,0.3)';
  ctx.font = '9px Segoe UI'; ctx.textAlign = 'left';
  ctx.fillText('HIT ZONE', 4, HIT_Y - 4);

  // Lane labels + flash indicator
  ctx.fillStyle = '#0a0a0f';
  ctx.fillRect(0, HIGHWAY_H, CANVAS_W, 48);
  ctx.strokeStyle = '#1a1a26'; ctx.lineWidth = 0.5;
  ctx.beginPath(); ctx.moveTo(0, HIGHWAY_H); ctx.lineTo(CANVAS_W, HIGHWAY_H); ctx.stroke();

  LANES.forEach((lane, i) => {
    const cx       = laneX(i);
    const flashAge = laneFlash[lane.name] ? now - laneFlash[lane.name] : Infinity;
    const flashing = flashAge < 120;

    // Lane indicator dot
    ctx.fillStyle = flashing ? lane.color : '#1a1a26';
    ctx.beginPath(); ctx.arc(cx, HIGHWAY_H + 10, 5, 0, Math.PI * 2); ctx.fill();

    // Lane label
    const lines = lane.label.split('\n');
    ctx.fillStyle = flashing ? lane.stroke : '#444';
    ctx.font = '8px Segoe UI'; ctx.textAlign = 'center';
    lines.forEach((line, li) => {
      ctx.fillText(line, cx, HIGHWAY_H + 24 + li * 11);
    });

    ctx.strokeStyle = '#1a1a26'; ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(i * LANE_W, HIGHWAY_H);
    ctx.lineTo(i * LANE_W, HIGHWAY_H + 48);
    ctx.stroke();
  });
}

function drawCountoff(beatNum, beatProgress) {
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(0, 0, CANVAS_W, HIGHWAY_H);
  const beatStr = beatNum <= COUNTOFF_BEATS ? String(beatNum) : 'GO!';
  const scale   = 1 - beatProgress * 0.2;

  ctx.save();
  ctx.translate(CANVAS_W / 2, HIGHWAY_H / 2);
  ctx.scale(scale, scale);
  ctx.fillStyle = beatNum <= COUNTOFF_BEATS ? '#04342C' : '#085041';
  ctx.font = '500 90px Segoe UI'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(beatStr, 2, 2);
  ctx.fillStyle = beatNum <= COUNTOFF_BEATS ? '#1D9E75' : '#5DCAA5';
  ctx.font = '500 86px Segoe UI';
  ctx.fillText(beatStr, 0, 0);
  ctx.restore();

  for (let i = 0; i < COUNTOFF_BEATS; i++) {
    ctx.beginPath();
    ctx.arc(CANVAS_W / 2 - ((COUNTOFF_BEATS - 1) / 2) * 24 + i * 24, HIGHWAY_H - 24, 5, 0, Math.PI * 2);
    ctx.fillStyle = i < beatNum ? '#1D9E75' : '#1a1a26';
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
        const li = laneIndex(sn.abstractName);
        if (li < 0) continue;
        const block = {
          x: laneX(li), y: 0,
          laneIndex: li,
          isKick:    sn.abstractName === 'KICK',
          hitQuality: null, hitTime: null,
        };
        sn.block   = block;
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
    fallingBlocks = fallingBlocks.filter(b => b.y < HIGHWAY_H + 20);

    // Count-off metronome click (drums only — piano is silent during count-off)
    if (Clock.justCrossedBeat()) playClick();

    // Tick count-off (auto-ends itself) and capture state for render
    const countoffState = Clock.tickCountoff();

    // Song end
    if (Clock.isCountoffDone() && songTime > songDuration) {
      Clock.stopSong();
      showSongComplete();
    }

    drawHighway();
    if (countoffState) drawCountoff(countoffState.beatNum, countoffState.beatProgress);

  } else {
    drawHighway();
  }

  updateDebug();
  requestAnimationFrame(update);
}


// ════════════════════════════════════════════════════════════════
// CALIBRATION OVERLAY
// ════════════════════════════════════════════════════════════════

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
  document.getElementById('cal-instruction').innerHTML = 'Hit any drum pad in time with each flash.<br>Keep going until the round ends.';
  document.getElementById('cal-tap-count').textContent  = '';

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
    if (label)  label.textContent = 'HIT';
    setTimeout(() => {
      const c = document.getElementById('cal-circle');
      if (c) c.classList.remove('flash');
    }, CAL_FLASH_MS);
  }

  document.getElementById('cal-tap-count').textContent =
    calTaps.length > 0 ? calTaps.length + ' hits recorded' : 'waiting for hits…';

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
      (result.avg !== null ? (result.avg > 0 ? '+' : '') + result.avg + 'ms' : 'not enough hits') +
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
      `<div class="rr-taps">${r.taps} hits</div>`;
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

document.getElementById('btn-pattern-rock')  .addEventListener('click', () => loadPattern('rock'));
document.getElementById('btn-pattern-hihat') .addEventListener('click', () => loadPattern('hihat'));
document.getElementById('btn-pattern-fills') .addEventListener('click', () => loadPattern('fills'));

document.getElementById('start-btn').addEventListener('click', startSong);
document.getElementById('btn-pause').addEventListener('click', togglePause);
document.getElementById('btn-reset').addEventListener('click', resetSong);
document.getElementById('btn-cal')  .addEventListener('click', openCal);

document.getElementById('device-select').addEventListener('change', e => switchDevice(e.target.value));

document.getElementById('speed') .addEventListener('input', e => updateSpeedUI(parseInt(e.target.value)));
document.getElementById('hitwin').addEventListener('input', e => updateHitWindowUI(parseInt(e.target.value)));
document.getElementById('sound-toggle').addEventListener('click', toggleAlwaysSound);

document.getElementById('btn-open-mapping')   .addEventListener('click', () => window.open('drum_monitor.html'));
document.getElementById('btn-reload-mapping') .addEventListener('click', reloadMapping);

document.getElementById('cal-nudge-m10').addEventListener('click', () => nudgeOffset(-10));
document.getElementById('cal-nudge-m1') .addEventListener('click', () => nudgeOffset(-1));
document.getElementById('cal-nudge-p1') .addEventListener('click', () => nudgeOffset(+1));
document.getElementById('cal-nudge-p10').addEventListener('click', () => nudgeOffset(+10));
document.getElementById('cal-cancel')   .addEventListener('click', closeCal);
document.getElementById('cal-apply')    .addEventListener('click', applyOffset);

document.addEventListener('keydown', e => {
  if (e.code === 'Space')  { e.preventDefault(); if (!calOpen) togglePause(); }
  if (e.code === 'KeyR')   { if (!calOpen) resetSong(); }
  if (e.code === 'KeyC')   { if (!calOpen) openCal(); }
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
