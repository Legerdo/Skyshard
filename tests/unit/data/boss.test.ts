import { describe, expect, it } from 'vitest';
import {
  ARENA, attackPool, BOSS_ATTACKS, BOSS_PHASES, CAELITH, CAELITH_ACTIONS, CAELITH_ATTACKS, CAELITH_GEOMETRY, MIN_TELEGRAPH,
  SHARD_CRYSTAL, SHARD_CRYSTAL_SOCKETS, STARSHELL, type BossAttackDef,
} from '../../../src/data/boss';
import { ELEMENT_IDS } from '../../../src/data/ids';
import { LOCATIONS } from '../../../src/data/worldLayout';
import { bossPhaseDef, bossPhaseFor, PHASE_THRESHOLDS, phaseFloorHp, STARSHELL_ROTATE_SECONDS } from '../../../src/logic/boss';
import { computeDamage, SHIELD_REACTION_MUL, SHIELD_SAME_MUL, VULNERABLE_MUL } from '../../../src/logic/damage';

// Caelith data (task 10.1; design "Boss Caelith"; Req 6.1, 6.2, 6.3, 6.7, 6.9).
const attacks: readonly BossAttackDef[] = CAELITH_ATTACKS.map((name) => BOSS_ATTACKS[name]);

describe('Caelith', () => {
  it('has 24,000 max HP and ATK 120 at its fixed level 9, dealt with computeDamage level 1', () => {
    expect([CAELITH.maxHp, CAELITH.level, CAELITH.atk, CAELITH.damageLevel]).toEqual([24000, 9, 120, 1]);
    // Design: slashCombo's first hit on DEF 50 ≈ 80 (120 × 1.0 × 100/150), astralSweep ≈ 176.
    const hit = (dmgMul: number): number => computeDamage({
      baseAtk: CAELITH.atk, level: CAELITH.damageLevel, equipAtkPct: 0, abilityUpgradePct: 0, equipDmgPct: 0, critChance: 0,
      dmgMul, def: 50, rng01: 0, kind: 'enemy', frontGuard: false, shield: null, vulnerable: false,
    }).amount;
    expect([hit(BOSS_ATTACKS.slashCombo.dmgMul[0]), hit(BOSS_ATTACKS.astralSweep.dmgMul[0])]).toEqual([80, 176]);
  });
});

describe('Phase table', () => {
  it('has Phase 1, 2 and Final ending at 0.65 / 0.30 / 0 with intervals 2.2 / 1.9 / 1.54 s and their music', () => {
    expect(BOSS_PHASES.map((p) => [p.phase, p.until, p.interval, p.music])).toEqual([
      ['p1', 0.65, 2.2, 'mus_boss_p1'],
      ['p2', 0.3, 1.9, 'mus_boss_p2'],
      ['final', 0, 1.54, 'mus_boss_p3'],
    ]);
    expect(BOSS_PHASES[2].interval).toBeCloseTo(BOSS_PHASES[0].interval * 0.7, 9); // Req 6.7: −30 %
  });

  it('adds each of the eight attacks once: Phase 1 the melee three, Phase 2 dash / sectorBlast / summonCrystals, Final starfall / astralSweep', () => {
    expect(BOSS_PHASES.map((p) => p.adds)).toEqual([
      ['slashCombo', 'starShards', 'groundSlam'],
      ['dash', 'sectorBlast', 'summonCrystals'],
      ['starfall', 'astralSweep'],
    ]);
    expect(BOSS_PHASES.flatMap((p) => p.adds)).toEqual([...CAELITH_ATTACKS]);
    expect(attackPool('p1')).toEqual(['slashCombo', 'starShards', 'groundSlam']);
    expect(attackPool('p2')).toHaveLength(6);
    expect(attackPool('final')).toEqual([...CAELITH_ATTACKS]);
  });

  it('puts the Starshell on Phase 2 and the Final Phase only', () => {
    expect(BOSS_PHASES.map((p) => p.starshell)).toEqual([false, true, true]);
    expect(Object.keys(STARSHELL.durability).sort()).toEqual(BOSS_PHASES.filter((p) => p.starshell).map((p) => p.phase).sort());
  });

  it('is what bossPhaseFor, phaseFloorHp and PHASE_THRESHOLDS read', () => {
    expect(([1, 2, 3] as const).map(bossPhaseDef)).toEqual([...BOSS_PHASES]);
    expect(PHASE_THRESHOLDS).toEqual({ p2: BOSS_PHASES[0].until, p3: BOSS_PHASES[1].until });
    for (const [i, def] of BOSS_PHASES.entries()) {
      const phase = (i + 1) as 1 | 2 | 3;
      // Just above `until` the Phase holds; at it the next Phase begins (the Final Phase to 0).
      expect(bossPhaseFor(def.until + 1e-6, phase), def.phase).toBe(phase);
      expect(bossPhaseFor(def.until, 1), def.phase).toBe(Math.min(3, phase + 1));
      expect(phaseFloorHp(CAELITH.maxHp, phase)).toBe(Math.floor(CAELITH.maxHp * def.until));
    }
    expect([phaseFloorHp(CAELITH.maxHp, 1), phaseFloorHp(CAELITH.maxHp, 2)]).toEqual([15600, 7200]);
  });
});

