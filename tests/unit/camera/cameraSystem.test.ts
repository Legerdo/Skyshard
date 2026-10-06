import { PerspectiveCamera } from 'three';
import { describe, expect, it } from 'vitest';
import { CameraCore } from '../../../src/camera/cameraCore';
import { CameraSystem } from '../../../src/camera/cameraSystem';
import { DEFAULT_PITCH } from '../../../src/camera/constants';
import { InputState, MOUSE_RAD_PER_PX } from '../../../src/input/inputState';

// Camera_System frame driver (design "Camera": update(realDt, alpha) after the sim state is interpolated).
const DT = 1 / 60;

describe('CameraSystem', () => {
  it('follows the pose for the frame alpha, consumes look and wheel once and moves the render camera', () => {
    const input = new InputState();
    const camera = new PerspectiveCamera(45, 16 / 9, 0.1, 500);
    const alphas: number[] = [];
    const system = new CameraSystem({
      core: new CameraCore(),
      camera,
      target: (alpha) => {
        alphas.push(alpha);
        return { pos: { x: 3, y: 1, z: -2 }, yaw: 0.5 };
      },
      input,
    });
    expect(system.rig).toBeNull();

    system.update(DT, 0.25);
    expect(alphas).toEqual([0.25]);
    expect(system.yaw).toBeCloseTo(0.5, 12); // first frame snaps behind the character
    expect(system.pitch).toBeCloseTo(DEFAULT_PITCH, 12);
    const rig = system.rig!;
    expect(camera.position.toArray()).toEqual([rig.position.x, rig.position.y, rig.position.z]);
    expect(camera.fov).toBe(rig.fov);

    input.addMouseLook(100, 0);
    input.beginTick([{ kind: 'wheel', delta: 200 }], DT);
    system.update(DT, 0.5);
    const turned = 0.5 - 100 * MOUSE_RAD_PER_PX; // mouse right turns the camera right (yaw decreases)
    expect(system.yaw).toBeCloseTo(turned, 12);
    expect([input.lookDelta(), input.wheelDelta()]).toEqual([{ x: 0, y: 0 }, 0]);
    system.update(DT, 0.75);
    expect(system.yaw).toBeCloseTo(turned, 12);
    expect(system.characterOpacity).toBe(1);
  });
});
