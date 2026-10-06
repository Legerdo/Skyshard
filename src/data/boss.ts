/*
 * Caelith data (design "Boss Caelith"; Req 6.1–6.9): the boss numbers, the Phase table (`BossPhaseDef`), the eight
 * attacks (`BossAttackDef`: strength and, per judgement, Telegraph and ATK multiplier), the arena, the Shard_Crystals
 * and the Starshell. src/logic/boss reads the Phase table (`bossPhaseFor`, `phaseFloorHp`, `bossPhaseDef`).
 *
 * The BossEncounter (src/boss/bossEncounter) plays the attacks from their action schedule (`CAELITH_ACTIONS`: when
 * each judgement's Telegraph shows and when it is judged, derived so that the warning equals the table's `telegraph`),
 * their geometry (`CAELITH_GEOMETRY`) and the scheduler's cooldowns and weights; BossBrain (src/boss/bossBrain) draws
 * from them. `def` 50, the cooldowns, weights, recoveries, knockbacks and the Shard_Crystal pulse / break damage are
 * implementation choices (the design gives none).
 *
 * Pure data: no three.js, DOM or Math.random (src/data layering rule).
 */

import { BOSS_NAMES, type ElementId } from './ids';

// ── Telegraph minimum ───────────────────────────────────────────────────────

/** Heavy (강) and normal (일반) attacks, the design tables' (강) / (일반). */
export type AttackStrength = 'normal' | 'strong';
/** Minimum warning before every judgement of an attack of that strength (s, Req 6.9, 28.9). */
export const MIN_TELEGRAPH: Readonly<Record<AttackStrength, number>> = { normal: 0.4, strong: 0.8 };

// ── Caelith ─────────────────────────────────────────────────────────────────

export const CAELITH = {
  id: 'caelith',
  name: BOSS_NAMES.caelith,
  /** Subtitle under the name on the HUD boss bar (design "적·보스 표시"). */
  epithet: '추락한 별의 수호자',
  /** Balanced for a level 7–8 party of four with Reactions and Burst (design 밸런스 목표). */
  maxHp: 24000,
  /** Fixed level; `atk` is its ATK at that level, so computeDamage gets `level = damageLevel` (1) and no growth. */
  level: 9,
  atk: 120,
  damageLevel: 1,
  /** Placeholder (the design gives none). */
  def: 50,
  /** Hurt capsule: radius and height of the ≈ 6 m knight, floating `hover` m above the floor. */
  radius: 1.6,
  height: 6,
  hover: 0.5,
  /** Body collider radius (the party walks around it). */
  bodyRadius: 1.4,
  /** Drift speed toward the Active_Character (m/s) and turn rate (rad/s). */
  moveSpeed: 4,
  turnRate: Math.PI,
  /** ± jitter on the Phase's base interval (design 패턴 스케줄러 4). */
  intervalJitter: 0.3,
  /** Wait before the first attack after `begin`. */
  openingWait: 1.5,
  /** Phase transition: `'boss:phaseChanged'`, no damage either way (Req 6.10). */
  transitionSeconds: 3,
  /** Distance filters of the scheduler: slashCombo within, starShards and dash beyond (design 패턴 스케줄러 2). */
  slashRange: 6,
  shardsMinRange: 8,
  dashMinRange: 10,
  /** Caelith stays this far inside the arena edge. */
  arenaMargin: 5,
  /** Phase 1: every this-many-th decision is the slashCombo → groundSlam combo (Req 6.2). */
  comboEvery: 3,
  /** No new Telegraph for this long after a strong attack ends (design 패턴 스케줄러 4). */
  strongGap: 1.0,
  /** Vulnerable `stagger` after the Phase 1 combo and after the Astral Sweep (Req 6.2, 6.8). */
  comboStaggerSeconds: 3,
  astralStaggerSeconds: 2.5,
  /** summonCrystals is forced again once fewer than this many crystals stand (and its 30 s cooldown is over). */
  resummonBelow: 2,
} as const;

// ── Phase table ─────────────────────────────────────────────────────────────

/**
 * Phase keys of the table (the design's data-side `BossPhase`). src/logic/boss numbers the same Phases 1 | 2 | 3
 * (3 = Final Phase), `BOSS_PHASES[phase - 1]`.
 */
export type BossPhaseKey = 'p1' | 'p2' | 'final';

