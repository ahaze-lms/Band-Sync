// ════════════════════════════════════════════════════════════════════
// BandSync — Drum Mapping
// ════════════════════════════════════════════════════════════════════
// Translates raw MIDI note numbers into abstract drum names. Each
// physical kit has its own mapping (different kits send different notes
// for the same pad) — mappings are stored per device.
//
// Game logic NEVER references raw note numbers. It only knows abstract
// names like KICK, SNARE, HH_CLOSED. This is what makes kits swappable.
//
// Storage key format:
//   bandsync_drummap_<deviceName>  →  JSON { "75": "KICK", ... }
//
// Future:
//   - Mappings will move into per-profile storage when profiles UI lands.
//   - Keep this module's API stable so callers don't need to change.
// ════════════════════════════════════════════════════════════════════

import { STORAGE, DEFAULT_DRUM_MAPPING_SD5X } from '../config.js';


function key(deviceName) {
  const safe = (deviceName || 'unknown').replace(/\s+/g, '_');
  return STORAGE.drumMapPrefix + safe;
}


// Returns the stored mapping for a device, or {} if none stored.
// The result is { midiNote: abstractName, ... }.
export function loadMapping(deviceName) {
  const raw = localStorage.getItem(key(deviceName));
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch (e) {
    return {};
  }
}


// Save a full mapping for a device.
export function saveMapping(deviceName, mapping) {
  localStorage.setItem(key(deviceName), JSON.stringify(mapping));
}


// Save just one pad's mapping. Merges with the existing mapping.
export function setPad(deviceName, midiNote, abstractName) {
  const m = loadMapping(deviceName);
  m[midiNote] = abstractName;
  saveMapping(deviceName, m);
}


// Wipe a device's mapping.
export function clearMapping(deviceName) {
  localStorage.removeItem(key(deviceName));
}


// Returns true if this device has any saved mapping.
export function hasMapping(deviceName) {
  return localStorage.getItem(key(deviceName)) !== null;
}


// ════════════════════════════════════════════════════════════════
// LOOKUP HELPERS
// ════════════════════════════════════════════════════════════════

// Returns the abstract drum name for a MIDI note, given a mapping.
// Returns null if the pad isn't mapped.
export function lookupAbstractName(mapping, midiNote) {
  return mapping[midiNote] ?? null;
}


// Returns the default Simmons SD5X mapping. Useful as a fallback when
// no per-device mapping has been saved yet.
export function getDefaultMapping() {
  return { ...DEFAULT_DRUM_MAPPING_SD5X };
}
