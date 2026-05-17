// ════════════════════════════════════════════════════════════════════
// BandSync — Shared Configuration
// ════════════════════════════════════════════════════════════════════
// All numeric constants and lookup tables used across the engine live
// here. Anything tweakable should land in this file so the rest of the
// codebase reads cleanly.
// ════════════════════════════════════════════════════════════════════


// ── HIGHWAY (shared between piano and drum renderers) ───────────
// The falling-note area is fixed at 400px tall regardless of view.
export const HIGHWAY_H   = 400;
export const HIT_Y       = HIGHWAY_H - 4;   // hit zone line
export const PREVIEW_ZONE = HIGHWAY_H * 0.3; // key-preview glow zone


// ── SPEED SYSTEM ────────────────────────────────────────────────
// Fall time = how long a note takes to travel from the top of the
// highway to the hit zone. Speed is defined as a duration (intuitive
// and frame-rate independent), not pixels-per-frame.
//
// Level 1 = 4.0s (very slow)   Level 10 = 0.5s (insane)
export const FALL_TIMES_MS = [4000, 3500, 3000, 2500, 2000, 1700, 1400, 1100, 800, 500];
export const DEFAULT_SPEED_LEVEL = 3; // 3.0s — comfortable default


// ── HIT WINDOWS ─────────────────────────────────────────────────
// Per-difficulty timing tolerances. A press within ±perfect ms of the
// expected hit time counts as PERFECT; within ±good ms counts as GOOD.
//
// Levels run easiest (1) to brutal (7). Practice and Beginner are
// generously loose for kids who are still building motor timing — at
// ±250ms PERFECT they can be off by a quarter-second and still get
// the full reward.
export const HIT_WINDOWS = [
  { name: 'Practice',  perfect: 250, good: 500 },
  { name: 'Beginner',  perfect: 180, good: 350 },
  { name: 'Very Easy', perfect: 120, good: 200 },
  { name: 'Easy',      perfect: 80,  good: 160 },
  { name: 'Normal',    perfect: 40,  good: 80  },
  { name: 'Hard',      perfect: 25,  good: 50  },
  { name: 'Expert',    perfect: 15,  good: 30  },
];
export const DEFAULT_HIT_WINDOW_LEVEL = 4; // Easy (same feel as the old default)


// ── COUNT-OFF ───────────────────────────────────────────────────
// Always fires at song start. Notes fall DURING the count-off so beat
// 1 of the song arrives at the hit zone exactly as the count-off ends.
// See design doc §7 — Timing Architecture.
export const COUNTOFF_BEATS     = 4;
export const COUNTOFF_BPM       = 80; // TODO: match song BPM when MIDI tempo is exposed
export const BEAT_MS            = 60000 / COUNTOFF_BPM;  // 750ms
export const COUNTOFF_TOTAL_MS  = BEAT_MS * COUNTOFF_BEATS; // 3000ms


// ── LATENCY CALIBRATION ─────────────────────────────────────────
// Three 10-second rounds at 80 BPM. Player taps each flash; the engine
// measures the offset between flash time and tap arrival and averages.
export const CAL_ROUNDS    = 3;
export const CAL_ROUND_MS  = 10000;
export const CAL_BPM       = 80;
export const CAL_BEAT_MS   = 60000 / CAL_BPM;
export const CAL_FLASH_MS  = 80; // how long the circle stays lit


// ── PIANO KEYBOARD ──────────────────────────────────────────────
// Default keyboard range. TODO: pick range per song / per player.
export const PIANO_NOTE_MIN = 48; // C3
export const PIANO_NOTE_MAX = 84; // C6

export const NOTE_NAMES  = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
export const KEY_PATTERN = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0]; // 1 = black key


// ── SCORING ─────────────────────────────────────────────────────
export const PERFECT_POINTS = 100;
export const GOOD_POINTS    = 50;

// Combo multiplier tiers — every COMBO_STEP hits bumps to the next tier.
export const COMBO_STEP  = 10;
export const COMBO_TIERS = [1, 2, 4, 8]; // x1 → x2 → x4 → x8

// Grade thresholds, descending — first match wins.
export const GRADE_THRESHOLDS = [
  { grade: 'S', min: 95 },
  { grade: 'A', min: 85 },
  { grade: 'B', min: 70 },
  { grade: 'C', min: 50 },
  { grade: 'D', min: 0  },
];


// ── DRUMS ───────────────────────────────────────────────────────
// Abstract drum names — the game layer never touches raw MIDI numbers.
// A per-device mapping (stored in localStorage) translates between the
// two. Add more names here as we support cymbal zones, V-drums, etc.
export const DRUM_NAMES = [
  'KICK', 'SNARE', 'SNARE_RIM',
  'HH_CLOSED', 'HH_OPEN', 'HH_PEDAL',
  'TOM_1', 'TOM_2', 'TOM_3',
  'CRASH', 'RIDE', 'RIDE_BELL',
];

// Default Simmons SD5X mapping. Used as a starting point — players can
// override via the drum_monitor mapping tool.
export const DEFAULT_DRUM_MAPPING_SD5X = {
  75: 'KICK',
  54: 'SNARE',
  31: 'HH_CLOSED',
  40: 'HH_OPEN',
  68: 'HH_PEDAL',
  19: 'TOM_1',
  79: 'TOM_2',
  37: 'TOM_3',
  46: 'CRASH',
};


// ── LOCALSTORAGE KEYS ───────────────────────────────────────────
// One place to register every key we read/write so we don't sprinkle
// hard-coded strings through the codebase.
export const STORAGE = {
  offsetPrefix:  'bandsync_offset_',   // + deviceName → ms (latency)
  drumMapPrefix: 'bandsync_drummap_',  // + deviceName → JSON mapping
  // Future:
  // profiles: 'bandsync_profiles',
  // sessions: 'bandsync_sessions',
};


// ── PLAYER COLORS ───────────────────────────────────────────────
// Each player has an accent color that runs through everything they
// touch — notes, score card, key highlights. Defaults below; players
// can override via their profile (when profiles UI exists).
export const PLAYER_COLORS = [
  { name: 'Purple', fill: '#534AB7', stroke: '#7F77DD', accent: '#AFA9EC', soft: '#CECBF6' },
  { name: 'Teal',   fill: '#0F6E56', stroke: '#1D9E75', accent: '#5DCAA5', soft: '#9FE1CB' },
  { name: 'Amber',  fill: '#854F0B', stroke: '#BA7517', accent: '#EF9F27', soft: '#FAC775' },
  { name: 'Red',    fill: '#8B2A29', stroke: '#E24B4A', accent: '#F09595', soft: '#F5BABA' },
];
