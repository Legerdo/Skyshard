import { describe, expect, it } from 'vitest';
import { abilityAtTier, CHARACTERS } from '../../../src/data/characters';
import type { AttackDef, CharacterDef, HitShape } from '../../../src/data/combatTypes';
import { CHARACTER_IDS } from '../../../src/data/ids';

// Character kit data (design "캐릭터 키트", "능력 강화 단계"; Req 22.1, 22.4, 24.2, 24.6, 29.5).
const chars: readonly CharacterDef[] = CHARACTER_IDS.map((id) => CHARACTERS[id]);
const attacksOf = (c: CharacterDef): AttackDef[] => [...c.normal, c.charged, c.skill.attack, c.burst.attack];
const attacks = chars.flatMap(attacksOf);
/** A line counts half its width. */
const radiusOf = (s: HitShape): number => ('radius' in s ? s.radius : s.width / 2);
const skillRadius = (c: CharacterDef): number => Math.max(...c.skill.attack.hits.map((h) => radiusOf(h.shape)));
/** Forward reach from the character. */
function reachOf(s: HitShape): number {
  if (s.kind === 'sphere') return Math.hypot(s.offset.x, s.offset.z) + s.radius;
  if (s.kind === 'capsule') return s.length + s.radius;
  if (s.kind === 'projectile') return s.maxRange;
  return s.kind === 'line' ? s.length : s.radius;
}

