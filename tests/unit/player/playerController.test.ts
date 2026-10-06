import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { CameraCore, cameraRight } from '../../../src/camera/cameraCore';
import { applyCameraRig } from '../../../src/camera/threeCamera';
import { dirFromYaw } from '../../../src/core/math';
import { InputState, type RawInput } from '../../../src/input/inputState';
import { createCollisionWorld } from '../../../src/physics/collisionWorld';
import { flatHeightfield } from '../../../src/physics/heightfield';
import { cameraRelativeMove, readControllerInput } from '../../../src/player/controllerInput';
import { createControllerState } from '../../../src/player/core/types';
import { PlayerController, interpolatePose } from '../../../src/player/playerController';

// Input → controller adapter (task 2.8): camera-relative movement, buffered presses and render interpolation.
const DT = 1 / 60;
const down = (code: string): RawInput => ({ kind: 'down', code, time: 0 });
const W = { x: 0, y: 1 };
const D = { x: 1, y: 0 };

describe('cameraRelativeMove', () => {
  it('turns forward into the camera forward and right into its screen-right, keeping the stick tilt', () => {
    const gap = (a: { x: number; z: number }, b: { x: number; z: number }): number => Math.hypot(a.x - b.x, a.z - b.z);
    for (const yaw of [0, 0.7, -2.1, Math.PI]) {
      expect(gap(cameraRelativeMove(W, yaw), dirFromYaw(yaw))).toBeLessThan(1e-12); // camera forward
      expect(gap(cameraRelativeMove(D, yaw), cameraRight(yaw))).toBeLessThan(1e-12); // camera screen-right
      const tilted = cameraRelativeMove({ x: 0.3, y: -0.4 }, yaw);
      expect(Math.hypot(tilted.x, tilted.z)).toBeCloseTo(0.5, 12);
    }
    expect(cameraRelativeMove(W, 0)).toEqual({ x: 0, z: 1 }); // yaw 0 faces +Z
  });

  it('walks W away from the rendered camera and D toward the right of the screen', () => {
    const core = new CameraCore();
    const feet = { x: 5, y: 0, z: -3 };
    core.update({ realDt: DT, characterPos: feet, characterYaw: 0.4 }); // first frame: behind the character
    const rig = core.update({ realDt: DT, characterPos: feet, characterYaw: 0.4, look: { x: 1.1, y: 0.2 } });
    const camera = new PerspectiveCamera(60, 16 / 9, 0.1, 100);
    applyCameraRig(camera, rig);
    camera.updateMatrixWorld();

    const w = cameraRelativeMove(W, core.yaw);
    const view = camera.getWorldDirection(new Vector3()).setY(0).normalize();
    expect(view.dot(new Vector3(w.x, 0, w.z))).toBeGreaterThan(0.9999);

    const d = cameraRelativeMove(D, core.yaw);
    const start = new Vector3(feet.x, feet.y, feet.z).project(camera);
    const moved = new Vector3(feet.x + d.x, feet.y, feet.z + d.z).project(camera);
    expect(moved.x).toBeGreaterThan(start.x + 0.05); // to the right on screen
  });
});

describe('readControllerInput', () => {
  it('reads the tick sample: camera-relative move, held sprint, walk toggle and buffered presses', () => {
    const input = new InputState();
    input.beginTick([down('KeyW'), down('ShiftLeft'), down('KeyX'), down('Space')], DT);
    const controls = readControllerInput(input, Math.PI / 2); // camera looking toward +X
    expect(controls.move.x).toBeCloseTo(1, 12);
    expect(controls.move.z).toBeCloseTo(0, 12);
    expect([controls.sprint, controls.walk, controls.jump, controls.dodge, controls.release]).toEqual([
      true,
      true,
      true,
      false,
      false,
    ]);
    expect(input.isBuffered('jump')).toBe(true); // only peeked
  });
});

describe('PlayerController', () => {
  const flatWorld = () => createCollisionWorld(flatHeightfield(0));

  it('moves along the camera yaw of each tick and keeps the previous state for interpolation', () => {
    const input = new InputState();
    const player = new PlayerController({ world: flatWorld(), pos: { x: 0, y: 0, z: 0 }, yaw: 0 });
    for (let tick = 0; tick < 30; tick++) {
      input.beginTick(tick === 0 ? [down('KeyW')] : [], DT);
      player.tick(input, Math.PI / 2, DT);
    }
    expect(player.state.pos.x).toBeGreaterThan(2); // 0.5 s toward +X at up to 6 m/s
    expect(Math.abs(player.state.pos.z)).toBeLessThan(1e-9);
    expect(player.state.yaw).toBeCloseTo(Math.PI / 2, 6); // turned to face the move
    expect(player.pose(0).pos).toEqual(player.previous.pos);
    expect(player.pose(1).pos).toEqual(player.state.pos);
    expect(player.previous.pos.x).toBeLessThan(player.state.pos.x);
  });

  it('teleport stands the character at rest at the target, moves the previous state too and keeps Stamina', () => {
    const input = new InputState();
    const player = new PlayerController({ world: flatWorld(), pos: { x: 0, y: 0, z: 0 }, yaw: 0 });
    for (let tick = 0; tick < 20; tick++) {
      input.beginTick(tick === 0 ? [down('KeyW'), down('ShiftLeft')] : [], DT);
      player.tick(input, 0, DT);
    }
    const stamina = player.stamina;
    expect(stamina.value).toBeLessThan(stamina.max); // sprinting spent some

    const target = { x: 5, y: 0, z: -1 };
    expect(player.teleport(target, 1)).toBe(true);
    expect(player.state).toEqual(createControllerState(target, 1));
    expect(player.previous).toEqual(player.state);
    expect(player.pose(0.4)).toEqual({ pos: target, yaw: 1 }); // no sweep across the jump
    expect(player.stamina).toEqual(stamina);

    expect(player.teleport({ x: Number.NaN, y: 0, z: 0 }, 0)).toBe(false);
    expect(player.state.pos).toEqual(target);
  });

  it('consumes the buffered press the step used and leaves the other one buffered', () => {
    const input = new InputState();
    const player = new PlayerController({ world: flatWorld(), pos: { x: 0, y: 0, z: 0 }, yaw: 0 });
    input.beginTick([down('Space'), down('Mouse2')], DT); // jump wins over dodge on the ground
    const events = player.tick(input, 0, DT);
    expect(events.map((e) => e.type)).toContain('jumped');
    expect(player.state.mode).toBe('jump');
    expect([input.isBuffered('jump'), input.isBuffered('dodge')]).toEqual([false, true]);
  });
});

describe('interpolatePose', () => {
  it('lerps the position, turns yaw along the shortest arc and clamps alpha', () => {
    const a = createControllerState({ x: 0, y: 1, z: 0 }, 3);
    const b = createControllerState({ x: 2, y: 3, z: -4 }, -3);
    const mid = interpolatePose(a, b, 0.5);
    expect(mid.pos).toEqual({ x: 1, y: 2, z: -2 });
    expect(Math.abs(mid.yaw)).toBeCloseTo(Math.PI, 12); // through ±π, not through 0
    expect(interpolatePose(a, b, 0)).toEqual({ pos: a.pos, yaw: 3 });
    expect(interpolatePose(a, b, 7).pos).toEqual(b.pos);
    expect(interpolatePose(a, b, Number.NaN).pos).toEqual(b.pos);
  });
});
