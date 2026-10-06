import { describe, expect, it } from 'vitest';
import { createCameraCollision } from '../../../src/camera/cameraCollision';
import { CameraCore, cameraRight, type CameraFrame, type CameraRig } from '../../../src/camera/cameraCore';
import {
  CAMERA_RADIUS,
  DEFAULT_DISTANCE,
  DEFAULT_PITCH,
  FADE_END_DISTANCE,
  FADED_OPACITY,
  GROUND_CLEARANCE,
  MAX_PITCH,
  MIN_DISTANCE,
  MIN_PITCH,
  SHAKE_MAX_ANGLE,
  SHAKE_OFFSET_LIMIT,
  SHOULDER_HEIGHT,
  SHOULDER_RIGHT,
  TRAUMA_DECAY_PER_SEC,
} from '../../../src/camera/constants';
import { DEG2RAD, addScaled, distance } from '../../../src/core/math';
import type { Vec3 } from '../../../src/core/types';
import { DEFAULT_BINDINGS } from '../../../src/input/bindings';
import { InputState, type RawInput } from '../../../src/input/inputState';
import { createCollisionWorld } from '../../../src/physics/collisionWorld';
import { analyticHeightfield, flatHeightfield } from '../../../src/physics/heightfield';
import { overlapSphere } from '../../../src/physics/sphereQueries';
import type { Collider, CollisionWorld } from '../../../src/physics/types';

const DT = 1 / 60;
const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const ORIGIN = v(0, 0, 0);

/** A 60 fps frame with the character at the origin facing +Z (camera behind it at −Z) unless overridden. */
const frame = (o: Partial<CameraFrame> = {}): CameraFrame => ({ realDt: DT, characterPos: ORIGIN, characterYaw: 0, ...o });

/** Runs `n` identical frames and returns the last rig. */
function run(cam: CameraCore, n: number, o: Partial<CameraFrame> = {}): CameraRig {
  let rig = cam.update(frame(o));
  for (let i = 1; i < n; i++) rig = cam.update(frame(o));
  return rig;
}

function expectV(a: Vec3, b: Vec3, digits = 9): void {
  expect(a.x).toBeCloseTo(b.x, digits);
  expect(a.y).toBeCloseTo(b.y, digits);
  expect(a.z).toBeCloseTo(b.z, digits);
}

function box(id: number, min: Vec3, max: Vec3): Collider {
  return { kind: 'aabb', min, max, id, flags: { climbable: false, walkableTop: true, blocksCamera: true, material: 'stone' } };
}

/** Thick camera-blocking wall behind the origin with its front face at z = face. */
const wall = (face: number, id = 1): Collider => box(id, v(-5, -5, face - 10), v(5, 10, face));

/** Ground far below, so only colliders matter. */
const openWorld = (): CollisionWorld => createCollisionWorld(flatHeightfield(-100));

/** Camera over `world`, snapped behind the origin and levelled (it looks straight along +Z from −Z). */
function levelCamera(world: CollisionWorld): CameraCore {
  const cam = new CameraCore({ collision: createCameraCollision(world) });
  cam.update(frame({ look: { x: 0, y: -DEFAULT_PITCH } }));
  return cam;
}

/** The camera sphere at `p` overlaps camera-blocking geometry. */
const inside = (w: CollisionWorld, p: Vec3): boolean => overlapSphere(w, p, CAMERA_RADIUS, { mask: 'camera' }).length > 0;

