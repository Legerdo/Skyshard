import { describe, expect, it } from 'vitest';
import { CHARACTERS } from '../../../src/data/characters';
import { createNewGameState } from '../../../src/logic/save/gameState';
import { canUpgradeAbility, starmoteOf, upgradedAbility } from '../../../src/logic/upgrades';

describe('upgradedAbility (Echo Altar tier effects, Req 29.5)', () => {
  it('returns the kit itself at tier 0', () => {
    const skill = CHARACTERS.kairen.skill;
    const up = upgradedAbility(skill, 0);
    expect(up).toMatchObject({ tier: 0, dmgPct: 0, cooldown: 8, applied: [] });
    expect(up.attack).toBe(skill.attack);
    expect(up.params).toEqual(skill.params);
    expect(up.params).not.toBe(skill.params);
  });

  it('sums the damage bonus and applies `key=value` extras; a dash extra lengthens the path capsule', () => {
    const skill = CHARACTERS.kairen.skill;
    const t2 = upgradedAbility(skill, 2);
    expect(t2.dmgPct).toBeCloseTo(0.3, 12);
    expect(t2.params.dash).toBe(8);
    expect(t2.attack.hits[0]?.shape).toMatchObject({ kind: 'capsule', length: 8, radius: 1.2 });
    expect(skill.attack.hits[0]?.shape).toMatchObject({ length: 6 }); // the kit is untouched
    const t3 = upgradedAbility(skill, 3);
    expect(t3.dmgPct).toBeCloseTo(0.5, 12);
    expect(t3.params.flameTrailSeconds).toBe(3);
    expect(t3.applied).toEqual(skill.upgrades.map((t) => t.label));
  });

  it('grows hit shapes with radiusAdd, adds durationAdd to the volleys and replaces the cooldown', () => {
    const burst = upgradedAbility(CHARACTERS.kairen.burst, 2);
    expect(burst.params.radius).toBe(6.5);
    expect(burst.attack.hits[0]?.shape).toMatchObject({ kind: 'sphere', radius: 6.5 });
    const isla = upgradedAbility(CHARACTERS.isla.burst, 2);
    expect(isla.attack.hits[0]?.shape).toMatchObject({ kind: 'arc', radius: 13 });
    const wren = upgradedAbility(CHARACTERS.wren.burst, 3);
    expect(wren.params.seconds).toBe(CHARACTERS.wren.burst.params.seconds + 1.5);
    const withCooldown = [CHARACTERS.kairen, CHARACTERS.isla, CHARACTERS.wren, CHARACTERS.talus]
      .map((kit) => [kit.id, upgradedAbility(kit.skill, 3).cooldown, kit.skill.cooldown] as const)
      .filter(([, up, base]) => up !== base);
    for (const [id, up] of withCooldown) {
      const set = CHARACTERS[id].skill.upgrades.filter((t) => t.cooldownSet !== undefined).at(-1)?.cooldownSet;
      expect(up, id).toBe(set);
    }
  });

  it('clamps the tier to 0–3', () => {
    expect(upgradedAbility(CHARACTERS.talus.skill, 7).tier).toBe(3);
    expect(upgradedAbility(CHARACTERS.talus.skill, -2).tier).toBe(0);
    expect(upgradedAbility(CHARACTERS.talus.skill, 3).params.pillarSeconds).toBe(12);
  });
});

describe('canUpgradeAbility', () => {
  it('reads Starmote, Glim and the tier from GameState', () => {
    const gs = createNewGameState(1);
    gs.inventory.items.mat_starmote = 4;
    gs.inventory.glim = 100;
    expect(starmoteOf(gs)).toBe(4);
    expect(canUpgradeAbility(gs, 'isla', 'skill')).toEqual({ ok: true, missingStarmote: 0, missingGlim: 0, nextTier: 1 });
    gs.party.upgrades.isla.skill = 1;
    expect(canUpgradeAbility(gs, 'isla', 'skill')).toEqual({ ok: false, missingStarmote: 2, missingGlim: 150, nextTier: 2 });
    gs.party.upgrades.isla.skill = 3;
    expect(canUpgradeAbility(gs, 'isla', 'skill')).toEqual({ ok: false, missingStarmote: 0, missingGlim: 0, nextTier: null });
  });
});
