import { PerspectiveCamera } from 'three';
import { describe, expect, it } from 'vitest';
import { CameraCore } from '../../../src/camera/cameraCore';
import { CameraSystem } from '../../../src/camera/cameraSystem';
import { LANDMARK_FRAMING_SECONDS, LandmarkFraming } from '../../../src/camera/landmarkFraming';
import { angleDelta, yawFromDir } from '../../../src/core/math';
import type { Vec3 } from '../../../src/core/types';
import { InputState } from '../../../src/input/inputState';

// Landmark first-discovery framing (task 20.3; Req 9.4): at most 3 s, then the view is the player's again.
const DT = 1 / 60;

describe('LandmarkFraming', () => {
  it('holds its point for LANDMARK_FRAMING_SECONDS (≤ 3 s), then ends; cancel ends it at once', () => {
    expect(LANDMARK_FRAMING_SECONDS).toBeLessThanOrEqual(3);
    const f = new LandmarkFraming();
    expect(f.update(DT)).toBeNull();
    f.start({ x: 10, y: 50, z: 80 });
    let frames = 0;
    while (f.update(DT) !== null) frames++;
    expect(frames * DT).toBeCloseTo(LANDMARK_FRAMING_SECONDS, 1);
    expect(f.active).toBe(false);
    f.start({ x: 0, y: 0, z: 1 }, 10);
    let long = 0;
    while (f.update(DT) !== null) long++;
    expect(long * DT).toBeLessThanOrEqual(3); // clamped
    f.start({ x: 0, y: 0, z: 1 });
    f.cancel();
    expect(f.update(DT)).toBeNull();
    f.start({ x: Number.NaN, y: 0, z: 0 });
    expect(f.active).toBe(false);
  });

  it('turns the Camera_System toward the framed Landmark and releases the view afterwards', () => {
    const input = new InputState();
    const framing = new LandmarkFraming();
    let point: Readonly<Vec3> | null = null;
    const system = new CameraSystem({
      core: new CameraCore(),
      camera: new PerspectiveCamera(60, 16 / 9, 0.1, 500),
      target: () => ({ pos: { x: 0, y: 0, z: 0 }, yaw: 0 }),
      input,
      framing: () => point,
    });
    system.update(DT, 1); // behind the character, looking along +Z
    const landmark = { x: 120, y: 40, z: 20 };
    framing.start(landmark);
    for (let i = 0; i < 90; i++) {
      point = framing.update(DT);
      system.update(DT, 1);
    }
    expect(Math.abs(angleDelta(system.yaw, yawFromDir(landmark.x, landmark.z)))).toBeLessThan(0.05);
    expect(system.lockTarget).toBeNull(); // no Lock-on target is involved
    for (let i = 0; i < 200; i++) {
      point = framing.update(DT);
      system.update(DT, 1);
    }
    expect(point).toBeNull();
    // Afterwards look input turns the camera 1:1 again (no framing pull).
    const before = system.yaw;
    input.addMouseLook(50, 0);
    system.update(DT, 1);
    expect(system.yaw).toBeLessThan(before);
  });
});
