// Feature: skyshard-echoes-of-the-wild, Property 28: 등반 표면 거리 유지
// **Validates: Requirements 18.10, 18.3**
//
// The pure controller core (stepController over a real CollisionWorld) at the fixed 60 Hz tick: for any
// convex climbable collider (an axis-aligned box or a vertical cylinder, standing on the ground or raised
// above it so its bottom edges and underside can be climbed too) and any climb input sequence (up, down,
// sideways around the corners, diagonals, holds, leaps), every tick that ends on the wall (climbAttach,
// climb, climbLeap) keeps the capsule centre 0.3–0.5 m outside the collider's surface. Convex edges
// included, the centre never enters the collider and never gets more than 0.9 m off it. Leaving the wall
// (mantle, grounded, fall) ends the check. Distances are measured analytically here, not with the
// collision queries the controller uses.
import fc, { type Arbitrary } from 'fast-check';
import { describe, expect, it } from 'vitest';
import { SIM_DT } from '../../src/core/loop';
import { DEG2RAD, yawFromDir, type Vec3 } from '../../src/core/math';
import { CHARACTER_IDS, type CharacterId } from '../../src/data/ids';
import { BUFFER_SECONDS } from '../../src/input/actions';
import type { StaminaState } from '../../src/logic/stamina';
import { createCollisionWorld } from '../../src/physics/collisionWorld';
import { flatHeightfield } from '../../src/physics/heightfield';
import type { Collider, ColliderFlags, SurfaceMaterial } from '../../src/physics/types';
import { CAPSULE_HEIGHT, CAPSULE_RADIUS } from '../../src/player/core/constants';
import { stepController } from '../../src/player/core/stepController';
import { createControllerState, type ControllerInput, type ControllerState, type MoveMode } from '../../src/player/core/types';

/** Req 18.10's band for the capsule centre off the climbed surface, and the surface search radius (m). */
const MIN_GAP = 0.3;
const MAX_GAP = 0.5;
const SEARCH_RADIUS = 0.9;
/** The vertical capsule's centre above its feet. */
const CENTRE_HEIGHT = CAPSULE_HEIGHT / 2;
/** Modes on the wall: the property holds after every tick that ends in one of them. */
const ON_WALL: ReadonlySet<MoveMode> = new Set<MoveMode>(['climbAttach', 'climb', 'climbLeap']);

const GROUND_Y = 0;
/** A standing collider reaches this far below the ground. */
const BURY = 1;

interface XZ {
  x: number;
  z: number;
}

/** Uniform on a `step` grid over [min, max] (fc.double clusters near 0 and the bounds). */
const arbGrid = (min: number, max: number, step: number): Arbitrary<number> =>
  fc.integer({ min: Math.round(min / step), max: Math.round(max / step) }).map((k) => k * step);
/** An angle in radians on a 0.5° grid. */
const arbAngle = arbGrid(0, 359.5, 0.5).map((deg) => deg * DEG2RAD);
/** True with probability `pct` %; shrinks toward false. */
const arbChance = (pct: number): Arbitrary<boolean> =>
  fc.oneof({ weight: 100 - pct, arbitrary: fc.constant(false) }, { weight: pct, arbitrary: fc.constant(true) });

// ---------------------------------------------------------------------------
// arbConvexCollider: a climbable box or vertical cylinder
// ---------------------------------------------------------------------------

interface ConvexSpec {
  shape: 'box' | 'cylinder';
  /** Box half sizes along X and Z; a cylinder's radius is halfX. */
  halfX: number;
  halfZ: number;
  /** Standing on the ground (bottom BURY under it) or raised: the bottom `lift` m above the ground. */
  raised: boolean;
  lift: number;
  /** Top above the ground (standing) or above the bottom (raised), m. */
  height: number;
  walkableTop: boolean;
  material: SurfaceMaterial;
}

const arbConvexCollider: Arbitrary<ConvexSpec> = fc.record({
  shape: fc.constantFrom<'box' | 'cylinder'>('box', 'cylinder'),
  halfX: arbGrid(0.25, 4, 0.01),
  halfZ: arbGrid(0.25, 4, 0.01),
  raised: arbChance(30),
  // The feet stay above the ground while the chest hangs 0.45 m under the underside.
  lift: arbGrid(2.5, 6, 0.01),
  height: arbGrid(1.5, 12, 0.01),
  walkableTop: fc.boolean(),
  material: fc.constantFrom<SurfaceMaterial>('stone', 'wood', 'rock', 'dirt', 'crystal'),
});

