// ════════════════════════════════════════════════════════════════════
// BandSync — Drum Renderer
// ════════════════════════════════════════════════════════════════════
// Reusable drum-highway view with 12 lanes (one per abstract drum
// name). Same factory pattern as the piano renderer — owns its canvas
// and drawing; caller passes per-frame state.
//
// Each lane has its own intrinsic color (kick = red, snare = purple,
// hi-hat = green, etc.) — those don't change per player. The player's
// accent color shows up in the hit zone, count-off, and hit flash.
//
// Usage:
//   import { createDrumRenderer } from '../js/render/drums.js';
//
//   const drums = createDrumRenderer(canvasEl, {
//     color:       PLAYER_COLORS[1],  // P2 teal default
//     onLaneClick: (abstractName) => { ... },
//   });
//
//   drums.draw({ fallingBlocks, laneFlash, countoff });
//
//   drums.laneX(abstractName)      → x coord on canvas
//   drums.laneIndex(abstractName)  → 0..11
//   drums.isKick(abstractName)
// ════════════════════════════════════════════════════════════════════

import {
  HIGHWAY_H, HIT_Y,
  COUNTOFF_BEATS,
  PLAYER_COLORS,
} from '../config.js';


// ── LANE DEFINITIONS (drum-name palette) ────────────────────────
// Ordering reflects rough physical kit layout — pedals + kick on the
// left, snare next, then hats, then toms, then cymbals.
const LANES = [
  { name: 'HH_PEDAL',  color: '#5DCAA5', stroke: '#9FE1CB', label: 'HH\nPED' },
  { name: 'KICK',      color: '#E24B4A', stroke: '#F09595', label: 'KICK'    },
  { name: 'SNARE',     color: '#7F77DD', stroke: '#AFA9EC', label: 'SNR'     },
  { name: 'SNARE_RIM', color: '#534AB7', stroke: '#7F77DD', label: 'RIM'     },
  { name: 'HH_CLOSED', color: '#5DCAA5', stroke: '#9FE1CB', label: 'HH\nCLS' },
  { name: 'HH_OPEN',   color: '#1D9E75', stroke: '#5DCAA5', label: 'HH\nOPN' },
  { name: 'TOM_1',     color: '#EF9F27', stroke: '#FAC775', label: 'T1'      },
  { name: 'TOM_2',     color: '#BA7517', stroke: '#EF9F27', label: 'T2'      },
  { name: 'TOM_3',     color: '#854F0B', stroke: '#BA7517', label: 'T3'      },
  { name: 'CRASH',     color: '#AFA9EC', stroke: '#CECBF6', label: 'CRS'     },
  { name: 'RIDE',      color: '#888898', stroke: '#aaaabc', label: 'RIDE'    },
  { name: 'RIDE_BELL', color: '#555566', stroke: '#888898', label: 'BELL'    },
];

const LANE_W = 60;
const NOTE_R = 10;    // dot radius for non-kick drums
const KICK_H = 16;    // kick bar height

// Hit-success flash and "GO!" colors — same as piano renderer.
const HIT_PERFECT_FILL   = '#1D9E75';
const HIT_PERFECT_STROKE = '#5DCAA5';
const HIT_FLASH_DURATION = 200;


// ════════════════════════════════════════════════════════════════
// FACTORY
// ════════════════════════════════════════════════════════════════

