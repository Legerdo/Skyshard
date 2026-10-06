import { describe, expect, it } from 'vitest';
import {
  advanceAttack, attackFinished, judgeHitEvent, startAttack, type Attacker, type HitReceiver, type ResolvedHit,
} from '../../../src/combat/attackRuntime';
import { hitShapeOverlaps } from '../../../src/combat/hitShapes';
import type { Vec3 } from '../../../src/core/types';
import { CHARACTERS } from '../../../src/data/characters';
import type { AttackDef } from '../../../src/data/combatTypes';
import { BRAMBLEKIN } from '../../../src/data/enemies';
import { computeDamage } from '../../../src/logic/damage';

// AttackDef / HitEvent runtime (design "전투 액션 모델", "피해 공식"; Req 24.1, 24.10, 28.10).
const DT = 1 / 60;
const KAIREN_NORMAL = CHARACTERS.kairen.normal;
const ORIGIN = { pos: { x: 0, y: 0, z: 0 }, yaw: 0 }; // facing +Z

/** A Bramblekin-sized target standing at `pos` that records how it is called. */
function target(id: string, pos: Vec3, def = 20): { receiver: HitReceiver; log: string[]; hits: ResolvedHit[] } {
  const log: string[] = [];
  const hits: ResolvedHit[] = [];
  const receiver: HitReceiver = {
    id,
    hurtVolume: () => ({ pos, radius: 0.5, height: 1.3 }),
    immune: () => false,
    sample: () => {
      log.push('sample');
      return { def, frontGuard: false, shieldElement: null, vulnerable: false, terraMarked: false };
    },
    receive: (hit) => {
      log.push(`receive ${hit.amount}`);
      hits.push(hit);
    },
  };
  return { receiver, log, hits };
}

/** Kairen at level 1 with the given pre-drawn crit roll. */
const kairen = (roll: number): Attacker => ({
  id: 'player',
  origin: ORIGIN,
  stats: { baseAtk: 120, level: 1, equipAtkPct: 0, abilityUpgradePct: 0, equipDmgPct: 0, critChance: 0.05 },
  kind: 'normal',
  element: 'ember',
  roll: () => roll,
});

/** Plays `def` tick by tick and returns the clip time at which each HitEvent was judged. */
function judgeTimes(def: AttackDef): number[] {
  const p = startAttack(def);
  const times: number[] = [];
  while (!attackFinished(p)) for (const _ of advanceAttack(p, DT)) times.push(p.t);
  return times;
}

describe('attack playback', () => {
  it('Kairen Normal_Attack hits 1–4 are 0.9/1.0/1.1/1.6× at 0.18/0.20/0.22/0.30 s, judged on the first tick reaching t', () => {
    expect(KAIREN_NORMAL.map((a) => a.id)).toEqual(['atk_kairen_n1', 'atk_kairen_n2', 'atk_kairen_n3', 'atk_kairen_n4']);
    expect(KAIREN_NORMAL.map((a) => a.hits.map((h) => [h.t, h.dmgMul]))).toEqual([
      [[0.18, 0.9]], [[0.2, 1]], [[0.22, 1.1]], [[0.3, 1.6]],
    ]);
    for (const attack of KAIREN_NORMAL) {
      const [t] = judgeTimes(attack);
      const hitT = attack.hits[0]?.t ?? Number.NaN;
      expect(t, attack.id).toBeGreaterThanOrEqual(hitT - 1e-9);
      expect(t, attack.id).toBeLessThan(hitT + DT);
    }
  });

  it('judges every HitEvent of a multi-hit attack exactly once, in order', () => {
    const times = judgeTimes(BRAMBLEKIN.attacks[0] as AttackDef);
    expect(times).toHaveLength(2);
    expect(times[0]).toBeCloseTo(0.4, 1);
    expect(times[1]).toBeCloseTo(0.8, 1);
  });
});

