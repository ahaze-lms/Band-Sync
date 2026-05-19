// ════════════════════════════════════════════════════════════════════
// BandSync — Piano-roll renderer (Studio)
// ════════════════════════════════════════════════════════════════════
// Canvas piano-roll view for a song. Draws the notes captured by the
// recorder, plus a playhead during playback. Phase 3 adds editing:
//   - tap empty grid → onAdd(pitch, startMs)
//   - tap a note     → onSelect(note) — note gets a highlight ring
//   - drag a note    → updates note.pitch / startMs / startMsRaw in
//                      place every pointermove tick, then onMove(note)
//                      fires on pointerup
//   - long-press a note (touch) or right-click it (mouse) → onDelete(note)
//
// Drawing happens in logical coordinates (ROLL_W × ROLL_H) and a
// per-frame setTransform maps that into the canvas's actual pixel
// buffer. The buffer itself is kept in sync with the CSS display size
// × devicePixelRatio via a ResizeObserver — same pattern as
// js/render/piano.js. Crisp at 4K, right-sized on mobile.
//
// Pitch range fixed at C2..C7 (60 semitones — covers most of a kid
// piano plus some headroom). Time window expands to fit the recording
// or shows a default 8 bars at the song's current BPM.
// ════════════════════════════════════════════════════════════════════

const ROLL_W = 1200;        // logical drawing width
const ROLL_H = 480;         // logical drawing height

const PITCH_MIN  = 36;      // C2
const PITCH_MAX  = 96;      // C7
const PITCH_COUNT = PITCH_MAX - PITCH_MIN + 1;

const KEY_STRIP_W = 56;     // left margin width (key labels live here)

// Black-key semitones within an octave (relative to C).
const BLACK_KEY_SET = new Set([1, 3, 6, 8, 10]);

