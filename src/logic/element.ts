// Element_Mark / Element_Shield rules and spread chains (design "applyElement", "확산과 연쇄", Req 25.2–25.10).
// Pure: `now` is injected by the caller, inputs are never mutated and results are fresh objects.

import { copyV3, distance, type Vec3 } from '../core/math';
import type { ElementId, ReactionId } from '../data/ids';
import { MARK_DURATION, REACTION_DEFS, SAME_REACTION_COOLDOWN, reactionFor } from '../data/reactions';
import { SHIELD_REACTION_MUL, SHIELD_SAME_MUL } from './damage';

export { reactionFor, SHIELD_REACTION_MUL, SHIELD_SAME_MUL };

export interface ElementMark {
  element: ElementId;
  /** The mark is active while now < expiresAt. */
  expiresAt: number;
}

export interface ElementShield {
  element: ElementId;
  durability: number;
  max: number;
}

export interface ElementTarget {
  mark: ElementMark | null;
  /** While present, the target counts as permanently marked with `shield.element`. */
  shield: ElementShield | null;
  /** Time of the last occurrence of each reaction on this target (rate limit). */
  lastReactionAt: Partial<Record<ReactionId, number>>;
}

/**
 * - marked / refreshed: a fresh 8 s mark of the applied element.
 * - reaction: `consumed` (the old mark) is gone and the applied element is not left behind (next.mark null).
 * - shieldHit: the shield stays; `shieldMul` scales the damage the shield takes (hit ×0.25 for the shield's
 *   own element, reaction damage ×3.0 otherwise).
 * - limited: `reaction` was blocked by the 1 s rate limit; mark and shield are unchanged.
 */
export type ElementOutcome =
  | { kind: 'marked' | 'refreshed'; next: ElementTarget }
  | { kind: 'reaction'; reaction: ReactionId; consumed: ElementId; next: ElementTarget }
  | { kind: 'shieldHit'; reaction: ReactionId | null; shieldMul: number; next: ElementTarget }
  | { kind: 'limited'; reaction: ReactionId; next: ElementTarget };

export function emptyTarget(): ElementTarget {
  return { mark: null, shield: null, lastReactionAt: {} };
}

/** The mark in effect at `now`; an expired mark counts as none. */
export function activeMark(t: ElementTarget, now: number): ElementMark | null {
  return t.mark !== null && now < t.mark.expiresAt ? t.mark : null;
}

function clone(t: ElementTarget): ElementTarget {
  return {
    mark: t.mark && { ...t.mark },
    shield: t.shield && { ...t.shield },
    lastReactionAt: { ...t.lastReactionAt },
  };
}

/** Rule 5: the same reaction occurs at most once per SAME_REACTION_COOLDOWN on one target. */
function isLimited(t: ElementTarget, r: ReactionId, now: number): boolean {
  const last = t.lastReactionAt[r];
  return last !== undefined && now - last < SAME_REACTION_COOLDOWN;
}

function withReaction(t: ElementTarget, r: ReactionId, now: number): ElementTarget {
  const next = clone(t);
  next.lastReactionAt[r] = now;
  return next;
}

/**
 * Applies `el` to `t` at `now` following design rules 1–5 in order:
 * shield → no (or expired) mark → same element → other element (reaction, mark consumed) → 1 s limit.
 * `reactionFor` returns null exactly when both elements are the same.
 */
export function applyElement(t: ElementTarget, el: ElementId, now: number): ElementOutcome {
  // 1. Shield: a permanent shield-element mark that reactions never consume.
  if (t.shield !== null) {
    const reaction = reactionFor(t.shield.element, el);
    if (reaction === null) return { kind: 'shieldHit', reaction, shieldMul: SHIELD_SAME_MUL, next: clone(t) };
    if (isLimited(t, reaction, now)) return { kind: 'limited', reaction, next: clone(t) };
    return { kind: 'shieldHit', reaction, shieldMul: SHIELD_REACTION_MUL, next: withReaction(t, reaction, now) };
  }
  const mark = activeMark(t, now);
  const fresh: ElementMark = { element: el, expiresAt: now + MARK_DURATION };
  // 2. No active mark (an expired one counts as none).
  if (mark === null) return { kind: 'marked', next: { ...clone(t), mark: fresh } };
  // 3. Same element: refresh without a reaction.
  const reaction = reactionFor(mark.element, el);
  if (reaction === null) return { kind: 'refreshed', next: { ...clone(t), mark: fresh } };
  // 5. Rate limited: the existing mark stays unchanged.
  if (isLimited(t, reaction, now)) return { kind: 'limited', reaction, next: clone(t) };
  // 4. Reaction: the old mark is consumed and the applied element is not left behind either.
  const next = withReaction(t, reaction, now);
  next.mark = null;
  return { kind: 'reaction', reaction, consumed: mark.element, next };
}

/** The reaction a real application would produce (outcome 'reaction' or a reacting 'shieldHit'), else null. */
function reactionOf(out: ElementOutcome): ReactionId | null {
  return out.kind === 'reaction' || out.kind === 'shieldHit' ? out.reaction : null;
}

/**
 * The reaction applyElement(t, el, now) would trigger, or null for marked / refreshed / limited and same-element
 * shield hits. Nothing is changed (HUD reaction preview, Req 23.9).
 */
export function previewReaction(t: ElementTarget, el: ElementId, now: number): ReactionId | null {
  return reactionOf(applyElement(t, el, now));
}

