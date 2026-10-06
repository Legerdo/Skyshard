// Party projectiles (design "전투 액션 모델"; Req 20.3, 23.6, 38.6). A projectile HitEvent spawns one here with a
// snapshot of its owner's attack values, so it keeps judging with them after a switch or a cancelled attack.
// Every tick each projectile moves along its velocity (gravity pulls it down) and sweeps a sphere of its radius
// from the previous to the new position against the terrain and colliders (sweepSphere) and against the targets'
// hurt capsules, so a fast arrow can neither pass through a wall nor skip a target between two ticks. Targets
// touched before the wall along the path are hit in path order, each at most once per projectile; `pierce` more
// targets may be passed through, and the projectile vanishes on the next hit, on the wall, or at `maxRange`.
// Records live in RuntimeState.projectiles.active; finished records return to a free list and are reused.
// No three.js / DOM.

import { dirFromYaw, normalize } from '../core/math';
import type { Vec3 } from '../core/types';
import type { HitEvent } from '../data/combatTypes';
import type { AttackId, EntityId } from '../data/ids';
import { sweepSphere } from '../physics/sphereQueries';
import type { CollisionQueries } from '../physics/types';
import type { ProjectilePool, ProjectileRuntime } from '../save/runtimeState';
import { landHit, type Attacker, type HitReceiver, type HitResult } from './attackRuntime';
import type { HurtVolume } from './hitShapes';

/** Search iterations of the swept contact (each narrows the interval to 2/3 or 1/2). */
const SEARCH_STEPS = 40;
const RANGE_EPS = 1e-6;

/** First fraction s ∈ [0, 1] of the move `from → to` at which a sphere of `radius` touches `target`, or null. */
export function sweptSphereContact(
  from: Readonly<Vec3>,
  to: Readonly<Vec3>,
  radius: number,
  target: HurtVolume,
): number | null {
  const reach = radius + target.radius;
  const y0 = target.pos.y + target.radius;
  const y1 = Math.max(y0, target.pos.y + Math.max(target.height, 2 * target.radius) - target.radius);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  // Distance from the sphere centre at fraction s to the target's core segment: convex in s.
  const gap = (s: number): number => {
    const y = from.y + dy * s;
    return Math.hypot(from.x + dx * s - target.pos.x, from.z + dz * s - target.pos.z, Math.max(0, y0 - y, y - y1));
  };
  if (gap(0) <= reach) return 0;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < SEARCH_STEPS; i++) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    if (gap(m1) <= gap(m2)) hi = m2;
    else lo = m1;
  }
  const closest = (lo + hi) / 2;
  if (!(gap(closest) <= reach)) return null;
  let a = 0;
  let b = closest;
  for (let i = 0; i < SEARCH_STEPS; i++) {
    const m = (a + b) / 2;
    if (gap(m) <= reach) b = m;
    else a = m;
  }
  return b;
}

export interface ProjectileSpawn {
  /** Owner snapshot: stats, element and crit roll are copied at spawn. */
  attacker: Attacker;
  attackId: AttackId;
  hitIndex: number;
  /** A HitEvent whose shape is a projectile. */
  hit: HitEvent;
  /** Sphere centre at launch. */
  from: Readonly<Vec3>;
  /** Launch direction (normalised here; a zero vector launches along the owner's yaw). */
  dir: Readonly<Vec3>;
  /** Called once, right after the projectile's first landed hit (party Energy, once per HitEvent). */
  onFirstHit?: () => void;
}

/** What a flying record needs beyond its public fields. */
interface Flight {
  attacker: Attacker;
  attackId: AttackId;
  hitIndex: number;
  hit: HitEvent;
  hitIds: Set<EntityId>;
  onFirstHit: (() => void) | null;
}

export interface ProjectileSystemOptions {
  /** RuntimeState.projectiles. */
  pool: ProjectilePool;
  /** Terrain and colliders the projectiles cannot pass; null flies through everything but targets. */
  world: Pick<CollisionQueries, 'sweepCapsule'> | null;
}

export class ProjectileSystem {
  private readonly pool: ProjectilePool;
  private readonly world: Pick<CollisionQueries, 'sweepCapsule'> | null;
  private readonly flights = new Map<ProjectileRuntime, Flight>();
  private readonly free: ProjectileRuntime[] = [];
  private serial = 0;

  constructor(options: ProjectileSystemOptions) {
    this.pool = options.pool;
    this.world = options.world;
  }

  /** Projectiles in flight (RuntimeState.projectiles.active). */
  get active(): readonly Readonly<ProjectileRuntime>[] {
    return this.pool.active;
  }

  /** Finished records waiting for reuse. */
  get pooled(): number {
    return this.free.length;
  }

