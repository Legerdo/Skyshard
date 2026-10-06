import { Matrix4, PerspectiveCamera } from 'three';
import { describe, expect, it } from 'vitest';
import { CameraCore } from '../../../src/camera/cameraCore';
import { CameraSystem } from '../../../src/camera/cameraSystem';
import { combatDistance, combatSpread, edgeIndicator } from '../../../src/camera/combatFraming';
import { DEFAULT_DISTANCE, DEFAULT_PITCH } from '../../../src/camera/constants';
import {
  keepLockTarget, LOCK_LOOK_LIMIT, pickLockTarget, RECENTER_SECONDS, type LockTargetCandidate,
} from '../../../src/camera/lockOn';
import { angleDelta, DEG2RAD, yawFromDir } from '../../../src/core/math';
import type { Vec3 } from '../../../src/core/types';
import { InputState } from '../../../src/input/inputState';

// Lock-on, re-centre and combat framing (design "Lock-on", "전투 프레이밍"; Req 21.5–21.8).
const DT = 1 / 60;
const at = (deg: number, dist: number, y = 1): Vec3 => ({ x: dist * Math.sin(deg * DEG2RAD), y, z: dist * Math.cos(deg * DEG2RAD) });

describe('Lock-on target rules', () => {
  const view = { eye: { x: 0, y: 1, z: 0 }, forward: { x: 0, y: 0, z: 1 } };

  it('picks the visible candidate within 20 m at the smallest angle from the view centre', () => {
    const candidates: LockTargetCandidate[] = [
      { id: 'wide', center: at(30, 8) },
      { id: 'best', center: at(10, 15) },
      { id: 'far', center: at(3, 22) },
      { id: 'hidden', center: at(2, 10) },
    ];
    const visible = (_from: Readonly<Vec3>, to: Readonly<Vec3>) => to !== candidates[3]!.center;
    expect(pickLockTarget(view, { x: 0, y: 0, z: 0 }, candidates, visible)).toBe('best');
    expect(pickLockTarget(view, { x: 0, y: 0, z: 0 }, [candidates[2]!, candidates[3]!], visible)).toBeNull();
  });

  it('keeps the target within 25 m while it is a (living) candidate', () => {
    const c = { id: 'e1', center: { x: 0, y: 1, z: 24 } };
    expect(keepLockTarget('e1', { x: 0, y: 1, z: 0 }, [c])).toBe(c);
    expect(keepLockTarget('e1', { x: 0, y: 1, z: -1.5 }, [c])).toBeNull(); // 25.5 m
    expect(keepLockTarget('e1', { x: 0, y: 1, z: 0 }, [])).toBeNull(); // defeated
  });
});

describe('CameraSystem Lock-on', () => {
  function rig(candidates: LockTargetCandidate[], yaw = 0) {
    const input = new InputState();
    const pose = { pos: { x: 0, y: 0, z: 0 }, yaw };
    const system = new CameraSystem({
      core: new CameraCore(),
      camera: new PerspectiveCamera(60, 16 / 9, 0.1, 500),
      target: () => pose,
      input,
      lockCandidates: () => candidates,
    });
    system.update(DT, 1); // snaps behind the character
    const frames = (n: number) => {
      for (let i = 0; i < n; i++) system.update(DT, 1);
    };
    return { system, input, pose, frames };
  }

  it('without a candidate, turns behind the character and back to the default pitch within 0.3 s', () => {
    const { system, input, frames } = rig([], 1.2);
    input.addMouseLook(-2000, 800); // turn away and look down
    frames(1);
    expect(Math.abs(angleDelta(system.yaw, 1.2))).toBeGreaterThan(1);
    system.lockOn();
    expect(system.lockTarget).toBeNull();
    frames(Math.round(RECENTER_SECONDS / DT));
    expect(system.yaw).toBeCloseTo(1.2, 9);
    expect(system.pitch).toBeCloseTo(DEFAULT_PITCH, 9);
  });

  it('locks, frames the target, bounds look to ±20°, releases on a second press, on defeat and beyond 25 m', () => {
    const target = { id: 'e1', center: at(60, 10) };
    const candidates = [target];
    const { system, input, pose, frames } = rig(candidates);
    system.lockOn();
    expect(system.lockTarget).toBe('e1');
    frames(90);
    const goal = yawFromDir(target.center.x, target.center.z);
    expect(Math.abs(angleDelta(system.yaw, goal))).toBeLessThan(0.01);

    input.addMouseLook(5000, 0); // far past the limit
    frames(1);
    expect(Math.abs(angleDelta(system.yaw, goal))).toBeLessThanOrEqual(LOCK_LOOK_LIMIT + 1e-6);
    frames(120); // look stopped: back to the goal
    expect(Math.abs(angleDelta(system.yaw, goal))).toBeLessThan(0.01);

    system.lockOn();
    expect(system.lockTarget).toBeNull();

    system.lockOn();
    candidates.length = 0; // defeated: no longer a candidate
    frames(1);
    expect(system.lockTarget).toBeNull();

    candidates.push(target);
    system.lockOn();
    expect(system.lockTarget).toBe('e1');
    pose.pos = { x: -20, y: 0, z: -10 }; // > 25 m away
    frames(1);
    expect(system.lockTarget).toBeNull();
  });
});

describe('combat framing', () => {
  it('widens to max(user, min(7, 5.5 + 0.2 · spread)) in combat and returns to userDistance after it', () => {
    expect(combatSpread({ x: 0, y: 0, z: 0 }, [{ x: 3, y: 0, z: 4 }, { x: 0, y: 5, z: 12 }, { x: 16, y: 0, z: 0 }])).toBe(12);
    expect([combatDistance(5.5, 3), combatDistance(5.5, 12), combatDistance(8, 12)]).toEqual([
      expect.closeTo(6.1, 9), 7, 8,
    ]);
    const core = new CameraCore();
    const frame = (spread: number | null) => core.update({ realDt: DT, characterPos: { x: 0, y: 0, z: 0 }, characterYaw: 0, combatSpread: spread });
    frame(null);
    for (let i = 0; i < 180; i++) frame(10);
    expect(core.distance).toBeCloseTo(7, 2);
    for (let i = 0; i < 90; i++) frame(null); // 1.5 s
    expect(core.distance).toBeCloseTo(DEFAULT_DISTANCE, 1);
  });

  it('projects off-screen Telegraphs to the 48 px inset edge, flipping points behind the camera', () => {
    const camera = new PerspectiveCamera(60, 16 / 9, 0.1, 500); // at the origin looking down −Z
    camera.updateMatrixWorld();
    const m = new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).elements;
    const W = 1920;
    const H = 1080;
    expect(edgeIndicator(m, { x: 0, y: 0, z: -10 }, W, H)).toBeNull(); // on screen
    const right = edgeIndicator(m, { x: 100, y: 0, z: -10 }, W, H)!;
    expect([right.x, right.y, right.angle]).toEqual([expect.closeTo(1 - 48 / W, 9), expect.closeTo(0.5, 9), expect.closeTo(0, 9)]);
    const behindLeft = edgeIndicator(m, { x: -5, y: 0, z: 10 }, W, H)!;
    expect(behindLeft.x).toBeCloseTo(48 / W, 9);
    const behind = edgeIndicator(m, { x: 0, y: 0, z: 10 }, W, H)!;
    expect([behind.x, behind.y]).toEqual([expect.closeTo(0.5, 9), expect.closeTo(1 - 48 / H, 9)]);
    const above = edgeIndicator(m, { x: 0, y: 100, z: -10 }, W, H)!;
    expect(above.y).toBeCloseTo(48 / H, 9);
  });
});
