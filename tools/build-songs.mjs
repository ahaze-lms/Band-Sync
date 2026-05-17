// ════════════════════════════════════════════════════════════════════
// BandSync — Bundled Song Generator
// ════════════════════════════════════════════════════════════════════
// One-shot dev tool. NOT part of the runtime — BandSync still has no
// build step. Run this manually to regenerate the .mid files in /songs.
//
//   node tools/build-songs.mjs
//
// Each song is a hand-transcribed public-domain melody encoded as
// [pitch, beats] tuples (pitch = MIDI note, or null for a rest). The
// script emits standard MIDI File format 1 with a conductor track
// (tempo + time-sig) and a single piano track named "Piano" so the
// game's role-guesser picks it up automatically.
//
// Licensing: melodies are PD (composition); the arrangements emitted
// here are dedicated to the public domain (CC0). See songs/README.md.
// ════════════════════════════════════════════════════════════════════

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const SONGS_DIR  = join(__dirname, '..', 'songs');
const TPB        = 480;   // ticks per quarter note

// ── MIDI binary helpers ───────────────────────────────────────────

function vlq(n) {
  const out = [n & 0x7F];
  n >>>= 7;
  while (n > 0) { out.unshift((n & 0x7F) | 0x80); n >>>= 7; }
  return out;
}
const be16 = n => [(n >> 8) & 0xFF, n & 0xFF];
const be24 = n => [(n >> 16) & 0xFF, (n >> 8) & 0xFF, n & 0xFF];
const be32 = n => [(n >>> 24) & 0xFF, (n >>> 16) & 0xFF, (n >>> 8) & 0xFF, n & 0xFF];
const ascii = s => [...s].map(c => c.charCodeAt(0));

function trackChunk(events) {
  const data = [];
  for (const e of events) data.push(...vlq(e.delta), ...e.bytes);
  data.push(0x00, 0xFF, 0x2F, 0x00);    // End of Track
  return [...ascii('MTrk'), ...be32(data.length), ...data];
}

function headerChunk(numTracks) {
  return [
    ...ascii('MThd'),
    ...be32(6),
    ...be16(1),                          // format 1
    ...be16(numTracks),
    ...be16(TPB),
  ];
}

// ── Event builders ────────────────────────────────────────────────

const tempoEvent = bpm => ({
  delta: 0,
  bytes: [0xFF, 0x51, 0x03, ...be24(Math.round(60_000_000 / bpm))],
});
const timeSigEvent = (num, den) => ({
  delta: 0,
  bytes: [0xFF, 0x58, 0x04, num, Math.log2(den), 24, 8],
});
const trackNameEvent = name => {
  const t = ascii(name);
  return { delta: 0, bytes: [0xFF, 0x03, ...vlq(t.length), ...t] };
};

// Build a piano track from [pitch, beats] tuples (pitch null = rest).
function buildPianoTrack(name, notes, { channel = 0, velocity = 96 } = {}) {
  const events = [trackNameEvent(name), { delta: 0, bytes: [0xC0 | channel, 0] }];
  let restTicks = 0;
  for (const [pitch, beats] of notes) {
    const dur = Math.round(beats * TPB);
    if (pitch === null) { restTicks += dur; continue; }
    events.push({ delta: restTicks,  bytes: [0x90 | channel, pitch, velocity] });
    events.push({ delta: dur,        bytes: [0x80 | channel, pitch, 0] });
    restTicks = 0;
  }
  return events;
}

// tracks: [{ name, notes, channel? }]  — channel auto-assigns 0,1,2,...
function writeSong(filename, { bpm, tracks }) {
  const conductor = [tempoEvent(bpm), timeSigEvent(4, 4)];
  const trackChunks = tracks.map((t, i) =>
    trackChunk(buildPianoTrack(t.name, t.notes, { channel: t.channel ?? i }))
  );
  const bytes = [
    ...headerChunk(1 + tracks.length),
    ...trackChunk(conductor),
    ...trackChunks.flat(),
  ];
  mkdirSync(SONGS_DIR, { recursive: true });
  writeFileSync(join(SONGS_DIR, filename), Buffer.from(bytes));
  const totalNotes = tracks.reduce((s, t) => s + t.notes.filter(n => n[0] !== null).length, 0);
  const trackList  = tracks.map(t => t.name).join(' + ');
  console.log(`  ✓ ${filename.padEnd(36)} ${String(totalNotes).padStart(3)} notes @ ${bpm} BPM (${trackList})`);
}

// ── Pitch shorthand (middle-C octave centered) ────────────────────

const C3=48, D3=50, E3=52, F3=53, G3=55, A3=57, B3=59,
      C4=60, D4=62, E4=64, F4=65, G4=67, A4=69, B4=71,
      C5=72, D5=74, E5=76, F5=77, G5=79;
const _ = null;

// ── Songs ─────────────────────────────────────────────────────────

// Twinkle Twinkle Little Star — C major, single-octave melody.
// Composition: French folk melody "Ah! vous dirai-je, maman" (1761). PD.
const TWINKLE = [
  [C4,1],[C4,1],[G4,1],[G4,1],[A4,1],[A4,1],[G4,2],
  [F4,1],[F4,1],[E4,1],[E4,1],[D4,1],[D4,1],[C4,2],
  [G4,1],[G4,1],[F4,1],[F4,1],[E4,1],[E4,1],[D4,2],
  [G4,1],[G4,1],[F4,1],[F4,1],[E4,1],[E4,1],[D4,2],
  [C4,1],[C4,1],[G4,1],[G4,1],[A4,1],[A4,1],[G4,2],
  [F4,1],[F4,1],[E4,1],[E4,1],[D4,1],[D4,1],[C4,2],
];

