// Wren: Gale area controller with a glaive (design "캐릭터 키트", "능력 강화 단계").
// Seconds from clip start, metres, dmgMul × ATK; initial values for playtesting.
import type { CharacterDef } from '../combatTypes';
import { CHARACTER_NAMES } from '../ids';

export const WREN: CharacterDef = {
  id: 'wren',
  name: CHARACTER_NAMES.wren,
  element: 'gale',
  role: '범위 제어형',
  baseStats: { hp: 950, atk: 95, def: 50 },
  weaponName: '글레이브',
  normalRange: 3,
  // 150° 호 3연속 0.8/0.9/1.3×, radius 3 m; only the 3rd applies Gale.
  normal: [
    {
      id: 'atk_wren_n1', owner: 'wren', clip: 'wren_n1', duration: 0.55,
      comboWindow: [0.26, 0.55], recoveryFrom: 0.38, dodgeCancelFrom: 0.26, rootMotion: 0.3,
      hits: [
        { t: 0.22, shape: { kind: 'arc', radius: 3, angleDeg: 150, height: 2 }, dmgMul: 0.8,
          appliesElement: false, poise: 12, knockback: 0.5, energy: 'normalHit' },
      ],
    },
    {
      id: 'atk_wren_n2', owner: 'wren', clip: 'wren_n2', duration: 0.58,
      comboWindow: [0.28, 0.58], recoveryFrom: 0.4, dodgeCancelFrom: 0.28, rootMotion: 0.3,
      hits: [
        { t: 0.24, shape: { kind: 'arc', radius: 3, angleDeg: 150, height: 2 }, dmgMul: 0.9,
          appliesElement: false, poise: 12, knockback: 0.5, energy: 'normalHit' },
      ],
    },
    {
      id: 'atk_wren_n3', owner: 'wren', clip: 'wren_n3', duration: 0.8,
      recoveryFrom: 0.55, dodgeCancelFrom: 0.36, rootMotion: 0.5,
      hits: [
        { t: 0.32, shape: { kind: 'arc', radius: 3, angleDeg: 150, height: 2 }, dmgMul: 1.3,
          appliesElement: true, poise: 20, knockback: 1.2, energy: 'normalHit' },
      ],
    },
  ],
  // 돌풍 찌르기: 5 m line ahead, 0.8 s launch.
  charged: {
    id: 'atk_wren_charged', owner: 'wren', clip: 'wren_charged', duration: 0.85,
    recoveryFrom: 0.6, dodgeCancelFrom: 0.42, rootMotion: 1,
    hits: [
      { t: 0.3, shape: { kind: 'line', length: 5, width: 1.2 }, dmgMul: 2.0,
        appliesElement: true, poise: 35, knockback: 0, launch: 0.8, energy: 'chargedHit' },
    ],
  },
  // 소용돌이: pulls enemies within 5 m for `pullSeconds`; cast while gliding, Wren rises `glideRise` m
  // (Req 19.9).
  skill: {
    cooldown: 10,
    params: { radius: 5, pullSeconds: 1.5, glideRise: 6 },
    attack: {
      id: 'atk_wren_skill', owner: 'wren', clip: 'wren_skill', duration: 0.7,
      recoveryFrom: 0.5, dodgeCancelFrom: 0.4,
      hits: [
        { t: 0.3, shape: { kind: 'sphere', radius: 5, offset: { x: 0, y: 1, z: 0 } }, dmgMul: 1.2,
          appliesElement: true, poise: 30, knockback: 0, energy: 'skillCastHit' },
      ],
    },
    upgrades: [
      { label: '피해 +15%', dmgPct: 0.15 },
      { label: '반경 6 m', dmgPct: 0, radiusAdd: 1 },
      { label: 'Cooldown 8 s로 단축', dmgPct: 0, cooldownSet: 8 },
    ],
  },
  // 폭풍의 눈: placed 7 m whirlwind binding enemies for `seconds` s; the hit is one tick, repeated
  // every `interval` s (10 ticks).
  burst: {
    energyCost: 70,
    cutIn: 0.9,
    params: { radius: 7, seconds: 5, interval: 0.5 },
    attack: {
      id: 'atk_wren_burst', owner: 'wren', clip: 'wren_burst', duration: 1.4,
      recoveryFrom: 1.15, dodgeCancelFrom: 1.05,
      hits: [
        { t: 0.95, shape: { kind: 'sphere', radius: 7, offset: { x: 0, y: 1, z: 0 } }, dmgMul: 0.6,
          appliesElement: true, poise: 15, knockback: 0, energy: null },
      ],
    },
    upgrades: [
      { label: '피해 +15%', dmgPct: 0.15 },
      { label: '지속 6.5 s', dmgPct: 0, durationAdd: 1.5 },
      { label: '반경 8.5 m', dmgPct: 0, radiusAdd: 1.5 },
    ],
  },
  passive: { activity: 'glide', staminaMul: 0.7, text: '활강 Stamina 소모 30% 감소' },
};
