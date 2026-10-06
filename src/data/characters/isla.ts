// Isla: Tide ranged attacker with a longbow (design "캐릭터 키트", "능력 강화 단계").
// Seconds from clip start, metres, dmgMul × ATK; initial values for playtesting.
// Normal and Charged shots aim per Req 24.13 (lock-on, else a 30° cone within 25 m).
import type { CharacterDef } from '../combatTypes';
import { CHARACTER_NAMES } from '../ids';

export const ISLA: CharacterDef = {
  id: 'isla',
  name: CHARACTER_NAMES.isla,
  element: 'tide',
  role: '원거리 공격형',
  baseStats: { hp: 900, atk: 100, def: 45 },
  weaponName: '장궁',
  normalRange: 25,
  // 3연사 0.7/0.8/1.2×, 45 m/s arrows reaching 25 m; only the 3rd applies Tide.
  normal: [
    {
      id: 'atk_isla_n1', owner: 'isla', clip: 'isla_n1', duration: 0.5,
      comboWindow: [0.24, 0.5], recoveryFrom: 0.34, dodgeCancelFrom: 0.22,
      hits: [
        { t: 0.2, shape: { kind: 'projectile', speed: 45, radius: 0.15, maxRange: 25, gravity: 0, pierce: 0 },
          dmgMul: 0.7, appliesElement: false, poise: 5, knockback: 0.2, energy: 'normalHit' },
      ],
    },
    {
      id: 'atk_isla_n2', owner: 'isla', clip: 'isla_n2', duration: 0.5,
      comboWindow: [0.24, 0.5], recoveryFrom: 0.34, dodgeCancelFrom: 0.22,
      hits: [
        { t: 0.18, shape: { kind: 'projectile', speed: 45, radius: 0.15, maxRange: 25, gravity: 0, pierce: 0 },
          dmgMul: 0.8, appliesElement: false, poise: 5, knockback: 0.2, energy: 'normalHit' },
      ],
    },
    {
      id: 'atk_isla_n3', owner: 'isla', clip: 'isla_n3', duration: 0.7,
      recoveryFrom: 0.46, dodgeCancelFrom: 0.3,
      hits: [
        { t: 0.28, shape: { kind: 'projectile', speed: 45, radius: 0.15, maxRange: 25, gravity: 0, pierce: 0 },
          dmgMul: 1.2, appliesElement: true, poise: 12, knockback: 0.8, energy: 'normalHit' },
      ],
    },
  ],
  // 조준 관통 화살: pierce 2, so at most 3 enemies are hit.
  charged: {
    id: 'atk_isla_charged', owner: 'isla', clip: 'isla_charged', duration: 0.7,
    recoveryFrom: 0.45, dodgeCancelFrom: 0.3,
    hits: [
      { t: 0.2, shape: { kind: 'projectile', speed: 60, radius: 0.2, maxRange: 25, gravity: 0, pierce: 2 },
        dmgMul: 2.2, appliesElement: true, poise: 25, knockback: 1, energy: 'chargedHit' },
    ],
  },
  // 물결 화살비: a placed zone at the lock-on target (else `fallbackRange` m ahead). The hit is one
  // volley; the zone repeats it every `interval` s for `seconds` s (6 volleys, 9 at tier 3).
  skill: {
    cooldown: 9,
    params: { radius: 4, seconds: 2, interval: 0.33, fallbackRange: 12 },
    attack: {
      id: 'atk_isla_skill', owner: 'isla', clip: 'isla_skill', duration: 0.75,
      recoveryFrom: 0.5, dodgeCancelFrom: 0.4,
      hits: [
        { t: 0.35, shape: { kind: 'groundCircle', radius: 4, delay: 0.5 }, dmgMul: 0.45,
          appliesElement: true, poise: 6, knockback: 0, energy: 'skillCastHit' },
      ],
    },
    upgrades: [
      { label: '피해 +15%', dmgPct: 0.15 },
      { label: '반경 5 m', dmgPct: 0, radiusAdd: 1 },
      { label: '지속 3 s (9회)', dmgPct: 0, durationAdd: 1 },
    ],
  },
  // 해일 포화: 10 m · 70° wave ahead with 4 m knockback.
  burst: {
    energyCost: 60,
    cutIn: 0.9,
    params: { radius: 10, puddleSeconds: 0, puddleSlow: 0.3 },
    attack: {
      id: 'atk_isla_burst', owner: 'isla', clip: 'isla_burst', duration: 1.5,
      recoveryFrom: 1.2, dodgeCancelFrom: 1.1,
      hits: [
        { t: 0.95, shape: { kind: 'arc', radius: 10, angleDeg: 70, height: 3 }, dmgMul: 3.5,
          appliesElement: true, poise: 60, knockback: 4, energy: null },
      ],
    },
    upgrades: [
      { label: '피해 +15%', dmgPct: 0.15 },
      { label: '부채꼴 사거리 13 m', dmgPct: 0, radiusAdd: 3 },
      { label: '4 s 물웅덩이(30% 둔화, Tide)', dmgPct: 0, extra: 'puddleSeconds=4' },
    ],
  },
  passive: { activity: 'swim', staminaMul: 0.6, text: '수영 Stamina 소모 40% 감소' },
};