describe('CameraCore orbit (Req 21.1, 21.2)', () => {
  it('starts behind the character at shoulder height, 5.5 m away at 15° pitch', () => {
    const cam = new CameraCore();
    const rig = cam.update(frame({ characterPos: v(10, 2, -4), characterYaw: Math.PI / 2 }));
    // Facing +X, the camera's right is +Z, so the shoulder target sits 0.35 m toward +Z.
    const target = v(10, 2 + SHOULDER_HEIGHT, -4 + SHOULDER_RIGHT);
    expect(cam.yaw).toBeCloseTo(Math.PI / 2, 12);
    expect(cam.pitch).toBeCloseTo(15 * DEG2RAD, 12);
    expect(cam.distance).toBe(DEFAULT_DISTANCE);
    expectV(cam.target, target);
    expectV(rig.lookAt, target);
    const d = DEFAULT_DISTANCE;
    expectV(rig.position, v(10 - d * Math.cos(DEFAULT_PITCH), target.y + d * Math.sin(DEFAULT_PITCH), target.z));
    expect([rig.fov, rig.roll, cam.characterOpacity]).toEqual([60, 0, 1]);
  });

  it('turns 1:1 with look input (+x right, +y down) and clamps pitch to −60°…+75°', () => {
    const cam = new CameraCore();
    cam.update(frame());
    let rig = cam.update(frame({ look: { x: 0.5, y: 0.2 } }));
    expect(cam.yaw).toBeCloseTo(-0.5, 12);
    expect(cam.pitch).toBeCloseTo(DEFAULT_PITCH + 0.2, 12);
    // Turning right swings the view toward the old right-hand side, (−1, 0, 0) at yaw 0.
    expect(rig.lookAt.x - rig.position.x).toBeLessThan(0);
    rig = cam.update(frame({ look: { x: 0, y: 10 } }));
    expect(cam.pitch).toBe(MAX_PITCH);
    expect(rig.position.y - rig.lookAt.y).toBeCloseTo(DEFAULT_DISTANCE * Math.sin(MAX_PITCH), 9);
    rig = cam.update(frame({ look: { x: 0, y: -10 } }));
    expect(cam.pitch).toBe(MIN_PITCH);
    expect(rig.position.y - rig.lookAt.y).toBeCloseTo(DEFAULT_DISTANCE * Math.sin(MIN_PITCH), 9);
  });

  it('applies mouse sensitivity and invertY through InputState and turns with the camera keys', () => {
    const input = new InputState(DEFAULT_BINDINGS, { sensitivity: 2, invertY: false });
    const cam = new CameraCore();
    cam.update(frame());
    input.beginTick([{ kind: 'mouseMove', dx: 100, dy: 50 }], DT);
    cam.update(frame({ look: input.lookDelta() }));
    expect(cam.yaw).toBeCloseTo(-24 * DEG2RAD, 9); // 100 px · 0.12°/px · 2, turning right
    expect(cam.pitch).toBeCloseTo(27 * DEG2RAD, 9); // 15° + 50 px · 0.12°/px · 2: mouse down looks down
    input.setLookOptions({ sensitivity: 1, invertY: true });
    input.beginTick([{ kind: 'mouseMove', dx: 0, dy: 50 }], DT);
    cam.update(frame({ look: input.lookDelta() }));
    expect(cam.pitch).toBeCloseTo(21 * DEG2RAD, 9); // inverted: mouse down looks up
    input.setLookOptions({ sensitivity: 1, invertY: false });
    const yaw0 = cam.yaw;
    const pitch0 = cam.pitch;
    const keys: RawInput[] = [
      { kind: 'down', code: 'ArrowLeft', time: 0 },
      { kind: 'down', code: 'ArrowUp', time: 0 },
    ];
    for (let i = 0; i < 30; i++) {
      input.beginTick(i === 0 ? keys : [], DT);
      cam.update(frame({ look: input.lookDelta() }));
    }
    expect(cam.yaw - yaw0).toBeCloseTo(75 * DEG2RAD, 9); // 150°/s for 0.5 s, turning left
    expect(cam.pitch - pitch0).toBeCloseTo(-45 * DEG2RAD, 9); // 90°/s for 0.5 s, looking up
  });

  it('moves userDistance 0.5 m per 100 wheel within 3–8 m and eases the distance there', () => {
    const cam = new CameraCore();
    cam.update(frame());
    cam.update(frame({ wheel: 200 }));
    expect(cam.userDistance).toBe(6.5);
    expect(cam.distance).toBeGreaterThan(DEFAULT_DISTANCE);
    expect(cam.distance).toBeLessThan(6.5);
    run(cam, 120);
    expect(cam.distance).toBeCloseTo(6.5, 6);
    cam.update(frame({ wheel: 5000 }));
    expect(cam.userDistance).toBe(8);
    cam.update(frame({ wheel: -5000 }));
    expect(cam.userDistance).toBe(3);
  });

  it('follows the target with 0.05 s horizontal and slower 0.12 s vertical smoothing', () => {
    const cam = new CameraCore();
    cam.update(frame());
    cam.update(frame({ characterPos: v(1, 1, 0) })); // √2 m: below the teleport threshold
    const t = cam.target;
    const horizontal = t.x + SHOULDER_RIGHT; // right at yaw 0 is −X
    const vertical = t.y - SHOULDER_HEIGHT;
    expect(horizontal).toBeGreaterThan(0);
    expect(horizontal).toBeLessThan(1);
    expect(vertical).toBeGreaterThan(0);
    expect(vertical).toBeLessThan(horizontal);
    run(cam, 90, { characterPos: v(1, 1, 0) });
    expectV(cam.target, v(1 - SHOULDER_RIGHT, 1 + SHOULDER_HEIGHT, 0), 6);
  });

  it('snaps behind the character after a teleport-sized move or snap()', () => {
    const cam = new CameraCore();
    cam.update(frame());
    cam.update(frame({ look: { x: 1, y: 0.3 }, wheel: 200 }));
    cam.update(frame({ characterPos: v(0, 0, 1.4) })); // under max(1.5 m, 50 m/s · dt): a normal move
    expect(cam.yaw).toBeCloseTo(-1, 12);
    cam.update(frame({ characterPos: v(0, 0, 3), characterYaw: 2 })); // 1.6 m in one frame
    expect(cam.yaw).toBeCloseTo(2, 12);
    expect(cam.pitch).toBe(DEFAULT_PITCH);
    expect(cam.distance).toBe(6.5); // userDistance at once, no smoothing
    expectV(cam.target, addScaled(v(0, SHOULDER_HEIGHT, 3), cameraRight(2), SHOULDER_RIGHT));
    // A long frame raises the threshold: 3 m in 0.1 s is under 50 m/s · 0.1 s = 5 m.
    cam.update(frame({ characterPos: v(0, 0, 6), characterYaw: -1, realDt: 0.1, look: { x: 0.5, y: 0 } }));
    expect(cam.yaw).toBeCloseTo(1.5, 12);
    cam.snap();
    cam.update(frame({ characterPos: v(0, 0, 6.1), characterYaw: -1 }));
    expect(cam.yaw).toBeCloseTo(-1, 12);
    expect(cam.pitch).toBe(DEFAULT_PITCH);
    expectV(cam.target, addScaled(v(0, SHOULDER_HEIGHT, 6.1), cameraRight(-1), SHOULDER_RIGHT));
  });
});