/** A spot on the collider's side surface: the point and its outward (horizontal) normal. */
interface Spot {
  point: Vec3;
  normal: Vec3;
}

interface Convex {
  collider: Collider;
  bottom: number;
  top: number;
  /** Signed distance from `p` to the collider's surface (negative inside). */
  distance(p: Readonly<Vec3>): number;
  /** Side-surface spot at height y: a box face `side` (0–3) at `lateral` ∈ [−1, 1] of its half width, a cylinder bearing `angle`. */
  spot(side: number, lateral: number, angle: number, y: number): Spot;
}

function boxDistance(p: Readonly<Vec3>, min: Readonly<Vec3>, max: Readonly<Vec3>): number {
  const dx = Math.max(min.x - p.x, p.x - max.x);
  const dy = Math.max(min.y - p.y, p.y - max.y);
  const dz = Math.max(min.z - p.z, p.z - max.z);
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0), Math.max(dz, 0)) + Math.min(Math.max(dx, dy, dz), 0);
}

function cylinderDistance(p: Readonly<Vec3>, base: Readonly<Vec3>, radius: number, height: number): number {
  const dr = Math.hypot(p.x - base.x, p.z - base.z) - radius;
  const dy = Math.max(base.y - p.y, p.y - (base.y + height));
  return Math.hypot(Math.max(dr, 0), Math.max(dy, 0)) + Math.min(Math.max(dr, dy), 0);
}

/** Box face normals by side index. */
const SIDES: readonly XZ[] = [
  { x: 1, z: 0 },
  { x: -1, z: 0 },
  { x: 0, z: 1 },
  { x: 0, z: -1 },
];

function buildConvex(spec: ConvexSpec): Convex {
  const bottom = spec.raised ? GROUND_Y + spec.lift : GROUND_Y - BURY;
  const top = spec.raised ? bottom + spec.height : GROUND_Y + spec.height;
  const flags: ColliderFlags = { climbable: true, walkableTop: spec.walkableTop, blocksCamera: true, material: spec.material };
  if (spec.shape === 'box') {
    const min = { x: -spec.halfX, y: bottom, z: -spec.halfZ };
    const max = { x: spec.halfX, y: top, z: spec.halfZ };
    return {
      collider: { kind: 'aabb', min, max, id: 1, flags },
      bottom,
      top,
      distance: (p) => boxDistance(p, min, max),
      spot(side, lateral, _angle, y) {
        const n = SIDES[side];
        const point =
          n.x !== 0 ? { x: n.x * spec.halfX, y, z: lateral * spec.halfZ } : { x: lateral * spec.halfX, y, z: n.z * spec.halfZ };
        return { point, normal: { x: n.x, y: 0, z: n.z } };
      },
    };
  }
  const radius = spec.halfX;
  const base = { x: 0, y: bottom, z: 0 };
  return {
    collider: { kind: 'cylinder', base, radius, height: top - bottom, id: 1, flags },
    bottom,
    top,
    distance: (p) => cylinderDistance(p, base, radius, top - bottom),
    spot(_side, _lateral, angle, y) {
      const n = { x: Math.sin(angle), y: 0, z: Math.cos(angle) };
      return { point: { x: radius * n.x, y, z: radius * n.z }, normal: n };
    },
  };
}

// ---------------------------------------------------------------------------
// The start: on the wall, or on the ground in front of it
// ---------------------------------------------------------------------------

interface ClimbStart {
  /** climb / climbAttach: seated 0.45 m off a side-surface spot; ground: walks into that spot and attaches. */
  how: 'climb' | 'climbAttach' | 'ground';
  side: number;
  lateral: number;
  angle: number;
  /** Chest height within the side surface's usable band, 0 (low) to 1 (top). */
  level: number;
  /** ground: gap between the capsule and the surface (m). */
  gap: number;
  /** ground: facing off the direction toward the wall. */
  yawOff: number;
  stamina: number;
  character: CharacterId;
}

