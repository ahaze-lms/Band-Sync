// ════════════════════════════════════════════════════════════════════
// BandSync — Calibration Storage
// ════════════════════════════════════════════════════════════════════
// Per-device latency offsets, persisted in localStorage. The overlay UI
// that measures offsets lives in the screen layer for now — this module
// just owns the storage contract so all callers read/write the same keys.
//
// Storage key format:
//   bandsync_offset_<deviceName>   →  string ms (e.g. "-111")
//
// Future:
//   - Migrate into per-profile storage once profiles UI exists (design
//     doc §4). The data shape will become:
//       profile.calibration[deviceName] = offsetMs
//   - Keep the legacy keys readable so existing calibrations aren't lost.
// ════════════════════════════════════════════════════════════════════

import { STORAGE } from '../config.js';


function key(deviceName) {
  const safe = (deviceName || 'unknown').replace(/\s+/g, '_');
  return STORAGE.offsetPrefix + safe;
}


// Returns the saved offset in ms for a device, or 0 if none stored.
export function loadOffset(deviceName) {
  const raw = localStorage.getItem(key(deviceName));
  if (raw === null) return 0;
  const n = parseInt(raw, 10);
  return isNaN(n) ? 0 : n;
}


// Persist an offset in ms for a device.
export function saveOffset(deviceName, offsetMs) {
  localStorage.setItem(key(deviceName), String(Math.round(offsetMs)));
}


// Wipe a device's saved offset. Useful for "reset to defaults" flows.
export function clearOffset(deviceName) {
  localStorage.removeItem(key(deviceName));
}


// ════════════════════════════════════════════════════════════════
// ROUND ANALYSIS (used by the calibration overlay)
// ════════════════════════════════════════════════════════════════

// Given the flash timestamps and tap timestamps for one calibration
// round, returns { avg, taps, offsets } where avg is the average offset
// in ms (positive = player tapping late, negative = early), or null if
// not enough valid taps to compute a meaningful average.
//
// Taps farther than half a beat from the nearest flash are discarded
// as wild misses.
export function calcRoundOffset(flashTimes, tapTimes, halfBeatMs) {
  if (flashTimes.length < 2 || tapTimes.length < 2) {
    return { avg: null, taps: tapTimes.length, offsets: [] };
  }

  const offsets = [];
  for (const tap of tapTimes) {
    let nearest     = flashTimes[0];
    let nearestDiff = Math.abs(tap - flashTimes[0]);
    for (const f of flashTimes) {
      const d = Math.abs(tap - f);
      if (d < nearestDiff) { nearestDiff = d; nearest = f; }
    }
    if (nearestDiff < halfBeatMs) {
      offsets.push(Math.round(tap - nearest));
    }
  }

  if (offsets.length < 2) {
    return { avg: null, taps: tapTimes.length, offsets };
  }

  const avg = Math.round(offsets.reduce((a, b) => a + b, 0) / offsets.length);
  return { avg, taps: tapTimes.length, offsets };
}
