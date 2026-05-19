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

const KEY_STRIP_W = 56;     // left column reserved for key labels
const RULER_H     = 24;     // top strip reserved for bar/beat ruler + draggable playhead
const GRID_H      = ROLL_H - RULER_H;   // remaining vertical space for note rows

// Black-key semitones within an octave (relative to C).
const BLACK_KEY_SET = new Set([1, 3, 6, 8, 10]);

export function createPianoRollRenderer(canvas, song, options = {}) {
  const ctx = canvas.getContext('2d');

  const {
    onAdd          = null,   // (pitch, startMs)   — empty grid tapped
    onSelect       = null,   // (note | null)       — note tapped, ring drawn
    onMove         = null,   // (note)              — drag finished
    onDelete       = null,   // (note)              — long-press / right-click
    onPlayheadDrag = null,   // (ms)                — fires while ruler is being dragged
  } = options;

  let playheadMs    = 0;        // current playhead position; always drawn
  // Multi-select: Set of selected note objects. A "single selection"
  // is just a one-entry Set. Renderer draws an outline ring around
  // every member.
  const selectedNotes = new Set();
  let rulerDragging = false;    // true while user is dragging the top ruler
  // Rubber-band lasso: when user drags from empty grid, this becomes
  // an object with the start + current canvas-logical coordinates so
  // we can draw the rectangle and hit-test it on release.
  let lasso = null;

  // Zoom state. 1 = fit-all (default). 2 = show half, 4 = quarter, etc.
  // viewOffsetMs is the song-time at the left edge of the visible
  // window. When zoom > 1, the user can be viewing any window of the
  // song; ensurePlayheadVisible() keeps playback from disappearing.
  let zoomFactor   = 1;
  let viewOffsetMs = 0;
  const MAX_ZOOM = 16;
  const MIN_ZOOM = 1;

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
  function setPlayhead(ms) {
    playheadMs = ms;
    ensurePlayheadVisible();
  }
  // Selection API. setSelected(null) clears; setSelected(note) selects
  // just that one; setSelected(iterable) selects exactly those.
  function setSelected(arg) {
    selectedNotes.clear();
    if (arg == null) return;
    if (arg && typeof arg[Symbol.iterator] === 'function' && typeof arg !== 'string') {
      for (const n of arg) selectedNotes.add(n);
    } else {
      selectedNotes.add(arg);
    }
  }
  // Returns a single selected note when exactly one is selected,
  // null otherwise. Used by the duration-length toolbar which only
  // makes sense for single-selection.
  function getSelected() {
    if (selectedNotes.size === 1) return selectedNotes.values().next().value;
    return null;
  }
  function getSelectedSet() { return selectedNotes; }

  // Zoom anchored on the playhead — the spot you care about stays
  // in view across zoom changes. setZoom clamps to [MIN_ZOOM, MAX_ZOOM].
  function setZoom(factor) {
    const oldFactor = zoomFactor;
    zoomFactor = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, factor));
    if (zoomFactor === oldFactor) return;
    if (zoomFactor <= 1) {
      viewOffsetMs = 0;
    } else {
      const viewMs = computeViewMs();
      viewOffsetMs = clampOffset(playheadMs - viewMs / 2);
    }
  }
  function getZoom() { return zoomFactor; }
  function zoomIn()  { setZoom(zoomFactor * 2); }
  function zoomOut() { setZoom(zoomFactor / 2); }
  function zoomFit() { setZoom(1); }

  function draw() {
    syncBufferToDisplay();
    const sx = canvas.width  / ROLL_W;
    const sy = canvas.height / ROLL_H;
    ctx.setTransform(sx, 0, 0, sy, 0, 0);
    ctx.clearRect(0, 0, ROLL_W, ROLL_H);

    const totalMs = computeViewMs();
    const pxPerMs = (ROLL_W - KEY_STRIP_W) / totalMs;
    const yView   = computeYView();

    drawRowBands(yView);
    drawGridlines(totalMs, pxPerMs);
    drawNotes(pxPerMs, yView);
    drawPlayhead(pxPerMs);
    drawKeyStrip(yView);
    drawRuler(totalMs, pxPerMs);   // sits on top of everything in the top strip
    drawLasso();                   // last — sits on top of every other element
  }

  // Translucent selection rectangle drawn while the user is rubber-
  // band-dragging on empty grid. The actual hit-test against notes
  // happens on pointerup (see the pointer handlers below).
  function drawLasso() {
    if (!lasso) return;
    const x = Math.min(lasso.x0, lasso.x1);
    const y = Math.min(lasso.y0, lasso.y1);
    const w = Math.abs(lasso.x1 - lasso.x0);
    const h = Math.abs(lasso.y1 - lasso.y0);
    ctx.fillStyle = 'rgba(127, 119, 221, 0.18)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#AFA9EC';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.setLineDash([]);
  }

  // ── Internal ────────────────────────────────────────────────────
  // Total "song area" (fit-all window) — the size you'd see at zoom 1.
  // Considers notes from ALL tracks so the fit always covers everything.
  function computeFitMs() {
    const beatMs = 60_000 / song.bpm;
    const minMs = 8 * 4 * beatMs;   // always at least 8 bars
    let lastEnd = 0;
    for (const track of song.tracks) {
      for (const n of track.notes) {
        const end = n.startMs + n.durationMs;
        if (end > lastEnd) lastEnd = end;
      }
    }
    return Math.max(minMs, lastEnd * 1.05);
  }
  // Visible window size in ms — fit / zoom.
  function computeViewMs() {
    return computeFitMs() / zoomFactor;
  }
  // Pan offset is clamped to song boundaries so you can't scroll past.
  function clampOffset(offset) {
    const viewMs = computeViewMs();
    const maxOffset = Math.max(0, computeFitMs() - viewMs);
    return Math.max(0, Math.min(offset, maxOffset));
  }
  // Y-axis viewport. Y zoom is dampened (sqrt of X zoom) so notes
  // get *somewhat* bigger when you zoom in, and capped so that the
  // song's actual pitch range stays visible with a small headroom.
  // If your song uses the full piano, Y zoom stays at 1 even when
  // X zoom is 16; if it's all in one octave, Y zooms in freely and
  // the rows get nice and fat.
  function computeYView() {
    let minP = PITCH_MAX, maxP = PITCH_MIN;
    let anyNotes = false;
    for (const track of song.tracks) {
      for (const n of track.notes) {
        anyNotes = true;
        if (n.pitch < minP) minP = n.pitch;
        if (n.pitch > maxP) maxP = n.pitch;
      }
    }
    if (!anyNotes) {
      // Default centred on the playable warmup keyboard range (G3-G5).
      minP = 55; maxP = 79;
    }
    const songSpan = (maxP - minP) + 1;
    // Keep all song pitches visible plus a buffer (so adding nearby
    // notes doesn't immediately scroll them off).
    const desiredRowsVisible = Math.max(songSpan + 8, 12);
    const maxYZoom = PITCH_COUNT / desiredRowsVisible;
    const desiredYZoom = Math.sqrt(Math.max(1, zoomFactor));
    const yZoom = Math.max(1, Math.min(desiredYZoom, maxYZoom));
    const visibleRows = Math.min(PITCH_COUNT, Math.max(1, Math.ceil(PITCH_COUNT / yZoom)));
    const rowH = GRID_H / visibleRows;
    // Center the visible window on the song's median pitch, clamped
    // so we never show "above C7" or "below C2".
    const center = Math.round((minP + maxP) / 2);
    let viewPitchTop = center + Math.floor(visibleRows / 2);
    viewPitchTop = Math.min(PITCH_MAX, viewPitchTop);
    viewPitchTop = Math.max(PITCH_MIN + visibleRows - 1, viewPitchTop);
    return { yZoom, visibleRows, viewPitchTop, rowH };
  }

  // Whenever the playhead moves (drag, playback, programmatic) make
  // sure it stays inside the visible window when zoomed. Pans the
  // view as a side-effect.
  function ensurePlayheadVisible() {
    if (zoomFactor <= 1) { viewOffsetMs = 0; return; }
    const viewMs = computeViewMs();
    if (playheadMs < viewOffsetMs) {
      viewOffsetMs = clampOffset(playheadMs - viewMs * 0.1);
    } else if (playheadMs > viewOffsetMs + viewMs) {
      viewOffsetMs = clampOffset(playheadMs - viewMs * 0.9);
    } else {
      viewOffsetMs = clampOffset(viewOffsetMs);
    }
  }

  // Subtle row stripes — black-key rows slightly darker.
  function drawRowBands(yView) {
    const { visibleRows, viewPitchTop, rowH } = yView;
    for (let i = 0; i < visibleRows; i++) {
      const pitch = viewPitchTop - i;
      if (pitch < PITCH_MIN || pitch > PITCH_MAX) continue;
      const isBlack = BLACK_KEY_SET.has(pitch % 12);
      ctx.fillStyle = isBlack ? '#0c0c18' : '#11111e';
      ctx.fillRect(KEY_STRIP_W, RULER_H + i * rowH, ROLL_W - KEY_STRIP_W, rowH);
    }
    // Octave separator at every C — slightly brighter horizontal line.
    ctx.strokeStyle = '#1a1a28';
    ctx.lineWidth = 0.5;
    for (let i = 0; i < visibleRows; i++) {
      const pitch = viewPitchTop - i;
      if (pitch < PITCH_MIN || pitch > PITCH_MAX) continue;
      if (pitch % 12 === 0) {
        const y = RULER_H + (i + 1) * rowH;
        ctx.beginPath();
        ctx.moveTo(KEY_STRIP_W, y);
        ctx.lineTo(ROLL_W, y);
        ctx.stroke();
      }
    }
  }

  // Beat + bar vertical gridlines (drawn through the grid area; the
  // ruler has its own ticks). Bar lines fall every `timeSig.num` beats.
  // Iterates only the beats inside the visible window (cheap when
  // zoomed in to e.g. 4 bars of a long song).
  function drawGridlines(totalMs, pxPerMs) {
    const beatMs = 60_000 / song.bpm;
    const barBeats = song.timeSig?.num ?? 4;
    const startBeat = Math.floor(viewOffsetMs / beatMs);
    const endBeat   = Math.ceil((viewOffsetMs + totalMs) / beatMs);
    for (let beat = startBeat; beat <= endBeat; beat++) {
      const x = KEY_STRIP_W + (beat * beatMs - viewOffsetMs) * pxPerMs;
      if (x < KEY_STRIP_W || x > ROLL_W) continue;
      const isBarLine = beat % barBeats === 0;
      ctx.strokeStyle = isBarLine ? '#2a2a40' : '#181826';
      ctx.lineWidth   = isBarLine ? 1 : 0.5;
      ctx.beginPath();
      ctx.moveTo(x, RULER_H);
      ctx.lineTo(x, ROLL_H);
      ctx.stroke();
    }
  }

  // Note pills — per-track-color vertical gradient with rounded corners.
  // Inactive-track notes are dimmed so the active track reads as "the
  // layer I'm editing right now." Selected note gets a bright outline.
  function drawNotes(pxPerMs, yView) {
    const { visibleRows, viewPitchTop, rowH } = yView;
    const visiblePitchMin = viewPitchTop - visibleRows + 1;
    const radius = Math.min(3, rowH / 3);
    const activeId = song.activeTrackId;
    // Inactive tracks first so the active track paints on top when
    // notes share a row at high zoom.
    const ordered = [
      ...song.tracks.filter(t => t.id !== activeId),
      ...song.tracks.filter(t => t.id === activeId),
    ];

    for (const track of ordered) {
      const isActive  = track.id === activeId;
      const baseColor = track.color || '#7F77DD';
      for (const note of track.notes) {
        if (note.pitch < visiblePitchMin || note.pitch > viewPitchTop) continue;
        const x = KEY_STRIP_W + (note.startMs - viewOffsetMs) * pxPerMs;
        const w = Math.max(2, note.durationMs * pxPerMs);
        if (x + w < KEY_STRIP_W || x > ROLL_W) continue;
        const yIdx = viewPitchTop - note.pitch;
        const y = RULER_H + yIdx * rowH;

        if (isActive) {
          // Vertical gradient — tint(top) → base → shade(bottom).
          const grad = ctx.createLinearGradient(0, y + 1, 0, y + rowH - 1);
          grad.addColorStop(0,   tintHex(baseColor, 0.22));
          grad.addColorStop(0.5, baseColor);
          grad.addColorStop(1,   shadeHex(baseColor, 0.22));
          ctx.fillStyle = grad;
        } else {
          // Inactive tracks render as flat dim color so they sit
          // visually behind the active one without competing.
          ctx.fillStyle = withAlpha(baseColor, 0.40);
        }

        ctx.beginPath();
        if (typeof ctx.roundRect === 'function') {
          ctx.roundRect(x, y + 1, w, rowH - 2, radius);
        } else {
          ctx.rect(x, y + 1, w, rowH - 2);
        }
        ctx.fill();

        if (isActive) {
          // Velocity hint: brighter top edge for louder notes.
          const v = Math.min(1, note.velocity / 127);
          ctx.fillStyle = `rgba(255, 255, 255, ${0.08 + 0.18 * v})`;
          ctx.fillRect(x + radius, y + 1, Math.max(0, w - 2 * radius), 1);
        }

        if (selectedNotes.has(note)) {
          ctx.strokeStyle = '#FFFFFF';
          ctx.lineWidth   = 1.5;
          ctx.beginPath();
          if (typeof ctx.roundRect === 'function') {
            ctx.roundRect(x - 0.5, y + 0.5, w + 1, rowH - 1, radius + 1);
          } else {
            ctx.rect(x - 0.5, y + 0.5, w + 1, rowH - 1);
          }
          ctx.stroke();
        }
      }
    }
  }

  // ── Color helpers (hex → tint / shade / alpha) ─────────────────
  // Derive gradient stops + dim variant from each track's base color.
  function hexToRgb(hex) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!m) return { r: 127, g: 119, b: 221 };  // fallback to default purple
    return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
  }
  function tintHex(hex, t) {
    const { r, g, b } = hexToRgb(hex);
    const k = Math.min(1, Math.max(0, t));
    return `rgb(${Math.round(r + (255 - r) * k)}, ${Math.round(g + (255 - g) * k)}, ${Math.round(b + (255 - b) * k)})`;
  }
  function shadeHex(hex, t) {
    const { r, g, b } = hexToRgb(hex);
    const k = Math.min(1, Math.max(0, t));
    return `rgb(${Math.round(r * (1 - k))}, ${Math.round(g * (1 - k))}, ${Math.round(b * (1 - k))})`;
  }
  function withAlpha(hex, a) {
    const { r, g, b } = hexToRgb(hex);
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }

  function drawPlayhead(pxPerMs) {
    const x = KEY_STRIP_W + (Math.max(0, playheadMs) - viewOffsetMs) * pxPerMs;
    if (x < KEY_STRIP_W || x > ROLL_W) return;
    ctx.strokeStyle = '#1D9E75';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);            // extends through the ruler so the user can grab it there
    ctx.lineTo(x, ROLL_H);
    ctx.stroke();
  }

  // Left-margin mini keyboard — alternating black/white blocks per
  // semitone, octave labels on each C. Starts below the ruler.
  function drawKeyStrip(yView) {
    const { visibleRows, viewPitchTop, rowH } = yView;
    // Top-left corner above the keys (covered by ruler styling later, but fill so it's clean)
    ctx.fillStyle = '#0d0d18';
    ctx.fillRect(0, 0, KEY_STRIP_W, RULER_H);

    for (let i = 0; i < visibleRows; i++) {
      const pitch = viewPitchTop - i;
      if (pitch < PITCH_MIN || pitch > PITCH_MAX) continue;
      const isBlack = BLACK_KEY_SET.has(pitch % 12);
      ctx.fillStyle = isBlack ? '#0a0a14' : '#1c1c2a';
      ctx.fillRect(0, RULER_H + i * rowH, KEY_STRIP_W, rowH);

      if (pitch % 12 === 0) {
        const octave = Math.floor(pitch / 12) - 1;
        ctx.fillStyle = '#666';
        ctx.font = '11px "Segoe UI", sans-serif';
        ctx.fillText(`C${octave}`, 6, RULER_H + i * rowH + rowH - 3);
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

  // Top ruler — dark strip showing bar numbers. Click + drag here to
  // set the playhead position. Drawn last so the playhead line passes
  // behind the labels but the ruler background covers any gridlines
  // that may have leaked into the strip.
  function drawRuler(totalMs, pxPerMs) {
    // Background fills the full ruler row (the key-strip portion was
    // already filled by drawKeyStrip).
    ctx.fillStyle = '#0d0d18';
    ctx.fillRect(KEY_STRIP_W, 0, ROLL_W - KEY_STRIP_W, RULER_H);

    // Bottom border under the ruler — separates it from the grid.
    ctx.strokeStyle = '#2a2a40';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(KEY_STRIP_W, RULER_H);
    ctx.lineTo(ROLL_W, RULER_H);
    ctx.stroke();

    // Bar tick marks + numbers — span = (timeSig.num) beats. Iterates
    // only the bars inside the visible window.
    const beatMs = 60_000 / song.bpm;
    const barBeats = song.timeSig?.num ?? 4;
    const barMs  = beatMs * barBeats;
    const startBar = Math.floor(viewOffsetMs / barMs);
    const endBar   = Math.ceil((viewOffsetMs + totalMs) / barMs);

    ctx.font = '10px "Segoe UI", sans-serif';
    ctx.fillStyle = '#8585a0';
    ctx.textBaseline = 'middle';

    for (let bar = startBar; bar <= endBar; bar++) {
      const x = KEY_STRIP_W + (bar * barMs - viewOffsetMs) * pxPerMs;
      if (x < KEY_STRIP_W || x > ROLL_W) continue;
      ctx.strokeStyle = '#3a3a52';
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(x, RULER_H - 5);
      ctx.lineTo(x, RULER_H);
      ctx.stroke();
      ctx.fillText(`${bar + 1}`, x + 4, RULER_H / 2 + 1);
    }

    // Playhead handle — a small notch in the ruler so you can see
    // where to grab it.
    const phX = KEY_STRIP_W + (Math.max(0, playheadMs) - viewOffsetMs) * pxPerMs;
    if (phX >= KEY_STRIP_W && phX <= ROLL_W) {
      ctx.fillStyle = '#1D9E75';
      ctx.beginPath();
      ctx.moveTo(phX - 5, 2);
      ctx.lineTo(phX + 5, 2);
      ctx.lineTo(phX,     RULER_H - 4);
      ctx.closePath();
      ctx.fill();
    }
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
    if (ly < RULER_H)     return null;
    const totalMs = computeViewMs();
    const pxPerMs = (ROLL_W - KEY_STRIP_W) / totalMs;
    const yView   = computeYView();
    const { visibleRows, viewPitchTop, rowH } = yView;
    const visiblePitchMin = viewPitchTop - visibleRows + 1;

    // Active track is drawn on top, so search it first so the active
    // layer wins overlapping-note ties. Each track scanned in reverse
    // (later notes z-index over earlier in the same track).
    const activeId = song.activeTrackId;
    const orderedForHit = [
      ...song.tracks.filter(t => t.id === activeId),
      ...song.tracks.filter(t => t.id !== activeId),
    ];

    for (const track of orderedForHit) {
      for (let i = track.notes.length - 1; i >= 0; i--) {
        const note = track.notes[i];
        if (note.pitch < visiblePitchMin || note.pitch > viewPitchTop) continue;
        const x = KEY_STRIP_W + (note.startMs - viewOffsetMs) * pxPerMs;
        const w = Math.max(2, note.durationMs * pxPerMs);
        const yIdx = viewPitchTop - note.pitch;
        const y = RULER_H + yIdx * rowH;
        if (lx >= x && lx <= x + w && ly >= y && ly <= y + rowH) return note;
      }
    }
    return null;
  }

  function gridPosAtLogical(lx, ly) {
    if (lx < KEY_STRIP_W) return null;
    if (ly < RULER_H)     return null;
    const totalMs = computeViewMs();
    const pxPerMs = (ROLL_W - KEY_STRIP_W) / totalMs;
    const yView   = computeYView();
    const startMs = Math.max(0, viewOffsetMs + (lx - KEY_STRIP_W) / pxPerMs);
    const yIdx    = Math.floor((ly - RULER_H) / yView.rowH);
    const pitch   = yView.viewPitchTop - yIdx;
    if (pitch < PITCH_MIN || pitch > PITCH_MAX) return null;
    return { pitch, startMs };
  }

  // Returns the song-time (ms) at a given logical X, clamped to >= 0.
  // Used by the ruler-drag path. Accounts for the current pan offset.
  function msAtLogicalX(lx) {
    const totalMs = computeViewMs();
    const pxPerMs = (ROLL_W - KEY_STRIP_W) / totalMs;
    return Math.max(0, viewOffsetMs + (lx - KEY_STRIP_W) / pxPerMs);
  }

  function isInRulerLogical(lx, ly) {
    return lx >= KEY_STRIP_W && ly >= 0 && ly < RULER_H;
  }

  // ── Pointer interaction ────────────────────────────────────────
  // Distinguishes tap vs drag via a small threshold, and uses a 500ms
  // pointerdown-on-note timer for the touch-friendly "long-press to
  // delete" gesture.
  canvas.addEventListener('pointerdown', (e) => {
    const pt = clientToLogical(e.clientX, e.clientY);

    // Ruler click → start a playhead drag. Fires onPlayheadDrag every
    // pointermove tick until release. The renderer doesn't decide
    // whether the drag is "allowed" (e.g. during playback) — that's
    // up to the consumer to enforce inside its callback.
    if (isInRulerLogical(pt.x, pt.y)) {
      e.preventDefault();
      try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
      rulerDragging = true;
      if (onPlayheadDrag) onPlayheadDrag(msAtLogicalX(pt.x));
      return;
    }

    const note = noteAtLogical(pt.x, pt.y);
    const grid = note ? null : gridPosAtLogical(pt.x, pt.y);
    if (!note && !grid) return;     // clicked the key strip — ignore
    e.preventDefault();
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}

    // Snapshot initial positions of every currently-selected note so
    // a group drag can apply the same delta to all of them.
    const groupInitial = new Map();
    for (const n of selectedNotes) {
      groupInitial.set(n, {
        startMs: n.startMs,
        startMsRaw: n.startMsRaw,
        pitch:   n.pitch,
      });
    }

    drag = {
      note,
      gridPos: grid,
      shift:   e.shiftKey,
      startClientX: e.clientX,
      startClientY: e.clientY,
      started: false,
      longPressTimer: null,
      groupInitial,        // {note → {startMs, startMsRaw, pitch}} for group drag
      anchorInitial: note ? { startMs: note.startMs, pitch: note.pitch } : null,
    };
    if (note) {
      // Long-press a note to delete. If the long-pressed note is part
      // of a selection, delete the whole selection; otherwise just
      // delete that one.
      drag.longPressTimer = setTimeout(() => {
        if (drag && drag.note === note && !drag.started) {
          const toDelete = selectedNotes.has(note)
            ? [...selectedNotes]
            : [note];
          for (const n of toDelete) selectedNotes.delete(n);
          if (onDelete) onDelete(toDelete);
          drag = null;
        }
      }, LONG_PRESS_MS);
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (rulerDragging) {
      const pt = clientToLogical(e.clientX, e.clientY);
      if (onPlayheadDrag) onPlayheadDrag(msAtLogicalX(pt.x));
      return;
    }
    if (!drag) return;
    const dx = e.clientX - drag.startClientX;
    const dy = e.clientY - drag.startClientY;
    if (!drag.started && Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
      drag.started = true;
      if (drag.longPressTimer) {
        clearTimeout(drag.longPressTimer);
        drag.longPressTimer = null;
      }
      // First time we confirm a drag started — for a note drag, if
      // the clicked note isn't already in selection, make it the only
      // selected note so the group drag operates on what the user
      // grabbed. For an empty-grid drag, kick off a rubber-band lasso.
      if (drag.note) {
        if (!selectedNotes.has(drag.note)) {
          selectedNotes.clear();
          selectedNotes.add(drag.note);
          drag.groupInitial.clear();
          drag.groupInitial.set(drag.note, {
            startMs: drag.note.startMs,
            startMsRaw: drag.note.startMsRaw,
            pitch:   drag.note.pitch,
          });
          if (onSelect) onSelect([drag.note]);
        }
      } else if (drag.gridPos) {
        const pt = clientToLogical(e.clientX, e.clientY);
        lasso = { x0: drag.startClientX, y0: drag.startClientY,
                  x1: e.clientX,         y1: e.clientY,
                  // Cache logical-coord versions for later hit-test.
                  startLogical: { x: 0, y: 0 } };
        // Recompute the start point in logical coords (drag.startClientX
        // is in client coords; we need logical for the hit-test).
        const startLogical = clientToLogical(drag.startClientX, drag.startClientY);
        lasso.startLogical = startLogical;
      }
    }
    if (!drag.started) return;

    if (drag.note) {
      // Group drag — apply the same (dStart, dPitch) delta to every
      // initially-selected note. Anchor on the dragged note's initial
      // position so what's under the cursor matches.
      const pt = clientToLogical(e.clientX, e.clientY);
      const totalMs = computeViewMs();
      const pxPerMs = (ROLL_W - KEY_STRIP_W) / totalMs;
      const yView   = computeYView();
      const targetStart = Math.max(0, viewOffsetMs + (pt.x - KEY_STRIP_W) / pxPerMs);
      const yIdx        = Math.floor((pt.y - RULER_H) / yView.rowH);
      const targetPitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, yView.viewPitchTop - yIdx));
      const dStart = targetStart - drag.anchorInitial.startMs;
      const dPitch = targetPitch - drag.anchorInitial.pitch;
      for (const [n, init] of drag.groupInitial) {
        const newStart = Math.max(0, init.startMs + dStart);
        n.startMs    = newStart;
        n.startMsRaw = newStart;
        n.pitch      = Math.max(PITCH_MIN, Math.min(PITCH_MAX, init.pitch + dPitch));
      }
    } else if (lasso) {
      // Rubber-band: track the current pointer in logical coords.
      const pt = clientToLogical(e.clientX, e.clientY);
      lasso.x0 = lasso.startLogical.x;
      lasso.y0 = lasso.startLogical.y;
      lasso.x1 = pt.x;
      lasso.y1 = pt.y;
    }
  });

  canvas.addEventListener('pointerup', (e) => {
    if (rulerDragging) {
      rulerDragging = false;
      try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
      return;
    }
    if (!drag) return;
    if (drag.longPressTimer) {
      clearTimeout(drag.longPressTimer);
      drag.longPressTimer = null;
    }
    try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}

    if (drag.started && drag.note) {
      // Finished a group drag.
      if (onMove) onMove([...selectedNotes]);
    } else if (drag.started && lasso) {
      // Finished a rubber-band. Hit-test every note against the rect
      // and replace the selection (or extend if shift was held).
      const x0 = Math.min(lasso.x0, lasso.x1);
      const x1 = Math.max(lasso.x0, lasso.x1);
      const y0 = Math.min(lasso.y0, lasso.y1);
      const y1 = Math.max(lasso.y0, lasso.y1);
      const inside = notesInRect(x0, y0, x1, y1);
      if (!drag.shift) selectedNotes.clear();
      for (const n of inside) selectedNotes.add(n);
      if (onSelect) onSelect([...selectedNotes]);
      lasso = null;
    } else if (drag.note) {
      // Plain tap on a note. Shift toggles in/out; plain click selects
      // just this one (unless it was already the sole selection, in
      // which case we leave it alone).
      if (drag.shift) {
        if (selectedNotes.has(drag.note)) selectedNotes.delete(drag.note);
        else                              selectedNotes.add(drag.note);
        if (onSelect) onSelect([...selectedNotes]);
      } else {
        selectedNotes.clear();
        selectedNotes.add(drag.note);
        if (onSelect) onSelect([drag.note]);
      }
    } else if (drag.gridPos) {
      // Tap on empty grid — deselect, then add a note at that position.
      selectedNotes.clear();
      if (onSelect) onSelect([]);
      if (onAdd) onAdd(drag.gridPos.pitch, drag.gridPos.startMs);
    }
    drag = null;
  });

  canvas.addEventListener('pointercancel', () => {
    rulerDragging = false;
    if (drag && drag.longPressTimer) clearTimeout(drag.longPressTimer);
    drag = null;
    lasso = null;
  });

  // Right-click anywhere on the grid: if it's on a note, delete it.
  // Mirrors the long-press logic — selection-aware.
  canvas.addEventListener('contextmenu', (e) => {
    const pt = clientToLogical(e.clientX, e.clientY);
    const note = noteAtLogical(pt.x, pt.y);
    if (!note) return;
    e.preventDefault();
    const toDelete = selectedNotes.has(note) ? [...selectedNotes] : [note];
    for (const n of toDelete) selectedNotes.delete(n);
    if (onDelete) onDelete(toDelete);
  });

  // Returns the list of notes whose visible rect overlaps the given
  // logical-coord rectangle. Used by the rubber-band hit-test.
  function notesInRect(x0, y0, x1, y1) {
    const hits = [];
    const totalMs = computeViewMs();
    const pxPerMs = (ROLL_W - KEY_STRIP_W) / totalMs;
    const yView   = computeYView();
    const { viewPitchTop, rowH, visibleRows } = yView;
    const visiblePitchMin = viewPitchTop - visibleRows + 1;
    for (const track of song.tracks) {
      for (const note of track.notes) {
        if (note.pitch < visiblePitchMin || note.pitch > viewPitchTop) continue;
        const nx = KEY_STRIP_W + (note.startMs - viewOffsetMs) * pxPerMs;
        const nw = Math.max(2, note.durationMs * pxPerMs);
        const yIdx = viewPitchTop - note.pitch;
        const ny = RULER_H + yIdx * rowH;
        // Standard AABB overlap.
        if (nx + nw < x0 || nx > x1) continue;
        if (ny + rowH < y0 || ny > y1) continue;
        hits.push(note);
      }
    }
    return hits;
  }

  return {
    draw, setPlayhead, setSelected, getSelected, getSelectedSet,
    setZoom, getZoom, zoomIn, zoomOut, zoomFit,
  };
}