const arbClimbStart: Arbitrary<ClimbStart> = fc.record({
  how: fc.oneof(
    { weight: 3, arbitrary: fc.constant<'climb'>('climb') },
    { weight: 1, arbitrary: fc.constant<'climbAttach'>('climbAttach') },
    { weight: 1, arbitrary: fc.constant<'ground'>('ground') },
  ),
  side: fc.integer({ min: 0, max: 3 }),
  lateral: arbGrid(-1, 1, 0.005),
  angle: arbAngle,
  level: arbGrid(0, 1, 0.005),
  gap: arbGrid(0.02, 1, 0.01),
  yawOff: arbGrid(-90, 90, 0.5).map((deg) => deg * DEG2RAD),
  stamina: fc.integer({ min: 50, max: 100 }),
  character: fc.constantFrom<CharacterId>(...CHARACTER_IDS),
});

/** Chest heights a start may sit at: the feet above the ground, the chest on the side surface. */
function chestBand(c: Convex): [number, number] {
  const low = Math.max(c.bottom, GROUND_Y + CENTRE_HEIGHT) + 0.05;
  return [low, c.top - 0.05];
}

/** A start on the wall seats the capsule centre this far out along the surface normal (design "표면 추종"). */
const SEAT = 0.45;
/** Ticks the ground start pushes into the wall before the generated input takes over. */
const PUSH_TICKS = 45;

function startState(c: Convex, raised: boolean, st: ClimbStart): { state: ControllerState; push: XZ | null } {
  const [low, high] = chestBand(c);
  const how = st.how === 'ground' && raised ? 'climb' : st.how; // a raised collider cannot be reached on foot
  if (how === 'ground') {
    // Well inside the face, so the walk meets it head-on.
    const s = c.spot(st.side, st.lateral * 0.8, st.angle, GROUND_Y);
    const n = s.normal;
    const feet = { x: s.point.x + n.x * (CAPSULE_RADIUS + st.gap), y: GROUND_Y, z: s.point.z + n.z * (CAPSULE_RADIUS + st.gap) };
    return { state: createControllerState(feet, yawFromDir(-n.x, -n.z) + st.yawOff), push: { x: -n.x, z: -n.z } };
  }
  const y = low + (high - low) * st.level;
  const s = c.spot(st.side, st.lateral, st.angle, y);
  const n = s.normal;
  const feet = { x: s.point.x + n.x * SEAT, y: y - CENTRE_HEIGHT, z: s.point.z + n.z * SEAT };
  const state: ControllerState = {
    ...createControllerState(feet, yawFromDir(-n.x, -n.z)),
    mode: how,
    grounded: false,
    climbNormal: { ...n },
    fallStartY: feet.y,
  };
  return { state, push: null };
}

// ---------------------------------------------------------------------------
// arbClimbInput: held climb input with buffered jump (leap) presses
// ---------------------------------------------------------------------------

/**
 * A move direction. facing: relative to the character's current facing (camera behind it), `angle` 0 toward
 * the wall (up), 90° right, 180° away (down), 270° left. world: a fixed world direction (yaw convention).
 */
interface MoveSpec {
  frame: 'facing' | 'world';
  angle: number;
  tilt: number;
}

/** One input held for `ticks` ticks; jump and release are pressed on its first tick. */
interface ClimbSegment {
  ticks: number;
  /** null: no move input (hold on the wall). */
  move: MoveSpec | null;
  jump: boolean;
  release: boolean;
}

const arbTilt = fc.oneof({ weight: 4, arbitrary: fc.constant(1) }, { weight: 1, arbitrary: arbGrid(0.05, 1, 0.01) });

const arbFacingAngle = fc
  .oneof(
    { weight: 4, arbitrary: fc.constantFrom(90, 270) }, // sideways: around the corners
    { weight: 2, arbitrary: fc.constantFrom(0, 180) }, // straight up or down
    { weight: 3, arbitrary: arbGrid(0, 359.5, 0.5) }, // any diagonal
  )
  .map((deg) => deg * DEG2RAD);

