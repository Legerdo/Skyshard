/*
 * Animation state selection (design.md "레이어와 블렌드" 상태 선택, "다른 rig"): pure functions from what the sim decided
 * to the three layer requests. They read the controller mode and the combat action only — never input — so a Dodge
 * refused for lack of Stamina never plays, and a buffered action plays from the tick it really started.
 *
 * - Heroes (`selectAnimState`): grounded → 1D locomotion blend by horizontal speed; the other modes → full-body
 *   override clips (slide → a slope-tilted `fall`, landing → `land`, climbAttach → the climb blend at rest, locked →
 *   idle); attacks and the 0.4 s hurt play on the action layer; the weapon rides on the back while climbing, gliding
 *   and swimming.
 * - Enemies (`selectEnemyAnim`): idle · alert · recovery → idle, patrol · chase · return → move, stagger → stagger,
 *   dead → defeat; an attack plays its windup until `firstHit − lead`, then its strike (lead = the strike's first `hit`).
 * - Caelith (`selectBossAnim`) from its snapshot; NPCs (`selectNpcAnim`) from the NpcSystem's animation name (a talk
 *   is always `idle`).
 * Attack times come from the sim's attack clock (render-interpolated), so poses and judgements never drift apart.
 */
import type { CaelithAttack } from '../data/boss';
import type { NpcAnim } from '../data/village';
import { CLIMB_SPEED, RUN_SPEED, SPRINT_SPEED, WALK_SPEED } from '../player/core/constants';
import type { AnimRequest, BlendDef, LayerRequest } from './animator';

// ── Heroes ──────────────────────────────────────────────────────────────────

/** The 20 clips every Player_Character shares (Req 39.6), src/anim/clips/common.ts. */
export const HERO_COMMON_CLIPS = [
  'idle', 'walk', 'run', 'sprint', 'jump', 'fall', 'land', 'dodge', 'hurt', 'downed',
  'climbIdle', 'climbUp', 'climbDown', 'climbLeft', 'climbRight', 'climbLeap', 'mantle', 'glideDeploy', 'glide', 'swim',
] as const;
export type HeroCommonClip = (typeof HERO_COMMON_CLIPS)[number];

/** The hero blends: 1D locomotion by speed, 2D climb by the climb direction. */
export const HERO_BLENDS: Readonly<Record<'locomotion' | 'climb', BlendDef>> = {
  locomotion: {
    kind: '1d',
    points: [{ clip: 'idle', at: 0 }, { clip: 'walk', at: WALK_SPEED }, { clip: 'run', at: RUN_SPEED }, { clip: 'sprint', at: SPRINT_SPEED }],
  },
  climb: { kind: '2d', center: 'climbIdle', up: 'climbUp', down: 'climbDown', left: 'climbLeft', right: 'climbRight' },
};

/** Hurt flinch on the Active_Character (Req 26.7). */
export const HERO_HURT_SECONDS = 0.4;

export interface HeroAnimInput {
  readonly mode: string;
  /** Seconds in the mode. */
  readonly modeTime: number;
  /** Horizontal speed (m/s). */
  readonly speed: number;
  /** Climb direction on the wall (right +x, up +y; −1..1) and speed (m/s). */
  readonly climb: { readonly x: number; readonly y: number; readonly speed: number };
  /** The attack playing (its AttackDef clip) and its render-interpolated clip time, or null. */
  readonly attack: { readonly clip: string; readonly time: number } | null;
  /** Seconds into the hurt flinch, or null. */
  readonly hurtTime: number | null;
}

export type LeanMode = 'turn' | 'glide' | 'slope' | 'none';

export interface HeroAnimState extends AnimRequest {
  /** Weapon on the `back` socket (climb, glide, swim). */
  readonly weaponOnBack: boolean;
  /** Feet on the ground: the pelvis-height layer keeps the lower foot down. */
  readonly grounded: boolean;
  readonly lean: LeanMode;
}

const STOWED = new Set(['climbAttach', 'climb', 'climbLeap', 'mantle', 'glideDeploy', 'glide', 'swim']);
const GROUNDED = new Set(['grounded', 'landing', 'locked', 'hurt', 'dodge']);

const LOCOMOTION = (speed: number): LayerRequest => ({ blend: 'locomotion', x: Math.max(0, speed) });
const IDLE: LayerRequest = { clip: 'idle' };