describe('attacks', () => {
  it('defines the eight atk_caelith_<name> attacks with a Telegraph and ATK multiplier per judgement', () => {
    expect(Object.keys(BOSS_ATTACKS).sort()).toEqual([...CAELITH_ATTACKS].sort());
    for (const name of CAELITH_ATTACKS) {
      const a = BOSS_ATTACKS[name];
      expect(a.id).toBe(`atk_caelith_${name}`);
      expect(a.telegraph.length, name).toBeGreaterThan(0);
      expect(a.dmgMul.length, name).toBe(a.telegraph.length);
      expect(a.strength === null, name).toBe(a.dmgMul.every((m) => m === 0)); // null exactly for no damage
    }
    expect(new Set(attacks.map((a) => a.id)).size).toBe(8);
  });

  it('warns every judgement at least MIN_TELEGRAPH of its strength (Req 6.9)', () => {
    expect(MIN_TELEGRAPH).toEqual({ normal: 0.4, strong: 0.8 });
    for (const a of attacks) {
      if (a.strength === null) continue;
      for (const t of a.telegraph) expect(t, a.id).toBeGreaterThanOrEqual(MIN_TELEGRAPH[a.strength]);
    }
    expect(SHARD_CRYSTAL.pulseTelegraph).toBeGreaterThanOrEqual(MIN_TELEGRAPH.strong); // judged as a strong attack
  });

  it('matches the design table: strength, per-judgement Telegraph and ATK multiplier, forced-event periods', () => {
    expect(Object.fromEntries(attacks.map((a) => [a.id, [a.strength, a.telegraph, a.dmgMul, a.every ?? null]]))).toEqual({
      atk_caelith_slashCombo: ['normal', [0.5, 0.4, 0.4], [1.0, 1.0, 1.4], null],
      atk_caelith_starShards: ['normal', [0.6], [0.8], null],
      atk_caelith_groundSlam: ['strong', [1.0], [2.0], null],
      atk_caelith_dash: ['strong', [0.9], [1.8], null],
      atk_caelith_sectorBlast: ['strong', [1.0, 1.0, 1.0, 1.0], [1.6, 1.6, 1.6, 1.6], null],
      atk_caelith_summonCrystals: [null, [1.0], [0], 30],
      atk_caelith_starfall: ['strong', [1.2], [1.8], null],
      atk_caelith_astralSweep: ['strong', [1.2], [2.2], 18],
    });
  });

  it('keeps the encounter\'s action schedule in step with the BossAttackDefs: each judgement shows its Telegraph for exactly its table value', () => {
    for (const name of CAELITH_ATTACKS) {
      const table = BOSS_ATTACKS[name];
      const action = CAELITH_ACTIONS[name];
      expect(action.judgements.length, name).toBe(table.telegraph.length);
      action.judgements.forEach((j, i) => {
        expect(j.at - j.shownAt, `${name} judgement ${i + 1}`).toBeCloseTo(table.telegraph[i] ?? NaN, 9);
        expect(j.shownAt, name).toBeGreaterThanOrEqual(0);
        if (i > 0) expect(j.at, `${name} in order`).toBeGreaterThan(action.judgements[i - 1]?.at ?? Infinity);
      });
      expect(action.activeEnd, name).toBeGreaterThanOrEqual(action.judgements[action.judgements.length - 1]?.at ?? Infinity);
    }
    // slashCombo's sweeps 0.4 s apart after the 0.5 s glow; sectorBlast's zones light 0.4 s apart, each 1.0 s ahead.
    expect(CAELITH_ACTIONS.slashCombo.judgements.map((j) => j.at)).toEqual([0.5, 0.9, 1.3]);
    expect(CAELITH_ACTIONS.sectorBlast.judgements.map((j) => j.shownAt)).toEqual([0, 0.4, 0.8, 1.2]);
    // The forced events only come forced, with their table periods as cooldowns.
    expect([CAELITH_ACTIONS.summonCrystals.weight, CAELITH_ACTIONS.astralSweep.weight]).toEqual([0, 0]);
    expect([CAELITH_ACTIONS.summonCrystals.cooldown, CAELITH_ACTIONS.astralSweep.cooldown]).toEqual([30, 18]);
  });

  it('gives the attacks the design table\'s geometry', () => {
    expect(CAELITH_GEOMETRY.slash).toMatchObject({ radius: 4.5, angleDeg: 120 });
    expect(CAELITH_GEOMETRY.shards).toMatchObject({ count: 3, spreadDeg: 15, speed: 22 });
    expect(CAELITH_GEOMETRY.slam.radius).toBe(6);
    expect(CAELITH_GEOMETRY.dash).toMatchObject({ width: 3, length: 20 });
    expect(CAELITH_GEOMETRY.sectorBlast.zones).toBe(4);
    expect(CAELITH_GEOMETRY.starfall).toMatchObject({ count: 5, radius: 3 });
    expect(CAELITH_GEOMETRY.astral).toMatchObject({ height: 0.8, thickness: 1.5, speed: 14 });
    expect([CAELITH.comboEvery, CAELITH.strongGap, CAELITH.comboStaggerSeconds, CAELITH.astralStaggerSeconds]).toEqual([3, 1, 3, 2.5]);
    expect([CAELITH.slashRange, CAELITH.shardsMinRange, CAELITH.dashMinRange]).toEqual([6, 8, 10]);
  });
});

