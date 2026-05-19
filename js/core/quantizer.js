// ════════════════════════════════════════════════════════════════════
// BandSync — Quantizer
// ════════════════════════════════════════════════════════════════════
// Snaps a song's notes to a rhythmic grid. Phase 2 supports four grid
// resolutions (1/4 · 1/8 · 1/16 · 1/32) at full snap strength.
//
// Each note carries an immutable `startMsRaw` (set by the recorder)
// alongside its mutable `startMs`. Quantization only ever writes
// `startMs`, so the original take is preserved — you can re-quantize
// at any other resolution, or call quantize(song, 'raw') to revert.
//
// Strength variation (0–100%) and quantizing note ends are deferred to
// later phases per DESIGN.md §25.
// ════════════════════════════════════════════════════════════════════

const GRID_DENOMINATORS = {
  '1/4':  4,
  '1/8':  8,
  '1/16': 16,
  '1/32': 32,
};

// Snap every note's startMs to the nearest grid line at the given
// resolution. `grid` is '1/4' | '1/8' | '1/16' | '1/32' | 'raw'.
//   - 'raw' reverts every note's startMs to its original startMsRaw.
//   - Any other value computes a per-note quantized startMs using the
//     song's current BPM as the metric (so re-quantize after BPM change
//     works correctly).
export function quantize(song, grid) {
  if (grid === 'raw') {
    for (const n of song.notes) {
      if (n.startMsRaw != null) n.startMs = n.startMsRaw;
    }
    return;
  }
  const denom = GRID_DENOMINATORS[grid];
  if (!denom) throw new Error(`Unknown quantize grid: ${grid}`);
  const beatMs = 60_000 / song.bpm;     // quarter-note duration
  const gridMs = beatMs * (4 / denom);  // grid line spacing
  for (const n of song.notes) {
    const raw = n.startMsRaw != null ? n.startMsRaw : n.startMs;
    n.startMs = Math.round(raw / gridMs) * gridMs;
  }
}

// Convenience for an eventual "auto-quantize on stop" toggle. Phase 2
// does not surface this yet; the user picks a grid manually.
export function quantizeDefault(song) {
  quantize(song, '1/16');
}
