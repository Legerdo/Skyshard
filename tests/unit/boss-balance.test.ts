import { describe, expect, it } from 'vitest';
import { BOSS_ATTACKS, CAELITH } from '../../src/data/boss';
import { DT, partyHit, setupEncounter } from './boss/bossHarness';

// Caelith balance simulation (task 10.8, design "밸런스 목표", Req 6.12): a level 7–8 party modelled as a steady 140 dps
// that stops while a Telegraph is showing (the party dodges), and 220 dps × 1.5 (Reactions and Burst into the vulnerable
// ×1.5) in the vulnerable windows. Run to the end over several seeds: 60–150 s per Phase, 3–6 minutes in total. The
// same runs check the 1.0 s floor after a strong attack's end before the next Caelith Telegraph.

const BASE_DPS = 140;
const WINDOW_DPS = 220 * 1.5;
const SEEDS = [20240601, 1, 2, 3, 99, 12345];
const STRONG: ReadonlySet<string> = new Set(Object.values(BOSS_ATTACKS).filter((a) => a.strength === 'strong').map((a) => a.id));

function simulate(seed: number) {
  const { boss, tick } = setupEncounter(seed, 1);
  const phaseStart: Record<number, number> = { 1: 0 };
  const phaseEnd: Record<number, number> = {};
  let t = 0;
  let lastPhase = 1;
  let strongEndAt = Number.NEGATIVE_INFINITY;
  let current: { attack: string; strong: boolean } | null = null;
  const seenTelegraphs = new Set<number>();
  const gapViolations: string[] = [];
  while (boss.state !== 'dead' && t < 600) {
    const snap = boss.snapshot();
    // The party evades while a Caelith Telegraph shows and while its shards or the sweep ring are in flight.
    const dodging = snap.telegraphs.some((tg) => tg.attack !== 'shardCrystal_pulse') || snap.ring !== null || snap.shards.length > 0;
    const dps = snap.vulnerable ? WINDOW_DPS : dodging ? 0 : BASE_DPS;
    if (dps > 0) boss.applyHit(partyHit(dps * DT));
    tick();
    t += DT;
    const after = boss.snapshot();
    if (after.phase !== lastPhase) {
      phaseEnd[lastPhase] = t;
      phaseStart[after.phase] = t;
      lastPhase = after.phase;
    }
    // A strong attack ended → no new Telegraph of another Caelith attack for 1.0 s (the combo's chained slam aside).
    const playing = after.attack;
    if (current !== null && playing !== current.attack && current.strong) strongEndAt = t;
    current = playing === null ? null : { attack: playing, strong: STRONG.has(playing) };
    for (const tg of after.telegraphs) {
      if (seenTelegraphs.has(tg.id)) continue;
      seenTelegraphs.add(tg.id);
      if (tg.attack === 'shardCrystal_pulse' || tg.attack === 'atk_caelith_groundSlam' || tg.attack === playing) continue;
      if (t - strongEndAt < CAELITH.strongGap - 0.05) gapViolations.push(`${tg.attack} ${(t - strongEndAt).toFixed(2)} s after a strong attack`);
    }
  }
  phaseEnd[lastPhase] = t;
  return { dead: boss.state === 'dead', total: t, phaseStart, phaseEnd, gapViolations };
}

describe('Caelith balance simulation', () => {
  it.each(SEEDS)('seed %i: each Phase takes 60–150 s and the fight 3–6 minutes', (seed) => {
    const r = simulate(seed);
    expect(r.dead).toBe(true);
    const durations = [1, 2, 3].map((p) => r.phaseEnd[p] - r.phaseStart[p]);
    for (const [i, d] of durations.entries()) {
      expect(d, `Phase ${i + 1}: ${d.toFixed(1)} s`).toBeGreaterThanOrEqual(60);
      expect(d, `Phase ${i + 1}: ${d.toFixed(1)} s`).toBeLessThanOrEqual(150);
    }
    expect(r.total).toBeGreaterThanOrEqual(180);
    expect(r.total).toBeLessThanOrEqual(360);
    expect(r.gapViolations).toEqual([]);
  });
});
