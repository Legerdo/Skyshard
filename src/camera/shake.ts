// Camera shake (design "흔들림과 impulse"; Req 35.8). A trauma value in [0, 1] rises with addTrauma()
// and falls by TRAUMA_DECAY_PER_SEC in real time. Each frame's offset is
// maxOffset · trauma² · noise(t) per axis, times the Settings shake intensity, so 0% never moves the
// camera. noise is SHAKE_NOISE_HZ value noise in [−1, 1] with its own seed per axis: deterministic,
// no Math.random. Pure: no three.js / DOM.

import { lerp } from '../core/math';
import { deriveSeed } from '../core/rng';
import { SHAKE_MAX_ANGLE, SHAKE_MAX_OFFSET, SHAKE_NOISE_HZ, SHAKE_OFFSET_LIMIT, TRAUMA_DECAY_PER_SEC } from './constants';

/** One frame of shake. All zero when there is no shake. */
export interface ShakeOffset {
  /** World-space position offset (m); its length is at most SHAKE_OFFSET_LIMIT. */
  x: number;
  y: number;
  z: number;
  /** Rotation offsets (rad), each within ±SHAKE_MAX_ANGLE. */
  yaw: number;
  pitch: number;
  roll: number;
}

/** Seed of the per-axis noise streams when none is given. */
export const DEFAULT_SHAKE_SEED = 0x51a7e5;

const AXES = ['x', 'y', 'z', 'yaw', 'pitch', 'roll'] as const;
const UINT32_MAX = 0xffffffff;

const noShake = (): ShakeOffset => ({ x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 });

/** Uniform lattice value in [−1, 1] for integer `i` (murmur3 finalizer over i · golden ratio ^ seed). */
function lattice(seed: number, i: number): number {
  let h = Math.imul(i | 0, 0x9e3779b1) ^ seed;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return ((h >>> 0) / UINT32_MAX) * 2 - 1;
}

/**
 * Smooth 1D value noise in [−1, 1]: a seeded lattice value every 1/hz seconds, blended with
 * smoothstep, so it is continuous with a continuous slope. Same (seed, t) → same value.
 */
export function shakeNoise(seed: number, t: number, hz: number = SHAKE_NOISE_HZ): number {
  const p = t * hz;
  const i = Math.floor(p);
  const f = p - i;
  return lerp(lattice(seed, i), lattice(seed, i + 1), f * f * (3 - 2 * f));
}

/** Trauma-based shake with a real-time clock. */
export class CameraShake {
  private traumaValue = 0;
  /** Noise clock (s of real time). */
  private time = 0;
  private readonly seeds: readonly number[];

  constructor(seed: number = DEFAULT_SHAKE_SEED) {
    this.seeds = AXES.map((axis) => deriveSeed(seed, `camera-shake:${axis}`));
  }

  get trauma(): number {
    return this.traumaValue;
  }

  /** trauma = min(1, trauma + amount). Zero, negative and NaN amounts are ignored. */
  addTrauma(amount: number): void {
    if (!(amount > 0)) return;
    this.traumaValue = Math.min(1, this.traumaValue + amount);
  }

  /**
   * This frame's offset for the current trauma, then advances the clock and lowers trauma by
   * TRAUMA_DECAY_PER_SEC · realDt (an impulse shows at full strength on the frame after it is added).
   * `intensity` is Settings.shake (0..1, clamped); 0 or no trauma returns exact zeros.
   */
  update(realDt: number, intensity: number): ShakeOffset {
    const dt = realDt > 0 ? realDt : 0;
    const scale = this.traumaValue * this.traumaValue * (intensity > 0 ? Math.min(1, intensity) : 0);
    const offset = scale > 0 ? this.sample(scale) : noShake();
    this.time += dt;
    this.traumaValue = Math.max(0, this.traumaValue - TRAUMA_DECAY_PER_SEC * dt);
    return offset;
  }

  private sample(scale: number): ShakeOffset {
    const [nx, ny, nz, nYaw, nPitch, nRoll] = this.seeds.map((seed) => shakeNoise(seed, this.time));
    const reach = SHAKE_MAX_OFFSET * scale;
    let x = nx * reach;
    let y = ny * reach;
    let z = nz * reach;
    const length = Math.hypot(x, y, z);
    if (length > SHAKE_OFFSET_LIMIT) {
      const k = SHAKE_OFFSET_LIMIT / length;
      x *= k;
      y *= k;
      z *= k;
    }
    const angle = SHAKE_MAX_ANGLE * scale;
    return { x, y, z, yaw: nYaw * angle, pitch: nPitch * angle, roll: nRoll * angle };
  }
}
