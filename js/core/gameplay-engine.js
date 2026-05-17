// ════════════════════════════════════════════════════════════════════
// BandSync — Gameplay Engine
// ════════════════════════════════════════════════════════════════════
// Pure, reusable gameplay engine. Takes a config + callbacks; owns the
// game loop, MIDI routing, hit detection, scoring, and rendering. Knows
// nothing about which page hosts it (2player.html, play.html) — the
// caller provides canvases and reacts to callbacks.
//
// Designed for 1 to N players. Multiple players can share a MIDI device
// (engine multiplexes one input listener to all matching players).
// Multiple players can share a track (they get the same notes array).
//
// Usage:
//   const gp = createGameplay({
//     players: [{
//       id, color, instrument, canvas, notes, deviceId,
//       drumMapping, userOffset, pianoOpts,
//     }, ...],
//     speedLevel:      3,
//     hitWindowLevel:  4,
//     alwaysSound:     true,
//     callbacks: {
//       onScoreUpdate:  (idx, stats) => {},
//       onFeedback:     (idx, text, cls) => {},
//       onCountoff:     (countoff) => {},
//       onSongComplete: () => {},
//     },
//   });
//   gp.start();
//   // ... later
//   gp.destroy();
//
// The `Clock` module is a singleton — only one gameplay can run at a
// time. Always call destroy() when leaving the screen.
// ════════════════════════════════════════════════════════════════════

import {
  HIGHWAY_H, PIANO_NOTE_MIN, PIANO_NOTE_MAX,
  DEFAULT_SPEED_LEVEL, DEFAULT_HIT_WINDOW_LEVEL,
} from '../config.js';

import * as Clock                    from './timing.js';
import { playPianoNote, playDrumSound, playClick } from './audio.js';
import { createScorer }              from './scoring.js';
import * as Midi                     from './midi.js';
import { lookupAbstractName }        from './drum-mapping.js';
import { createPianoRenderer }       from '../render/piano.js';
import { createDrumRenderer }        from '../render/drums.js';

const DEFAULT_VEL = 80;

