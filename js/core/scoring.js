// ════════════════════════════════════════════════════════════════════
// BandSync — Scoring
// ════════════════════════════════════════════════════════════════════
// Each player has their own Scorer. The factory below returns a fresh
// scorer with isolated state so two players' scores don't bleed into
// each other.
//
// Usage:
//   const scorer = createScorer();
//   scorer.registerHit('perfect');  // PERFECT/GOOD increment combo + score
//   scorer.registerMiss();          // breaks combo, miss++
//   scorer.registerWrong();         // wrong note: no combo effect, wrong++
//   scorer.getStats();              // { score, combo, maxCombo, perfect, good, miss, wrong, accuracy, grade }
//   scorer.reset();                 // back to zero
// ════════════════════════════════════════════════════════════════════

import {
  PERFECT_POINTS,
  GOOD_POINTS,
  COMBO_STEP,
  COMBO_TIERS,
  GRADE_THRESHOLDS,
} from '../config.js';


export function createScorer() {
  let score    = 0;
  let combo    = 0;
  let maxCombo = 0;
  let perfect  = 0;
  let good     = 0;
  let miss     = 0;
  let wrong    = 0;

  function multiplier() {
    // Tier index = floor(combo / COMBO_STEP), capped at the last tier.
    const tier = Math.min(Math.floor(combo / COMBO_STEP), COMBO_TIERS.length - 1);
    return COMBO_TIERS[tier];
  }

  function accuracy() {
    const total = perfect + good + miss;
    if (total === 0) return null;
    return Math.round(((perfect + good) / total) * 100);
  }

  function grade() {
    const acc = accuracy();
    if (acc === null) return null;
    for (const t of GRADE_THRESHOLDS) {
      if (acc >= t.min) return t.grade;
    }
    return 'D';
  }

  return {
    // ── State mutations ───────────────────────────────────────
    registerHit(quality) {
      const mult = multiplier();
      if (quality === 'perfect') { score += PERFECT_POINTS * mult; perfect++; }
      else                        { score += GOOD_POINTS    * mult; good++;    }
      combo++;
      if (combo > maxCombo) maxCombo = combo;
    },

    registerMiss() {
      miss++;
      combo = 0;
    },

    registerWrong() {
      wrong++;
      // Wrong notes do NOT break the combo — they're tracked separately
      // because a player might mash extra keys without affecting their
      // streak on the actual notes. See design doc §10.
    },

    reset() {
      score = combo = maxCombo = perfect = good = miss = wrong = 0;
    },

    // ── Read-only getters ─────────────────────────────────────
    getScore()      { return score; },
    getCombo()      { return combo; },
    getMaxCombo()   { return maxCombo; },
    getPerfect()    { return perfect; },
    getGood()       { return good; },
    getMiss()       { return miss; },
    getWrong()      { return wrong; },
    getMultiplier() { return multiplier(); },
    getAccuracy()   { return accuracy(); },
    getGrade()      { return grade(); },

    // Bundle everything — useful for one-shot reads in the render loop.
    getStats() {
      return {
        score, combo, maxCombo, perfect, good, miss, wrong,
        multiplier: multiplier(),
        accuracy:   accuracy(),
        grade:      grade(),
      };
    },
  };
}
