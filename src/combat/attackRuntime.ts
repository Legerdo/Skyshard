// AttackDef / HitEvent runtime shared by the party and enemies (design "전투 액션 모델", "피해 공식"; Req 24.1,
// 24.2, 24.10, 28.10). An AttackPlayback runs one AttackDef from clip start; each HitEvent is judged once, on the
// first tick whose clip time reaches its `t` (a groundCircle `delay` s later), and a HitEvent hits each target at
// most once. A hit is processed as: sample the target state → computeDamage → the receiver applies HP, then the
// hit's Element (applyElement, when the HitEvent appliesElement) and stagger / knockback; Energy is granted by the
// caller from the returned hits (task 6.5). A receiver that is immune only because of Dodge i-frames is told it
// evaded an overlapping hit (Perfect_Dodge, Req 24.9). No three.js / DOM; randomness arrives through `roll`.
// The party's projectiles (src/combat/projectiles) and delayed ground circles (src/combat/playerCombat) land
// through the same landHit().

import { dirFromYaw } from '../core/math';
import type { ElementSource } from '../core/gameEvents';
import type { Vec3 } from '../core/types';
import type { AttackDef, HitEvent } from '../data/combatTypes';
import type { AttackId, ElementId, EntityId } from '../data/ids';
import { computeDamage, staggerGain, type DamageKind } from '../logic/damage';
import { hitShapeOverlaps, type HitOrigin, type HurtVolume } from './hitShapes';

/** Slack when comparing accumulated tick time with clip times. */
const TIME_EPS = 1e-9;

/** One AttackDef being played. */
export interface AttackPlayback {
  readonly def: AttackDef;
  /** Seconds since the clip started. */
  t: number;
  /** Per HitEvent (index-aligned with def.hits): already judged. */
  readonly judged: boolean[];
  /** Per HitEvent: ids it has hit, so a target is hit at most once per HitEvent. */
  readonly hitIds: Set<EntityId>[];
}

export function startAttack(def: AttackDef): AttackPlayback {
  return { def, t: 0, judged: def.hits.map(() => false), hitIds: def.hits.map(() => new Set<EntityId>()) };
}

/** Clip time at which `hit` is judged: `t`, plus `delay` for a ground circle. */
export function judgeTime(hit: HitEvent): number {
  return hit.t + (hit.shape.kind === 'groundCircle' ? hit.shape.delay : 0);
}

/**
 * Advances the clip by `dt` (the tick that starts an attack counts too) and returns the indices of the
 * HitEvents due now, marking them judged; each index is returned by exactly one call. `dueTime` picks when a
 * HitEvent is due (default judgeTime); the party passes `hit.t` and places ground circles as delayed effects
 * that outlive the clip.
 */
export function advanceAttack(p: AttackPlayback, dt: number, dueTime: (hit: HitEvent) => number = judgeTime): number[] {
  if (Number.isFinite(dt) && dt > 0) p.t += dt;
  const due: number[] = [];
  p.def.hits.forEach((hit, i) => {
    if (!p.judged[i] && p.t >= dueTime(hit) - TIME_EPS) {
      p.judged[i] = true;
      due.push(i);
    }
  });
  return due;
}

/**
 * The clip has played to `duration`. With the default judgeTime a HitEvent still unjudged then (a ground circle
 * whose delay runs past the clip) is dropped; the party's combat places those as delayed effects instead.
 */
export function attackFinished(p: AttackPlayback): boolean {
  return p.t >= p.def.duration - TIME_EPS;
}

/** Inside the current hit's comboWindow, where an `attack` press chains the next Normal hit (Req 24.1). */
export function inComboWindow(p: AttackPlayback): boolean {
  const w = p.def.comboWindow;
  return w !== undefined && p.t >= w[0] - TIME_EPS && p.t <= w[1] + TIME_EPS;
}

/** Before `recoveryFrom`: movement input does not end the attack yet. */
export function beforeRecovery(p: AttackPlayback): boolean {
  return p.t < p.def.recoveryFrom - TIME_EPS;
}