export function createGameplay(config) {
  const callbacks = config.callbacks ?? {};
  let alwaysSound = config.alwaysSound ?? true;

  // ── PER-PLAYER STATE ───────────────────────────────────────────
  const players = config.players.map((pc, idx) => {
    const player = {
      idx,
      config:          pc,
      scorer:          createScorer(),
      scheduledNotes: prepareNotes(pc.notes ?? []),
      fallingBlocks:   [],
      heldNotes:       new Set(),
      laneFlash:       {},
      feedbackTimer:   null,
      renderer:        null,
    };

    if (pc.instrument === 'piano') {
      const opts = pc.pianoOpts ?? {};
      player.renderer = createPianoRenderer(pc.canvas, {
        noteMin:   opts.noteMin ?? PIANO_NOTE_MIN,
        noteMax:   opts.noteMax ?? PIANO_NOTE_MAX,
        color:     pc.color,
        onKeyDown: note => dispatch(player, { type: 'noteOn',  note, velocity: DEFAULT_VEL }),
        onKeyUp:   note => dispatch(player, { type: 'noteOff', note, velocity: 0 }),
      });
    } else if (pc.instrument === 'drums') {
      player.renderer = createDrumRenderer(pc.canvas, {
        color:       pc.color,
        onLaneClick: abstractName => {
          // Mouse clicks on drum lanes send an abstract-name "hit" — we
          // synthesise a fake MIDI event that the dispatcher will
          // translate via the drum mapping. But mouse clicks don't carry
          // a MIDI note number, so we go through a dedicated path that
          // skips the mapping lookup.
          handleDrumHit(player, abstractName, DEFAULT_VEL);
        },
      });
    } else {
      throw new Error(`createGameplay: unknown instrument "${pc.instrument}" for player ${idx}`);
    }
    return player;
  });

  // ── SONG DURATION ──────────────────────────────────────────────
  // Last note's end time across all players, plus a 4s tail so the
  // final notes don't get clipped by an early stop.
  const songDurationMs = (() => {
    const ends = players.flatMap(p =>
      p.scheduledNotes.map(n => n.startMs + (n.durMs ?? 0))
    );
    return Math.max(0, ...ends) + 4000;
  })();

  // ── CLOCK SETTINGS ─────────────────────────────────────────────
  Clock.setSpeedLevel(config.speedLevel ?? DEFAULT_SPEED_LEVEL);
  Clock.setHitWindowLevel(config.hitWindowLevel ?? DEFAULT_HIT_WINDOW_LEVEL);

  // ── MIDI ROUTING ───────────────────────────────────────────────
  // Group players by deviceId so a shared device fans out to all of
  // them in one listener (matches existing 2player "shared device"
  // behaviour).
  const midiTeardown = [];
  {
    const byDevice = new Map();
    for (const p of players) {
      const id = p.config.deviceId;
      if (!id) continue;
      if (!byDevice.has(id)) byDevice.set(id, []);
      byDevice.get(id).push(p);
    }
    for (const [deviceId, group] of byDevice) {
      const attached = Midi.attachListener(deviceId, evt => {
        for (const p of group) dispatch(p, evt);
      });
      if (attached) midiTeardown.push(() => Midi.detachListener(deviceId));
    }
  }

  // ── INPUT DISPATCH ─────────────────────────────────────────────
  function dispatch(player, evt) {
    if (player.config.instrument === 'piano') {
      if (evt.type === 'noteOff') { player.heldNotes.delete(evt.note); return; }
      if (evt.type !== 'noteOn')   return;
      player.heldNotes.add(evt.note);
      if (alwaysSound) playPianoNote(evt.note, evt.velocity);
      if (Clock.isPlaying() && !Clock.isPaused() && Clock.isCountoffDone()) {
        if (!alwaysSound) playPianoNote(evt.note, evt.velocity);
        checkHitPiano(player, evt.note);
      }
      return;
    }
    // drums — translate MIDI note number to abstract name
    if (evt.type !== 'noteOn') return;
    const abstractName = lookupAbstractName(player.config.drumMapping ?? {}, evt.note);
    if (!abstractName) {
      // Unmapped pad while song is playing = WRONG; otherwise silent.
      if (Clock.isPlaying() && !Clock.isPaused() && Clock.isCountoffDone()) {
        player.scorer.registerWrong();
        emitFeedback(player, 'WRONG', 'wrong');
      }
      return;
    }
    handleDrumHit(player, abstractName, evt.velocity);
  }

  function handleDrumHit(player, abstractName, velocity) {
    player.laneFlash[abstractName] = performance.now();
    if (alwaysSound) playDrumSound(abstractName, velocity);
    if (Clock.isPlaying() && !Clock.isPaused() && Clock.isCountoffDone()) {
      if (!alwaysSound) playDrumSound(abstractName, velocity);
      checkHitDrums(player, abstractName, velocity);
    }
  }

  // ── HIT DETECTION ──────────────────────────────────────────────
  function checkHitPiano(player, note) {
    const songTime = Clock.getSongTime();
    if (songTime < 0) return;
    const fallTimeMs = Clock.getFallTimeMs();
    const hw         = Clock.getHitWindow();
    const offset     = player.config.userOffset ?? 0;

    let best = null, bestDiff = Infinity;
    for (const sn of player.scheduledNotes) {
      if (sn.note !== note || sn.hit || sn.missed || !sn.spawned) continue;
      const expected = sn.startMs + fallTimeMs + offset;
      const diff = Math.abs(songTime - expected);
      if (diff < bestDiff) { bestDiff = diff; best = sn; }
    }

    if (!best) {
      player.scorer.registerWrong();
      emitFeedback(player, 'WRONG', 'wrong');
      return;
    }

    const quality = bestDiff <= hw.perfect ? 'perfect'
                  : bestDiff <= hw.good    ? 'good' : null;
    if (!quality) return;

    best.hit = true;
    if (best.block) { best.block.hitQuality = quality; best.block.hitTime = performance.now(); }
    playPianoNote(best.note, best.vel ?? DEFAULT_VEL);
    player.scorer.registerHit(quality);
    emitFeedback(player, quality === 'perfect' ? 'PERFECT' : 'GOOD', quality);
  }

  function checkHitDrums(player, abstractName, velocity) {
    const songTime = Clock.getSongTime();
    if (songTime < 0) return;
    const fallTimeMs = Clock.getFallTimeMs();
    const hw         = Clock.getHitWindow();
    const offset     = player.config.userOffset ?? 0;

    let best = null, bestDiff = Infinity;
    for (const sn of player.scheduledNotes) {
      if (sn.abstractName !== abstractName || sn.hit || sn.missed || !sn.spawned) continue;
      const expected = sn.startMs + fallTimeMs + offset;
      const diff = Math.abs(songTime - expected);
      if (diff < bestDiff) { bestDiff = diff; best = sn; }
    }

    if (!best) {
      player.scorer.registerWrong();
      emitFeedback(player, 'WRONG', 'wrong');
      return;
    }

    const quality = bestDiff <= hw.perfect ? 'perfect'
                  : bestDiff <= hw.good    ? 'good' : null;
    if (!quality) return;

    best.hit = true;
    if (best.block) { best.block.hitQuality = quality; best.block.hitTime = performance.now(); }
    player.scorer.registerHit(quality);
    emitFeedback(player, quality === 'perfect' ? 'PERFECT' : 'GOOD', quality);
  }

  function registerMiss(player, sn) {
    if (!sn.spawned) return;
    sn.missed = true;
    player.scorer.registerMiss();
    emitFeedback(player, 'MISS', 'miss');
  }

  // ── BLOCK SPAWNING ─────────────────────────────────────────────
  function spawnPianoBlocks(player, songTime) {
    for (const sn of player.scheduledNotes) {
      if (sn.hit || sn.missed || sn.block) continue;
      if (songTime < sn.startMs) continue;
      if (!player.renderer.noteInRange(sn.note)) { sn.missed = true; continue; }
      const cx = player.renderer.noteToX(sn.note);
      const nw = player.renderer.noteWidth(sn.note);
      const nh = player.renderer.blockHeight(sn.note);
      const block = {
        x: cx - nw / 2, y: 0, w: nw, h: nh,
        note: sn.note, black: player.renderer.isBlack(sn.note),
        hitQuality: null, hitTime: null,
      };
      sn.block = block;
      sn.spawned = true;
      player.fallingBlocks.push(block);
    }
  }

  function spawnDrumBlocks(player, songTime) {
    for (const sn of player.scheduledNotes) {
      if (sn.hit || sn.missed || sn.block) continue;
      if (songTime < sn.startMs) continue;
      if (!player.renderer.isValidLane(sn.abstractName)) { sn.missed = true; continue; }
      const block = {
        x: player.renderer.laneX(sn.abstractName), y: 0,
        laneIndex: player.renderer.laneIndex(sn.abstractName),
        isKick:    player.renderer.isKick(sn.abstractName),
        hitQuality: null, hitTime: null,
      };
      sn.block = block;
      sn.spawned = true;
      player.fallingBlocks.push(block);
    }
  }

  // ── CALLBACKS ──────────────────────────────────────────────────
  function emitFeedback(player, text, cls) {
    callbacks.onFeedback?.(player.idx, text, cls);
  }
  function emitScoreUpdate() {
    if (!callbacks.onScoreUpdate) return;
    for (const p of players) callbacks.onScoreUpdate(p.idx, p.scorer.getStats());
  }

  // ── GAME LOOP ──────────────────────────────────────────────────
  let rafId       = null;
  let lastFrame   = 0;
  let songEnded   = false;

  function loop(timestamp) {
    if (rafId === null) return;   // destroyed
    if (!lastFrame) lastFrame = timestamp;
    const delta = timestamp - lastFrame;
    lastFrame = timestamp;
    const pxPerFrame = Clock.getPxPerFrame();

    let countoff = null;

    if (Clock.isPlaying() && !Clock.isPaused()) {
      const songTime   = Clock.getSongTime();
      const fallTimeMs = Clock.getFallTimeMs();
      const hw         = Clock.getHitWindow();

      for (const p of players) {
        if (p.config.instrument === 'piano') spawnPianoBlocks(p, songTime);
        else                                  spawnDrumBlocks(p, songTime);

        p.fallingBlocks.forEach(b => { b.y += pxPerFrame * (delta / 16.67); });

        for (const sn of p.scheduledNotes) {
          if (sn.hit || sn.missed || !sn.spawned) continue;
          if (songTime - (sn.startMs + fallTimeMs) > hw.good) registerMiss(p, sn);
        }
        p.fallingBlocks = p.fallingBlocks.filter(b =>
          p.config.instrument === 'piano' ? b.y < HIGHWAY_H + b.h : b.y < HIGHWAY_H + 20
        );
      }

      if (Clock.justCrossedBeat()) playClick();
      countoff = Clock.tickCountoff();
      callbacks.onCountoff?.(countoff);

      if (!songEnded && Clock.isCountoffDone() && songTime > songDurationMs) {
        songEnded = true;
        Clock.stopSong();
        callbacks.onSongComplete?.();
      }
    }

    drawAll(countoff);
    emitScoreUpdate();
    rafId = requestAnimationFrame(loop);
  }

  function drawAll(countoff) {
    for (const p of players) {
      if (p.config.instrument === 'piano') {
        p.renderer.draw({ fallingBlocks: p.fallingBlocks, heldNotes: p.heldNotes, countoff });
      } else {
        p.renderer.draw({ fallingBlocks: p.fallingBlocks, laneFlash: p.laneFlash, countoff });
      }
    }
  }

  // ── LIFECYCLE ──────────────────────────────────────────────────
  // Options are forwarded to Clock.startSong(). The notable one is
  // `countoffStartsAt: <performance.now() timestamp>` for synchronized
  // starts across remote players — see Clock.startSong() docs.
  function start(options) {
    if (Clock.isPlaying()) return;
    resetState();
    songEnded = false;
    Clock.startSong(options);
    if (rafId === null) rafId = requestAnimationFrame(loop);
  }

  function pause()        { /* no-op; togglePause toggles */ }
  function togglePause()  { return Clock.isPlaying() ? Clock.togglePause() : false; }

  function reset() {
    Clock.stopSong();
    resetState();
    songEnded = false;
  }

  function resetState() {
    for (const p of players) {
      p.scheduledNotes.forEach(n => { n.hit = false; n.missed = false; n.block = null; n.spawned = false; });
      p.fallingBlocks = [];
      p.scorer.reset();
      p.heldNotes.clear();
      p.laneFlash = {};
    }
  }

  function destroy() {
    if (rafId !== null) { cancelAnimationFrame(rafId); }
    rafId = null;
    Clock.stopSong();
    for (const td of midiTeardown) td();
    for (const p of players) clearTimeout(p.feedbackTimer);
  }

  // Kick off the render loop so the countoff-pending highway shows up
  // immediately (renderer needs a draw before start() is called).
  rafId = requestAnimationFrame(loop);

  // ── PUBLIC API ─────────────────────────────────────────────────
  return {
    start, pause, togglePause, reset, destroy,
    getStats:        idx => players[idx]?.scorer.getStats(),
    getSongTime:     () => Clock.getSongTime(),
    getSongDuration: () => songDurationMs,
    isPlaying:       () => Clock.isPlaying(),
    isPaused:        () => Clock.isPaused(),
    isCountoffDone:  () => Clock.isCountoffDone(),
    setAlwaysSound:  v => { alwaysSound = !!v; },
    setSpeedLevel:   l => Clock.setSpeedLevel(l),
    setHitWindowLevel: l => Clock.setHitWindowLevel(l),
  };
}

// ── PRIVATE HELPERS ──────────────────────────────────────────────

// Defensive copy + add per-note runtime fields (hit/missed/block/spawned).
// We never mutate the caller's note objects.
function prepareNotes(notes) {
  return notes.map(n => ({
    ...n,
    hit: false, missed: false, block: null, spawned: false,
  }));
}
