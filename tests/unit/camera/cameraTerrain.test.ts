import { PerspectiveCamera } from 'three';
import { describe, expect, it } from 'vitest';
import { createCameraCollision } from '../../../src/camera/cameraCollision';
import { CameraCore } from '../../../src/camera/cameraCore';
import { CameraSystem } from '../../../src/camera/cameraSystem';
import { CAMERA_FOV_DEG, GROUND_CLEARANCE, MAX_PITCH, MIN_PITCH } from '../../../src/camera/constants';
import { GameLoop } from '../../../src/core/loop';
import { yawFromDir } from '../../../src/core/math';
import { createRng } from '../../../src/core/rng';
import type { Vec3 } from '../../../src/core/types';
import { LOCATIONS, type LocationId } from '../../../src/data/worldLayout';
import { InputSampler } from '../../../src/input/inputSampler';
import { InputState, type RawInput } from '../../../src/input/inputState';
import type { InputCode } from '../../../src/input/bindings';
import { createCollisionWorld } from '../../../src/physics/collisionWorld';
import { PlayerController } from '../../../src/player/playerController';
import { RecoverySystem } from '../../../src/player/recovery';
import { buildTerrain } from '../../../src/world/terrain';

// Checkpoint M1 (task 3): on the generated terrain, the main.ts frame order (InputSample → PlayerController
// → interpolation → Camera_System → render camera) keeps the feet on the ground and the render camera at
// least GROUND_CLEARANCE above the terrain under it (design "카메라 충돌과 근접 페이드", Req 20.1, 21.3)
// while the player sprints, runs, walks and jumps and the camera sweeps the whole pitch range.

const SEED = 20240601; // main.ts DEV_WORLD_SEED
const SECONDS = 8;
const EPS = 1e-9;

/** Real-time input script (s): sprint 0–3 s, run 3–6 s, walk after; jumps, yaw turns and pitch sweeps throughout. */
function scriptedEvents(t0: number, t1: number): RawInput[] {
  const events: RawInput[] = [];
  const at = (t: number, kind: 'down' | 'up', code: InputCode): void => {
    if (t >= t0 && t < t1) events.push({ kind, code, time: t });
  };
  at(0, 'down', 'KeyW');
  at(0, 'down', 'ShiftLeft');
  at(3, 'up', 'ShiftLeft');
  at(6, 'down', 'KeyX'); // walk toggle
  at(6.05, 'up', 'KeyX');
  for (let k = 0; k * 0.8 < SECONDS; k++) {
    at(0.4 + k * 0.8, 'down', 'Space');
    at(0.45 + k * 0.8, 'up', 'Space');
  }
  for (let k = 0; k * 2.5 < SECONDS; k++) {
    at(k * 2.5, 'down', 'ArrowLeft'); // 150°/s for 0.6 s: the run curves across the slopes
    at(k * 2.5 + 0.6, 'up', 'ArrowLeft');
  }
  for (let k = 0; k * 4 < SECONDS; k++) {
    at(k * 4, 'down', 'ArrowUp'); // down to MIN_PITCH (camera low, looking up)
    at(k * 4 + 2, 'up', 'ArrowUp');
    at(k * 4 + 2, 'down', 'ArrowDown'); // up to MAX_PITCH (camera high, looking down)
    at(k * 4 + 4, 'up', 'ArrowDown');
  }
  return events;
}

/** A start `offset` m from `from` toward `toward`, on the ground and facing `toward`. */
function startNear(terrain: ReturnType<typeof buildTerrain>, from: LocationId, toward: LocationId, offset: number) {
  const a = LOCATIONS[from];
  const b = LOCATIONS[toward];
  const length = Math.hypot(b.x - a.x, b.z - a.z);
  const x = a.x + ((b.x - a.x) / length) * offset;
  const z = a.z + ((b.z - a.z) / length) * offset;
  const pos: Vec3 = { x, y: terrain.heightAt(x, z), z };
  return { pos, yaw: yawFromDir(b.x - x, b.z - z) };
}

