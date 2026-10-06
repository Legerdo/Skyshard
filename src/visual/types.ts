/*
 * Visual_Provider interfaces (design.md "시각 모델 교체 구조 (Visual_Provider)", Req 43). The rules never see a model:
 * the simulation uses the collision capsule, hit volumes and AttackDefs, and the presentation's EntityView shows the
 * VisualInstance a VisualProvider built from the entity's Visual_Manifest spec.
 *
 * - VisualProvider: one per source kind. `load` resolves to a VisualTemplate (loaded / generated once per entity id).
 * - VisualTemplate: `instantiate()` makes an independent copy (own skeleton, material instance, sockets) that shares
 *   the template's geometry.
 * - VisualInstance: what EntityView holds. `humanoid` exposes the normalized humanoid bones (for the procedural rig the
 *   raw bones themselves: T-pose rest, identity rest world rotations) that the Animation_System and retargeting pose.
 */
import type * as THREE from 'three';
import type { AnimRequest, BlendDef } from '../anim/animator';
import type { PoseClip } from '../anim/clip';
import type { WeaponBuild } from '../anim/rigTypes';
import type { VisualEntityId } from '../data/ids';
import type { HumanoidBoneName, SocketName, VisualSource, VisualSpec } from '../data/visualManifest';

/** Normalized humanoid pose target: local rotations set on these nodes are normalized pose rotations (Req 43.4). */
export interface HumanoidPoseTarget {
  readonly bones: ReadonlyMap<HumanoidBoneName, THREE.Object3D>;
  /** Rest hips height above the feet (m), for the pelvis-height layer and clip hips scaling. */
  readonly restHipsHeight: number;
}

export interface VisualInstance {
  /** Model root: feet at the origin, facing +Z (EntityView places it). */
  readonly root: THREE.Object3D;
  readonly humanoid: HumanoidPoseTarget | null;
  /** Only external models with their own clips (task 19.8); null for procedural rigs. */
  readonly mixer: THREE.AnimationMixer | null;
  readonly sockets: ReadonlyMap<SocketName, THREE.Object3D>;
  /** Model height (m) after normalisation. */
  readonly height: number;
  /** All joints by name (preset joints, sockets, spring joints) for the pose driver and debugging. */
  readonly joints: ReadonlyMap<string, THREE.Object3D>;
  setOpacity(a: number): void;
  /** Additive flash 0–1 (hit flash white; `color` for a hurt tint). */
  setFlash(t: number, color?: THREE.ColorRepresentation): void;
  setExpression(name: 'blink' | 'talk', weight: number): void;
  /** Element glow line strength (`uGlow`; 0.3 idle, 1.0 while casting a Skill / Burst). */
  setGlow(v: number): void;
  /** Death dissolve 0 → 1 (`uDissolve`; `rise`: from the feet up). Optional for adapters without one. */
  setDissolve?(amount: number, rise?: boolean): void;
  /** Weapon between the hand socket and the `back` socket (climb, glide, swim). */
  stowWeapon(onBack: boolean): void;
  /** Springs back to rest (switch, teleport, respawn). */
  resetSecondary(): void;
  /**
   * External models (task 19.8): this frame's clip request, given after the Animator posed `joints` and before
   * `update` — a state mapped to one of the file's clips plays on the mixer, others retarget the pose (humanoid) or
   * get the procedural root animation (generic). Procedural rigs do not need it.
   */
  animate?(dt: number, req: AnimRequest, clips?: { clip(name: string): PoseClip | undefined; readonly blends?: Readonly<Record<string, BlendDef>> }): void;
  /** The procedural weapon the model holds (trail anchors, bow string), if any. */
  readonly weapon?: WeaponBuild | null;
  /** Face, springs (and mixer) in scaled time; `wind` in world m/s. */
  update(dt: number, wind?: Readonly<{ x: number; y: number; z: number }>): void;
  dispose(): void;
}

export interface VisualTemplate {
  readonly kind: VisualSource['kind'];
  readonly height: number;
  instantiate(): VisualInstance;
}

export interface VisualProvider {
  load(id: VisualEntityId, spec: VisualSpec): Promise<VisualTemplate>;
}