describe('character kits', () => {
  it('match the design table', () => {
    expect(chars.map((c) => [c.id, c.element, c.baseStats, c.skill.cooldown, c.burst.energyCost])).toEqual([
      ['kairen', 'ember', { hp: 1000, atk: 120, def: 50 }, 8, 60],
      ['isla', 'tide', { hp: 900, atk: 100, def: 45 }, 9, 60],
      ['wren', 'gale', { hp: 950, atk: 95, def: 50 }, 10, 70],
      ['talus', 'terra', { hp: 1300, atk: 85, def: 80 }, 12, 70],
    ]);
    const normalMuls = chars.map((c) => c.normal.flatMap((a) => a.hits.map((h) => h.dmgMul)));
    expect(normalMuls).toEqual([[0.9, 1, 1.1, 1.6], [0.7, 0.8, 1.2], [0.8, 0.9, 1.3], [0.9, 1, 1.5]]);
    expect(CHARACTERS.kairen.normal.map((a) => a.hits.map((h) => h.t))).toEqual([[0.18], [0.2], [0.22], [0.3]]);
    expect(CHARACTERS.talus.skill.params).toMatchObject({
      pillarRadius: 0.8, pillarHeight: 2.4, pillarSeconds: 8, shieldPct: 0.2, shieldSeconds: 8,
    });
  });

  it('meet the Req 22.4 role constraints', () => {
    const { kairen, isla, wren, talus } = CHARACTERS;
    const others = [kairen, isla, wren];
    expect(talus.baseStats.hp).toBeGreaterThanOrEqual((1.3 * others.reduce((s, c) => s + c.baseStats.hp, 0)) / 3);
    for (const c of [isla, wren, talus]) expect(kairen.baseStats.atk).toBeGreaterThan(c.baseStats.atk);
    for (const a of isla.normal) {
      for (const h of a.hits) expect(h.shape).toMatchObject({ kind: 'projectile', speed: 45, maxRange: 25 });
    }
    expect(isla.normalRange).toBe(25);
    for (const c of [kairen, isla, talus]) expect(skillRadius(wren)).toBeGreaterThan(skillRadius(c));
  });

  it('give each normalRange as the reach of the Normal hits', () => {
    for (const c of chars) {
      expect(c.normalRange, c.id).toBe(Math.max(...c.normal.flatMap((a) => a.hits.map((h) => reachOf(h.shape)))));
    }
  });

  it('use unique atk_<owner>_ ids owned by the character', () => {
    expect(new Set(attacks.map((a) => a.id)).size).toBe(attacks.length);
    for (const c of chars) {
      for (const a of attacksOf(c)) {
        expect(a.owner).toBe(c.id);
        expect(a.id).toMatch(new RegExp(`^atk_${c.id}_[a-z0-9]+$`));
      }
    }
  });

  it('keep hit times strictly increasing within [0, duration] and valid cancel / combo windows', () => {
    for (const a of attacks) {
      const times = a.hits.map((h) => h.t);
      expect(times.length, a.id).toBeGreaterThan(0);
      expect(times[0], a.id).toBeGreaterThanOrEqual(0);
      expect(times.at(-1), a.id).toBeLessThanOrEqual(a.duration);
      times.slice(1).forEach((t, i) => expect(t, a.id).toBeGreaterThan(times[i] ?? Infinity));
      expect(a.dodgeCancelFrom, a.id).toBeLessThanOrEqual(a.recoveryFrom);
      expect(a.recoveryFrom, a.id).toBeLessThanOrEqual(a.duration);
      const [open, close] = a.comboWindow ?? [0, 0];
      expect(open >= 0 && open <= close && close <= a.duration, a.id).toBe(true);
    }
    // Every Normal hit but the last chains; nothing else does.
    const chaining = chars.flatMap((c) => c.normal.slice(0, -1).map((a) => a.id)).sort();
    expect(attacks.filter((a) => a.comboWindow !== undefined).map((a) => a.id).sort()).toEqual(chaining);
  });

  it('apply the Element only on the last Normal hit and on Charged, Skill and Burst hits', () => {
    const energyOf = (as: readonly AttackDef[]) => [...new Set(as.flatMap((a) => a.hits.map((h) => h.energy)))];
    for (const c of chars) {
      const normalHits = c.normal.flatMap((a) => a.hits);
      const last = normalHits.length - 1;
      expect(normalHits.map((h) => h.appliesElement), c.id).toEqual(normalHits.map((_, i) => i === last));
      for (const a of [c.charged, c.skill.attack, c.burst.attack]) {
        expect(a.hits.every((h) => h.appliesElement), a.id).toBe(true);
      }
      expect([c.normal, [c.charged], [c.skill.attack], [c.burst.attack]].map(energyOf), c.id).toEqual([
        ['normalHit'], ['chargedHit'], ['skillCastHit'], [null],
      ]);
    }
  });

  it('define three stacking upgrade tiers per Skill and Burst, each with a Korean label and a change', () => {
    for (const { skill, burst } of chars) {
      for (const { upgrades, params } of [skill, burst]) {
        expect(upgrades).toHaveLength(3);
        for (const { label, dmgPct, radiusAdd, durationAdd, cooldownSet, extra } of upgrades) {
          expect(label).toMatch(/[가-힣]/);
          expect(dmgPct, label).toBeGreaterThanOrEqual(0);
          const changes = [radiusAdd, durationAdd, cooldownSet, extra].some((v) => v !== undefined);
          expect(dmgPct > 0 || changes, label).toBe(true);
          if (radiusAdd !== undefined) expect(params, label).toHaveProperty('radius');
          if (durationAdd !== undefined) expect(params, label).toHaveProperty('seconds');
          const [key = '', value] = extra?.split('=') ?? ['radius', '0'];
          expect(params, label).toHaveProperty(key);
          expect(Number(value), label).not.toBeNaN();
        }
      }
    }
  });

  it('stack tiers: damage increases add up and effect changes accumulate', () => {
    const { kairen, isla, wren, talus } = CHARACTERS;
    // Design example: Kairen Skill tier 3 is +50% → 2.7×, 8 m dash plus a 3 s flame trail.
    const k3 = abilityAtTier(kairen.skill, 3);
    expect(k3.dmgPct).toBeCloseTo(0.5, 10);
    expect((kairen.skill.attack.hits[0]?.dmgMul ?? 0) * (1 + k3.dmgPct)).toBeCloseTo(2.7, 10);
    expect(k3.params).toMatchObject({ dash: 8, flameTrailSeconds: 3, radius: 1.2 });
    expect(k3.applied).toEqual(kairen.skill.upgrades.map((t) => t.label));
    expect(abilityAtTier(kairen.burst, 3)).toMatchObject({ params: { radius: 6.5, aftershockMul: 1.5 } });
    expect(abilityAtTier(kairen.burst, 3).dmgPct).toBeCloseTo(0.4, 10);
    expect(abilityAtTier(isla.skill, 3).params).toMatchObject({ radius: 5, seconds: 3 });
    expect(abilityAtTier(isla.burst, 2).params).toMatchObject({ radius: 13, puddleSeconds: 0 });
    expect(abilityAtTier(wren.skill, 3)).toMatchObject({ cooldown: 8, params: { radius: 6 } });
    expect(abilityAtTier(wren.burst, 3).params).toMatchObject({ radius: 8.5, seconds: 6.5 });
    expect(abilityAtTier(talus.skill, 3).params).toMatchObject({ shieldPct: 0.25, pillarSeconds: 12, pillars: 2 });
    expect(abilityAtTier(talus.burst, 3).params).toMatchObject({ healPct: 0.35, stunSeconds: 2.5 });
  });

  it('report tier 0 as the base values and the next tier until the maximum', () => {
    for (const c of chars) {
      for (const ability of [c.skill, c.burst]) {
        const base = abilityAtTier(ability, 0);
        expect(base).toMatchObject({ tier: 0, dmgPct: 0, params: ability.params, applied: [], next: ability.upgrades[0] });
        expect(base.params).not.toBe(ability.params);
        expect([1, 2].map((t) => abilityAtTier(ability, t).next)).toEqual([ability.upgrades[1], ability.upgrades[2]]);
        expect(abilityAtTier(ability, 3).next).toBeNull();
        // Out-of-range input clamps to 0..3.
        expect([Number.NaN, -1, 7].map((t) => abilityAtTier(ability, t).tier)).toEqual([0, 0, 3]);
        // Damage never drops as tiers go up.
        const pcts = [0, 1, 2, 3].map((t) => abilityAtTier(ability, t).dmgPct);
        pcts.slice(1).forEach((p, i) => expect(p).toBeGreaterThanOrEqual(pcts[i] ?? Infinity));
      }
      expect(abilityAtTier(c.burst, 3).cooldown).toBeUndefined();
    }
  });

  it('keep each Burst cut-in within 1.0 s and before the first Burst hit', () => {
    for (const { burst } of chars) {
      expect(burst.cutIn).toBeGreaterThan(0);
      expect(burst.cutIn).toBeLessThanOrEqual(1);
      expect(burst.attack.hits[0]?.t).toBeGreaterThanOrEqual(burst.cutIn);
    }
  });
});