export function createDrumRenderer(canvas, options = {}) {
  const {
    color       = PLAYER_COLORS[1], // teal default
    onLaneClick = null,
  } = options;

  const CANVAS_W = LANES.length * LANE_W;
  const CANVAS_H = HIGHWAY_H + 48; // +48 for lane labels area

  // Bind canvas
  canvas.width  = CANVAS_W;
  canvas.height = CANVAS_H;
  const ctx = canvas.getContext('2d');

  const laneXFor     = i => i * LANE_W + LANE_W / 2;
  const laneIndexFor = name => LANES.findIndex(l => l.name === name);


  // ── Click input ───────────────────────────────────────────────
  // Click below the highway (in the lane-label area) triggers a hit
  // on that lane. Convenient for testing without a connected kit.
  canvas.addEventListener('click', e => {
    if (!onLaneClick) return;
    const r  = canvas.getBoundingClientRect();
    const mx = (e.clientX - r.left) * (CANVAS_W / r.width);
    const my = (e.clientY - r.top)  * (CANVAS_H / r.height);
    if (my < HIGHWAY_H) return;

    const laneI = Math.floor(mx / LANE_W);
    if (laneI < 0 || laneI >= LANES.length) return;
    onLaneClick(LANES[laneI].name);
  });


  // ══════════════════════════════════════════════════════════════
  // DRAWING
  // ══════════════════════════════════════════════════════════════

  function drawHighway(fallingBlocks, laneFlash) {
    // Background + per-lane shading
    ctx.fillStyle = '#0d0d14';
    ctx.fillRect(0, 0, CANVAS_W, HIGHWAY_H);
    LANES.forEach((lane, i) => {
      ctx.fillStyle = i % 2 === 0 ? '#0d0d14' : '#0f0f18';
      ctx.fillRect(i * LANE_W, 0, LANE_W, HIGHWAY_H);
      ctx.strokeStyle = '#1a1a24'; ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(i * LANE_W, 0);
      ctx.lineTo(i * LANE_W, HIGHWAY_H);
      ctx.stroke();
    });

    // Hit zone (player accent color)
    ctx.fillStyle = hexToRgba(color.stroke, 0.4);
    ctx.fillRect(0, HIT_Y, CANVAS_W, 3);

    // Falling blocks
    const now = performance.now();
    fallingBlocks.forEach(block => {
      const lane = LANES[block.laneIndex];
      let fill   = lane.color;
      let stroke = lane.stroke;
      let alpha  = 0.9;
      if (block.hitQuality) {
        const age = now - block.hitTime;
        if (age < HIT_FLASH_DURATION) {
          fill   = HIT_PERFECT_FILL;
          stroke = HIT_PERFECT_STROKE;
          alpha  = 1 - (age / HIT_FLASH_DURATION) * 0.5;
        }
      }
      ctx.globalAlpha = alpha;
      if (block.isKick) {
        // Wide horizontal bar
        ctx.fillStyle = fill;
        ctx.beginPath();
        ctx.roundRect(block.x - LANE_W * 0.4, block.y - KICK_H / 2, LANE_W * 0.8, KICK_H, 3);
        ctx.fill();
        ctx.strokeStyle = stroke; ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.roundRect(block.x - LANE_W * 0.4, block.y - KICK_H / 2, LANE_W * 0.8, KICK_H, 3);
        ctx.stroke();
      } else {
        // Dot
        ctx.fillStyle = fill;
        ctx.beginPath(); ctx.arc(block.x, block.y, NOTE_R, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = stroke; ctx.lineWidth = 0.5;
        ctx.beginPath(); ctx.arc(block.x, block.y, NOTE_R, 0, Math.PI * 2); ctx.stroke();
        // Highlight
        ctx.fillStyle = 'rgba(255,255,255,0.15)';
        ctx.beginPath(); ctx.arc(block.x - 3, block.y - 3, NOTE_R * 0.4, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
    });

    // Hit zone label
    ctx.fillStyle = hexToRgba(color.stroke, 0.3);
    ctx.font = '9px Segoe UI'; ctx.textAlign = 'left';
    ctx.fillText('HIT ZONE', 4, HIT_Y - 4);

    // Lane label band at the bottom (with flash indicators)
    ctx.fillStyle = '#0a0a0f';
    ctx.fillRect(0, HIGHWAY_H, CANVAS_W, 48);
    ctx.strokeStyle = '#1a1a26'; ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(0, HIGHWAY_H); ctx.lineTo(CANVAS_W, HIGHWAY_H); ctx.stroke();

    LANES.forEach((lane, i) => {
      const cx       = laneXFor(i);
      const flashAge = laneFlash[lane.name] ? now - laneFlash[lane.name] : Infinity;
      const flashing = flashAge < 120;

      // Lane indicator dot
      ctx.fillStyle = flashing ? lane.color : '#1a1a26';
      ctx.beginPath(); ctx.arc(cx, HIGHWAY_H + 10, 5, 0, Math.PI * 2); ctx.fill();

      // Lane label
      const lines = lane.label.split('\n');
      ctx.fillStyle = flashing ? lane.stroke : '#444';
      ctx.font = '8px Segoe UI'; ctx.textAlign = 'center';
      lines.forEach((line, li) => {
        ctx.fillText(line, cx, HIGHWAY_H + 24 + li * 11);
      });

      // Vertical divider in the label area
      ctx.strokeStyle = '#1a1a26'; ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(i * LANE_W, HIGHWAY_H);
      ctx.lineTo(i * LANE_W, HIGHWAY_H + 48);
      ctx.stroke();
    });
  }

  function drawCountoff(beatNum, beatProgress) {
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(0, 0, CANVAS_W, HIGHWAY_H);

    const beatStr = beatNum <= COUNTOFF_BEATS ? String(beatNum) : 'GO!';
    const scale   = 1 - beatProgress * 0.2;
    const isGo    = beatNum > COUNTOFF_BEATS;

    ctx.save();
    ctx.translate(CANVAS_W / 2, HIGHWAY_H / 2);
    ctx.scale(scale, scale);
    ctx.fillStyle = isGo ? '#085041' : darken(color.fill);
    ctx.font = '500 90px Segoe UI'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(beatStr, 2, 2);
    ctx.fillStyle = isGo ? '#9FE1CB' : color.accent;
    ctx.font = '500 86px Segoe UI';
    ctx.fillText(beatStr, 0, 0);
    ctx.restore();

    // Beat dots
    for (let i = 0; i < COUNTOFF_BEATS; i++) {
      ctx.beginPath();
      ctx.arc(
        CANVAS_W / 2 - ((COUNTOFF_BEATS - 1) / 2) * 24 + i * 24,
        HIGHWAY_H - 24, 5, 0, Math.PI * 2,
      );
      ctx.fillStyle = i < beatNum ? color.stroke : '#1a1a26';
      ctx.fill();
    }
  }


  // ══════════════════════════════════════════════════════════════
  // PUBLIC API
  // ══════════════════════════════════════════════════════════════

  return {
    draw({ fallingBlocks = [], laneFlash = {}, countoff = null } = {}) {
      ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
      drawHighway(fallingBlocks, laneFlash);
      if (countoff) drawCountoff(countoff.beatNum, countoff.beatProgress);
    },

    // ── Position helpers ──────────────────────────────────────
    laneX:        name => laneXFor(laneIndexFor(name)),
    laneIndex:    name => laneIndexFor(name),
    laneByIndex:  i    => LANES[i],
    isKick:       name => name === 'KICK',
    isValidLane:  name => laneIndexFor(name) >= 0,

    // ── Geometry getters ──────────────────────────────────────
    getCanvasWidth:  () => CANVAS_W,
    getCanvasHeight: () => CANVAS_H,
    getLanes:        () => LANES.slice(),
  };
}


// ════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════

function hexToRgba(hex, alpha) {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function darken(hex) {
  const h = hex.replace('#', '');
  const r = Math.floor(parseInt(h.substring(0, 2), 16) * 0.75);
  const g = Math.floor(parseInt(h.substring(2, 4), 16) * 0.75);
  const b = Math.floor(parseInt(h.substring(4, 6), 16) * 0.75);
  return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
}