/** An enemy kind's Element_Shield at full durability as it spawns, or null for a kind without one. */
export function freshShield(def: { readonly element: ElementId; readonly max: number } | undefined): ElementShield | null {
  return def === undefined || !(def.max > 0) ? null : { element: def.element, durability: def.max, max: def.max };
}

/** Slack for sim clocks summed from fixed ticks (a switch due at 10 s lands on the tick at 10 s). */
const ROTATION_EPS = 1e-6;

/**
 * The Element of a rotating Element_Shield `elapsed` s after it was raised (design: Aether Sentinel every 10 s,
 * Sentinel Prime every 8 s, ember → tide → gale → terra from Ember): along `order` from `start`, one step every
 * `every` s. Durability is not its business (it stays across switches). `start` without a rotation.
 */
export function shieldElementAt(
  start: ElementId,
  rotation: { readonly every: number; readonly order: readonly ElementId[] } | undefined,
  elapsed: number,
): ElementId {
  if (rotation === undefined || !(rotation.every > 0) || rotation.order.length === 0 || !Number.isFinite(elapsed)) return start;
  const from = Math.max(0, rotation.order.indexOf(start));
  const steps = Math.floor((Math.max(0, elapsed) + ROTATION_EPS) / rotation.every);
  return rotation.order[(from + steps) % rotation.order.length] ?? start;
}

/**
 * Deals `amount` (≥ 0, already scaled by the shield multiplier) to the shield. At durability 0 the shield is
 * removed and `broken` is true; the caller then plays the break VFX and applies the 3 s Stagger (Req 25.11).
 */
export function damageShield(t: ElementTarget, amount: number): { next: ElementTarget; broken: boolean } {
  const next = clone(t);
  if (next.shield === null) return { next, broken: false };
  next.shield.durability = Math.max(0, next.shield.durability - Math.max(0, amount));
  if (next.shield.durability > 0) return { next, broken: false };
  next.shield = null;
  return { next, broken: true };
}

// ── Spread and chains ───────────────────────────────────────────────────────

/** Depth of the deepest reaction in a chain; the direct reaction has depth 1 and a depth-4 spread goes no further. */
export const MAX_CHAIN_DEPTH = 4;
/** Spread range around the reacting target (3D distance, inclusive). */
export const SPREAD_RADIUS = 5;

export interface SpreadTarget {
  id: string;
  pos: Vec3;
  element: ElementTarget;
  alive: boolean;
}

export interface ReactionEvent {
  reaction: ReactionId;
  targetId: string;
  /** Copy of the reacting target's position. */
  position: Vec3;
  /** 1 = the direct reaction, n = n-th link of a spread chain (≤ MAX_CHAIN_DEPTH). */
  chainDepth: number;
}

/** A spread element applied to a receiver; the direct application is not listed. */
export interface SpreadApplication {
  targetId: string;
  element: ElementId;
}

export interface SpreadResult {
  targets: SpreadTarget[];
  reactions: ReactionEvent[];
  applied: SpreadApplication[];
  /** Reactions produced by this one application, the direct one included: the HUD's "연쇄 x{n}" when ≥ 2. */
  chainCount: number;
}

/** Pending spread of `element` from targets[source], whose reaction had depth `depth`. */
interface Wave {
  source: number;
  element: ElementId;
  depth: number;
}

/** Other alive targets within SPREAD_RADIUS of targets[source], nearest first (ties by id). */
function receivers(targets: readonly SpreadTarget[], source: number): number[] {
  const from = targets[source].pos;
  const near: { index: number; id: string; d: number }[] = [];
  targets.forEach((t, index) => {
    const d = distance(from, t.pos);
    if (index !== source && t.alive && d <= SPREAD_RADIUS) near.push({ index, id: t.id, d });
  });
  near.sort((a, b) => a.d - b.d || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return near.map((n) => n.index);
}

/**
 * Applies `el` to `targetId`, then resolves spread reactions breadth-first within the same frame. A spread
 * reaction (flameSpread, mistSpread, sandGust) applies its non-Gale element with applyElement to every other
 * alive target within SPREAD_RADIUS; a receiver holding a different mark or shield reacts at depth + 1 and may
 * spread again. A spread from a depth-MAX_CHAIN_DEPTH reaction propagates no further; together with the 1 s
 * rate limit this ends every chain. A dead or unknown target changes nothing.
 */
export function resolveSpread(
  targets: readonly SpreadTarget[],
  targetId: string,
  el: ElementId,
  now: number,
): SpreadResult {
  const work = targets.slice();
  const reactions: ReactionEvent[] = [];
  const applied: SpreadApplication[] = [];
  const queue: Wave[] = [];

  const apply = (index: number, element: ElementId, depth: number): void => {
    const t = work[index];
    const out = applyElement(t.element, element, now);
    work[index] = { ...t, element: out.next };
    const reaction = reactionOf(out);
    if (reaction === null) return;
    reactions.push({ reaction, targetId: t.id, position: copyV3(t.pos), chainDepth: depth });
    const spreads = REACTION_DEFS[reaction].spreads;
    if (spreads !== null && depth < MAX_CHAIN_DEPTH) queue.push({ source: index, element: spreads, depth });
  };

  const start = work.findIndex((t) => t.id === targetId);
  if (start >= 0 && work[start].alive) apply(start, el, 1);
  // FIFO over waves queued in reaction order, so depth never decreases (BFS).
  for (let q = 0; q < queue.length; q++) {
    const { source, element, depth } = queue[q];
    for (const index of receivers(work, source)) {
      applied.push({ targetId: work[index].id, element });
      apply(index, element, depth + 1);
    }
  }
  return { targets: work, reactions, applied, chainCount: reactions.length };
}