describe('CameraCore collision (Req 21.3)', () => {
  it('pulls in front of an occluder within 0.1 s without entering it, then eases back over 0.5 s', () => {
    const world = openWorld();
    const cam = levelCamera(world);
    run(cam, 5);
    expect(cam.distance).toBe(DEFAULT_DISTANCE);
    expect(world.upsertDynamic(box(7, v(-3, -5, -3.1), v(3, 10, -3)))).toBe(true);
    const blocked = 2.55; // the r 0.25 sphere touches the plate face 2.75 m back, minus the 0.2 m margin
    const pulled: number[] = [];
    for (let i = 0; i < 6; i++) {
      const rig = cam.update(frame());
      expect(inside(world, rig.position)).toBe(false);
      pulled.push(cam.distance);
    }
    expect(pulled[0]).toBeGreaterThan(blocked);
    expect(pulled[0]).toBeLessThan(DEFAULT_DISTANCE);
    expect(pulled[5]).toBeCloseTo(blocked, 4); // 6 frames = 0.1 s
    for (let i = 1; i < pulled.length; i++) expect(pulled[i]).toBeLessThanOrEqual(pulled[i - 1]);

    expect(world.removeDynamic(7)).toBe(true);
    const back: number[] = [];
    for (let i = 0; i < 30; i++) {
      cam.update(frame());
      back.push(cam.distance);
    }
    expect(back[0]).toBeGreaterThan(blocked);
    expect(back[14]).toBeCloseTo(blocked + (DEFAULT_DISTANCE - blocked) * 0.875, 3); // cubic ease-out at half time
    expect(back[28]).toBeLessThan(DEFAULT_DISTANCE);
    expect(back[29]).toBe(DEFAULT_DISTANCE); // 30 frames = 0.5 s
    for (let i = 1; i < back.length; i++) expect(back[i]).toBeGreaterThanOrEqual(back[i - 1]);
  });

  it('moves in the same frame when the camera would be inside geometry and stays out while backing into a wall', () => {
    const world = openWorld();
    const cam = levelCamera(world);
    run(cam, 5);
    world.upsertDynamic(wall(-3));
    let rig = cam.update(frame());
    expect(cam.distance).toBeCloseTo(2.55, 4);
    expect(inside(world, rig.position)).toBe(false);
    for (let i = 1; i <= 18; i++) {
      rig = cam.update(frame({ characterPos: v(0, 0, -0.1 * i) })); // 6 m/s toward the wall
      expect(inside(world, rig.position)).toBe(false);
    }
    expect(cam.distance).toBeLessThan(1.5);
  });

  it('snaps without the ease-out return after a teleport', () => {
    const world = openWorld();
    world.addStatic(wall(-3));
    const cam = levelCamera(world);
    expect(cam.distance).toBeCloseTo(2.55, 4); // a snap applies the collision at once
    cam.update(frame({ characterPos: v(0, 0, 60) }));
    expect(cam.distance).toBe(DEFAULT_DISTANCE);
  });

  it('pulls in for terrain behind the character and keeps the camera out of it', () => {
    const hill = analyticHeightfield((_x, z) => Math.max(0, 2 * (-z - 3)));
    const world = createCollisionWorld(hill);
    const cam = levelCamera(world);
    const rig = run(cam, 3);
    // At y 1.55 the r 0.25 sphere touches the 2:1 slope 3.4955 m back; minus the margin: 3.2955 m.
    expect(cam.distance).toBeCloseTo(3.2955, 3);
    expect(inside(world, rig.position)).toBe(false);
    expect(rig.position.y).toBeGreaterThanOrEqual(hill.heightAt(rig.position.x, rig.position.z) + GROUND_CLEARANCE);
  });

  it('keeps the 0.6 m minimum distance and lifts the camera 0.3 m above a steep bank', () => {
    const bank = analyticHeightfield((_x, z) => Math.max(0, 5 * (-z - 0.2)));
    const cam = levelCamera(createCollisionWorld(bank));
    const rig = run(cam, 20);
    expect(cam.distance).toBe(MIN_DISTANCE);
    // 0.6 m back the orbit point is under the 2.0 m bank surface; the clearance lifts it to 2.3 m.
    expect(rig.position.z).toBeCloseTo(-MIN_DISTANCE, 9);
    expect(rig.position.y).toBeCloseTo(bank.heightAt(rig.position.x, rig.position.z) + GROUND_CLEARANCE, 9);
    expect(cam.characterOpacity).toBe(FADED_OPACITY); // 0.96 m from the target
  });

  it('squeezes the shoulder offset beside a wall and grows it back afterwards', () => {
    const world = openWorld();
    const cam = levelCamera(world);
    world.upsertDynamic(box(3, v(-10, -5, -20), v(-0.5, 10, 20))); // on the camera's right (−X)
    let rig = cam.update(frame());
    expect(cam.target.x).toBeCloseTo(-0.2, 4); // sphere contact at 0.25 m, minus the 0.05 m skin
    expect(inside(world, rig.position)).toBe(false);
    expect(cam.distance).toBe(DEFAULT_DISTANCE);
    world.removeDynamic(3);
    rig = cam.update(frame());
    expect(cam.target.x).toBeLessThan(-0.2);
    expect(cam.target.x).toBeGreaterThan(-SHOULDER_RIGHT);
    run(cam, 60);
    expect(cam.target.x).toBeCloseTo(-SHOULDER_RIGHT, 3);
  });
});