const arbMove: Arbitrary<MoveSpec | null> = fc.oneof(
  { weight: 1, arbitrary: fc.constant(null) },
  { weight: 4, arbitrary: fc.record({ frame: fc.constant<'facing'>('facing'), angle: arbFacingAngle, tilt: arbTilt }) },
  { weight: 2, arbitrary: fc.record({ frame: fc.constant<'world'>('world'), angle: arbAngle, tilt: arbTilt }) },
);

const arbClimbSegment: Arbitrary<ClimbSegment> = fc.record({
  ticks: fc.integer({ min: 1, max: 40 }),
  move: arbMove,
  jump: arbChance(15),
  release: arbChance(2),
});

/** arbClimbInput: 1–10 segments (at most 400 ticks, 6.7 s). */
const arbClimbInput = fc.array(arbClimbSegment, { minLength: 1, maxLength: 10 });

/** A jump press stays usable for BUFFER_SECONDS: its own tick and the next 9 at 60 Hz. */
const BUFFER_TICKS = Math.floor(BUFFER_SECONDS / SIM_DT + 1e-9) + 1;

function moveOf(m: MoveSpec | null, s: Readonly<ControllerState>): XZ {
  if (m === null) return { x: 0, z: 0 };
  // Yaw convention: yaw a faces (sin a, cos a), and the facing's right is (−cos yaw, sin yaw).
  if (m.frame === 'world') return { x: m.tilt * Math.sin(m.angle), z: m.tilt * Math.cos(m.angle) };
  const f = { x: Math.sin(s.yaw), z: Math.cos(s.yaw) };
  const r = { x: -Math.cos(s.yaw), z: Math.sin(s.yaw) };
  const c = Math.cos(m.angle);
  const sn = Math.sin(m.angle);
  return { x: m.tilt * (f.x * c + r.x * sn), z: m.tilt * (f.z * c + r.z * sn) };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

interface ClimbRun {
  violation: string | null;
  /** Ticks that ended on the wall (checked). */
  wallTicks: number;
  /** Path length of the feet over the checked ticks (m). */
  travel: number;
  /** Largest angle between the climb normal and the one of the first wall tick (deg). */
  maxTurnDeg: number;
  /** The climb normal pointed downward (an underside or bottom edge) at some checked tick. */
  underside: boolean;
  leapt: boolean;
  attachedFromGround: boolean;
  /** The mode that ended the climb, or null when the input ran out on the wall (or it never attached). */
  exit: MoveMode | null;
}

const fmt = (p: Readonly<Vec3>): string => `${p.x.toFixed(4)}, ${p.y.toFixed(4)}, ${p.z.toFixed(4)}`;

function checkGap(c: Convex, s: Readonly<ControllerState>, when: string): string | null {
  const centre = { x: s.pos.x, y: s.pos.y + CENTRE_HEIGHT, z: s.pos.z };
  const d = c.distance(centre);
  if (d >= MIN_GAP && d <= MAX_GAP) return null;
  const why = d < 0 ? 'inside the collider' : d > SEARCH_RADIUS ? `more than ${SEARCH_RADIUS} m off it` : `outside ${MIN_GAP}–${MAX_GAP} m`;
  const n = s.climbNormal === null ? 'null' : fmt(s.climbNormal);
  return `${when} (${s.mode}): capsule centre (${fmt(centre)}) is ${d.toFixed(4)} m from the surface, ${why}; climbNormal (${n})`;
}

function runClimb(spec: ConvexSpec, st: ClimbStart, segments: readonly ClimbSegment[]): ClimbRun {
  const c = buildConvex(spec);
  const world = createCollisionWorld(flatHeightfield(GROUND_Y));
  world.addStatic(c.collider);
  const { state: start, push } = startState(c, spec.raised, st);
  const pushIn: ClimbSegment | null =
    push === null ? null : { ticks: PUSH_TICKS, move: { frame: 'world', angle: yawFromDir(push.x, push.z), tilt: 1 }, jump: false, release: false };
  const inputs: readonly ClimbSegment[] = pushIn === null ? segments : [pushIn, ...segments];

  let state = start;
  let stamina: StaminaState = { value: st.stamina, max: 100, exhausted: false, idleTimer: 0 };
  let onWall = ON_WALL.has(state.mode);
  const run: ClimbRun = {
    violation: onWall ? checkGap(c, state, 'start') : null,
    wallTicks: 0,
    travel: 0,
    maxTurnDeg: 0,
    underside: false,
    leapt: false,
    attachedFromGround: false,
    exit: null,
  };
  let firstNormal: Vec3 | null = null;
  let jumpLeft = 0;
  let tick = 0;
  for (const seg of inputs) {
    for (let k = 0; k < seg.ticks; k++, tick++) {
      if (run.violation !== null) return run;
      if (k === 0 && seg.jump) jumpLeft = BUFFER_TICKS;
      const input: ControllerInput = {
        move: moveOf(seg.move, state),
        sprint: false,
        walk: false,
        jump: jumpLeft > 0,
        dodge: false,
        release: k === 0 && seg.release,
      };
      const r = stepController(state, input, world, stamina, st.character, SIM_DT);
      jumpLeft = r.consumed.jump ? 0 : Math.max(0, jumpLeft - 1);
      const from = state.pos;
      state = r.state;
      stamina = r.stamina;
      if (!ON_WALL.has(state.mode)) {
        if (onWall) {
          run.exit = state.mode;
          return run; // off the wall (mantle, grounded, fall): the check ends
        }
        continue; // the ground start has not attached yet
      }
      if (onWall) run.travel += Math.hypot(state.pos.x - from.x, state.pos.y - from.y, state.pos.z - from.z);
      else run.attachedFromGround = true;
      onWall = true;
      run.wallTicks++;
      if (state.mode === 'climbLeap') run.leapt = true;
      const n = state.climbNormal;
      if (n !== null) {
        firstNormal ??= { ...n };
        const cos = Math.min(1, Math.max(-1, n.x * firstNormal.x + n.y * firstNormal.y + n.z * firstNormal.z));
        run.maxTurnDeg = Math.max(run.maxTurnDeg, Math.acos(cos) / DEG2RAD);
        if (n.y < -0.5) run.underside = true;
      }
      run.violation = checkGap(c, state, `tick ${tick}`);
    }
  }
  return run;
}

// ---------------------------------------------------------------------------
// Property
// ---------------------------------------------------------------------------

describe('Property 28: 등반 표면 거리 유지', () => {
  it(
    'keeps the capsule centre 0.3–0.5 m off a climbed box or cylinder, around its convex edges, on every tick on the wall',
    () => {
      const stats = { onWall: 0, travelled: 0, boxCorner: 0, cylinderTurn: 0, underside: 0, leapt: 0, fromGround: 0 };
      const exits = new Map<MoveMode, number>();
      fc.assert(
        fc.property(arbConvexCollider, arbClimbStart, arbClimbInput, (spec, start, inputs) => {
          const run = runClimb(spec, start, inputs);
          expect(run.violation).toBeNull();
          if (run.wallTicks > 0) stats.onWall++;
          if (run.travel > 1) stats.travelled++;
          if (spec.shape === 'box' && run.maxTurnDeg >= 60) stats.boxCorner++;
          if (spec.shape === 'cylinder' && run.maxTurnDeg >= 60) stats.cylinderTurn++;
          if (run.underside) stats.underside++;
          if (run.leapt) stats.leapt++;
          if (run.attachedFromGround) stats.fromGround++;
          if (run.exit !== null) exits.set(run.exit, (exits.get(run.exit) ?? 0) + 1);
        }),
        { numRuns: 200, seed: 2801 },
      );
      // Guard against a vacuous pass: runs must stay on the wall and travel along it, turn around box
      // corners and cylinders, wrap onto undersides, leap, attach from the ground and leave the wall
      // by every exit. (Starts on a walkable top's lip mantle and starts just above the ground land on
      // their first tick, so not every run is on the wall.)
      expect(stats.onWall).toBeGreaterThan(150);
      expect(stats.travelled).toBeGreaterThan(120);
      expect(stats.boxCorner).toBeGreaterThan(20);
      expect(stats.cylinderTurn).toBeGreaterThan(8);
      expect(stats.underside).toBeGreaterThan(4);
      expect(stats.leapt).toBeGreaterThan(40);
      expect(stats.fromGround).toBeGreaterThan(15);
      for (const exit of ['mantle', 'grounded', 'fall'] as const) expect(exits.get(exit) ?? 0, exit).toBeGreaterThan(10);
    },
    30_000,
  );
});
