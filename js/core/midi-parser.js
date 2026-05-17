// ════════════════════════════════════════════════════════════════════
// BandSync — MIDI File Parser
// ════════════════════════════════════════════════════════════════════
// Reads a Standard MIDI File (.mid) and returns per-track note data.
//
// The original piano_debug parser merged every track into one flat
// list. For multi-player support we keep tracks separate so the user
// can assign each one to a player at song select.
//
// Returned shape:
//   {
//     tpb:    480,         // ticks per beat (from MThd)
//     tempo:  500000,      // microseconds per quarter (last tempo event)
//     tracks: [
//       {
//         index:    0,
//         name:     'Piano',     // from FF 03 meta event, or 'Track 1'
//         channel:  0,           // MIDI channel of first note (0-15)
//         isDrum:   false,       // channel 9 (i.e. MIDI ch 10) = drums
//         roleHint: 'piano',     // 'piano' | 'drums' | 'unknown'
//         notes:    [
//           { note, vel, startMs, durMs }
//         ]
//       },
//       ...
//     ]
//   }
//
// Tempo changes mid-song aren't supported yet — we use the last tempo
// event encountered. Most rhythm-game MIDI files use a single tempo.
// ════════════════════════════════════════════════════════════════════


export function parseMIDIFile(arrayBuffer) {
  const data = new DataView(arrayBuffer);
  let pos = 0;

  // ── Helpers ───────────────────────────────────────────────────
  const u32 = () => { const v = data.getUint32(pos); pos += 4; return v; };
  const u16 = () => { const v = data.getUint16(pos); pos += 2; return v; };
  const u8  = () => data.getUint8(pos++);
  const vl  = () => {
    let val = 0, b;
    do { b = u8(); val = (val << 7) | (b & 0x7F); } while (b & 0x80);
    return val;
  };
  const readText = (len) => {
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(u8());
    return s;
  };

  // ── Header (MThd) ─────────────────────────────────────────────
  pos += 4;            // 'MThd'
  pos += 4;            // header length (always 6)
  u16();               // format type (0/1/2) — we don't differentiate
  const nTracks = u16();
  const tpb     = u16();

  let tempo = 500000;          // 120 BPM default
  const tracks = [];

  // ── Per-track parse ───────────────────────────────────────────
  for (let t = 0; t < nTracks; t++) {
    pos += 4;                  // 'MTrk'
    const tLen   = u32();
    const tEnd   = pos + tLen;

    let tick   = 0;
    let lastSt = 0;
    let name   = `Track ${t + 1}`;
    let firstChannel = null;
    const ons   = {};          // { note: { tick, vel } } — pending note-ons
    const notes = [];

    while (pos < tEnd) {
      tick += vl();
      let st = data.getUint8(pos);
      if (st & 0x80) { lastSt = st; pos++; } else { st = lastSt; }
      const type    = st & 0xF0;
      const channel = st & 0x0F;

      if (st === 0xFF) {
        // Meta event: FF type len data
        // (Check full status byte, not masked `type` — `st & 0xF0` tops at 0xF0
        //  so `type === 0xFF` would never match and meta events would silently
        //  fall through to the sysex branch, dropping tempo and track names.)
        const mt = u8();
        const ml = vl();
        if (mt === 0x51 && ml === 3) {
          // Tempo: 24-bit microseconds per quarter
          tempo = (u8() << 16) | (u8() << 8) | u8();
        } else if (mt === 0x03) {
          // Track name
          name = readText(ml).trim() || name;
        } else {
          pos += ml;
        }

      } else if (type === 0xF0 || type === 0xF7) {
        // Sysex / escape — skip
        pos += vl();

      } else if (type === 0x90 && data.getUint8(pos + 1) > 0) {
        // Note ON
        const note = u8(), vel = u8();
        ons[note] = { tick, vel };
        if (firstChannel === null) firstChannel = channel;

      } else if (type === 0x80 || (type === 0x90 && data.getUint8(pos + 1) === 0)) {
        // Note OFF (or note-on with vel 0)
        const note = u8();
        pos++;                 // velocity, unused
        const on = ons[note];
        if (on) {
          notes.push({
            note,
            vel:     on.vel,
            startMs: (on.tick / tpb) * (tempo / 1000),
            durMs:   ((tick - on.tick) / tpb) * (tempo / 1000),
          });
          delete ons[note];
        }

      } else if (type === 0xA0 || type === 0xB0 || type === 0xE0) {
        // Polyphonic aftertouch / CC / pitch bend — 2 data bytes
        pos += 2;
      } else if (type === 0xC0 || type === 0xD0) {
        // Program change / channel pressure — 1 data byte
        pos += 1;
      } else {
        // Unknown — best-effort skip
        pos++;
      }
    }

    pos = tEnd;
    notes.sort((a, b) => a.startMs - b.startMs);

    const channel = firstChannel ?? 0;
    const isDrum  = channel === 9; // MIDI channel 10 (zero-indexed 9)
    const roleHint = guessRole(name, isDrum, notes);

    tracks.push({
      index: t,
      name,
      channel,
      isDrum,
      roleHint,
      notes,
    });
  }

  return { tpb, tempo, tracks };
}


// ════════════════════════════════════════════════════════════════
// ROLE GUESSING
// ════════════════════════════════════════════════════════════════

// Best-effort guess at which player role a track should map to.
// Returns 'piano' | 'drums' | 'unknown'.
function guessRole(name, isDrum, notes) {
  if (isDrum) return 'drums';

  const n = name.toLowerCase();
  if (/drum|kick|snare|hat|cymbal|perc/.test(n)) return 'drums';
  // Melodic instrument names — all collapse to 'piano' until bass/guitar/
  // vocal views ship (DESIGN.md §15: bass v1.5, guitar v2.0, vocals v2.5).
  // Add the new role here when those views land.
  if (/piano|keys?|synth|epiano|rhodes|organ|bass|guitar|gtr|vocal|vox|melody|lead|harm/.test(n)) return 'piano';

  // No name hint — fall back to note-range heuristic.
  if (notes.length === 0) return 'unknown';
  const lo = Math.min(...notes.map(n => n.note));
  const hi = Math.max(...notes.map(n => n.note));
  // GM drum kit lives at MIDI 35–51; the old upper bound of 60 caught
  // low piano/bass notes and misclassified them.
  if (lo >= 35 && hi <= 51) return 'drums';
  return 'piano';
}
