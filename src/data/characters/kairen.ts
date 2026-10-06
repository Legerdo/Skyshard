// Kairen: Ember melee attacker with a one-handed curved sword (design "캐릭터 키트", "능력 강화 단계").
// Seconds from clip start, metres, dmgMul × ATK; initial values for playtesting.
import type { CharacterDef } from '../combatTypes';
import { CHARACTER_NAMES } from '../ids';

export const KAIREN: CharacterDef = {
  id: 'kairen',
  name: CHARACTER_NAMES.kairen,
  element: 'ember',
  role: '근거리 공격형',
  baseStats: { hp: 1000, atk: 120, def: 50 },
  weaponName: '한손 곡검',
  normalRange: 2.8,
  // 4연속 베기 0.9/1.0/1.1/1.6× at 0.18/0.20/0.22/0.30 s; only the 4th applies Ember.
  normal: [
    {
      id: 'atk_kairen_n1', owner: 'kairen', clip: 'kairen_n1', duration: 0.45,
      comboWindow: [0.22, 0.45], recoveryFrom: 0.32, dodgeCancelFrom: 0.2, rootMotion: 0.4,
      hits: [
        { t: 0.18, shape: { kind: 'arc', radius: 2.4, angleDeg: 110, height: 2 }, dmgMul: 0.9,
          appliesElement: false, poise: 10, knockback: 0.3, energy: 'normalHit' },
      ],
    },
    {
      id: 'atk_kairen_n2', owner: 'kairen', clip: 'kairen_n2', duration: 0.48,
      comboWindow: [0.24, 0.48], recoveryFrom: 0.34, dodgeCancelFrom: 0.22, rootMotion: 0.4,
      hits: [
        { t: 0.2, shape: { kind: 'arc', radius: 2.4, angleDeg: 110, height: 2 }, dmgMul: 1.0,
          appliesElement: false, poise: 10, knockback: 0.3, energy: 'normalHit' },
      ],
    },
    {
      id: 'atk_kairen_n3', owner: 'kairen', clip: 'kairen_n3', duration: 0.52,
      comboWindow: [0.26, 0.52], recoveryFrom: 0.36, dodgeCancelFrom: 0.24, rootMotion: 0.5,
      hits: [
        { t: 0.22, shape: { kind: 'arc', radius: 2.6, angleDeg: 140, height: 2 }, dmgMul: 1.1,
          appliesElement: false, poise: 15, knockback: 0.5, energy: 'normalHit' },
      ],
    },
    {
      id: 'atk_kairen_n4', owner: 'kairen', clip: 'kairen_n4', duration: 0.8,
      recoveryFrom: 0.55, dodgeCancelFrom: 0.34, rootMotion: 0.8,
      hits: [
        { t: 0.3, shape: { kind: 'arc', radius: 2.8, angleDeg: 160, height: 2.2 }, dmgMul: 1.6,
          appliesElement: true, poise: 25, knockback: 1.5, energy: 'normalHit' },
      ],
    },
  ],
  // 회전 상승 베기: 3 m around Kairen, launches.
  charged: {
    id: 'atk_kairen_charged', owner: 'kairen', clip: 'kairen_charged', duration: 0.9,
    recoveryFrom: 0.62, dodgeCancelFrom: 0.45,
    hits: [
      { t: 0.36, shape: { kind: 'sphere', radius: 3, offset: { x: 0, y: 1, z: 0 } }, dmgMul: 2.4,
        appliesElement: true, poise: 40, knockback: 0.5, launch: 0.6, energy: 'chargedHit' },
    ],
  },
  // 화염 돌진: dashes `dash` m; the path capsule (length = dash) is judged as the dash starts.
  skill: {
    cooldown: 8,
    params: { radius: 1.2, dash: 6, flameTrailSeconds: 0 },
    attack: {
      id: 'atk_kairen_skill', owner: 'kairen', clip: 'kairen_skill', duration: 0.7,
      recoveryFrom: 0.5, dodgeCancelFrom: 0.36, rootMotion: 6,
      hits: [
        { t: 0.12, shape: { kind: 'capsule', length: 6, radius: 1.2 }, dmgMul: 1.8,
          appliesElement: true, poise: 35, knockback: 1, energy: 'skillCastHit' },
      ],
    },
    upgrades: [
      { label: '피해 +15%', dmgPct: 0.15 },
      { label: '피해 +15%, 돌진 8 m', dmgPct: 0.15, extra: 'dash=8' },
      { label: '피해 +20%, 경로에 3 s 화염 자국(Ember 지대)', dmgPct: 0.2, extra: 'flameTrailSeconds=3' },
    ],
  },
  // 태양 낙하: leaps, then slams a 5 m circle ahead after the 1.0 s cut-in.
  burst: {
    energyCost: 60,
    cutIn: 1.0,
    params: { radius: 5, aftershockMul: 0 },
    attack: {
      id: 'atk_kairen_burst', owner: 'kairen', clip: 'kairen_burst', duration: 1.6,
      recoveryFrom: 1.35, dodgeCancelFrom: 1.2, rootMotion: 4,
      hits: [
        { t: 1.05, shape: { kind: 'sphere', radius: 5, offset: { x: 0, y: 0, z: 2 } }, dmgMul: 4.5,
          appliesElement: true, poise: 80, knockback: 3, energy: null },
      ],
    },
    upgrades: [
      { label: '피해 +15%', dmgPct: 0.15 },
      { label: '반경 6.5 m', dmgPct: 0, radiusAdd: 1.5 },
      { label: '피해 +25%, 2차 충격파 1.5×', dmgPct: 0.25, extra: 'aftershockMul=1.5' },
    ],
  },
  passive: { activity: 'sprint', staminaMul: 0.8, text: '질주 Stamina 소모 20% 감소' },
};
