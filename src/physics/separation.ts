// Player ↔ agent overlap separation for CollisionResolve (design "CollisionResolve", Req 20.2).
// Pure TypeScript: imports only src/core and src/physics; no three.js / DOM / Math.random.
//
// Ground movement does not stop the player at enemies or NPCs. Once per tick, after every
// displacement, CollisionResolve calls resolvePlayerOverlaps: each agent whose capsule overlaps
// the player's is pushed horizontally out of it by at most SEPARATION_SPEED·dt, so even the
// deepest supported overlap clears within SEPARATION_TIME. Pushes are swept against the world,
// so an agent never passes through a wall: a blocked agent slides along the hit surface with the
// rest of its push, and one that cannot move stays put and is reported in `blocked` (a later
// recovery system handles stuck agents). The player is never moved.
//
// Bodies are vertical capsules with `pos` at the feet (types.ts conventions); a height below
// 2·radius counts as 2·radius.

import { add, addScaled, copyV3, dirFromYaw, dot, isFiniteNum, isFiniteV3, scale, type Vec3 } from '../core/math';
import type { CollisionQueries, QueryFilter } from './types';

/** Longest a player–agent overlap may last (s, Req 20.2). */
export const SEPARATION_TIME = 0.2;

/**
 * Largest agent radius (m) the SEPARATION_TIME guarantee covers, against the 0.4 m player: the largest enemy body
 * (Rootbound Warden, 1.6 m).
 */
export const MAX_SEPARATION_AGENT_RADIUS = 1.6;

/**
 * Push speed (m/s). The deepest overlap, coincident centres of the 0.4 m player and a 1.6 m agent,
 * needs (0.4 + 1.6) m / 0.2 s = 10 m/s. 11 m/s clears it in 11 ticks at 60 Hz with a margin for
 * SEPARATION_SKIN and rounding.
 */
export const SEPARATION_SPEED = 11;

/** Clearance (m) a push aims for past contact, and the gap it keeps to a blocking surface. */
export const SEPARATION_SKIN = 1e-3;

/** Below this horizontal centre distance (m) the push direction comes from the agent id. */
const COINCIDENT_EPSILON = 1e-6;
/** Moves shorter than this (m) are not swept. */
const MIN_MOVE = 1e-6;
/** An overlapping agent that moved less than this fraction of its push counts as blocked. */
const BLOCKED_FRACTION = 0.01;

/** A vertical capsule: `pos` is the feet, `height` the total height (m). */
export interface SeparationBody {
  id: number;
  pos: Vec3;
  radius: number;
  height: number;
}

export interface SeparationOptions {
  /**
   * Filter for the push sweeps. When agents (or the player) are registered as dynamic colliders,
   * exclude their ids here, or each push starts inside the agent's own collider.
   */
  filter?: QueryFilter;
}

export interface SeparationResult {
  /** New feet position of every agent, index-aligned with `agents`. Fresh objects; untouched agents are copies. */
  positions: Vec3[];
  /** Ids of overlapping agents that could not move this tick (e.g. pinned between the player and a wall). */
  blocked: number[];
}

/**
 * Pushes every agent that overlaps `player` (vertical spans overlap and the horizontal centre
 * distance d < player.radius + agent.radius) horizontally away from the player by
 * min(penetration + SEPARATION_SKIN, SEPARATION_SPEED·dt), swept against `world`.
 * Agents with a non-finite position or an invalid shape, and every agent when the player or `dt`
 * is invalid, are returned unchanged. Never mutates its inputs.
 */
export function resolvePlayerOverlaps(
  world: Pick<CollisionQueries, 'sweepCapsule'>,
  player: Readonly<SeparationBody>,
  agents: readonly Readonly<SeparationBody>[],
  dt: number,
  opts: Readonly<SeparationOptions> = {},
): SeparationResult {
  const positions: Vec3[] = [];
  const blocked: number[] = [];
  const maxStep = isFiniteNum(dt) && dt > 0 && isValidBody(player) ? SEPARATION_SPEED * dt : 0;
  for (const agent of agents) {
    const push = maxStep > 0 ? pushOut(player, agent, maxStep) : null;
    if (push === null) {
      positions.push(copyV3(agent.pos));
      continue;
    }
    const res = sweepAndSlide(world, agent, push, opts.filter);
    positions.push(res.pos);
    if (res.moved < BLOCKED_FRACTION * Math.sqrt(dot(push, push))) blocked.push(agent.id);
  }
  return { positions, blocked };
}

/** Finite position, radius > 0 and height ≥ 0. */
function isValidBody(b: Readonly<SeparationBody>): boolean {
  return isFiniteV3(b.pos) && isFiniteNum(b.radius) && b.radius > 0 && isFiniteNum(b.height) && b.height >= 0;
}

/** Top of a body's capsule (a height below 2·radius counts as 2·radius). */
function topY(b: Readonly<SeparationBody>): number {
  return b.pos.y + Math.max(b.height, 2 * b.radius);
}

/** This tick's horizontal push out of the player's capsule, or null when the agent does not overlap it. */
function pushOut(player: Readonly<SeparationBody>, agent: Readonly<SeparationBody>, maxStep: number): Vec3 | null {
  if (!isValidBody(agent)) return null;
  if (!(agent.pos.y < topY(player) && player.pos.y < topY(agent))) return null;
  const dx = agent.pos.x - player.pos.x;
  const dz = agent.pos.z - player.pos.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  const reach = player.radius + agent.radius;
  if (!(d < reach)) return null;
  const step = Math.min(reach - d + SEPARATION_SKIN, maxStep);
  if (d > COINCIDENT_EPSILON) return { x: (dx / d) * step, y: 0, z: (dz / d) * step };
  const dir = coincidentDir(agent.id);
  return { x: dir.x * step, y: 0, z: dir.z * step };
}

/** Deterministic horizontal direction for an agent centred on the player: a hash of its id → yaw. */
function coincidentDir(id: number): Vec3 {
  // Knuth multiplicative hash, so consecutive ids spread around the circle.
  const h = Math.imul(id | 0, 0x9e3779b1) >>> 0;
  return dirFromYaw((h / 4294967296) * 2 * Math.PI);
}

/**
 * Sweeps `push` from the agent's feet. On a hit the agent stops SEPARATION_SKIN short of the
 * contact, then sweeps once more with the part of the remaining push tangent to the hit surface.
 * `moved` is the total distance travelled.
 */
function sweepAndSlide(
  world: Pick<CollisionQueries, 'sweepCapsule'>,
  agent: Readonly<SeparationBody>,
  push: Vec3,
  filter: QueryFilter | undefined,
): { pos: Vec3; moved: number } {
  let pos = copyV3(agent.pos);
  let move = push;
  let moved = 0;
  for (let pass = 0; pass < 2; pass++) {
    const len = Math.sqrt(dot(move, move));
    if (!(len > MIN_MOVE)) break;
    const target = add(pos, move);
    const hit = world.sweepCapsule(pos, target, agent.radius, agent.height, filter);
    if (hit === null) return { pos: target, moved: moved + len };
    const advance = Math.min(len, Math.max(0, hit.distance - SEPARATION_SKIN));
    if (advance > 0) pos = addScaled(pos, move, advance / len);
    moved += advance;
    // Slide: drop the part of the remaining push that points into the surface.
    const rest = scale(move, 1 - advance / len);
    const into = dot(rest, hit.normal);
    move = into < 0 ? addScaled(rest, hit.normal, -into) : rest;
  }
  return { pos, moved };
}
