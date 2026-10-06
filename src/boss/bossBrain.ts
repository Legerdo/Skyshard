// BossBrain: Caelith's pattern scheduler (design "Boss Caelith" 패턴 스케줄러; Req 6.2, 6.3, 6.7, 6.9). The
// BossEncounter asks it for the next action each time a recovery ends (transition, `stagger` and `disabled` ends
// included) and the wait before it:
// 1. candidates = the Phase's pool − attacks on cooldown − the previous attack (weight-0 attacks only come forced);
// 2. distance filters: slashCombo only within 6 m, starShards only beyond 8 m, dash only beyond 10 m; no candidate
//    left → `decide` returns null and the encounter adjusts its distance in `idle`, then asks again;
// 3. a weighted draw from the `boss` RNG stream;
// 4. the wait is the Phase interval (2.2 / 1.9 / 1.54 s) ± 0.3 s, also from the `boss` stream (the encounter adds the
//    1.0 s floor after a strong attack).
// Forced events skip 1–3 when due, in this order: Final Phase astralSweep 18 s after the previous one started (the
// first 18 s after the Final Phase began), Phase 2+ summonCrystals as the Phase's first action and later whenever
// fewer than 2 crystals stand and its 30 s cooldown is over, Phase 1 the slashCombo → groundSlam combo every third
// decision (with the Active_Character beyond 6 m, at the next decision within it). Pure TypeScript: randomness only
// from the injected Rng.

import type { Rng } from '../core/rng';
import { attackPool, CAELITH, CAELITH_ACTIONS, type CaelithAttack } from '../data/boss';
import { bossPhaseDef, type BossPhase } from '../logic/boss';

/** What a decision looks at. */
export interface BrainView {
  readonly phase: BossPhase;
  /** Horizontal distance to the Active_Character (m). */
  readonly distance: number;
  /** Encounter clock (s). */
  readonly now: number;
  /** Shard_Crystals standing. */
  readonly crystalsAlive: number;
}

export interface BrainDecision {
  readonly attack: CaelithAttack;
  /** A forced event (no draw). */
  readonly forced: boolean;
  /** Phase 1's slashCombo → groundSlam combo, a 3 s `stagger` after it (Req 6.2). */
  readonly combo: boolean;
}

const EPS = 1e-9;

/** Whether `attack` passes the distance filter at `d` m (design 패턴 스케줄러 2). */
export function inRange(attack: CaelithAttack, d: number): boolean {
  if (attack === 'slashCombo') return d <= CAELITH.slashRange;
  if (attack === 'starShards') return d > CAELITH.shardsMinRange;
  if (attack === 'dash') return d > CAELITH.dashMinRange;
  return true;
}

const PHASE_KEY = { 1: 'p1', 2: 'p2', 3: 'final' } as const;

export class BossBrain {
  private readonly rng: Rng;
  /** Clock time from which each attack is off cooldown. */
  private readonly readyAt = new Map<CaelithAttack, number>();
  private last: CaelithAttack | null = null;
  private decisions = 0;
  /** Phase 1's combo reached its turn but the target was beyond slash range: the next decision in range takes it. */
  private comboDue = false;
  private summonDue = false;
  private sweepFrom = 0;
  private phaseNow: BossPhase = 1;

  constructor(rng: Rng) {
    this.rng = rng;
  }

  /** The previous attack (excluded from the next draw), or null after a reset. */
  get previous(): CaelithAttack | null {
    return this.last;
  }

  /** Decisions taken since the last reset. */
  get decisionCount(): number {
    return this.decisions;
  }

