import { describe, expect, it } from 'vitest';
import { judgeHitEvent, startAttack, type Attacker, type HitReceiver } from '../../../src/combat/attackRuntime';
import { createGameEventBus } from '../../../src/core/gameEvents';
import { DEG2RAD, yawFromDir } from '../../../src/core/math';
import { CHARACTERS } from '../../../src/data/characters';
import type { AttackDef } from '../../../src/data/combatTypes';
import { MOSSBACK_BRUTE } from '../../../src/data/enemies';
import type { CharacterId } from '../../../src/data/ids';
import { EnemySystem } from '../../../src/enemies/enemySystem';
import type { DamageKind } from '../../../src/logic/damage';
import { breaksGuard, guardCovers, type FrontGuardRule } from '../../../src/logic/frontGuard';
import type { EnemyRuntime } from '../../../src/save/runtimeState';

// Mossback Brute's front guard (design "적 정의", "피해 공식"; Req 28.11): a Normal_Attack from inside the front
// 120° loses 70%, an Ember or Charged_Attack hit breaks the guard into a 3 s Stagger, and the guard is back after it.
const DT = 1 / 60;
const STAGGER_TICKS = Math.round(3 / DT);
const KAIREN_N1 = CHARACTERS.kairen.normal[0] as AttackDef;
const KAIREN_N4 = CHARACTERS.kairen.normal[3] as AttackDef; // the Ember finisher

/** The Active_Character 60 m away along +Z: the Mossback only wakes when hit, then walks toward +Z facing it. */
const FAR_PLAYER: HitReceiver = {
  id: 'player',
  hurtVolume: () => ({ pos: { x: 0, y: 0, z: 60 }, radius: 0.4, height: 1.75 }),
  immune: () => false,
  sample: () => ({ def: 50, frontGuard: false, shieldElement: null, vulnerable: false, terraMarked: false }),
  receive: () => undefined,
};

function setup() {
  const enemies = new EnemySystem({ enemies: new Map(), terrain: { heightAt: () => 0 }, bus: createGameEventBus() });
  const id = enemies.spawn({ kind: 'mossbackBrute', pos: { x: 0, y: 0, z: 0 }, yaw: 0 });
  const [receiver] = [...enemies.receivers()];
  if (receiver === undefined) throw new Error('no receiver');
  const mossback = (): Readonly<EnemyRuntime> => {
    const e = enemies.get(id);
    if (e === undefined) throw new Error('mossback gone');
    return e;
  };
  const tick = (n = 1): void => {
    for (let i = 0; i < n; i++) enemies.tick({ dt: DT, player: FAR_PLAYER });
  };
  /** `who` lands `attack` (as `kind`, no crit) from 1.5 m away, `angleDeg` off the Mossback's facing; the damage. */
  const strike = (who: CharacterId, attack: AttackDef, kind: DamageKind, angleDeg: number): number => {
    const e = mossback();
    const a = e.yaw + angleDeg * DEG2RAD;
    const pos = { x: e.pos.x + Math.sin(a) * 1.5, y: 0, z: e.pos.z + Math.cos(a) * 1.5 };
    const c = CHARACTERS[who];
    const attacker: Attacker = {
      id: 'player',
      origin: { pos, yaw: yawFromDir(e.pos.x - pos.x, e.pos.z - pos.z) },
      stats: { baseAtk: c.baseStats.atk, level: 1, equipAtkPct: 0, abilityUpgradePct: 0, equipDmgPct: 0, critChance: 0 },
      kind,
      element: c.element,
      elementSource: who,
      roll: () => 0.5,
    };
    const results = judgeHitEvent(startAttack(attack), 0, attacker, [receiver]);
    expect(results).toHaveLength(1);
    return results[0]?.hit.amount ?? Number.NaN;
  };
  return { mossback, tick, strike };
}

