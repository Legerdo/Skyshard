/*
 * Enemy AI rules (design.md "AI 상태 머신", "감지·추적·거리 유지", "공격 토큰과 분리", "갱신 비용"; Req 28.2–28.6,
 * 28.12): the state table, detection, when an alert starts, leash / lost target, the 80 m sleep range and the 20 Hz
 * decision cadence, ranged distance keeping, attack choice and the line-of-sight ray, and the melee attack tokens.
 * Pure: no three.js, DOM or randomness. The per-enemy state itself lives in the non-saved RuntimeState.
 */
import { DEG2RAD, dirFromYaw } from '../core/math';
import type { Vec3 } from '../core/types';
import type { EntityId } from '../data/ids';

/** Detection (Req 28.3): a 120° forward cone out to 14 m, or anywhere within 6 m. */
export const DETECT_CONE_DEG = 120;
export const DETECT_CONE_RANGE = 14;
export const DETECT_NEAR_RANGE = 6;
/** Seconds of the alert reaction ("!" and warning sound) before chasing (Req 28.3). */
export const ALERT_SECONDS = 0.5;
/**
 * Feet height difference beyond which nothing is sensed (implementation choice): a character on a ledge or
 * platform far above or below is out of reach, so it does not pull enemies off their floor.
 */
export const DETECT_HEIGHT_RANGE = 5;
/** Leash (Req 28.5): chase / recovery give up this far (m, horizontal) from the spawn position… */
export const LEASH_RANGE = 30;
/** …or after this long (s) without detecting the target. */
export const LOST_TARGET_SECONDS = 8;
/** Beyond this distance (m) from the player an enemy sleeps: no decisions, movement or timers (Req 28.12). */
export const SLEEP_RANGE = 80;
/** Decisions run on one fixed tick in this many (60 Hz → 20 Hz), phased by the enemy's ordinal. */
export const DECISION_PERIOD = 3;
/** Line of sight (Req 28.4): from this fraction of the enemy's height to this fraction of the target's. */
export const EYE_HEIGHT_FRACTION = 0.9;
export const CHEST_HEIGHT_FRACTION = 0.7;
/** A ray hit closer than the target by more than this (m) blocks the sight line. */
export const SIGHT_EPSILON = 1e-3;

const TIME_EPS = 1e-9;

/** Detection shape; EnemyDef.perception has this form. */
export interface Perception {
  readonly coneDeg: number;
  readonly coneRange: number;
  readonly nearRange: number;
}

export const STANDARD_DETECTION: Perception = {
  coneDeg: DETECT_CONE_DEG,
  coneRange: DETECT_CONE_RANGE,
  nearRange: DETECT_NEAR_RANGE,
};

const COS_HALF_CONE = Math.cos((DETECT_CONE_DEG / 2) * DEG2RAD);

/**
 * Whether an enemy at `pos` facing `yaw` senses a target at `target`: horizontal distance and angle within
 * DETECT_HEIGHT_RANGE of height, no terrain occlusion (design "감지·추적·거리 유지"). Being hit also counts as
 * detection; callers handle that.
 */
export function detectsTarget(
  pos: Readonly<Vec3>,
  yaw: number,
  target: Readonly<Vec3>,
  perception: Perception = STANDARD_DETECTION,
): boolean {
  if (!(Math.abs(target.y - pos.y) <= DETECT_HEIGHT_RANGE)) return false;
  const dx = target.x - pos.x;
  const dz = target.z - pos.z;
  const d = Math.hypot(dx, dz);
  if (d <= perception.nearRange) return true;
  if (!(d <= perception.coneRange)) return false;
  const cosHalf = perception.coneDeg === DETECT_CONE_DEG ? COS_HALF_CONE : Math.cos((perception.coneDeg / 2) * DEG2RAD);
  const f = dirFromYaw(yaw);
  return (dx * f.x + dz * f.z) / d >= cosHalf;
}

/** What starts an alert: seeing the target (the detection shape) or being hit. */
export type AlertCause = 'sight' | 'hit';

/** Whether `cause` alerts an enemy in `state`: sight only in idle / patrol, a hit also during return (Req 28.3). */
export function alertsOn(state: AiState, cause: AlertCause): boolean {
  return state === 'idle' || state === 'patrol' || (cause === 'hit' && state === 'return');
}

/**
 * Whether a chase / recovery turns to return (Req 28.5): `fromSpawn` (m, horizontal) at or beyond LEASH_RANGE, or
 * `unseen` seconds without detection at or beyond LOST_TARGET_SECONDS.
 */
export function shouldReturn(fromSpawn: number, unseen: number): boolean {
  return fromSpawn >= LEASH_RANGE || unseen >= LOST_TARGET_SECONDS - TIME_EPS;
}

/** Whether an enemy `distance` m from the player sleeps (strictly beyond SLEEP_RANGE, Req 28.12). */
export function sleepsAt(distance: number): boolean {
  return distance > SLEEP_RANGE;
}

/**
 * The 20 Hz decision cadence (design "갱신 비용"): the enemy with ordinal `n` decides on fixed tick `tick` only when
 * `(tick + n) % 3 === 0`, which spreads the enemies over three ticks.
 */