  /** Launches a projectile from `s.from` at the HitEvent's speed; returns its record. */
  spawn(s: ProjectileSpawn): ProjectileRuntime {
    const shape = s.hit.shape;
    const speed = shape.kind === 'projectile' ? shape.speed : 0;
    let dir = normalize(s.dir);
    if (dir.x === 0 && dir.y === 0 && dir.z === 0) dir = dirFromYaw(s.attacker.origin.yaw);
    this.serial += 1;
    const rec = this.free.pop() ?? ({} as ProjectileRuntime);
    rec.id = `proj_${this.serial}`;
    rec.attack = s.attackId;
    rec.owner = s.attacker.id;
    rec.pos = { x: s.from.x, y: s.from.y, z: s.from.z };
    rec.vel = { x: dir.x * speed, y: dir.y * speed, z: dir.z * speed };
    rec.radius = shape.kind === 'projectile' ? shape.radius : 0.1;
    rec.gravity = shape.kind === 'projectile' ? shape.gravity : 0;
    rec.travelled = 0;
    rec.maxRange = shape.kind === 'projectile' ? shape.maxRange : 0;
    rec.pierce = shape.kind === 'projectile' ? shape.pierce : 0;
    const a = s.attacker;
    this.flights.set(rec, {
      attacker: {
        id: a.id,
        origin: { pos: { ...a.origin.pos }, yaw: a.origin.yaw },
        stats: { ...a.stats },
        kind: a.kind,
        element: a.element,
        elementSource: a.elementSource,
        roll: a.roll,
      },
      attackId: s.attackId,
      hitIndex: s.hitIndex,
      hit: s.hit,
      hitIds: new Set(),
      onFirstHit: s.onFirstHit ?? null,
    });
    this.pool.active.push(rec);
    return rec;
  }

  /** Moves and sweeps every projectile by `dt`; returns the hits in flight order. */
  tick(dt: number, receivers: Iterable<HitReceiver>): HitResult[] {
    if (!(Number.isFinite(dt) && dt > 0) || this.pool.active.length === 0) return [];
    const targets = [...receivers];
    const results: HitResult[] = [];
    const done: ProjectileRuntime[] = [];
    for (const rec of this.pool.active) {
      const flight = this.flights.get(rec);
      if (flight === undefined || this.fly(rec, flight, dt, targets, results)) done.push(rec);
    }
    for (const rec of done) this.release(rec);
    return results;
  }

  /** Removes every projectile (Party_Wipe restart, session end). */
  clear(): void {
    for (const rec of [...this.pool.active]) this.release(rec);
  }

  /** One tick of flight; true when the projectile is finished. */
  private fly(rec: ProjectileRuntime, flight: Flight, dt: number, targets: HitReceiver[], out: HitResult[]): boolean {
    rec.vel.y -= rec.gravity * dt;
    let sx = rec.vel.x * dt;
    let sy = rec.vel.y * dt;
    let sz = rec.vel.z * dt;
    let len = Math.hypot(sx, sy, sz);
    const left = rec.maxRange - rec.travelled;
    const last = len >= left - RANGE_EPS;
    if (last && len > 0) {
      const k = Math.max(0, left) / len;
      sx *= k;
      sy *= k;
      sz *= k;
      len = Math.max(0, left);
    }
    const from = { ...rec.pos };
    const to = { x: from.x + sx, y: from.y + sy, z: from.z + sz };
    const wall = this.world === null || len === 0 ? null : sweepSphere(this.world, from, to, rec.radius);
    const wallT = wall?.t ?? Infinity;

    const contacts: { receiver: HitReceiver; t: number }[] = [];
    for (const receiver of targets) {
      if (flight.hitIds.has(receiver.id) || receiver.immune()) continue;
      const t = sweptSphereContact(from, to, rec.radius, receiver.hurtVolume());
      if (t !== null && t <= wallT) contacts.push({ receiver, t });
    }
    contacts.sort((a, b) => a.t - b.t);
    const h = Math.hypot(rec.vel.x, rec.vel.z);
    const push = h > 1e-6 ? { x: rec.vel.x / h, y: 0, z: rec.vel.z / h } : dirFromYaw(flight.attacker.origin.yaw);
    for (const { receiver, t } of contacts) {
      flight.hitIds.add(receiver.id);
      out.push(landHit(flight.attacker, flight.attackId, flight.hitIndex, flight.hit, receiver, push));
      if (receiver.device !== true) {
        // Environment devices take the hit but grant nothing (party Energy is for enemy hits).
        const first = flight.onFirstHit;
        flight.onFirstHit = null;
        first?.();
      }
      if (rec.pierce <= 0) {
        this.moveTo(rec, from, sx, sy, sz, t, len);
        return true;
      }
      rec.pierce -= 1;
    }
    if (wall !== null) {
      this.moveTo(rec, from, sx, sy, sz, wall.t, len);
      return true;
    }
    this.moveTo(rec, from, sx, sy, sz, 1, len);
    return last;
  }

  private moveTo(rec: ProjectileRuntime, from: Vec3, sx: number, sy: number, sz: number, t: number, len: number): void {
    rec.pos = { x: from.x + sx * t, y: from.y + sy * t, z: from.z + sz * t };
    rec.travelled += len * t;
  }

  private release(rec: ProjectileRuntime): void {
    const i = this.pool.active.indexOf(rec);
    if (i >= 0) this.pool.active.splice(i, 1);
    if (this.flights.delete(rec)) this.free.push(rec);
  }
}