describe('CameraCore near fade (Req 21.4)', () => {
  it('fades the character to 35% below 1.0 m over 0.15 s and clears it only from 1.2 m', () => {
    const world = openWorld();
    const cam = levelCamera(world);
    world.upsertDynamic(wall(-1.55)); // holds the camera at 1.1 m: inside the band, still opaque
    run(cam, 3);
    expect(cam.distance).toBeCloseTo(1.1, 4);
    expect(cam.characterOpacity).toBe(1);

    world.upsertDynamic(wall(-1.3)); // pulled to 0.85 m; the fade starts once below 1.0 m and lasts 9 frames
    const opacity: number[] = [];
    for (let i = 0; i < 20; i++) {
      cam.update(frame());
      opacity.push(cam.characterOpacity);
    }
    expect(cam.distance).toBeCloseTo(0.85, 4);
    const start = opacity.findIndex((o) => o < 1);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(opacity[start]).toBeCloseTo(1 - (1 - FADED_OPACITY) / 9, 9);
    expect(opacity[start + 7]).toBeGreaterThan(FADED_OPACITY);
    expect(opacity[start + 8]).toBeCloseTo(FADED_OPACITY, 9); // 9 frames = 0.15 s

    world.upsertDynamic(wall(-1.55)); // eased back to 1.1 m: below 1.2 m, stays faded
    for (let i = 0; i < 40; i++) {
      cam.update(frame());
      expect(cam.characterOpacity).toBeCloseTo(FADED_OPACITY, 9);
    }
    expect(cam.distance).toBeCloseTo(1.1, 4);

    world.upsertDynamic(wall(-1.7)); // 1.25 m: clears once the distance reaches 1.2 m
    for (let i = 0; i < 40; i++) {
      const before = cam.characterOpacity;
      cam.update(frame());
      if (cam.characterOpacity > before) expect(cam.distance).toBeGreaterThanOrEqual(FADE_END_DISTANCE);
    }
    expect(cam.distance).toBeCloseTo(1.25, 4);
    expect(cam.characterOpacity).toBe(1);
  });
});

