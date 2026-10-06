// Talus: Terra defender / support with a tower shield and stone gauntlets (design "캐릭터 키트",
// "능력 강화 단계"). Seconds from clip start, metres, dmgMul × ATK; initial values for playtesting.
import type { CharacterDef } from '../combatTypes';
import { CHARACTER_NAMES } from '../ids';

export const TALUS: CharacterDef = {
  id: 'talus',
  name: CHARACTER_NAMES.talus,
  element: 'terra',
  role: '방어/지원형',
  baseStats: { hp: 1300, atk: 85, def: 80 },
  weaponName: '대형 방패·석재 건틀릿',
  normalRange: 3,
  // 방패 강타 0.9/1.0× + 내려찍기 1.5× (radius 2.5 m); only the slam applies Terra.
  normal: [
    {
      id: 'atk_talus_n1', owner: 'talus', clip: 'talus_n1', duration: 0.6,
      comboWindow: [0.3, 0.6], recoveryFrom: 0.42, dodgeCancelFrom: 0.3, rootMotion: 0.4,
      hits: [
        { t: 0.24, shape: { kind: 'arc', radius: 2.2, angleDeg: 100, height: 2 }, dmgMul: 0.9,
          appliesElement: false, poise: 20, knockback: 0.8, energy: 'normalHit' },
      ],
    },
    {
      id: 'atk_talus_n2', owner: 'talus', clip: 'talus_n2', duration: 0.62,
      comboWindow: [0.32, 0.62], recoveryFrom: 0.44, dodgeCancelFrom: 0.32, rootMotion: 0.4,
      hits: [
        { t: 0.26, shape: { kind: 'arc', radius: 2.2, angleDeg: 100, height: 2 }, dmgMul: 1.0,
          appliesElement: false, poise: 20, knockback: 0.8, energy: 'normalHit' },
      ],
    },
    {
      id: 'atk_talus_n3', owner: 'talus', clip: 'talus_n3', duration: 0.95,
      recoveryFrom: 0.66, dodgeCancelFrom: 0.46,
      hits: [
        { t: 0.42, shape: { kind: 'sphere', radius: 2.5, offset: { x: 0, y: 0, z: 0.5 } }, dmgMul: 1.5,
          appliesElement: true, poise: 35, knockback: 1, energy: 'normalHit' },
      ],
    },
  ],
  // 대지 충격파: 8 m line ahead, high poise.
  charged: {
    id: 'atk_talus_charged', owner: 'talus', clip: 'talus_charged', duration: 1.0,
    recoveryFrom: 0.7, dodgeCancelFrom: 0.5,
    hits: [
      { t: 0.4, shape: { kind: 'line', length: 8, width: 2 }, dmgMul: 2.0,
        appliesElement: true, poise: 70, knockback: 1, energy: 'chargedHit' },
    ],
  },
  // 암석 방벽, all at once: a walkableTop pillar collider `pillarDistance` m ahead (a platform that
  // also presses pressure plates), the 2 m impact around it, and a `shieldPct` × max HP shield on the
  // Active_Character that stays with the party through switches.
  skill: {
    cooldown: 12,
    params: {
      radius: 2,
      pillarDistance: 2.5,
      pillarRadius: 0.8,
      pillarHeight: 2.4,
      pillarSeconds: 8,
      pillars: 1,
      shieldPct: 0.2,
      shieldSeconds: 8,
    },
    attack: {
      id: 'atk_talus_skill', owner: 'talus', clip: 'talus_skill', duration: 0.8,
      recoveryFrom: 0.55, dodgeCancelFrom: 0.45,
      hits: [
        { t: 0.4, shape: { kind: 'sphere', radius: 2, offset: { x: 0, y: 0, z: 2.5 } }, dmgMul: 1.2,
          appliesElement: true, poise: 30, knockback: 1.5, energy: 'skillCastHit' },
      ],
    },
    upgrades: [
      { label: '피해 +15%, 보호막 최대 HP 25%', dmgPct: 0.15, extra: 'shieldPct=0.25' },
      { label: '돌기둥 유지 12 s', dmgPct: 0, extra: 'pillarSeconds=12' },
      { label: '돌기둥 2개(좌우)', dmgPct: 0, extra: 'pillars=2' },
    ],
  },
  // 대지의 요새: 6 m pillar ring stuns enemies and heals the whole party `healPct` × max HP.
  burst: {
    energyCost: 70,
    cutIn: 1.0,
    params: { radius: 6, stunSeconds: 1.5, healPct: 0.25 },
    attack: {
      id: 'atk_talus_burst', owner: 'talus', clip: 'talus_burst', duration: 1.7,
      recoveryFrom: 1.4, dodgeCancelFrom: 1.25,
      hits: [
        { t: 1.05, shape: { kind: 'sphere', radius: 6, offset: { x: 0, y: 0, z: 0 } }, dmgMul: 3.0,
          appliesElement: true, poise: 80, knockback: 0, energy: null },
      ],
    },
    upgrades: [
      { label: '피해 +15%', dmgPct: 0.15 },
      { label: '회복 최대 HP 35%', dmgPct: 0, extra: 'healPct=0.35' },
      { label: '기절 2.5 s', dmgPct: 0, extra: 'stunSeconds=2.5' },
    ],
  },
  passive: { activity: 'climb', staminaMul: 0.75, text: '등반 Stamina 소모 25% 감소' },
};