/** The hero's layer requests for this frame (pure). */
export function selectAnimState(input: HeroAnimInput): HeroAnimState {
  const t = Math.max(0, input.modeTime);
  let base: LayerRequest = IDLE;
  let override: LayerRequest | null = null;
  let lean: LeanMode = 'none';
  switch (input.mode) {
    case 'grounded':
      base = LOCOMOTION(input.speed);
      lean = 'turn';
      break;
    case 'slide':
      override = { clip: 'fall' };
      lean = 'slope';
      break;
    case 'jump':
      override = { clip: 'jump', time: t };
      break;
    case 'fall':
      override = { clip: 'fall' };
      break;
    case 'landing':
      override = { clip: 'land', time: t };
      break;
    case 'dodge':
      override = { clip: 'dodge', time: t };
      break;
    case 'climbAttach':
      override = { blend: 'climb', x: 0, y: 0, speed: 0 };
      break;
    case 'climb':
      override = { blend: 'climb', x: input.climb.x, y: input.climb.y, speed: input.climb.speed };
      break;
    case 'climbLeap':
      override = { clip: 'climbLeap', time: t };
      break;
    case 'mantle':
      override = { clip: 'mantle', time: t };
      break;
    case 'glideDeploy':
      override = { clip: 'glideDeploy', time: t };
      lean = 'glide';
      break;
    case 'glide':
      override = { clip: 'glide' };
      lean = 'glide';
      break;
    case 'swim':
      override = { clip: 'swim', speed: input.speed };
      break;
    case 'downed':
      override = { clip: 'downed', time: t };
      break;
    case 'hurt':
      base = IDLE;
      break;
    default:
      // locked (and anything unknown): idle, or a clip a cinematic names.
      base = IDLE;
  }
  let action: LayerRequest | null = null;
  if (input.attack !== null) action = { clip: input.attack.clip, time: Math.max(0, input.attack.time) };
  else if (input.mode === 'hurt') action = { clip: 'hurt', time: t };
  else if (input.hurtTime !== null && input.hurtTime < HERO_HURT_SECONDS && GROUNDED.has(input.mode)) action = { clip: 'hurt', time: input.hurtTime };
  return { base, action, override, weaponOnBack: STOWED.has(input.mode), grounded: GROUNDED.has(input.mode), lean };
}

/** Climb direction of a climbing hero from its velocity and facing (yaw 0 faces +Z; right = the model's −X). */
export function climbDirection(vel: { readonly x: number; readonly y: number; readonly z: number }, yaw: number): { x: number; y: number; speed: number } {
  const lateral = -(vel.x * Math.cos(yaw) - vel.z * Math.sin(yaw));
  const x = lateral / CLIMB_SPEED;
  const y = vel.y / CLIMB_SPEED;
  return { x: Math.max(-1, Math.min(1, x)), y: Math.max(-1, Math.min(1, y)), speed: Math.hypot(lateral, vel.y) };
}

// ── Enemies ─────────────────────────────────────────────────────────────────

/** A windup / strike pair of one attack; `lead` is the strike clip's first `hit` time (≥ 0.1 s). */
export interface AttackClipPair {
  readonly windup: string;
  readonly strike: string;
  readonly lead: number;
}

/** One enemy kind's clips (design 클립 목록: idle, move, attackWindup, attack, hurt, stagger, defeat). */
export interface EnemyClipSet {
  readonly idle: string;
  readonly move: string;
  readonly hurt: string;
  readonly stagger: string;
  readonly defeat: string;
  /** Keyed by the AttackDef's `clip`. */
  readonly attacks: Readonly<Record<string, AttackClipPair>>;
}

export interface EnemyAnimInput {
  readonly state: string;
  readonly stateTime: number;
  /** Horizontal speed (m/s), for the move clip's speed matching. */
  readonly speed: number;
  /** The attack playing: its AttackDef clip, render-interpolated time and first hit time. */
  readonly attack: { readonly clip: string; readonly time: number; readonly firstHit: number } | null;
  /** Seconds into the hit flinch, or null. */
  readonly flinch: number | null;
}

const MOVING = new Set(['patrol', 'chase', 'return']);

/** Start of the strike within an attack (s): the first hit minus the strike's lead. */
export const strikeStart = (firstHit: number, pair: AttackClipPair): number => Math.max(0, firstHit - pair.lead);

/** An enemy's layer requests (pure). */
export function selectEnemyAnim(input: EnemyAnimInput, set: EnemyClipSet): AnimRequest {
  if (input.state === 'dead') return { base: { clip: set.idle }, action: null, override: { clip: set.defeat, time: Math.max(0, input.stateTime) } };
  if (input.state === 'stagger') return { base: { clip: set.idle }, action: null, override: { clip: set.stagger } };
  const base: LayerRequest = MOVING.has(input.state) && input.speed > 0.05 ? { clip: set.move, speed: input.speed } : { clip: set.idle };
  let action: LayerRequest | null = null;
  const pair = input.attack === null ? undefined : set.attacks[input.attack.clip];
  if (input.attack !== null && pair !== undefined) {
    const start = strikeStart(input.attack.firstHit, pair);
    action = input.attack.time < start
      ? { clip: pair.windup, time: Math.max(0, input.attack.time) }
      : { clip: pair.strike, time: input.attack.time - start };
  } else if (input.flinch !== null) {
    action = { clip: set.hurt, time: Math.max(0, input.flinch) };
  }
  return { base, action, override: null };
}

