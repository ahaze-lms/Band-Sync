// ════════════════════════════════════════════════════════════════════
// BandSync — Drum Debug Screen
// ════════════════════════════════════════════════════════════════════
// Standalone drum debug tool. Composes shared engine + renderer
// modules with a debug-panel HUD + multi-device dropdown.
// ════════════════════════════════════════════════════════════════════

import {
  HIGHWAY_H,
  BEAT_MS,
  CAL_ROUNDS, CAL_ROUND_MS, CAL_BEAT_MS, CAL_FLASH_MS,
  DEFAULT_SPEED_LEVEL, DEFAULT_HIT_WINDOW_LEVEL,
  PLAYER_COLORS,
} from '../js/config.js';

import * as Clock from '../js/core/timing.js';
import { playDrumSound, playClick } from '../js/core/audio.js';
import { createScorer } from '../js/core/scoring.js';
import * as Midi from '../js/core/midi.js';
import { loadOffset, saveOffset, calcRoundOffset } from '../js/core/calibration.js';
import { loadMapping, hasMapping, lookupAbstractName } from '../js/core/drum-mapping.js';
import { createDrumRenderer } from '../js/render/drums.js';


// ════════════════════════════════════════════════════════════════
// RENDERER
// ════════════════════════════════════════════════════════════════

const drums = createDrumRenderer(
  document.getElementById('highway'),
  {
    color:       PLAYER_COLORS[1], // teal
    onLaneClick: handleLaneClick,
  },
);


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
let allMidiInputs    = {};        // { name: { id, name, port } } for the dropdown
let alwaysSound      = true;
let feedbackTimer    = null;
let lastTime         = 0;
const laneFlash      = {};        // { abstractName: timestamp }


// ════════════════════════════════════════════════════════════════
// LANE CLICK (from renderer) — simulate a hit on that drum
// ════════════════════════════════════════════════════════════════

function handleLaneClick(abstractName) {
  if (calOpen) { registerCalTap(); return; }
  laneFlash[abstractName] = performance.now();
  if (alwaysSound) playDrumSound(abstractName, 80);
  document.getElementById('d-lastnote').textContent = '(click)';
  document.getElementById('d-lastname').textContent = abstractName;
  if (Clock.isPlaying() && !Clock.isPaused() && Clock.isCountoffDone()) {
    checkHit(abstractName, null, 80);
  }
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

  rescanInputs();
  Midi.onStateChange(() => rescanInputs());
}

function rescanInputs() {
  const dot    = document.getElementById('sdot');
  const txt    = document.getElementById('stext');
  const inputs = Midi.getInputs();

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

  // Prefer a device that already has a saved drum mapping
  const preferred = inputs.find(i => hasMapping(i.name)) || inputs[0];

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

function switchDevice(name) {
  if (!allMidiInputs[name]) return;
  Midi.detachAll();
  Midi.attachListener(allMidiInputs[name].id, onMidiEvent);
  switchActiveDevice(name);
  document.getElementById('stext').textContent = 'Listening: ' + name;
}

function onMidiEvent(evt) {
  if (evt.type !== 'noteOn') return;

  // Flash signal indicator
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
  const E = B / 2;
  const S = B / 4;
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

    // Spawn blocks
    for (const sn of scheduledNotes) {
      if (sn.hit || sn.missed || sn.block) continue;
      if (songTime >= sn.startMs) {
        if (!drums.isValidLane(sn.abstractName)) continue;
        const li = drums.laneIndex(sn.abstractName);
        const block = {
          x: drums.laneX(sn.abstractName), y: 0,
          laneIndex: li,
          isKick:    drums.isKick(sn.abstractName),
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

    // Cleanup
    fallingBlocks = fallingBlocks.filter(b => b.y < HIGHWAY_H + 20);

    // Count-off click (drums plays audible click each beat)
    if (Clock.justCrossedBeat()) playClick();
    const countoff = Clock.tickCountoff();

    // Song end
    if (Clock.isCountoffDone() && songTime > songDuration) {
      Clock.stopSong();
      showSongComplete();
    }

    drums.draw({ fallingBlocks, laneFlash, countoff });
  } else {
    drums.draw({ fallingBlocks, laneFlash });
  }

  updateDebug();
  requestAnimationFrame(update);
}


// ════════════════════════════════════════════════════════════════
// CALIBRATION OVERLAY (same pattern as piano_debug)
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
  document.getElementById('cal-instruction').innerHTML     = 'Hit any drum pad in time with each flash.<br>Keep going until the round ends.';
  document.getElementById('cal-tap-count').textContent     = '';

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

document.getElementById('btn-pattern-rock') .addEventListener('click', () => loadPattern('rock'));
document.getElementById('btn-pattern-hihat').addEventListener('click', () => loadPattern('hihat'));
document.getElementById('btn-pattern-fills').addEventListener('click', () => loadPattern('fills'));

document.getElementById('start-btn').addEventListener('click', startSong);
document.getElementById('btn-pause').addEventListener('click', togglePause);
document.getElementById('btn-reset').addEventListener('click', resetSong);
document.getElementById('btn-cal')  .addEventListener('click', openCal);

document.getElementById('device-select').addEventListener('change', e => switchDevice(e.target.value));

document.getElementById('speed') .addEventListener('input', e => updateSpeedUI(parseInt(e.target.value)));
document.getElementById('hitwin').addEventListener('input', e => updateHitWindowUI(parseInt(e.target.value)));
document.getElementById('sound-toggle').addEventListener('click', toggleAlwaysSound);

document.getElementById('btn-open-mapping')  .addEventListener('click', () => window.open('drum_monitor.html'));
document.getElementById('btn-reload-mapping').addEventListener('click', reloadMapping);

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