describe('front guard rules', () => {
  /** Travel direction of a hit whose attacker stands `deg` off a +Z facing. */
  const fromAngle = (deg: number) => ({ x: -Math.sin(deg * DEG2RAD), y: 0, z: -Math.cos(deg * DEG2RAD) });

  it('covers attackers within 60° of the facing and breaks on an Ember hit or any Charged_Attack hit', () => {
    expect([0, 45, 59, -59].map((deg) => guardCovers(0, fromAngle(deg), 120))).toEqual([true, true, true, true]);
    expect([61, -61, 90, 180].map((deg) => guardCovers(0, fromAngle(deg), 120))).toEqual([false, false, false, false]);
    const rule = MOSSBACK_BRUTE.frontGuard as FrontGuardRule;
    expect(breaksGuard(rule, { kind: 'normal', element: 'ember' })).toBe(true);
    expect(breaksGuard(rule, { kind: 'charged', element: 'tide' })).toBe(true);
    expect(breaksGuard(rule, { kind: 'normal', element: null })).toBe(false);
    expect(breaksGuard(rule, { kind: 'skill', element: 'gale' })).toBe(false);
  });
});

describe('Mossback Brute front guard in the EnemySystem', () => {
  it('cuts a Normal_Attack from inside the front 120° by 70% and leaves one from outside it whole', () => {
    const { strike, mossback } = setup();
    // Kairen N1 vs DEF 60: 120 × 0.9 × 100 / 160 = 67.5 → 68; through the guard × 0.3 → 20.
    expect([0, 55, -55].map((deg) => strike('kairen', KAIREN_N1, 'normal', deg))).toEqual([20, 20, 20]);
    expect([65, -90, 180].map((deg) => strike('kairen', KAIREN_N1, 'normal', deg))).toEqual([68, 68, 68]);
    expect(mossback().guard).toBe('up');
  });

  it('a Charged_Attack breaks the guard into a 3 s Stagger, and the guard is back when the Stagger ends', () => {
    const { strike, mossback, tick } = setup();
    strike('kairen', KAIREN_N1, 'normal', 180); // wakes it from behind
    tick(31);
    expect(mossback().state).toBe('chase');
    // Talus's Charged_Attack from the front is not reduced: 85 × 2.0 × 100 / 160 = 106.25 → 106.
    expect(strike('talus', CHARACTERS.talus.charged, 'charged', 0)).toBe(106);
    expect([mossback().state, mossback().staggerSeconds, mossback().guard]).toEqual(['stagger', 3, 'staggered']);
    expect(strike('kairen', KAIREN_N1, 'normal', 0)).toBe(68); // no guard while broken
    tick(STAGGER_TICKS - 1);
    expect(mossback().state).toBe('stagger');
    tick();
    expect([mossback().state, mossback().guard]).toEqual(['chase', 'up']);
    expect(strike('kairen', KAIREN_N1, 'normal', 0)).toBe(20);
  });

  it('an Ember hit breaks it too; hit while idle, the 3 s Stagger starts on the tick the chase begins', () => {
    const { strike, mossback, tick } = setup();
    // The guard still covers the breaking hit: 120 × 1.6 × 100 / 160 × 0.3 = 36.
    expect(strike('kairen', KAIREN_N4, 'normal', 0)).toBe(36);
    expect([mossback().state, mossback().guard]).toEqual(['alert', 'broken']);
    expect(strike('kairen', KAIREN_N1, 'normal', 0)).toBe(68);
    let alertTicks = 0;
    while (mossback().state === 'alert' && alertTicks < 60) {
      tick();
      alertTicks += 1;
    }
    expect(alertTicks).toBe(30); // the 0.5 s alert
    expect([mossback().state, mossback().staggerSeconds, mossback().guard]).toEqual(['stagger', 3, 'staggered']);
    tick(STAGGER_TICKS - 1);
    expect(mossback().state).toBe('stagger');
    tick();
    expect([mossback().state, mossback().guard]).toEqual(['chase', 'up']);
    expect(strike('kairen', KAIREN_N1, 'normal', 0)).toBe(20);
  });
});
