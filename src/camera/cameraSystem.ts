// Camera_System frame driver (design "Camera": `update(realDt, alpha)` once per render frame, right after
// the sim state is interpolated). It reads the interpolated Active_Character pose and the look / wheel
// input gathered since the last frame, advances CameraCore on real time and copies the rig to the
// render camera. It also owns the Lock-on target (Req 21.6–21.8): lockOn() picks the visible living enemy within
// 20 m closest to the view centre, or re-centres behind the character when there is none, and a second press
// releases it; each frame the target is dropped once it is defeated (no longer a candidate) or beyond 25 m.
// While In_Combat the combat framing widens the distance (Req 21.5). Cinematic and map modes come later.

import type { PerspectiveCamera } from 'three';
import type { Vec2, Vec3 } from '../core/types';
import type { CameraCollision } from './cameraCollision';
import type { CameraCore, CameraRig } from './cameraCore';
import { keepLockTarget, LOCK_SIGHT_RADIUS, pickLockTarget, type LockTargetCandidate } from './lockOn';
import { applyCameraRig } from './threeCamera';

/** Interpolated Active_Character pose: feet position and facing (rad). */
export interface CameraFollowPose {
  readonly pos: Readonly<Vec3>;
  readonly yaw: number;
}

/** Look and wheel input since the last frame, reset by reading (InputState satisfies this). */
export interface CameraLookInput {
  lookDelta(): Vec2;
  wheelDelta(): number;
}

export interface CameraSystemOptions {
  core: CameraCore;
  /** Render camera the rig is copied to. */
  camera: PerspectiveCamera;
  /** Active_Character pose interpolated for the frame's alpha. */
  target: (alpha: number) => CameraFollowPose;
  input: CameraLookInput;
  /** Settings.shake (0..1). Default: always 1, the Settings default. */
  shake?: () => number;
  /** Living enemies (and a fighting boss) with their body centres. Default none: Lock-on always re-centres. */
  lockCandidates?: () => Iterable<LockTargetCandidate>;
  /** Line-of-sight geometry for picking a Lock-on target (terrain, camera-blocking colliders). Default: all visible. */
  collision?: CameraCollision | null;
  /** While In_Combat the combat spread (combatSpread), else null. Default: never in combat. */
  combatSpread?: () => number | null;
  /**
   * Task 20.3: a point to frame this frame (a Landmark's first discovery, LandmarkFraming), or null. Framed like a
   * Lock-on goal while no Lock-on target is held. Default: none.
   */
  framing?: () => Readonly<Vec3> | null;
}

export class CameraSystem {
  private readonly core: CameraCore;
  private readonly camera: PerspectiveCamera;
  private readonly target: (alpha: number) => CameraFollowPose;
  private readonly input: CameraLookInput;
  private readonly shake: () => number;
  private readonly candidates: () => Iterable<LockTargetCandidate>;
  private readonly collision: CameraCollision | null;
  private readonly combatSpread: () => number | null;
  private readonly framing: () => Readonly<Vec3> | null;
  private lastRig: CameraRig | null = null;
  private lastPose: CameraFollowPose | null = null;
  private locked: string | null = null;

  constructor(options: CameraSystemOptions) {
    this.core = options.core;
    this.camera = options.camera;
    this.target = options.target;
    this.input = options.input;
    this.shake = options.shake ?? (() => 1);
    this.candidates = options.lockCandidates ?? (() => []);
    this.collision = options.collision ?? null;
    this.combatSpread = options.combatSpread ?? (() => null);
    this.framing = options.framing ?? (() => null);
  }

  /** Orbit yaw (rad) without shake: the tick's movement and aiming reference. */
  get yaw(): number {
    return this.core.yaw;
  }

  /** Orbit pitch (rad, positive looks down) without shake. */
  get pitch(): number {
    return this.core.pitch;
  }

  /** Opacity for the Active_Character material (near fade, Req 21.4). */
  get characterOpacity(): number {
    return this.core.characterOpacity;
  }

  /** Rig of the last update; null before the first. */
  get rig(): Readonly<CameraRig> | null {
    return this.lastRig;
  }

  /** Lock-on target (Combat aim, HUD target bar and Reaction preview read it), or null. */
  get lockTarget(): string | null {
    return this.locked;
  }

  /**
   * Lock-on input: releases a held lock; otherwise locks the visible candidate within 20 m closest to the view
   * centre, or re-centres the camera behind the character over 0.3 s when there is none (Req 21.6, 21.7).
   */
  lockOn(): void {
    if (this.locked !== null) {
      this.releaseLock();
      return;
    }
    const pose = this.lastPose ?? this.target(1);
    const rig = this.lastRig;
    const eye = rig?.position ?? pose.pos;
    const forward = rig !== null
      ? { x: rig.lookAt.x - rig.position.x, y: rig.lookAt.y - rig.position.y, z: rig.lookAt.z - rig.position.z }
      : { x: Math.sin(this.core.yaw), y: 0, z: Math.cos(this.core.yaw) };
    const collision = this.collision;
    const visible = collision === null
      ? () => true
      : (from: Readonly<Vec3>, to: Readonly<Vec3>) => collision.sweep(from, to, LOCK_SIGHT_RADIUS) === null;
    this.locked = pickLockTarget({ eye, forward }, pose.pos, this.candidates(), visible);
    if (this.locked === null) this.core.recenter(pose.yaw);
  }

  /** Ends the lock (defeat, range, cinematic); no effect without one. */
  releaseLock(): void {
    this.locked = null;
  }

  /** One render frame: consumes this frame's look and wheel input and moves the render camera. */
  update(realDt: number, alpha: number): void {
    const pose = this.target(alpha);
    this.lastPose = pose;
    let lock: Vec3 | null = null;
    if (this.locked !== null) {
      const kept = keepLockTarget(this.locked, pose.pos, this.candidates());
      if (kept === null) this.locked = null;
      else lock = { x: kept.center.x, y: kept.center.y, z: kept.center.z };
    }
    if (lock === null) {
      const framed = this.framing();
      if (framed !== null) lock = { x: framed.x, y: framed.y, z: framed.z };
    }
    const rig = this.core.update({
      realDt,
      characterPos: pose.pos,
      characterYaw: pose.yaw,
      look: this.input.lookDelta(),
      wheel: this.input.wheelDelta(),
      shake: this.shake(),
      lock,
      combatSpread: this.combatSpread(),
      aspect: this.camera.aspect,
    });
    applyCameraRig(this.camera, rig);
    this.lastRig = rig;
  }

  addTrauma(amount: number): void {
    this.core.addTrauma(amount);
  }

  /** The next update skips smoothing (fast travel, recovery, loads). */
  snap(): void {
    this.core.snap();
  }
}