/** The eight attacks, in the order the Phases add them. */
export const CAELITH_ATTACKS = [
  'slashCombo', 'starShards', 'groundSlam',
  'dash', 'sectorBlast', 'summonCrystals',
  'starfall', 'astralSweep',
] as const;
export type CaelithAttack = (typeof CAELITH_ATTACKS)[number];
export type CaelithAttackId = `atk_caelith_${CaelithAttack}`;

export interface BossPhaseDef {
  readonly phase: BossPhaseKey;
  /** The Phase ends once the HP ratio is at or below this: 0.65 / 0.30 / 0 (Req 6.1). */
  readonly until: number;
  /** Base wait from the end of one attack to the next Telegraph (s). */
  readonly interval: number;
  /** Attacks this Phase adds to the previous Phases' pool. */
  readonly adds: readonly CaelithAttack[];
  /** Starshell active (from Phase 2, Req 6.3). */
  readonly starshell: boolean;
  readonly music: 'mus_boss_p1' | 'mus_boss_p2' | 'mus_boss_p3';
}

/**
 * Phase 1 (100–65 %), Phase 2 (65–30 %), Final Phase (30–0 %). The Final interval is Phase 1's −30 %:
 * 2.2 × 0.7 = 1.54 s (Req 6.7).
 */
export const BOSS_PHASES: readonly [BossPhaseDef, BossPhaseDef, BossPhaseDef] = [
  { phase: 'p1', until: 0.65, interval: 2.2, adds: ['slashCombo', 'starShards', 'groundSlam'], starshell: false, music: 'mus_boss_p1' },
  { phase: 'p2', until: 0.3, interval: 1.9, adds: ['dash', 'sectorBlast', 'summonCrystals'], starshell: true, music: 'mus_boss_p2' },
  { phase: 'final', until: 0, interval: 1.54, adds: ['starfall', 'astralSweep'], starshell: true, music: 'mus_boss_p3' },
];

/** Attack pool of a Phase: every attack its Phase and the earlier ones add, in table order. */
export function attackPool(phase: BossPhaseKey): readonly CaelithAttack[] {
  const end = BOSS_PHASES.findIndex((def) => def.phase === phase);
  return BOSS_PHASES.slice(0, end + 1).flatMap((def) => def.adds);
}

// ── Attacks ─────────────────────────────────────────────────────────────────

export interface BossAttackDef {
  readonly id: CaelithAttackId;
  /** null: an action without damage (summonCrystals). */
  readonly strength: AttackStrength | null;
  /**
   * Warning before each judgement (s): the first is the Telegraph; a combo's later hits count the time since the
   * previous hit, a sequence's own markers (sectorBlast zones) their own lead time. Each ≥ MIN_TELEGRAPH[strength].
   */
  readonly telegraph: readonly number[];
  /** ATK multiplier of each judgement (0: no damage); same length as `telegraph`. */
  readonly dmgMul: readonly number[];
  /** Period of a forced event (s): astralSweep 18, summonCrystals 30 (while fewer crystals remain). */
  readonly every?: number;
}

/** The design's 공격 정의 table. A volley (starShards' 3 shards, starfall's 5 circles) is one judgement. */
export const BOSS_ATTACKS = {
  /** 연속 베기: body and blade glow 0.5 s, 0.4 s between sweeps; front 4.5 m 120° sector, 3 hits (Req 6.2). */
  slashCombo: { id: 'atk_caelith_slashCombo', strength: 'normal', telegraph: [0.5, 0.4, 0.4], dmgMul: [1.0, 1.0, 1.4] },
  /** 별 파편: hand glow and aim lines 0.6 s; 3 shards 15° apart at 22 m/s, 0.8 each (Req 6.2). */
  starShards: { id: 'atk_caelith_starShards', strength: 'normal', telegraph: [0.6], dmgMul: [0.8] },
  /** 내려찍기: 6 m ground circle 1.0 s; after the slashCombo → groundSlam combo a 3 s Stagger (Req 6.2). */
  groundSlam: { id: 'atk_caelith_groundSlam', strength: 'strong', telegraph: [1.0], dmgMul: [2.0] },
  /** 돌진: straight path line 3 m wide, 20 m long, 0.9 s (Req 6.3). */
  dash: { id: 'atk_caelith_dash', strength: 'strong', telegraph: [0.9], dmgMul: [1.8] },
  /** 구역 폭발: 4 of the 8 sectors light 0.4 s apart, each exploding 1.0 s after it lights (Req 6.3). */
  sectorBlast: { id: 'atk_caelith_sectorBlast', strength: 'strong', telegraph: [1.0, 1.0, 1.0, 1.0], dmgMul: [1.6, 1.6, 1.6, 1.6] },
  /** Shard_Crystal 소환: 1.0 s summon, no damage; first action of Phase 2, then every 30 s while few remain (Req 6.3). */
  summonCrystals: { id: 'atk_caelith_summonCrystals', strength: null, telegraph: [1.0], dmgMul: [0], every: 30 },
  /** Starfall: five 3 m circles 1.2 s, then the meteors land (Req 6.7). */
  starfall: { id: 'atk_caelith_starfall', strength: 'strong', telegraph: [1.2], dmgMul: [1.8] },
  /**
   * Astral Sweep: leap, ring glow and warning sound 1.2 s, then a 360° ring (0.8 m high, 1.5 m thick, 14 m/s);
   * about every 18 s in the Final Phase, a 2.5 s vulnerable window after it (Req 6.7, 6.8).
   */
  astralSweep: { id: 'atk_caelith_astralSweep', strength: 'strong', telegraph: [1.2], dmgMul: [2.2], every: 18 },
} as const satisfies Readonly<Record<CaelithAttack, BossAttackDef>>;

