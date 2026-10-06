// Attack and ability data shapes shared by characters, enemies and Caelith (design "전투 액션 모델").
// Pure types. Times are seconds from clip start, distances metres, dmgMul a multiplier of ATK.
import type { Vec3 } from '../core/types';
import type { AttackId, AttackOwnerId, CharacterId, ElementId } from './ids';

/** Hit volume in the attacker's local frame (+Z forward, +Y up). */
export type HitShape =
  | { kind: 'arc'; radius: number; angleDeg: number; height: number } // frontal sector
  | { kind: 'sphere'; radius: number; offset: Vec3 } // sphere around a local offset
  | { kind: 'capsule'; length: number; radius: number } // capsule reaching forward
  // gravity m/s² downward; pierce = extra targets passed through before it vanishes
  | { kind: 'projectile'; speed: number; radius: number; maxRange: number; gravity: number; pierce: number }
  | { kind: 'groundCircle'; radius: number; delay: number } // ground disc judged `delay` s later
  | { kind: 'line'; length: number; width: number }; // forward strip

/** One judgement at `t`; a target is hit at most once per HitEvent. */
export interface HitEvent {
  t: number;
  shape: HitShape;
  dmgMul: number;
  /** Only the last Normal hit and Charged / Skill / Burst hits (Req 24.2). */
  appliesElement: boolean;
  poise: number;
  /** Push distance (m). */
  knockback: number;
  /** Airborne time (s). */
  launch?: number;
  /** logic/energy event granted on hit ('skillCastHit' once per cast); null for Burst. */
  energy: 'normalHit' | 'chargedHit' | 'skillCastHit' | null;
  /**
   * Energy granted once when this HitEvent hits at least one target. Filled at data load from `energy`
   * (energyGain for Normal and Charged hits, 0 for Skill and Burst hits: a Skill pays once per cast); unset
   * counts as 0 (enemy attacks).
   */
  energyOnHit?: number;
}

/** Warning shown before an enemy hit (Req 26.5); `strong` marks heavy attacks. */
export interface TelegraphDef {
  kind: 'glow' | 'circle' | 'sector' | 'line' | 'ring';
  duration: number;
  strong: boolean;
  radius?: number;
  length?: number;
  width?: number;
  angleDeg?: number;
}

export interface AttackDef {
  /** `atk_<owner>_<name>`. */
  id: AttackId;
  owner: AttackOwnerId;
  clip: string;
  duration: number;
  /** Strictly increasing `t`, all within [0, duration]. */
  hits: readonly HitEvent[];
  /** Normal hits except the last: an attack press inside it chains the next hit (Req 24.1). */
  comboWindow?: readonly [number, number];
  /** From here movement input ends the attack. */
  recoveryFrom: number;
  /** From here Dodge cancels the attack; ≤ recoveryFrom (Req 24.11). */
  dodgeCancelFrom: number;
  telegraph?: TelegraphDef;
  rootMotion?: number; // m forward over the attack
  tags?: readonly string[];
}

/** One Echo Altar tier; tiers stack and their dmgPct values add up (Req 29.4, 29.5). */
export interface AbilityTier {
  /** Korean change text shown on the upgrade screen. */
  label: string;
  /** Added to computeDamage's abilityUpgradePct. */
  dmgPct: number;
  /** Added to params.radius and to the ability's hit shape radius. */
  radiusAdd?: number;
  /** Added to params.seconds. */
  durationAdd?: number;
  /** Replaces the Skill cooldown. */
  cooldownSet?: number;
  /** `key=value` override of one params entry, e.g. 'dash=8'. */
  extra?: string;
}

export interface CharacterDef {
  id: CharacterId;
  name: string;
  element: ElementId;
  /** Korean role name. */
  role: string;
  baseStats: { hp: number; atk: number; def: number };
  /** Combo order. */
  normal: readonly AttackDef[];
  charged: AttackDef;
  skill: {
    attack: AttackDef;
    cooldown: number;
    params: Record<string, number>;
    upgrades: readonly [AbilityTier, AbilityTier, AbilityTier];
  };
  burst: {
    attack: AttackDef;
    energyCost: number;
    /** Invulnerable cut-in (s, ≤ 1.0); the first hit comes after it (Req 24.6). */
    cutIn: number;
    params: Record<string, number>;
    upgrades: readonly [AbilityTier, AbilityTier, AbilityTier];
  };
  /** Stamina drain × staminaMul while doing `activity` (logic/stamina). */
  passive: { activity: string; staminaMul: number; text: string };
  weaponName: string;
  /** Forward reach of the Normal_Attack hits (m). */
  normalRange: number;
}
