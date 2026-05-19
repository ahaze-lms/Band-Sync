// ════════════════════════════════════════════════════════════════════
// BandSync — Piano Renderer
// ════════════════════════════════════════════════════════════════════
// Reusable piano view. Owns its canvas dimensions and drawing; the
// caller owns gameplay state (falling blocks, held notes, count-off
// status) and passes it in per frame.
//
// One renderer = one canvas = one player. Two-player gameplay creates
// two renderers with different colors.
//
// Usage:
//   import { createPianoRenderer } from '../js/render/piano.js';
//
//   const piano = createPianoRenderer(canvasEl, {
//     noteMin: 48,                  // optional, defaults to PIANO_NOTE_MIN
//     noteMax: 84,                  // optional, defaults to PIANO_NOTE_MAX
//     color:   PLAYER_COLORS[0],    // optional, defaults to P1 palette
//     onKeyDown: midiNote => { ... },
//     onKeyUp:   midiNote => { ... },
//   });
//
//   // In the game loop:
//   piano.draw({ fallingBlocks, heldNotes, countoff });
//
//   // Helpers the game loop needs:
//   piano.noteToX(midiNote)    → x coord on canvas
//   piano.noteWidth(midiNote)  → block width for a falling note
//   piano.isBlack(midiNote)    → bool
//   piano.noteInRange(midiNote)
// ════════════════════════════════════════════════════════════════════

import {
  PIANO_NOTE_MIN, PIANO_NOTE_MAX, NOTE_NAMES, KEY_PATTERN,
  HIGHWAY_H, HIT_Y, PREVIEW_ZONE,
  COUNTOFF_BEATS,
  PLAYER_COLORS,
} from '../config.js';


// ── Layout constants (internal to this renderer) ────────────────
const WHITE_KEY_W = 22, WHITE_KEY_H = 72;
const BLACK_KEY_W = 14, BLACK_KEY_H = 44;

// "Go!" color always uses the teal/success palette regardless of the
// player's accent — it's a universal "song starts now" signal.
const GO_SHADOW = '#085041';
const GO_FILL   = '#9FE1CB';

// Hit-success flash color (notes turn green briefly when scored)
const HIT_PERFECT_FILL   = '#1D9E75';
const HIT_GOOD_FILL      = '#5DCAA5';
const HIT_FLASH_STROKE   = '#9FE1CB';
const HIT_FLASH_DURATION = 250;


// ── Pure helpers ────────────────────────────────────────────────
export const midiToName = n => NOTE_NAMES[n % 12] + Math.floor(n / 12 - 1);
export const isBlackKey = n => KEY_PATTERN[n % 12] === 1;


// ════════════════════════════════════════════════════════════════
// FACTORY
// ════════════════════════════════════════════════════════════════