// ── Arena, Shard_Crystal, Starshell ─────────────────────────────────────────

/**
 * Arena on the Sanctum island (design Arena): sanctum_arena, 32 m radius, 8 floor sectors of 45° for sectorBlast,
 * Shard_Crystal sockets 18 m from the centre and a 1.2 m rim wall.
 */
export const ARENA = { location: 'sanctum_arena', radius: 32, sectors: 8, socketRadius: 18, rimHeight: 1.2 } as const;

/**
 * Shard_Crystal (design Shard_Crystal; Req 6.6): HP 300, DEF 0. While it stands a Party character within
 * `triggerRadius` sets off a 3 m ring pulse every 6 s after a 0.8 s Telegraph (checked as a strong attack); broken,
 * it applies its Element to Caelith within `markRadius`.
 */
export const SHARD_CRYSTAL = {
  hp: 300, def: 0, triggerRadius: 3, pulseRadius: 3, pulseTelegraph: 0.8, pulseEvery: 6, markRadius: 6,
  /** ATK multiplier of the ring pulse on a Party character (implementation choice). */
  pulseDmgMul: 1.0,
  /**
   * The break's burst when it marks Caelith (implementation choice): into the Starshell ×3 when its Element reacts,
   * ×0.25 when it matches, straight to HP (×1.5 while vulnerable) without one.
   */
  breakDamage: 150,
  /** Hurt capsule standing on the pedestal top (m). */
  radius: 0.7,
  height: 1.8,
} as const;

/**
 * The four sockets north, east, south and west of the arena centre (+x east, +z south), one crystal of each Element;
 * a re-summon fills only the empty ones, so each Element stays at most once.
 */
export const SHARD_CRYSTAL_SOCKETS: readonly { readonly element: ElementId; readonly dx: number; readonly dz: number }[] = [
  { element: 'ember', dx: 0, dz: -ARENA.socketRadius },
  { element: 'tide', dx: ARENA.socketRadius, dz: 0 },
  { element: 'gale', dx: 0, dz: ARENA.socketRadius },
  { element: 'terra', dx: -ARENA.socketRadius, dz: 0 },
];

/**
 * Starshell (design Starshell; Req 6.4, 6.5): max durability 1,200 in Phase 2 and 900 in the Final Phase; its
 * Element changes every 12 s. Same-Element hits deal 25 % and Reactions 300 % to it (the Element_Shield multipliers
 * of logic/damage). Broken, Caelith is `disabled` for 6 s taking 150 %, then it regrows at full durability.
 */
export const STARSHELL = {
  durability: { p2: 1200, final: 900 },
  rotateSeconds: 12,
  sameElementMul: 0.25,
  reactionMul: 3,
  disabledSeconds: 6,
  disabledDamageMul: 1.5,
} as const;

// ── Runtime action schedule ─────────────────────────────────────────────────

/**
 * One judgement of an action: its Telegraph shows from `shownAt` and it is judged at `at` (s from the action start).
 * `at − shownAt` is the table's `telegraph` of that judgement: a combo's later sweeps show as the previous one lands
 * (the time since the previous hit), sectorBlast's zones light 0.4 s apart and each explodes 1.0 s after it lit.
 */