// ── Caelith ─────────────────────────────────────────────────────────────────

export interface BossAnimInput {
  readonly state: string;
  /** 1 | 2 | 3 (3 = Final Phase). */
  readonly phase: number;
  readonly attack: CaelithAttack | null;
  readonly attackTime: number;
  readonly stateTime: number;
  /** The attack whose recovery this is (the view remembers it), or null. */
  readonly lastAttack: CaelithAttack | null;
  readonly speed: number;
}

/** Clip names and timeline of one Caelith attack. */
export interface BossAttackClips {
  readonly windup: string;
  readonly strike: string;
  /** Strike start within the action (s): first judgement − lead. */
  readonly strikeStart: number;
  /** End of the active part (s from the action start); recovery continues the strike from here. */
  readonly activeEnd: number;
}

export const CAELITH_CLIPS = {
  idle: 'caelith_idle',
  move: 'caelith_move',
  stagger: 'caelith_stagger',
  disabled: 'caelith_disabled',
  death: 'caelith_death',
  phaseShiftP2: 'caelith_phaseShift_p2',
  phaseShiftFinal: 'caelith_phaseShift_final',
} as const;

/** Caelith's layer requests from its snapshot (pure). */
export function selectBossAnim(input: BossAnimInput, clips: (attack: CaelithAttack) => BossAttackClips): AnimRequest {
  const base: LayerRequest = input.speed > 0.3 ? { clip: CAELITH_CLIPS.move, speed: input.speed } : { clip: CAELITH_CLIPS.idle };
  const t = Math.max(0, input.stateTime);
  switch (input.state) {
    case 'dead':
      return { base, action: null, override: { clip: CAELITH_CLIPS.death, time: t } };
    case 'transition':
      return { base, action: null, override: { clip: input.phase >= 3 ? CAELITH_CLIPS.phaseShiftFinal : CAELITH_CLIPS.phaseShiftP2, time: t } };
    case 'stagger':
      return { base, action: null, override: { clip: CAELITH_CLIPS.stagger } };
    case 'disabled':
      return { base, action: null, override: { clip: CAELITH_CLIPS.disabled } };
    default:
      break;
  }
  if (input.attack !== null && (input.state === 'telegraph' || input.state === 'attack')) {
    const c = clips(input.attack);
    const action: LayerRequest = input.attackTime < c.strikeStart
      ? { clip: c.windup, time: Math.max(0, input.attackTime) }
      : { clip: c.strike, time: input.attackTime - c.strikeStart };
    return { base, action, override: null };
  }
  if (input.state === 'recovery' && input.lastAttack !== null) {
    const c = clips(input.lastAttack);
    return { base, action: { clip: c.strike, time: c.activeEnd - c.strikeStart + t }, override: null };
  }
  return { base, action: null, override: null };
}

// ── NPCs ────────────────────────────────────────────────────────────────────

/** NPC clip per NpcSystem animation name (idle, walk, lookAround and the per-NPC work motions, Req 14.9). */
export const NPC_ANIM_CLIPS: Readonly<Record<NpcAnim, string>> = {
  idle: 'npc_idle',
  walk: 'npc_walk',
  run: 'npc_run',
  lookAround: 'npc_lookAround',
  point: 'npc_point',
  leanCounter: 'npc_leanCounter',
  arrange: 'npc_work_arrange',
  eyesClosed: 'npc_eyesClosed',
  sweep: 'npc_work_sweep',
  restOnHoe: 'npc_restOnHoe',
  hoe: 'npc_work_hoe',
  armsCrossed: 'npc_armsCrossed',
  hammer: 'npc_work_hammer',
  notebook: 'npc_work_notebook',
  telescope: 'npc_work_telescope',
  staff: 'npc_staff',
};

/** An NPC's layer requests: its animation on the base layer (walks speed-matched), `idle` while talking. */
export function selectNpcAnim(anim: NpcAnim, talking: boolean, speed: number): AnimRequest {
  if (talking) return { base: { clip: NPC_ANIM_CLIPS.idle }, action: null, override: null };
  const clip = NPC_ANIM_CLIPS[anim];
  const walking = anim === 'walk' || anim === 'run';
  // A walker held still (the player stands within 2.5 m) idles instead of treading in place.
  if (walking && !(speed > 0.1)) return { base: { clip: NPC_ANIM_CLIPS.idle }, action: null, override: null };
  const base: LayerRequest = walking ? { clip, speed } : { clip };
  return { base, action: null, override: null };
}