/** From `dodgeCancelFrom` a Dodge may cancel the attack (Req 24.11). */
export function dodgeCancelOpen(p: AttackPlayback): boolean {
  return p.t >= p.def.dodgeCancelFrom - TIME_EPS;
}

// ── Hit processing ──────────────────────────────────────────────────────────

/** Target state sampled at impact (design DamageInput.target plus DEF and the Terra mark). */
export interface TargetSample {
  /** DEF including equipment. */
  def: number;
  /** Mossback Brute's intact guard covers the hit: its attacker stands in the guard's frontal 120° (Req 28.11). */
  frontGuard: boolean;
  /** Element of an active Element_Shield, else null. */
  shieldElement: ElementId | null;
  /** Caelith after its Starshell breaks. */
  vulnerable: boolean;
  /** Terra-marked: stagger gain ×1.5. */
  terraMarked: boolean;
}

/** A hit after computeDamage, handed to the receiver to apply. */
export interface ResolvedHit {
  attackerId: EntityId;
  attackId: AttackId;
  hitIndex: number;
  kind: DamageKind;
  amount: number;
  crit: boolean;
  /** Element the hit carries (its HitEvent appliesElement), else null. */
  element: ElementId | null;
  /** Who applies `element` ('element:applied' source; absent counts as 'enemy'); null when the hit carries none. */
  elementSource?: ElementSource | null;
  /** Stagger meter gain (staggerGain). */
  stagger: number;
  /** Push distance (m). */
  knockback: number;
  /** Horizontal unit vector from the attacker toward the target. */
  direction: Vec3;
  /** The attacker's stats at impact: ATK-based Reaction damage of the character who applied `element`. */
  attackerStats?: AttackerStats;
}

/** Something a HitEvent can hit. */
export interface HitReceiver {
  readonly id: EntityId;
  /**
   * An environment device (ElementReceiver): hits land on it through the same judgement, but they grant no
   * Energy, count for no Skill hit, show no damage number and are no aim-assist target.
   */
  readonly device?: boolean;
  hurtVolume(): HurtVolume;
  /** Hits pass through while true (Dodge i-frames, dead, Downed). */
  immune(): boolean;
  /**
   * State at the moment of impact. `direction` is the hit's horizontal travel direction (attacker toward target, or
   * a projectile's flight), which decides whether a front guard covers it; without it nothing is guarded.
   */
  sample(direction?: Readonly<Vec3>): TargetSample;
  /**
   * Applies HP loss, then the hit's Element (Element_System applyElement when `hit.element` is set) and its
   * stagger / knockback.
   */
  receive(hit: ResolvedHit): void;
  /**
   * Called instead of `receive` when the receiver is immune and the hit volume overlaps it: the Active_Character
   * uses it to detect a Perfect_Dodge during Dodge i-frames (Req 24.9).
   */
  evade?(attackerId: EntityId): void;
}

/** computeDamage inputs that belong to the attacker. */
export interface AttackerStats {
  baseAtk: number;
  /** computeDamage level: party level, or L − L₀ + 1 for enemies. */
  level: number;
  equipAtkPct: number;
  abilityUpgradePct: number;
  equipDmgPct: number;
  /** 0 for enemies (Req 28.10). */
  critChance: number;
  /** Equipment Reaction damage bonus (잉걸 핵, task 12.4): computeDamage adds it for kind 'reaction' only. */
  reactionDamagePct?: number;
}

export interface Attacker {
  id: EntityId;
  origin: HitOrigin;
  stats: AttackerStats;
  kind: DamageKind;
  /** Element carried by HitEvents with appliesElement (the character's Element), or null. */
  element: ElementId | null;
  /** 'element:applied' source of that Element: the character id; default 'enemy'. */
  elementSource?: ElementSource;
  /** Crit roll in [0, 1) for one target; drawn once per hit target (combat Rng stream). */
  roll(): number;
}

export interface HitResult {
  receiver: HitReceiver;
  hit: ResolvedHit;
}