describe('judgeHitEvent', () => {
  it('hits the same target at most once per HitEvent', () => {
    const a = target('a', { x: 0, y: 0, z: 1.5 });
    const b = target('b', { x: 0.8, y: 0, z: 1.2 });
    const p = startAttack(KAIREN_NORMAL[0] as AttackDef);
    // The same receiver listed twice (e.g. two hurtboxes) and the HitEvent judged again.
    const first = judgeHitEvent(p, 0, kairen(0.5), [a.receiver, a.receiver, b.receiver]);
    const again = judgeHitEvent(p, 0, kairen(0.5), [a.receiver, b.receiver]);
    expect(first.map((r) => r.receiver.id)).toEqual(['a', 'b']);
    expect(again).toEqual([]);
    expect([a.hits.length, b.hits.length]).toEqual([1, 1]);
    // A different HitEvent (the next combo hit) may hit it again.
    const next = startAttack(KAIREN_NORMAL[1] as AttackDef);
    expect(judgeHitEvent(next, 0, kairen(0.5), [a.receiver])).toHaveLength(1);
  });

  it('samples the target, then applies the computeDamage result: 120 × 0.9 × 100 / 120 = 90, crit ×1.5', () => {
    const a = target('a', { x: 0, y: 0, z: 1.5 });
    judgeHitEvent(startAttack(KAIREN_NORMAL[0] as AttackDef), 0, kairen(0.5), [a.receiver]);
    expect(a.log).toEqual(['sample', 'receive 90']);
    const crit = target('c', { x: 0, y: 0, z: 1.5 });
    judgeHitEvent(startAttack(KAIREN_NORMAL[0] as AttackDef), 0, kairen(0.01), [crit.receiver]);
    expect(crit.hits[0]).toMatchObject({ amount: 135, crit: true, kind: 'normal', element: null });
    expect(crit.hits[0]?.direction).toEqual({ x: 0, y: 0, z: 1 });
  });

  it('only the 4th Normal hit carries Kairen’s Ember, with 1.6× damage and its poise as stagger', () => {
    const a = target('a', { x: 0, y: 0, z: 2 });
    judgeHitEvent(startAttack(KAIREN_NORMAL[3] as AttackDef), 0, kairen(0.5), [a.receiver]);
    expect(a.hits[0]).toMatchObject({ attackId: 'atk_kairen_n4', amount: 160, element: 'ember', stagger: 25 });
  });

  it('skips immune targets and targets outside the arc', () => {
    const immune: HitReceiver = { ...target('i', { x: 0, y: 0, z: 1.5 }).receiver, immune: () => true };
    const behind = target('behind', { x: 0, y: 0, z: -1.5 });
    const far = target('far', { x: 0, y: 0, z: 3.5 });
    const p = startAttack(KAIREN_NORMAL[0] as AttackDef);
    expect(judgeHitEvent(p, 0, kairen(0.5), [immune, behind.receiver, far.receiver])).toEqual([]);
  });

  it('enemy hits use kind "enemy" with no crits: Bramblekin claw vs Kairen DEF 50 → round(40 × 100 / 150) = 27', () => {
    const claw = BRAMBLEKIN.attacks[0] as AttackDef;
    const kairenBody = target('player', { x: 0, y: 0, z: 1.5 }, 50);
    const bramblekin: Attacker = {
      id: 'bramblekin_1',
      origin: ORIGIN,
      stats: { baseAtk: 40, level: 1, equipAtkPct: 0, abilityUpgradePct: 0, equipDmgPct: 0, critChance: 0 },
      kind: 'enemy',
      element: null,
      roll: () => 0,
    };
    judgeHitEvent(startAttack(claw), 0, bramblekin, [kairenBody.receiver]);
    expect(kairenBody.hits[0]).toMatchObject({ amount: 27, crit: false, kind: 'enemy' });
    expect(computeDamage({ baseAtk: 40, level: 1, equipAtkPct: 0, dmgMul: 1, abilityUpgradePct: 0, equipDmgPct: 0, def: 50, critChance: 0, rng01: 0, kind: 'enemy' }).amount).toBe(27);
  });
});

describe('hitShapeOverlaps', () => {
  const volume = (x: number, y: number, z: number) => ({ pos: { x, y, z }, radius: 0.5, height: 1.3 });
  const arc = { kind: 'arc', radius: 2.4, angleDeg: 110, height: 2 } as const;

  it('arc: reach counts the target radius, the half-angle widens by the target width, and heights must overlap', () => {
    expect(hitShapeOverlaps(arc, ORIGIN, volume(0, 0, 2.8))).toBe(true); // 2.8 − 0.5 ≤ 2.4
    expect(hitShapeOverlaps(arc, ORIGIN, volume(0, 0, 3))).toBe(false);
    expect(hitShapeOverlaps(arc, ORIGIN, volume(1.5, 0, 1))).toBe(true); // centre 56° off, inside 55° + asin(0.5 / 1.8)
    expect(hitShapeOverlaps(arc, ORIGIN, volume(2, 0, 0.3))).toBe(false); // 81° off, outside 55° + 14°
    expect(hitShapeOverlaps(arc, ORIGIN, volume(0, 0, -1.5))).toBe(false);
    expect(hitShapeOverlaps(arc, ORIGIN, volume(0, 2.5, 1.5))).toBe(false);
    expect(hitShapeOverlaps(arc, { pos: ORIGIN.pos, yaw: Math.PI }, volume(0, 0, -1.5))).toBe(true);
  });

  it('sphere, capsule and ground circle follow the attacker frame; projectiles are never judged here', () => {
    const sphere = { kind: 'sphere', radius: 1, offset: { x: 0, y: 1, z: 2 } } as const;
    expect(hitShapeOverlaps(sphere, ORIGIN, volume(0, 0, 3))).toBe(true);
    expect(hitShapeOverlaps(sphere, { pos: ORIGIN.pos, yaw: Math.PI / 2 }, volume(3, 0, 0))).toBe(true);
    expect(hitShapeOverlaps(sphere, ORIGIN, volume(0, 0, -2))).toBe(false);
    const capsule = { kind: 'capsule', length: 6, radius: 1.2 } as const;
    expect(hitShapeOverlaps(capsule, ORIGIN, volume(1.5, 0, 5))).toBe(true);
    expect(hitShapeOverlaps(capsule, ORIGIN, volume(0, 0, 8))).toBe(false);
    const circle = { kind: 'groundCircle', radius: 3, delay: 0.5 } as const;
    expect(hitShapeOverlaps(circle, ORIGIN, volume(-3, 0, 0))).toBe(true);
    const projectile = { kind: 'projectile', speed: 45, radius: 0.1, maxRange: 25, gravity: 0, pierce: 0 } as const;
    expect(hitShapeOverlaps(projectile, ORIGIN, volume(0, 0, 1))).toBe(false);
  });
});