describe('arena, Shard_Crystal and Starshell', () => {
  it('holds the 32 m arena at sanctum_arena with 8 sectors, sockets 18 m out and a 1.2 m rim', () => {
    expect(ARENA).toEqual({ location: 'sanctum_arena', radius: 32, sectors: 8, socketRadius: 18, rimHeight: 1.2 });
    expect(LOCATIONS[ARENA.location]).toMatchObject({ x: 0, z: 30, groundY: 182 });
  });

  it('places 4 crystals, one per Element, 18 m north / east / south / west of the centre, with HP 300 and DEF 0', () => {
    expect(SHARD_CRYSTAL).toMatchObject({ hp: 300, def: 0, triggerRadius: 3, pulseRadius: 3, pulseTelegraph: 0.8, pulseEvery: 6, markRadius: 6 });
    expect(SHARD_CRYSTAL_SOCKETS).toHaveLength(4);
    expect(SHARD_CRYSTAL_SOCKETS.map((s) => s.element).sort()).toEqual([...ELEMENT_IDS].sort());
    expect(SHARD_CRYSTAL_SOCKETS.map((s) => [Math.sign(s.dx), Math.sign(s.dz)])).toEqual([[0, -1], [1, 0], [0, 1], [-1, 0]]);
    for (const s of SHARD_CRYSTAL_SOCKETS) expect(Math.hypot(s.dx, s.dz)).toBe(ARENA.socketRadius);
    expect(ARENA.socketRadius).toBeLessThan(ARENA.radius);
  });

  it('gives the Starshell 1,200 / 900 durability, a 12 s swap, 25 % same-Element and 300 % Reaction damage, and 6 s disabled at 150 %', () => {
    expect(STARSHELL).toEqual({
      durability: { p2: 1200, final: 900 },
      rotateSeconds: 12,
      sameElementMul: 0.25,
      reactionMul: 3,
      disabledSeconds: 6,
      disabledDamageMul: 1.5,
    });
    // The same multipliers computeDamage and the Starshell rotation use.
    expect([STARSHELL.sameElementMul, STARSHELL.reactionMul, STARSHELL.disabledDamageMul]).toEqual([SHIELD_SAME_MUL, SHIELD_REACTION_MUL, VULNERABLE_MUL]);
    expect(STARSHELL_ROTATE_SECONDS).toBe(STARSHELL.rotateSeconds);
  });
});