/** Horizontal unit vector from `from` toward `to`; the attacker's facing when they coincide. */
function horizontalDirection(from: Readonly<Vec3>, to: Readonly<Vec3>, yaw: number): Vec3 {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const d = Math.hypot(dx, dz);
  return d > 1e-6 ? { x: dx / d, y: 0, z: dz / d } : dirFromYaw(yaw);
}

/** computeDamage and stagger for one HitEvent against a sampled target (pure). */
export function resolveHit(
  attacker: Readonly<Omit<Attacker, 'roll' | 'origin'>>,
  attackId: AttackId,
  hitIndex: number,
  hit: HitEvent,
  target: Readonly<TargetSample>,
  roll: number,
  direction: Vec3,
): ResolvedHit {
  const element = hit.appliesElement ? attacker.element : null;
  const shield = target.shieldElement === null ? null : element === target.shieldElement ? 'same' : 'other';
  const { amount, crit } = computeDamage({
    ...attacker.stats,
    dmgMul: hit.dmgMul,
    def: target.def,
    rng01: roll,
    kind: attacker.kind,
    frontGuard: target.frontGuard,
    shield,
    vulnerable: target.vulnerable,
  });
  return {
    attackerId: attacker.id,
    attackId,
    hitIndex,
    kind: attacker.kind,
    amount,
    crit,
    element,
    elementSource: element === null ? null : (attacker.elementSource ?? 'enemy'),
    stagger: staggerGain(hit.poise, target.terraMarked),
    knockback: hit.knockback,
    direction,
    attackerStats: { ...attacker.stats },
  };
}

/**
 * Judges HitEvent `index` of `p` against `receivers`: each receiver not yet hit by this HitEvent, not immune
 * and overlapping the shape is sampled, damaged through computeDamage and handed the result, in that order.
 * Returns the hits in receiver order.
 */
export function judgeHitEvent(
  p: AttackPlayback,
  index: number,
  attacker: Attacker,
  receivers: Iterable<HitReceiver>,
): HitResult[] {
  const hit = p.def.hits[index];
  const hitIds = p.hitIds[index];
  if (hit === undefined || hitIds === undefined) return [];
  return judgeShape(p.def.id, index, hit, attacker, receivers, hitIds);
}

/**
 * Judges `hit` placed at `attacker.origin` against `receivers`, skipping and then recording the ids in `hitIds`
 * so a target is hit at most once. Immune receivers the shape overlaps are told they evaded (once per HitEvent).
 */
export function judgeShape(
  attackId: AttackId,
  index: number,
  hit: HitEvent,
  attacker: Attacker,
  receivers: Iterable<HitReceiver>,
  hitIds: Set<EntityId>,
): HitResult[] {
  const results: HitResult[] = [];
  for (const receiver of receivers) {
    if (hitIds.has(receiver.id)) continue;
    const volume = receiver.hurtVolume();
    const immune = receiver.immune();
    if (immune && receiver.evade === undefined) continue;
    if (!hitShapeOverlaps(hit.shape, attacker.origin, volume)) continue;
    hitIds.add(receiver.id);
    if (immune) {
      receiver.evade?.(attacker.id);
      continue;
    }
    const direction = horizontalDirection(attacker.origin.pos, volume.pos, attacker.origin.yaw);
    results.push(landHit(attacker, attackId, index, hit, receiver, direction));
  }
  return results;
}

/**
 * One hit on a receiver the caller found touched and not immune: sample → computeDamage (crit rolled once) →
 * `receive` (HP, Element, stagger / knockback). `direction` is the horizontal push direction.
 */
export function landHit(
  attacker: Attacker,
  attackId: AttackId,
  index: number,
  hit: HitEvent,
  receiver: HitReceiver,
  direction: Vec3,
): HitResult {
  const sample = receiver.sample(direction);
  const resolved = resolveHit(attacker, attackId, index, hit, sample, attacker.roll(), direction);
  receiver.receive(resolved);
  return { receiver, hit: resolved };
}
