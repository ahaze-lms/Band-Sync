// ════════════════════════════════════════════════════════════════════
// BandSync — Piano-roll renderer (Studio)
// ════════════════════════════════════════════════════════════════════
// Canvas piano-roll view for a song. Phase 1 is view-only: draws the
// notes captured by the recorder, plus a playhead during playback.
// Edit interactions (drag, delete, click-to-add) are deferred.
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

export function createPianoRollRenderer(canvas, song) {
  const ctx = canvas.getContext('2d');

  let playheadMs = -1;      // -1 = don't draw playhead

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

  // Note rectangles — purple accent, rounded inset.
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

  return { draw, setPlayhead };
}