describe('CameraCore shake (Req 35.8)', () => {
  it('leaves the rig exactly still at 0% intensity even at full trauma, while trauma decays', () => {
    const still = new CameraCore();
    const shaken = new CameraCore();
    shaken.addTrauma(1);
    for (let i = 0; i < 20; i++) {
      const o = { characterPos: v(0, 0, 0.05 * i), look: { x: 0.01, y: 0.005 } };
      expect(shaken.update(frame({ ...o, shake: 0 }))).toEqual(still.update(frame(o)));
    }
    expect(shaken.trauma).toBeCloseTo(1 - TRAUMA_DECAY_PER_SEC * 20 * DT, 9);
  });

  it('shakes within 0.2 m and 3° at 100% and returns to the still rig once trauma is gone', () => {
    const still = new CameraCore();
    const shaken = new CameraCore();
    shaken.addTrauma(1);
    let moved = 0;
    for (let i = 0; i < 20; i++) {
      const a = still.update(frame());
      const b = shaken.update(frame());
      const d = distance(a.position, b.position);
      expect(d).toBeLessThanOrEqual(SHAKE_OFFSET_LIMIT + 1e-12);
      expect(Math.abs(b.roll)).toBeLessThanOrEqual(SHAKE_MAX_ANGLE);
      moved = Math.max(moved, d);
    }
    expect(moved).toBeGreaterThan(0.01);
    run(still, 30);
    run(shaken, 30); // 50 frames > 1 / 1.6 s
    expect(shaken.trauma).toBe(0);
    expect(shaken.update(frame())).toEqual(still.update(frame()));
  });
});