export function createPianoRenderer(canvas, options = {}) {
  const {
    noteMin    = PIANO_NOTE_MIN,
    noteMax    = PIANO_NOTE_MAX,
    color      = PLAYER_COLORS[0],
    onKeyDown  = null,
    onKeyUp    = null,
    // Optional per-note labels drawn on each falling block. Both functions
    // take a MIDI note number and return a string (or null to skip).
    //   blockLabel — primary, drawn centred. Usually the note name ("C", "F#")
    //                so players passively learn note recognition.
    //   blockHint  — secondary, drawn smaller at the bottom of the block.
    //                Usually the QWERTY key for keyboard-input players ("Z").
    blockLabel = null,
    blockHint  = null,
  } = options;

  // ── Build keyboard layout ─────────────────────────────────────
  const whiteKeys = [];
  for (let n = noteMin; n <= noteMax; n++) {
    if (!isBlackKey(n)) whiteKeys.push(n);
  }
  const CANVAS_W = whiteKeys.length * WHITE_KEY_W;
  const CANVAS_H = HIGHWAY_H + WHITE_KEY_H;

  const noteXCenter = {};
  for (let i = 0; i < whiteKeys.length; i++) {
    noteXCenter[whiteKeys[i]] = i * WHITE_KEY_W + WHITE_KEY_W / 2;
  }
  for (let n = noteMin; n <= noteMax; n++) {
    if (isBlackKey(n)) {
      const L = noteXCenter[n - 1], R = noteXCenter[n + 1];
      if (L != null && R != null) noteXCenter[n] = (L + R) / 2;
    }
  }

  const noteWidthFor = n => isBlackKey(n) ? BLACK_KEY_W * 0.85 : WHITE_KEY_W * 0.8;

  // ── Bind canvas ───────────────────────────────────────────────
  // The pixel buffer is sized dynamically to match the actual CSS
  // display size × devicePixelRatio — see syncBufferToDisplay() below.
  // Initial dimensions are a sane fallback for the first paint before
  // ResizeObserver fires; drawing code always works in logical coords
  // (CANVAS_W × CANVAS_H) and the per-frame ctx.setTransform handles
  // the mapping to actual pixels.
  canvas.width  = CANVAS_W;
  canvas.height = CANVAS_H;
  const ctx = canvas.getContext('2d');

  // Keep the canvas pixel buffer matched to its CSS display size × DPR.
  // This is the difference between a crisp keyboard at any screen size
  // and the bilinear-blur fuzz you get when a small buffer is stretched
  // by CSS. Cheap — no-op when dimensions haven't changed.
  function syncBufferToDisplay() {
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const w   = Math.max(1, Math.round(rect.width  * dpr));
    const h   = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width === w && canvas.height === h) return;
    canvas.width  = w;
    canvas.height = h;
  }

  // ResizeObserver fires whenever the canvas's CSS box changes
  // (window resize, panel layout change, mobile rotation, etc).
  // Setting canvas.width/.height inside doesn't re-trigger this
  // observer because it watches box size, not buffer size.
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(syncBufferToDisplay).observe(canvas);
  }

  // ── Click detection rects (for mouse → key) ───────────────────
  const whiteKeyRects = whiteKeys.map((note, i) => ({
    note, x: i * WHITE_KEY_W + 1, y: HIGHWAY_H + 1, w: WHITE_KEY_W - 2, h: WHITE_KEY_H - 4,
  }));
  const blackKeyRects = [];
  for (let n = noteMin; n <= noteMax; n++) {
    if (!isBlackKey(n)) continue;
    const cx = noteXCenter[n];
    if (cx == null) continue;
    blackKeyRects.push({ note: n, x: cx - BLACK_KEY_W / 2, y: HIGHWAY_H, w: BLACK_KEY_W, h: BLACK_KEY_H });
  }

  const mouseHeldNotes = new Set();

  function hitTestKey(clientX, clientY) {
    const r  = canvas.getBoundingClientRect();
    const mx = (clientX - r.left) * (CANVAS_W / r.width);
    const my = (clientY - r.top)  * (CANVAS_H / r.height);
    if (my < HIGHWAY_H) return null;
    for (const kr of blackKeyRects) {
      if (mx >= kr.x && mx <= kr.x + kr.w && my >= kr.y && my <= kr.y + kr.h) return kr.note;
    }
    for (const kr of whiteKeyRects) {
      if (mx >= kr.x && mx <= kr.x + kr.w && my >= kr.y && my <= kr.y + kr.h) return kr.note;
    }
    return null;
  }

  // ── Mouse input ───────────────────────────────────────────────
  canvas.addEventListener('mousedown', e => {
    const hit = hitTestKey(e.clientX, e.clientY);
    if (hit !== null) { mouseHeldNotes.add(hit); if (onKeyDown) onKeyDown(hit); }
  });

  const releaseMouse = () => {
    if (onKeyUp) mouseHeldNotes.forEach(n => onKeyUp(n));
    mouseHeldNotes.clear();
  };
  canvas.addEventListener('mouseup',    releaseMouse);
  canvas.addEventListener('mouseleave', releaseMouse);

  // ── Touch input ───────────────────────────────────────────────
  // Track which note each touch identifier is currently holding.
  const touchNotes = new Map(); // touchId → midiNote

  canvas.addEventListener('touchstart', e => {
    e.preventDefault();
    for (const t of e.changedTouches) {
      const hit = hitTestKey(t.clientX, t.clientY);
      if (hit !== null) { touchNotes.set(t.identifier, hit); if (onKeyDown) onKeyDown(hit); }
    }
  }, { passive: false });

  canvas.addEventListener('touchmove', e => {
    e.preventDefault();
    for (const t of e.changedTouches) {
      const prev = touchNotes.get(t.identifier) ?? null;
      const hit  = hitTestKey(t.clientX, t.clientY);
      if (hit !== prev) {
        if (prev !== null && onKeyUp) onKeyUp(prev);
        if (hit  !== null && onKeyDown) onKeyDown(hit);
        if (hit !== null) touchNotes.set(t.identifier, hit);
        else touchNotes.delete(t.identifier);
      }
    }
  }, { passive: false });

  const releaseTouch = e => {
    e.preventDefault();
    for (const t of e.changedTouches) {
      const prev = touchNotes.get(t.identifier);
      if (prev != null && onKeyUp) onKeyUp(prev);
      touchNotes.delete(t.identifier);
    }
  };
  canvas.addEventListener('touchend',    releaseTouch, { passive: false });
  canvas.addEventListener('touchcancel', releaseTouch, { passive: false });


  // ══════════════════════════════════════════════════════════════
  // DRAWING (internal)
  // ══════════════════════════════════════════════════════════════

  function drawHighway(fallingBlocks, heldNotes) {
    // Background + per-column shading
    ctx.fillStyle = '#0d0d14';
    ctx.fillRect(0, 0, CANVAS_W, HIGHWAY_H);
    for (let i = 0; i < whiteKeys.length; i++) {
      ctx.fillStyle = i % 2 === 0 ? '#0d0d14' : '#0f0f18';
      ctx.fillRect(i * WHITE_KEY_W, 0, WHITE_KEY_W, HIGHWAY_H);
    }

    // Vertical column dividers
    ctx.strokeStyle = '#1a1a24'; ctx.lineWidth = 0.5;
    for (let i = 0; i <= whiteKeys.length; i++) {
      ctx.beginPath();
      ctx.moveTo(i * WHITE_KEY_W, 0);
      ctx.lineTo(i * WHITE_KEY_W, HIGHWAY_H);
      ctx.stroke();
    }

    // Held-key column highlight (faint accent rectangle behind the note column)
    heldNotes.forEach(n => {
      if (n < noteMin || n > noteMax) return;
      const cx = noteXCenter[n];
      const nw = isBlackKey(n) ? BLACK_KEY_W : WHITE_KEY_W;
      ctx.fillStyle = hexToRgba(color.stroke, 0.1);
      ctx.fillRect(cx - nw / 2, 0, nw, HIGHWAY_H);
    });

    // Falling blocks
    const now = performance.now();
    fallingBlocks.forEach(block => {
      let fill   = block.black ? color.stroke : color.fill;
      let stroke = block.black ? color.accent : color.stroke;
      let alpha  = 0.9;
      if (block.hitQuality) {
        const age = now - block.hitTime;
        if (age < HIT_FLASH_DURATION) {
          fill   = block.hitQuality === 'perfect' ? HIT_PERFECT_FILL : HIT_GOOD_FILL;
          stroke = HIT_FLASH_STROKE;
          alpha  = 1 - (age / HIT_FLASH_DURATION) * 0.6;
        }
      }
      ctx.globalAlpha = alpha;
      ctx.fillStyle = fill;
      ctx.beginPath(); ctx.roundRect(block.x, block.y, block.w, block.h, 2); ctx.fill();
      ctx.strokeStyle = stroke; ctx.lineWidth = 0.5;
      ctx.beginPath(); ctx.roundRect(block.x, block.y, block.w, block.h, 2); ctx.stroke();
      // Subtle top-edge shine
      ctx.fillStyle = 'rgba(255,255,255,0.1)';
      ctx.beginPath(); ctx.roundRect(block.x + 1, block.y + 1, block.w - 2, 3, 1); ctx.fill();

      // Note-name label (primary) + optional keyboard-key hint (secondary).
      // Only draw when the block is tall enough to host text — keeps things
      // legible at high speed levels where blocks are short.
      if (block.h >= 18) {
        const cx = block.x + block.w / 2;
        if (blockLabel) {
          const lab = blockLabel(block.note);
          if (lab) {
            ctx.fillStyle    = '#fff';
            ctx.font         = '600 11px "Space Mono", monospace';
            ctx.textAlign    = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(lab, cx, block.y + block.h / 2);
          }
        }
        if (blockHint && block.h >= 28) {
          const hint = blockHint(block.note);
          if (hint) {
            ctx.fillStyle    = 'rgba(255,255,255,0.55)';
            ctx.font         = '8px "Space Mono", monospace';
            ctx.textAlign    = 'center';
            ctx.textBaseline = 'bottom';
            ctx.fillText(hint, cx, block.y + block.h - 2);
          }
        }
      }
      ctx.globalAlpha = 1;
    });

    // Hit zone line + label
    ctx.fillStyle = hexToRgba(color.stroke, 0.35);
    ctx.fillRect(0, HIT_Y, CANVAS_W, 3);
    ctx.fillStyle = hexToRgba(color.stroke, 0.3);
    ctx.font = '9px Segoe UI'; ctx.textAlign = 'left';
    ctx.fillText('HIT ZONE', 4, HIT_Y - 4);

    // Border between highway and keyboard
    ctx.fillStyle = '#1e1e2a';
    ctx.fillRect(0, HIGHWAY_H - 1, CANVAS_W, 1);
  }

  function drawKeyboard(heldNotes, notePreview) {
    const kyTop = HIGHWAY_H;

    // White keys
    for (let i = 0; i < whiteKeys.length; i++) {
      const n       = whiteKeys[i];
      const kx      = i * WHITE_KEY_W;
      const held    = heldNotes.has(n);
      const preview = notePreview[n] || 0;

      ctx.fillStyle   = held ? color.stroke : '#e8e8e0';
      ctx.strokeStyle = held ? color.accent : '#999';
      ctx.lineWidth   = 0.5;
      ctx.beginPath();
      ctx.roundRect(kx + 1, kyTop + 1, WHITE_KEY_W - 2, WHITE_KEY_H - 4, [0, 0, 3, 3]);
      ctx.fill(); ctx.stroke();

      if (!held && preview > 0) {
        ctx.globalAlpha = preview * 0.75;
        ctx.fillStyle   = color.stroke;
        ctx.beginPath();
        ctx.roundRect(kx + 1, kyTop + 1, WHITE_KEY_W - 2, WHITE_KEY_H - 4, [0, 0, 3, 3]);
        ctx.fill();
        ctx.globalAlpha = 1;
        if (preview > 0.6) {
          ctx.strokeStyle = color.accent;
          ctx.lineWidth   = preview;
          ctx.beginPath();
          ctx.roundRect(kx + 1, kyTop + 1, WHITE_KEY_W - 2, WHITE_KEY_H - 4, [0, 0, 3, 3]);
          ctx.stroke();
        }
      }

      // Octave label (C-key only)
      if (n % 12 === 0) {
        ctx.fillStyle = (held || preview > 0.3) ? color.fill : '#aaa';
        ctx.font = '8px Segoe UI'; ctx.textAlign = 'center';
        ctx.fillText(midiToName(n), kx + WHITE_KEY_W / 2, kyTop + WHITE_KEY_H - 8);
      }
    }

    // Black keys (drawn over white keys)
    for (let n = noteMin; n <= noteMax; n++) {
      if (!isBlackKey(n)) continue;
      const cx = noteXCenter[n];
      if (cx == null) continue;
      const kx      = cx - BLACK_KEY_W / 2;
      const held    = heldNotes.has(n);
      const preview = notePreview[n] || 0;

      ctx.fillStyle   = held ? color.fill : '#111';
      ctx.strokeStyle = held ? color.stroke : '#333';
      ctx.lineWidth   = 0.5;
      ctx.beginPath();
      ctx.roundRect(kx, kyTop, BLACK_KEY_W, BLACK_KEY_H, [0, 0, 3, 3]);
      ctx.fill(); ctx.stroke();

      if (!held && preview > 0) {
        ctx.globalAlpha = preview * 0.85;
        ctx.fillStyle   = color.stroke;
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
    // Dim the highway behind the count-off
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, 0, CANVAS_W, HIGHWAY_H);

    const beatStr  = beatNum <= COUNTOFF_BEATS ? String(beatNum) : 'GO!';
    const scale    = 1 - beatProgress * 0.25;
    const isGo     = beatNum > COUNTOFF_BEATS;

    ctx.save();
    ctx.translate(CANVAS_W / 2, HIGHWAY_H / 2);
    ctx.scale(scale, scale);

    // Shadow layer
    ctx.fillStyle = isGo ? GO_SHADOW : darken(color.fill);
    ctx.font = '500 108px Segoe UI'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(beatStr, 3, 3);

    // Main text
    ctx.fillStyle = isGo ? GO_FILL : color.accent;
    ctx.font = '500 100px Segoe UI';
    ctx.fillText(beatStr, 0, 0);

    ctx.restore();

    // Beat dots
    for (let i = 0; i < COUNTOFF_BEATS; i++) {
      ctx.beginPath();
      ctx.arc(
        CANVAS_W / 2 - ((COUNTOFF_BEATS - 1) / 2) * 24 + i * 24,
        HIGHWAY_H - 30, 5, 0, Math.PI * 2,
      );
      ctx.fillStyle = i < beatNum ? color.stroke : '#2a2a3a';
      ctx.fill();
    }
  }


  // ══════════════════════════════════════════════════════════════
  // PUBLIC API
  // ══════════════════════════════════════════════════════════════

  function computePreview(fallingBlocks) {
    const preview = {};
    for (const block of fallingBlocks) {
      const dist = HIT_Y - block.y;
      if (dist >= 0 && dist <= PREVIEW_ZONE) {
        const intensity = 1 - (dist / PREVIEW_ZONE);
        if (!preview[block.note] || intensity > preview[block.note]) {
          preview[block.note] = intensity;
        }
      }
    }
    return preview;
  }

  return {
    // ── Frame draw ────────────────────────────────────────────
    draw({ fallingBlocks = [], heldNotes = new Set(), countoff = null } = {}) {
      // Sync buffer first (cheap, no-op if unchanged), then re-scale
      // each frame so the logical (CANVAS_W × CANVAS_H) drawing space
      // maps to whatever pixel resolution the canvas currently has.
      syncBufferToDisplay();
      const sx = canvas.width  / CANVAS_W;
      const sy = canvas.height / CANVAS_H;
      ctx.setTransform(sx, 0, 0, sy, 0, 0);
      ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
      const notePreview = computePreview(fallingBlocks);
      drawHighway(fallingBlocks, heldNotes);
      drawKeyboard(heldNotes, notePreview);
      if (countoff) drawCountoff(countoff.beatNum, countoff.beatProgress);
    },

    // ── Position helpers (used by the screen's spawn logic) ───
    noteToX:     n => noteXCenter[n] ?? null,
    noteWidth:   n => noteWidthFor(n),
    isBlack:     n => isBlackKey(n),
    noteInRange: n => n >= noteMin && n <= noteMax && noteXCenter[n] != null,

    // ── Geometry getters ──────────────────────────────────────
    getCanvasWidth:  () => CANVAS_W,
    getCanvasHeight: () => CANVAS_H,
    getNoteMin:      () => noteMin,
    getNoteMax:      () => noteMax,

    // ── Block height for a given note ─────────────────────────
    // Spawning code uses this so falling blocks have correct sizes
    // for white vs black keys.
    blockHeight: n => isBlackKey(n) ? 14 : 18,
  };
}


// ════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════

// "#7F77DD" + 0.1 → "rgba(127,119,221,0.1)"
function hexToRgba(hex, alpha) {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// Quick darken for the count-off shadow (drops each channel by 25%)
function darken(hex) {
  const h = hex.replace('#', '');
  const r = Math.floor(parseInt(h.substring(0, 2), 16) * 0.75);
  const g = Math.floor(parseInt(h.substring(2, 4), 16) * 0.75);
  const b = Math.floor(parseInt(h.substring(4, 6), 16) * 0.75);
  return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
}