export function isDecisionTick(tick: number, n: number): boolean {
  return (tick + n) % DECISION_PERIOD === 0;
}

/** How a ranged enemy moves to keep its target inside the `keep` band (m, Req 28.4: 8–14). */
export type KeepMove = 'approach' | 'retreat' | 'strafe';

export function keepRangeMove(distance: number, keep: readonly [number, number]): KeepMove {
  if (distance > keep[1]) return 'approach';
  if (distance < keep[0]) return 'retreat';
  return 'strafe';
}

/** What attack choice needs of an attack definition. */
export interface AttackOption<K extends string = string> {
  readonly id: K;
  /** Target distance window (m, to the target's surface) in which it may start. */
  readonly useRange: readonly [number, number];
}

/**
 * The first attack (priority order) whose `useRange` holds `gap` and whose cooldown has run out at `now`
 * (`readyAt[id]` is the sim time it may start again; absent means ready), else null.
 */
export function pickAttack<T extends AttackOption>(
  attacks: readonly T[],
  gap: number,
  readyAt: Readonly<Partial<Record<T['id'], number>>>,
  now: number,
): T | null {
  const ready: Readonly<Partial<Record<string, number>>> = readyAt;
  for (const a of attacks) {
    const [min, max] = a.useRange;
    if (gap >= min && gap <= max && (ready[a.id] ?? Number.NEGATIVE_INFINITY) <= now + TIME_EPS) return a;
  }
  return null;
}

/** A sight ray: unit direction from `origin`, `distance` m long. */
export interface SightLine {
  readonly origin: Vec3;
  readonly dir: Vec3;
  readonly distance: number;
}

/**
 * The line-of-sight ray from an enemy's eyes (feet `from` + EYE_HEIGHT_FRACTION × `fromHeight`) to a target's chest
 * (feet `to` + CHEST_HEIGHT_FRACTION × `toHeight`); null when the two points coincide.
 */
export function sightLine(from: Readonly<Vec3>, fromHeight: number, to: Readonly<Vec3>, toHeight: number): SightLine | null {
  const origin = { x: from.x, y: from.y + fromHeight * EYE_HEIGHT_FRACTION, z: from.z };
  const dx = to.x - origin.x;
  const dy = to.y + toHeight * CHEST_HEIGHT_FRACTION - origin.y;
  const dz = to.z - origin.z;
  const distance = Math.hypot(dx, dy, dz);
  if (!(distance > SIGHT_EPSILON)) return null;
  return { origin, dir: { x: dx / distance, y: dy / distance, z: dz / distance }, distance };
}

/** Whether a solid ray hit at `hitDistance` (null: nothing hit) leaves `line` open to its end. */
export function sightClear(line: SightLine, hitDistance: number | null): boolean {
  return hitDistance === null || hitDistance >= line.distance - SIGHT_EPSILON;
}

/** The eight required states plus `stagger` (Req 28.2, 26.9). */
export const AI_STATES = [
  'idle', 'patrol', 'alert', 'chase', 'attack', 'recovery', 'stagger', 'return', 'dead',
] as const;
export type AiState = (typeof AI_STATES)[number];

/**
 * Allowed edges, shared by every enemy kind (a kind that omits a state simply never requests it).
 * Anything not listed is refused, including self-transitions; `dead` is terminal.
 */
export const AI_TRANSITIONS: Readonly<Record<AiState, readonly AiState[]>> = {
  idle: ['patrol', 'alert', 'dead'],
  patrol: ['idle', 'alert', 'dead'],
  alert: ['chase', 'dead'],
  chase: ['attack', 'return', 'stagger', 'dead'],
  attack: ['recovery', 'stagger', 'dead'],
  recovery: ['chase', 'return', 'stagger', 'dead'],
  stagger: ['chase', 'dead'],
  return: ['idle', 'alert', 'dead'],
  dead: [],
};

/** Whether `from → to` is an edge of {@link AI_TRANSITIONS}. */
export function aiTransition(from: AiState, to: AiState): boolean {
  return AI_TRANSITIONS[from].includes(to);
}

/**
 * Melee attack tokens (Req 28.6): a melee enemy must hold one to enter `attack`, so at most
 * `capacity` (default 2) start melee attacks at once. Ranged enemies do not use tokens.
 */
export class MeleeTokenPool {
  readonly capacity: number;
  private readonly held = new Set<EntityId>();

  /** @throws RangeError when `capacity` is not a non-negative integer. */
  constructor(capacity = 2) {
    if (!Number.isInteger(capacity) || capacity < 0) {
      throw new RangeError(`MeleeTokenPool: invalid capacity ${capacity}`);
    }
    this.capacity = capacity;
  }

  /** Current token holders (live, read-only view). */
  get holders(): ReadonlySet<EntityId> {
    return this.held;
  }

  /** True when `id` holds a token afterwards: it already held one, or a slot was free. */
  acquire(id: EntityId): boolean {
    if (this.held.has(id)) return true;
    if (this.held.size >= this.capacity) return false;
    this.held.add(id);
    return true;
  }

  /** Returns `id`'s token (recovery end, stagger, dead, return); ids holding none are ignored. */
  release(id: EntityId): void {
    this.held.delete(id);
  }
}
