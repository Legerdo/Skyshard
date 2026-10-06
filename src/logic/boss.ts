/*
 * Caelith phase and Starshell rules (design.md "Boss Caelith": Phase 전환, Starshell; Req 6.1, 6.4), reading the
 * Phase table and Starshell numbers of src/data/boss.
 * Pure: randomness only through the injected `Rng` (the `boss` stream); inputs are never mutated.
 */
import type { Rng } from '../core/rng';
import { BOSS_PHASES, STARSHELL, type BossPhaseDef } from '../data/boss';
import { ELEMENT_IDS, type ElementId } from '../data/ids';

/** 1, 2 and 3 (= Final Phase): `BOSS_PHASES[phase - 1]`. */
export type BossPhase = 1 | 2 | 3;

/** The Phase table row of `phase`. */
export function bossPhaseDef(phase: BossPhase): BossPhaseDef {
  return BOSS_PHASES[phase - 1];
}

/** HP ratios at or below which Phase 2 and the Final Phase begin: the `until` of Phases 1 and 2 (0.65 / 0.30). */
export const PHASE_THRESHOLDS: Readonly<{ p2: number; p3: number }> = { p2: bossPhaseDef(1).until, p3: bossPhaseDef(2).until };

/**
 * Phase implied by `hpRatio` — the first Phase of the table whose `until` it is above (> 0.65 → 1, > 0.30 → 2),
 * otherwise the Final Phase — never below `current`, so a heal never lowers the phase (Req 6.1). NaN keeps `current`.
 */
export function bossPhaseFor(hpRatio: number, current: BossPhase): BossPhase {
  if (Number.isNaN(hpRatio)) return current;
  const index = BOSS_PHASES.findIndex((def) => hpRatio > def.until);
  const implied = (index === -1 ? BOSS_PHASES.length : index + 1) as BossPhase;
  return implied > current ? implied : current;
}

/**
 * Lowest HP while `phase` is active: its `until` of `maxHp` (65 % / 30 % in Phases 1 / 2, 0 in the Final Phase).
 * Damage below it is discarded until the transition to the next phase ends, so no hit skips a phase.
 * Rounded down to whole HP, so `bossPhaseFor(floor / maxHp, phase)` already reports the next phase.
 */
export function phaseFloorHp(maxHp: number, phase: BossPhase): number {
  return Math.floor(maxHp * bossPhaseDef(phase).until);
}

/**
 * HP at the start of `phase`, its retry checkpoint (design "재도전과 처치"): 100 % / 65 % / 30 % of `maxHp`, the same
 * whole HP as the previous Phase's floor.
 */
export function phaseStartHp(maxHp: number, phase: BossPhase): number {
  return phase === 1 ? maxHp : phaseFloorHp(maxHp, (phase - 1) as BossPhase);
}

/** Starshell max durability of `phase`: 1,200 in Phase 2, 900 in the Final Phase, 0 without one (Req 6.3). */
export function starshellMax(phase: BossPhase): number {
  if (!bossPhaseDef(phase).starshell) return 0;
  return phase === 2 ? STARSHELL.durability.p2 : STARSHELL.durability.final;
}

/** Seconds between Starshell element changes (Req 6.4). */
export const STARSHELL_ROTATE_SECONDS: number = STARSHELL.rotateSeconds;

/** One of the three elements other than `current`, chosen uniformly with one `rng` draw. */
export function nextStarshellElement(current: ElementId, rng: Rng): ElementId {
  return rng.pick(ELEMENT_IDS.filter((element) => element !== current));
}

/** Current Starshell element and the time (s) of its next change. */
export interface StarshellClock {
  element: ElementId;
  nextRotateAt: number;
}

/**
 * Advances the rotation to `now`: every time `now` reaches `nextRotateAt` the element changes once
 * and `nextRotateAt` moves 12 s on, so each skipped period still rotates (and draws) exactly once.
 * Returns `clock` itself when nothing is due or a time is non-finite.
 */
export function stepStarshell(clock: StarshellClock, now: number, rng: Rng): StarshellClock {
  if (!Number.isFinite(now) || !Number.isFinite(clock.nextRotateAt) || now < clock.nextRotateAt) return clock;
  let { element, nextRotateAt } = clock;
  while (now >= nextRotateAt) {
    element = nextStarshellElement(element, rng);
    nextRotateAt += STARSHELL_ROTATE_SECONDS;
  }
  return { element, nextRotateAt };
}