export interface BossJudgementTiming {
  readonly shownAt: number;
  readonly at: number;
}

/** How the BossEncounter plays one attack. */
export interface BossActionDef {
  /** Index-aligned with BOSS_ATTACKS[name].telegraph / dmgMul. */
  readonly judgements: readonly BossJudgementTiming[];
  /**
   * The active part ends here (s from the action start; ≥ the last `at`) and recovery follows. astralSweep lasts
   * until its ring has crossed the arena, at least this long.
   */
  readonly activeEnd: number;
  /** Recovery after the active part (s). */
  readonly recovery: number;
  /** Cooldown from the action start (s); summonCrystals and astralSweep use their `every`. */
  readonly cooldown: number;
  /** Weight in the scheduler's draw; 0: only as a forced event (summonCrystals, astralSweep). */
  readonly weight: number;
  /** Push on a hit Party character (m). */
  readonly knockback: number;
}

export const CAELITH_ACTIONS = {
  slashCombo: {
    judgements: [{ shownAt: 0, at: 0.5 }, { shownAt: 0.5, at: 0.9 }, { shownAt: 0.9, at: 1.3 }],
    activeEnd: 1.5, recovery: 0.6, cooldown: 0, weight: 3, knockback: 1.5,
  },
  starShards: { judgements: [{ shownAt: 0, at: 0.6 }], activeEnd: 0.9, recovery: 0.5, cooldown: 0, weight: 2, knockback: 0.5 },
  groundSlam: { judgements: [{ shownAt: 0, at: 1.0 }], activeEnd: 1.3, recovery: 0.7, cooldown: 6, weight: 1, knockback: 3 },
  dash: { judgements: [{ shownAt: 0, at: 0.9 }], activeEnd: 1.3, recovery: 0.6, cooldown: 5, weight: 2, knockback: 4 },
  sectorBlast: {
    judgements: [{ shownAt: 0, at: 1.0 }, { shownAt: 0.4, at: 1.4 }, { shownAt: 0.8, at: 1.8 }, { shownAt: 1.2, at: 2.2 }],
    activeEnd: 2.4, recovery: 0.6, cooldown: 9, weight: 1.5, knockback: 2,
  },
  summonCrystals: {
    judgements: [{ shownAt: 0, at: 1.0 }], activeEnd: 1.2, recovery: 0.5, cooldown: BOSS_ATTACKS.summonCrystals.every, weight: 0, knockback: 0,
  },
  starfall: { judgements: [{ shownAt: 0, at: 1.2 }], activeEnd: 1.5, recovery: 0.6, cooldown: 7, weight: 2, knockback: 2 },
  astralSweep: {
    judgements: [{ shownAt: 0, at: 1.2 }], activeEnd: 1.2, recovery: 0, cooldown: BOSS_ATTACKS.astralSweep.every, weight: 0, knockback: 3,
  },
} as const satisfies Readonly<Record<CaelithAttack, BossActionDef>>;

/** Geometry of the attacks (design 공격 정의 table; m, m/s, s). */
export const CAELITH_GEOMETRY = {
  /** Front sector of each sweep, from the floor up to `height`. */
  slash: { radius: 4.5, angleDeg: 120, height: 3 },
  /** Three shards 15° apart at 22 m/s from hand height; the aim lines are `aimWidth` wide. */
  shards: { count: 3, spreadDeg: 15, speed: 22, radius: 0.5, maxRange: 34, launchHeight: 1.6, aimWidth: 1 },
  slam: { radius: 6 },
  /** Path line 3 m wide, up to 20 m long; Caelith rushes along it in `rushSeconds` after the Telegraph. */
  dash: { width: 3, length: 20, rushSeconds: 0.3 },
  /** Zones lit per sectorBlast (of the arena's 8). */
  sectorBlast: { zones: 4 },
  /** Five 3 m circles: one on the Active_Character, the rest `spreadMin`–`spreadMax` m around it. */
  starfall: { count: 5, radius: 3, spreadMin: 4, spreadMax: 9 },
  /** Ring 0.8 m high and 1.5 m thick expanding at 14 m/s; Caelith leaps `leapHeight` m during the Telegraph. */
  astral: { height: 0.8, thickness: 1.5, speed: 14, leapHeight: 2.5 },
  /** Vertical reach of ground judgements above the floor (circles, sectors, lines): a jump does not clear them. */
  groundReach: 1.5,
} as const;