// Mary Had a Little Lamb — C major. Composition: Lowell Mason (1830). PD.
const MARY = [
  [E4,1],[D4,1],[C4,1],[D4,1],[E4,1],[E4,1],[E4,2],
  [D4,1],[D4,1],[D4,2],          [E4,1],[G4,1],[G4,2],
  [E4,1],[D4,1],[C4,1],[D4,1],[E4,1],[E4,1],[E4,1],[E4,1],
  [D4,1],[D4,1],[E4,1],[D4,1],[C4,4],
];

// Ode to Joy (Beethoven, 9th Symphony theme, 1824). PD.
const ODE_TO_JOY = [
  [E4,1],[E4,1],[F4,1],[G4,1],  [G4,1],[F4,1],[E4,1],[D4,1],
  [C4,1],[C4,1],[D4,1],[E4,1],  [E4,1.5],[D4,0.5],[D4,2],
  [E4,1],[E4,1],[F4,1],[G4,1],  [G4,1],[F4,1],[E4,1],[D4,1],
  [C4,1],[C4,1],[D4,1],[E4,1],  [D4,1.5],[C4,0.5],[C4,2],
  [D4,1],[D4,1],[E4,1],[C4,1],  [D4,1],[E4,0.5],[F4,0.5],[E4,1],[C4,1],
  [D4,1],[E4,0.5],[F4,0.5],[E4,1],[D4,1],  [C4,1],[D4,1],[G3,2],
  [E4,1],[E4,1],[F4,1],[G4,1],  [G4,1],[F4,1],[E4,1],[D4,1],
  [C4,1],[C4,1],[D4,1],[E4,1],  [D4,1.5],[C4,0.5],[C4,2],
];

// Frère Jacques (traditional, 18th century). PD.
const FRERE_JACQUES = [
  [C4,1],[D4,1],[E4,1],[C4,1],   [C4,1],[D4,1],[E4,1],[C4,1],
  [E4,1],[F4,1],[G4,2],          [E4,1],[F4,1],[G4,2],
  [G4,0.5],[A4,0.5],[G4,0.5],[F4,0.5],[E4,1],[C4,1],
  [G4,0.5],[A4,0.5],[G4,0.5],[F4,0.5],[E4,1],[C4,1],
  [C4,1],[G3,1],[C4,2],          [C4,1],[G3,1],[C4,2],
];

// Twinkle Twinkle bass line — standard I-IV-V harmonization, half-note roots.
// Pairs with TWINKLE as a melody+bass duet (one octave below the melody).
const TWINKLE_BASS = [
  [C3,2],[C3,2],   // bar 1  (C   – Twinkle twinkle)
  [F3,2],[C3,2],   // bar 2  (F C – little star)
  [F3,2],[C3,2],   // bar 3  (F C – How I wonder)
  [G3,2],[C3,2],   // bar 4  (G C – what you are)
  [C3,2],[G3,2],   // bar 5  (C G – Up above the)
  [C3,2],[G3,2],   // bar 6  (C G – world so high)
  [C3,2],[G3,2],   // bar 7  (C G – Like a diamond)
  [C3,2],[G3,2],   // bar 8  (C G – in the sky)
  [C3,2],[C3,2],   // bar 9   (repeat of bars 1–4)
  [F3,2],[C3,2],   // bar 10
  [F3,2],[C3,2],   // bar 11
  [G3,2],[C3,2],   // bar 12
];

// When the Saints Go Marching In (traditional spiritual). PD.
const SAINTS = [
  [_,1],[C4,1],[E4,1],[F4,1],   [G4,3],[_,1],
  [_,1],[C4,1],[E4,1],[F4,1],   [G4,3],[_,1],
  [_,1],[C4,1],[E4,1],[F4,1],   [G4,2],[E4,1],[C4,1],
  [E4,2],[D4,2],                [_,4],
  [_,1],[E4,1],[E4,1],[D4,1],   [C4,2],[C4,1],[E4,1],
  [G4,2],[G4,1],[F4,1],         [E4,3],[F4,1],
  [G4,1],[E4,1],[C4,1],[D4,1],  [C4,4],
];

// ── Run ───────────────────────────────────────────────────────────

console.log('Generating bundled songs →', SONGS_DIR);
writeSong('twinkle-twinkle.mid', {
  bpm: 100,
  tracks: [{ name: 'Piano', notes: TWINKLE }],
});
writeSong('twinkle-twinkle-duet.mid', {
  bpm: 100,
  tracks: [
    { name: 'Melody', notes: TWINKLE },
    { name: 'Bass',   notes: TWINKLE_BASS },
  ],
});
writeSong('mary-had-a-little-lamb.mid', {
  bpm: 96,
  tracks: [{ name: 'Piano', notes: MARY }],
});
writeSong('ode-to-joy.mid', {
  bpm: 112,
  tracks: [{ name: 'Piano', notes: ODE_TO_JOY }],
});
writeSong('frere-jacques.mid', {
  bpm: 108,
  tracks: [{ name: 'Piano', notes: FRERE_JACQUES }],
});
writeSong('saints-go-marching-in.mid', {
  bpm: 120,
  tracks: [{ name: 'Piano', notes: SAINTS }],
});
console.log('Done.');
