// ════════════════════════════════════════════════════════════════════
// BandSync — Audio Engine
// ════════════════════════════════════════════════════════════════════
// Single shared AudioContext. All sound goes through here:
//   - playPianoNote(midiNote, velocity)   — triangle wave at pitch
//   - playDrumSound(abstractName, velocity) — synthesized drum kit
//   - playClick()                         — metronome / calibration click
//
// AudioContext starts suspended until a user gesture. Every public
// play function calls resumeIfSuspended() so callers don't have to.
//
// Future: swap synthesis for real piano samples + drum samples loaded
// from /samples/. Keep the function signatures stable.
// ════════════════════════════════════════════════════════════════════


// ── Shared AudioContext (lazy singleton) ────────────────────────
let _ctx = null;

export function getAudioContext() {
  if (!_ctx) _ctx = new (window.AudioContext || window.webkitAudioContext)();
  return _ctx;
}

export function resumeIfSuspended() {
  const ctx = getAudioContext();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}


// ════════════════════════════════════════════════════════════════
// PIANO
// ════════════════════════════════════════════════════════════════

// Plays a single piano note as a triangle wave at the correct pitch.
// Velocity 0..127 controls volume. Decays over 0.8s.
//
// TODO: replace with sampled piano (one sample per octave, pitch-shift
// for intermediate notes via AudioBufferSourceNode).
export function playPianoNote(midiNote, velocity = 80) {
  const ctx  = resumeIfSuspended();
  const t    = ctx.currentTime;
  const freq = 440 * Math.pow(2, (midiNote - 69) / 12);
  const vol  = (velocity / 127) * 0.3;

  const osc  = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(freq, t);
  gain.gain.setValueAtTime(vol, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.8);
  osc.start(t);
  osc.stop(t + 0.8);
}


// ════════════════════════════════════════════════════════════════
// DRUMS
// ════════════════════════════════════════════════════════════════

// Plays a synthesized drum sound for the given abstract name. Each kit
// piece has its own synthesis recipe. Velocity 0..127 controls volume.
//
// TODO: replace with sampled drums (one sample per abstract name).
export function playDrumSound(abstractName, velocity = 80) {
  const ctx = resumeIfSuspended();
  const t   = ctx.currentTime;
  const vol = (velocity / 127) * 0.6;

  switch (true) {
    case abstractName === 'KICK': {
      // Low sine sweep
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(150, t);
      osc.frequency.exponentialRampToValueAtTime(40, t + 0.15);
      gain.gain.setValueAtTime(vol, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
      osc.start(t); osc.stop(t + 0.35);
      break;
    }

    case abstractName === 'SNARE' || abstractName === 'SNARE_RIM': {
      // Bandpass noise burst
      playNoise(ctx, t, vol * 0.8, 0.18, {
        type: 'bandpass',
        frequency: abstractName === 'SNARE_RIM' ? 1200 : 2500,
      });
      break;
    }

    case abstractName === 'HH_CLOSED' || abstractName === 'HH_PEDAL': {
      // Short highpass noise — metallic chick
      playNoise(ctx, t, vol * 0.5, 0.08, { type: 'highpass', frequency: 8000 });
      break;
    }

    case abstractName === 'HH_OPEN': {
      // Longer highpass noise
      playNoise(ctx, t, vol * 0.45, 0.4, { type: 'highpass', frequency: 7000 });
      break;
    }

    case abstractName === 'CRASH': {
      // Long bandpass noise shimmer
      playNoise(ctx, t, vol * 0.5, 0.8, { type: 'bandpass', frequency: 5000, Q: 0.5 });
      break;
    }

    case abstractName === 'RIDE' || abstractName === 'RIDE_BELL': {
      // Triangle ping
      const isBell = abstractName === 'RIDE_BELL';
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.type = 'triangle';
      osc.frequency.value = isBell ? 1200 : 800;
      gain.gain.setValueAtTime(vol * 0.4, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + (isBell ? 0.6 : 0.3));
      osc.start(t); osc.stop(t + 0.6);
      break;
    }

    case abstractName.startsWith('TOM'): {
      // Pitched sine thud
      const baseFreq = abstractName === 'TOM_1' ? 180
                     : abstractName === 'TOM_2' ? 130
                     : 90; // TOM_3
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(baseFreq * 1.5, t);
      osc.frequency.exponentialRampToValueAtTime(baseFreq, t + 0.08);
      gain.gain.setValueAtTime(vol * 0.7, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
      osc.start(t); osc.stop(t + 0.25);
      break;
    }
  }
}

// Filtered white noise burst — used by snare, hi-hat, crash.
function playNoise(ctx, t, vol, duration, filterOpts) {
  const bufSize = Math.floor(ctx.sampleRate * duration);
  const buf     = ctx.createBuffer(1, bufSize, ctx.sampleRate);
  const data    = buf.getChannelData(0);
  for (let i = 0; i < bufSize; i++) data[i] = Math.random() * 2 - 1;

  const src    = ctx.createBufferSource();
  src.buffer   = buf;
  const filter = ctx.createBiquadFilter();
  filter.type            = filterOpts.type;
  filter.frequency.value = filterOpts.frequency;
  if (filterOpts.Q != null) filter.Q.value = filterOpts.Q;

  const gain = ctx.createGain();
  src.connect(filter); filter.connect(gain); gain.connect(ctx.destination);
  gain.gain.setValueAtTime(vol, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + duration * 0.95);
  src.start(t); src.stop(t + duration);
}


// ════════════════════════════════════════════════════════════════
// METRONOME / CALIBRATION CLICK
// ════════════════════════════════════════════════════════════════

// Short 880Hz sine blip. Used for count-off beats and calibration flashes.
export function playClick(volume = 0.25) {
  const ctx  = resumeIfSuspended();
  const t    = ctx.currentTime;
  const osc  = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain); gain.connect(ctx.destination);
  osc.type = 'sine';
  osc.frequency.setValueAtTime(880, t);
  gain.gain.setValueAtTime(volume, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
  osc.start(t); osc.stop(t + 0.06);
}