  /**
   * A Phase starts (transition end) or `begin(fromPhase)` restarts it: cooldowns, the previous attack and the forced
   * event counters from scratch; the Final Phase's Astral Sweep clock runs from `now`. `summonFirst` (default: Phase
   * 2+) makes summonCrystals the first action: the Phase 2 entry and any begin() at Phase 2+, which removed the
   * crystals.
   */
  reset(phase: BossPhase, now: number, summonFirst: boolean = phase >= 2): void {
    this.phaseNow = phase;
    this.readyAt.clear();
    this.last = null;
    this.decisions = 0;
    this.comboDue = false;
    this.summonDue = phase >= 2 && summonFirst;
    this.sweepFrom = now;
  }

  /** Wait from a recovery's end to the next Telegraph: the Phase interval ± 0.3 s (one `boss` draw). */
  wait(phase: BossPhase): number {
    const j = CAELITH.intervalJitter;
    return bossPhaseDef(phase).interval + this.rng.range(-j, j);
  }

  /** Attacks of the Phase's pool the draw may pick now (step 1–2), in pool order. */
  candidates(v: BrainView): CaelithAttack[] {
    return attackPool(PHASE_KEY[v.phase]).filter((a) =>
      CAELITH_ACTIONS[a].weight > 0 && a !== this.last && this.ready(a, v.now) && inRange(a, v.distance));
  }

  /** The forced event due now, or null. */
  forced(v: BrainView): BrainDecision | null {
    if (v.phase === 3 && v.now - this.sweepFrom >= CAELITH_ACTIONS.astralSweep.cooldown - EPS) {
      return { attack: 'astralSweep', forced: true, combo: false };
    }
    if (v.phase >= 2 && (this.summonDue || (v.crystalsAlive < CAELITH.resummonBelow && this.ready('summonCrystals', v.now)))) {
      return { attack: 'summonCrystals', forced: true, combo: false };
    }
    const turn = this.comboDue || (this.decisions + 1) % CAELITH.comboEvery === 0;
    if (v.phase === 1 && turn && inRange('slashCombo', v.distance)) return { attack: 'slashCombo', forced: true, combo: true };
    return null;
  }

  /**
   * The next action: a forced event, else a weighted draw among the candidates; null when none is left (nothing is
   * drawn or counted then). The pick is recorded (cooldown from `now`, previous attack, decision count).
   */
  decide(v: BrainView): BrainDecision | null {
    // Every third decision is the combo's; beyond slash range it waits for the next decision in range (a combo of
    // sweeps swung from afar would be no combo).
    if (v.phase === 1 && (this.decisions + 1) % CAELITH.comboEvery === 0) this.comboDue = true;
    const decision = this.forced(v) ?? this.draw(v);
    if (decision === null) return null;
    this.decisions++;
    if (decision.combo) this.comboDue = false;
    this.started(decision.attack, v.now);
    return decision;
  }

  /**
   * `attack` starts at `now` (also the combo's groundSlam, which the encounter chains itself): its cooldown runs,
   * it becomes the previous attack, and a summon / sweep resets its forced event.
   */
  started(attack: CaelithAttack, now: number): void {
    this.readyAt.set(attack, now + CAELITH_ACTIONS[attack].cooldown);
    this.last = attack;
    if (attack === 'summonCrystals') this.summonDue = false;
    if (attack === 'astralSweep') this.sweepFrom = now;
  }

  private ready(attack: CaelithAttack, now: number): boolean {
    return now >= (this.readyAt.get(attack) ?? Number.NEGATIVE_INFINITY) - EPS;
  }

  private draw(v: BrainView): BrainDecision | null {
    const pool = this.candidates(v);
    if (pool.length === 0) return null;
    const total = pool.reduce((sum, a) => sum + CAELITH_ACTIONS[a].weight, 0);
    let r = this.rng.next() * total;
    for (const attack of pool) {
      r -= CAELITH_ACTIONS[attack].weight;
      if (r < 0) return { attack, forced: false, combo: false };
    }
    const lastOne = pool[pool.length - 1];
    return lastOne === undefined ? null : { attack: lastOne, forced: false, combo: false };
  }

  /** Phase the brain was last reset to. */
  get phase(): BossPhase {
    return this.phaseNow;
  }
}