describe('Camera over the generated terrain (checkpoint M1)', () => {
  const terrain = buildTerrain(SEED);

  it.each([
    ['Thistlewick entrance (Verdant hills)', 'thistlewick', 'breezewatch', 18],
    ['Ember mesa top (vista_ember)', 'vista_ember', 'camp_durga', 0],
    ['Azure plateau by camp_oriel', 'camp_oriel', 'lm_arch_azure', 0],
  ] as const)('%s: feet stay on the terrain and the camera stays 0.3 m above it', (_name, from, toward, offset) => {
    const world = createCollisionWorld(terrain);
    const spawn = startNear(terrain, from, toward, offset);
    const input = new InputState();
    const sampler = new InputSampler(input);
    const player = new PlayerController({ world, pos: spawn.pos, yaw: spawn.yaw });
    const recovery = new RecoverySystem({ world, initial: spawn, fallback: () => spawn });
    const camera = new PerspectiveCamera(CAMERA_FOV_DEG, 16 / 9, 0.1, 2200);
    const core = new CameraCore({ collision: createCameraCollision(world) });
    const cameraSystem = new CameraSystem({ core, camera, target: (alpha) => player.pose(alpha), input });

    const failures: string[] = [];
    const modes = new Set<string>();
    let minPitch = Infinity;
    let maxPitch = -Infinity;
    let pulledIn = 0;
    let lifted = 0;
    let frames = 0;

    const loop = new GameLoop({
      requestFrame: () => 0,
      step: ({ dt }) => {
        sampler.beginTick(dt);
        if (!recovery.active) player.tick(input, cameraSystem.yaw, dt);
        const { teleport } = recovery.tick({ body: player.state, dt });
        if (teleport !== null) {
          player.teleport(teleport.pos, teleport.yaw);
          cameraSystem.snap();
        }
        const { pos, mode } = player.state;
        modes.add(mode);
        const ground = terrain.heightAt(pos.x, pos.z);
        if (!(pos.y >= ground)) failures.push(`feet (${pos.x}, ${pos.y}, ${pos.z}) in ${mode} below heightAt ${ground}`);
      },
      render: (alpha, realDt) => {
        cameraSystem.update(realDt, alpha);
        frames++;
        const { x, y, z } = camera.position;
        const floor = terrain.heightAt(x, z) + GROUND_CLEARANCE;
        if (![x, y, z].every(Number.isFinite)) failures.push(`frame ${frames}: non-finite camera (${x}, ${y}, ${z})`);
        else if (y < floor - EPS) failures.push(`frame ${frames}: camera y ${y} below heightAt + 0.3 = ${floor} at (${x}, ${z})`);
        minPitch = Math.min(minPitch, core.pitch);
        maxPitch = Math.max(maxPitch, core.pitch);
        if (core.distance < core.userDistance - 1) pulledIn++;
        // No shake here, so the rig sits on the orbit unless the ground clearance lifted it.
        const orbitY = core.target.y + Math.sin(core.pitch) * core.distance;
        if (y > orbitY + 1e-6) lifted++;
      },
    });

    // Display frames at 30–144 fps, deterministic.
    const rng = createRng(SEED);
    let now = 0;
    loop.frame(now);
    while (now < SECONDS * 1000) {
      const prev = now;
      now += 1000 / (30 + 114 * rng.next());
      sampler.collect(scriptedEvents(prev / 1000, now / 1000));
      loop.frame(now);
    }

    expect(failures.slice(0, 5)).toEqual([]);
    // Guard against a vacuous pass: the run covered ground, jumped, and the camera swept both pitch
    // limits, was pulled in by the terrain and was lifted by the ground clearance.
    const travelled = Math.hypot(player.state.pos.x - spawn.pos.x, player.state.pos.z - spawn.pos.z);
    expect(travelled).toBeGreaterThan(10);
    expect(modes.has('jump')).toBe(true);
    expect(minPitch).toBeCloseTo(MIN_PITCH, 9);
    expect(maxPitch).toBeCloseTo(MAX_PITCH, 9);
    expect(pulledIn).toBeGreaterThan(0);
    expect(lifted).toBeGreaterThan(0); // the ground clearance itself was exercised
  });
});
