// Fills every kit HitEvent's `energyOnHit` at data load (design "Energy·Cooldown·Dodge", Req 24.7): Normal and
// Charged hits get energyGain() of their `energy` tag; Skill and Burst hits get 0 (a Skill pays
// energyGain('skillCastHit') once per cast that hits an enemy, a Burst pays nothing). Pure.
import { energyGain } from '../../logic/energy';
import type { AttackDef, CharacterDef, HitEvent } from '../combatTypes';

/** Energy one HitEvent grants when it hits at least one target. */
export function energyOnHitFor(hit: Pick<HitEvent, 'energy'>): number {
  return hit.energy === 'normalHit' || hit.energy === 'chargedHit' ? energyGain(hit.energy) : 0;
}

const fillAttack = (a: AttackDef): AttackDef => ({ ...a, hits: a.hits.map((h) => ({ ...h, energyOnHit: energyOnHitFor(h) })) });

/** A copy of `def` whose HitEvents carry `energyOnHit`; the input is not changed. */
export function withEnergyOnHit(def: CharacterDef): CharacterDef {
  return {
    ...def,
    normal: def.normal.map(fillAttack),
    charged: fillAttack(def.charged),
    skill: { ...def.skill, attack: fillAttack(def.skill.attack) },
    burst: { ...def.burst, attack: fillAttack(def.burst.attack) },
  };
}