export function createPianoRollRenderer(canvas, song, options = {}) {
  const ctx = canvas.getContext('2d');

  const {
    onAdd    = null,   // (pitch, startMs)         — empty grid tapped
    onSelect = null,   // (note | null)             — note tapped, ring drawn
    onMove   = null,   // (note)                    — drag finished
    onDelete = null,   // (note)                    — long-press / right-click
  } = options;

  let playheadMs   = -1;        // -1 = don't draw playhead
  let selectedNote = null;      // highlighted note, or null

  // Pointer interaction state — shared between mouse + touch via Pointer Events.
  let drag = null;
  //   shape: { note, gridPos, startClientX, startClientY, started, longPressTimer }
  const DRAG_THRESHOLD_PX = 4;
  const LONG_PRESS_MS     = 500;

  // ── Buffer sync (crisp canvas at any size) ─────────────────────
  function syncBufferToDisplay() {
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(rect.width  * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width === w && canvas.height === h) return;
    canvas.width  = w;
    canvas.height = h;
  }

  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(syncBufferToDisplay).observe(canvas);
  }

  // ── Public ──────────────────────────────────────────────────────
  function setPlayhead(ms) { playheadMs = ms; }
  function setSelected(note) { selectedNote = note; }
  function getSelected() { return selectedNote; }

  function draw() {
    syncBufferToDisplay();
    const sx = canvas.width  / ROLL_W;
    const sy = canvas.height / ROLL_H;
    ctx.setTransform(sx, 0, 0, sy, 0, 0);
    ctx.clearRect(0, 0, ROLL_W, ROLL_H);

    const totalMs = computeViewMs();
    const pxPerMs = (ROLL_W - KEY_STRIP_W) / totalMs;
    const rowH    = ROLL_H / PITCH_COUNT;

    drawRowBands(rowH);
    drawGridlines(totalMs, pxPerMs);
    drawNotes(pxPerMs, rowH);
    drawPlayhead(pxPerMs);
    drawKeyStrip(rowH);
  }

  // ── Internal ────────────────────────────────────────────────────
  function computeViewMs() {
    const beatMs = 60_000 / song.bpm;
    const minMs = 8 * 4 * beatMs;   // 8 bars at 4/4
    let lastEnd = 0;
    for (const n of song.notes) {
      const end = n.startMs + n.durationMs;
      if (end > lastEnd) lastEnd = end;
    }
    return Math.max(minMs, lastEnd * 1.05);
  }

  // Subtle row stripes — black-key rows slightly darker.
  function drawRowBands(rowH) {
    for (let i = 0; i < PITCH_COUNT; i++) {
      const pitch = PITCH_MAX - i;
      const isBlack = BLACK_KEY_SET.has(pitch % 12);
      ctx.fillStyle = isBlack ? '#0c0c18' : '#11111e';
      ctx.fillRect(KEY_STRIP_W, i * rowH, ROLL_W - KEY_STRIP_W, rowH);
    }
    // Octave separator at every C — slightly brighter horizontal line.
    ctx.strokeStyle = '#1a1a28';
    ctx.lineWidth = 0.5;
    for (let i = 0; i < PITCH_COUNT; i++) {
      const pitch = PITCH_MAX - i;
      if (pitch % 12 === 0) {
        const y = (i + 1) * rowH;
        ctx.beginPath();
        ctx.moveTo(KEY_STRIP_W, y);
        ctx.lineTo(ROLL_W, y);
        ctx.stroke();
      }
    }
  }

  // Beat + bar vertical gridlines.
  function drawGridlines(totalMs, pxPerMs) {
    const beatMs = 60_000 / song.bpm;
    const beatsVisible = Math.floor(totalMs / beatMs) + 1;
    for (let beat = 0; beat <= beatsVisible; beat++) {
      const x = KEY_STRIP_W + beat * beatMs * pxPerMs;
      if (x > ROLL_W) break;
      const isBarLine = beat % 4 === 0;
      ctx.strokeStyle = isBarLine ? '#2a2a40' : '#181826';
      ctx.lineWidth   = isBarLine ? 1 : 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, ROLL_H);
      ctx.stroke();
    }
  }

  // Note rectangles — purple accent, rounded inset. Selected note also
  // gets a brighter purple2 outline ring so the user can confirm what
  // they just tapped.
  function drawNotes(pxPerMs, rowH) {
    for (const note of song.notes) {
      if (note.pitch < PITCH_MIN || note.pitch > PITCH_MAX) continue;
      const x = KEY_STRIP_W + note.startMs * pxPerMs;
      const w = Math.max(2, note.durationMs * pxPerMs);
      const yIdx = PITCH_MAX - note.pitch;
      const y = yIdx * rowH;

      ctx.fillStyle = '#7F77DD';
      ctx.fillRect(x, y + 1, w, rowH - 2);

      // Velocity hint: brighter top edge for louder notes.
      const v = Math.min(1, note.velocity / 127);
      ctx.fillStyle = `rgba(255, 255, 255, ${0.05 + 0.15 * v})`;
      ctx.fillRect(x, y + 1, w, 1.5);

      if (note === selectedNote) {
        ctx.strokeStyle = '#AFA9EC';
        ctx.lineWidth   = 1.5;
        ctx.strokeRect(x - 0.5, y + 0.5, w + 1, rowH - 1);
      }
    }
  }

  function drawPlayhead(pxPerMs) {
    if (playheadMs < 0) return;
    const x = KEY_STRIP_W + playheadMs * pxPerMs;
    if (x > ROLL_W) return;
    ctx.strokeStyle = '#1D9E75';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, ROLL_H);
    ctx.stroke();
  }

  // Left-margin mini keyboard — alternating black/white blocks per
  // semitone, octave labels on each C.
  function drawKeyStrip(rowH) {
    for (let i = 0; i < PITCH_COUNT; i++) {
      const pitch = PITCH_MAX - i;
      const isBlack = BLACK_KEY_SET.has(pitch % 12);
      ctx.fillStyle = isBlack ? '#0a0a14' : '#1c1c2a';
      ctx.fillRect(0, i * rowH, KEY_STRIP_W, rowH);

      if (pitch % 12 === 0) {
        const octave = Math.floor(pitch / 12) - 1;
        ctx.fillStyle = '#666';
        ctx.font = '11px "Segoe UI", sans-serif';
        ctx.fillText(`C${octave}`, 6, i * rowH + rowH - 3);
      }
    }
    // Right border separating strip from roll area.
    ctx.strokeStyle = '#1e1e2a';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(KEY_STRIP_W, 0);
    ctx.lineTo(KEY_STRIP_W, ROLL_H);
    ctx.stroke();
  }

  // ── Hit-testing (logical coords) ────────────────────────────────
  function clientToLogical(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left) / rect.width  * ROLL_W,
      y: (clientY - rect.top)  / rect.height * ROLL_H,
    };
  }

  function noteAtLogical(lx, ly) {
    if (lx < KEY_STRIP_W) return null;
    const totalMs = computeViewMs();
    const pxPerMs = (ROLL_W - KEY_STRIP_W) / totalMs;
    const rowH    = ROLL_H / PITCH_COUNT;
    // Iterate in reverse so the top-most rendered note wins ties.
    for (let i = song.notes.length - 1; i >= 0; i--) {
      const note = song.notes[i];
      if (note.pitch < PITCH_MIN || note.pitch > PITCH_MAX) continue;
      const x = KEY_STRIP_W + note.startMs * pxPerMs;
      const w = Math.max(2, note.durationMs * pxPerMs);
      const yIdx = PITCH_MAX - note.pitch;
      const y = yIdx * rowH;
      if (lx >= x && lx <= x + w && ly >= y && ly <= y + rowH) return note;
    }
    return null;
  }

  function gridPosAtLogical(lx, ly) {
    if (lx < KEY_STRIP_W) return null;
    const totalMs = computeViewMs();
    const pxPerMs = (ROLL_W - KEY_STRIP_W) / totalMs;
    const rowH    = ROLL_H / PITCH_COUNT;
    const startMs = Math.max(0, (lx - KEY_STRIP_W) / pxPerMs);
    const yIdx    = Math.floor(ly / rowH);
    const pitch   = PITCH_MAX - yIdx;
    if (pitch < PITCH_MIN || pitch > PITCH_MAX) return null;
    return { pitch, startMs };
  }

  // ── Pointer interaction ────────────────────────────────────────
  // Distinguishes tap vs drag via a small threshold, and uses a 500ms
  // pointerdown-on-note timer for the touch-friendly "long-press to
  // delete" gesture.
  canvas.addEventListener('pointerdown', (e) => {
    const pt   = clientToLogical(e.clientX, e.clientY);
    const note = noteAtLogical(pt.x, pt.y);
    const grid = note ? null : gridPosAtLogical(pt.x, pt.y);
    if (!note && !grid) return;     // clicked the key strip — ignore
    e.preventDefault();
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    drag = {
      note,
      gridPos: grid,
      startClientX: e.clientX,
      startClientY: e.clientY,
      started: false,
      longPressTimer: null,
    };
    if (note) {
      drag.longPressTimer = setTimeout(() => {
        if (drag && drag.note === note && !drag.started) {
          if (selectedNote === note) selectedNote = null;
          if (onDelete) onDelete(note);
          drag = null;
        }
      }, LONG_PRESS_MS);
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!drag || !drag.note) return;       // only existing notes are draggable
    const dx = e.clientX - drag.startClientX;
    const dy = e.clientY - drag.startClientY;
    if (!drag.started && Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
      drag.started = true;
      if (drag.longPressTimer) {
        clearTimeout(drag.longPressTimer);
        drag.longPressTimer = null;
      }
    }
    if (!drag.started) return;
    const pt = clientToLogical(e.clientX, e.clientY);
    const totalMs = computeViewMs();
    const pxPerMs = (ROLL_W - KEY_STRIP_W) / totalMs;
    const rowH    = ROLL_H / PITCH_COUNT;
    const newStart = Math.max(0, (pt.x - KEY_STRIP_W) / pxPerMs);
    const yIdx     = Math.floor(pt.y / rowH);
    const newPitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, PITCH_MAX - yIdx));
    // Move updates BOTH startMs and startMsRaw — otherwise a later
    // quantize toggle would snap the moved note back to its original
    // recorded location, which is not what the user expects.
    drag.note.startMs    = newStart;
    drag.note.startMsRaw = newStart;
    drag.note.pitch      = newPitch;
  });

  canvas.addEventListener('pointerup', (e) => {
    if (!drag) return;
    if (drag.longPressTimer) {
      clearTimeout(drag.longPressTimer);
      drag.longPressTimer = null;
    }
    try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}

    if (drag.started && drag.note) {
      if (onMove) onMove(drag.note);
    } else if (drag.note) {
      // Tap on a note — select it.
      selectedNote = drag.note;
      if (onSelect) onSelect(drag.note);
    } else if (drag.gridPos) {
      // Tap on empty grid — add a note. Selection clears (the user is
      // creating, not editing an existing).
      selectedNote = null;
      if (onSelect) onSelect(null);
      if (onAdd) onAdd(drag.gridPos.pitch, drag.gridPos.startMs);
    }
    drag = null;
  });

  canvas.addEventListener('pointercancel', () => {
    if (drag && drag.longPressTimer) clearTimeout(drag.longPressTimer);
    drag = null;
  });

  // Right-click anywhere on the grid: if it's on a note, delete it.
  canvas.addEventListener('contextmenu', (e) => {
    const pt = clientToLogical(e.clientX, e.clientY);
    const note = noteAtLogical(pt.x, pt.y);
    if (!note) return;
    e.preventDefault();
    if (selectedNote === note) selectedNote = null;
    if (onDelete) onDelete(note);
  });

  return { draw, setPlayhead, setSelected, getSelected };
}
