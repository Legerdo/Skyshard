/*
 * Rig kit types (design.md "Rig kit", "Rigid skinning 병합"). A RigSpec describes one procedural model: its preset
 * skeleton, proportions, parts, palette, face and spring chains. `buildRig(spec)` (./rigKit) turns it into one body
 * SkinnedMesh and one outline SkinnedMesh that share a single BufferGeometry and Skeleton (2 draw calls per model).
 */
import type * as THREE from 'three';
import type { SocketName } from '../data/visualManifest';
import type { SpringSystem } from './spring';

export type { SocketName } from '../data/visualManifest';

/** Colour zones of a part; `element` is the Element accent that glows with `uGlow`. */
export const PALETTE_ZONES = ['primary', 'secondary', 'accent', 'skin', 'hair', 'element'] as const;
export type PaletteZone = (typeof PALETTE_ZONES)[number];

export const RIG_PRESETS = ['humanoid', 'quadruped', 'crab', 'stalk', 'floater'] as const;
export type RigPreset = (typeof RIG_PRESETS)[number];

/** [x, y, z] in rig space: metres, feet (or ground contact) at the origin, facing +Z, left = +X. */
export type V3 = readonly [number, number, number];

/** One skeleton joint of a preset layout, at its rest world position (every rest world rotation is identity). */
export interface JointDef {
  readonly name: string;
  readonly parent: string | null;
  readonly pos: V3;
}

/** A spring chain (hair, scarf, ponytail, cape): `segments` bones from `parent`, `segLength` m apart. */
export interface SpringDef {
  readonly id: string;
  /** Joint the chain hangs from (usually head, neck or chest). */
  readonly parent: string;
  /** 4–8. */
  readonly segments: number;
  readonly segLength: number;
  /** First chain joint relative to the parent joint (m); default [0, 0, 0]. */
  readonly offset?: V3;
  /** Rest direction of the chain (normalised on use); default straight down. */
  readonly dir?: V3;
  /** Pull back toward the rest shape per 60 Hz step (0–1); default 0.04. */
  readonly stiffness?: number;
  /** Air drag toward the wind velocity (1/s); default 2.5. */
  readonly drag?: number;
  /** Gravity multiplier; default 1. */
  readonly gravity?: number;
}

/** A spring chain placed in a layout: its joint names (`${id}_${i}`) and rest points. */
export interface ChainLayout {
  readonly def: SpringDef;
  readonly joints: readonly string[];
  /** Rest world position of joint i, plus one tip point after the last joint (length segments + 1). */
  readonly points: readonly V3[];
  /** Unit rest direction. */
  readonly dir: V3;
}

/** A preset skeleton at rest for given proportions (joints in parent-before-child order). */
export interface RigLayout {
  readonly preset: RigPreset;
  readonly height: number;
  /** Preset joints, then socket joints, then spring joints. */
  readonly joints: readonly JointDef[];
  readonly chains: ReadonlyMap<string, ChainLayout>;
  /** Rest world position of a joint (throws for an unknown name). */
  pos(name: string): V3;
  has(name: string): boolean;
  /** Proportions the part builders need (m). */
  readonly dims: RigDims;
}

/** Derived body measurements (m) of a layout. */
export interface RigDims {
  readonly headHeight: number;
  /** Head sphere radius and centre. */
  readonly headRadius: number;
  readonly headCenter: V3;
  /** Half distance between the upper-arm joints (humanoid) or the body half-width (others). */
  readonly shoulderHalf: number;
  readonly hipHalf: number;
  /** Limb thickness scale (1 = the average hero). */
  readonly limb: number;
}

export interface PartDef {
  /** Rig-space (rest) geometry; indexed or not, any attribute set: the kit normalises it. */
  readonly geometry: THREE.BufferGeometry;
  /** Owning joint: every vertex gets weight 1 on it (unless `chain`). */
  readonly joint: string;
  readonly zone: PaletteZone;
  /** Spring chain id: vertices blend between neighbouring chain joints along the chain (smoothstep ±25 %). */
  readonly chain?: string;
  /** Element accent glow strength 0–1 (`aFx.x`), multiplied by `uGlow`. */
  readonly glow?: number;
  /** Face plane: samples the face atlas (`aFx.y = 1`) and collapses in the outline. */
  readonly face?: boolean;
  /** Explicit vertex colour instead of the zone's (e.g. a darker shade of it). */
  readonly color?: number;
}

export interface FaceSpec {
  /** Iris gradient top and bottom colours (0xRRGGBB). */
  readonly irisTop: number;
  readonly irisBottom: number;
  readonly eyeShape: 'round' | 'sharp' | 'soft';
  /** Brow / lash line colour; default a dark brown. */
  readonly lineColor?: number;
}

/**
 * A model-specific joint added after the preset joints (Aether Sentinel's rings, a crab's tail, Caelith's crown): at
 * `pos` in rig space, or `offset` from its parent's rest position. Rest world rotation identity, like every joint.
 */
export interface ExtraJointDef {
  readonly name: string;
  readonly parent: string;
  readonly pos?: V3;
  readonly offset?: V3;
}

/** Humanoid limb length multipliers (Mossback Brute: long arms, short legs); 1 = the common proportions. */
export interface LimbProportions {
  readonly arm?: number;
  readonly leg?: number;
}

export interface RigSpec {
  readonly id: string;
  readonly preset: RigPreset;
  /** Visual height (m); the collision capsule is separate (ADJ-06). */
  readonly height: number;
  /** Body heights per head (6 = 1:6). */
  readonly headRatio: number;
  /** Shoulder width multiplier (1 = average). */
  readonly shoulderScale: number;
  /** Humanoid only: arm / leg length multipliers. */
  readonly proportions?: LimbProportions;
  /** Joints beyond the preset's (added before the sockets and spring chains). */
  readonly extraJoints?: readonly ExtraJointDef[];
  /** Parts, or a builder called with the layout (so parts can follow the joints). */
  readonly parts: readonly PartDef[] | ((layout: RigLayout) => PartDef[]);
  readonly palette: Readonly<Record<PaletteZone, number>>;
  /** Bone the held weapon's socket hangs from (Kairen·Wren rightHand, Isla leftHand, Talus leftLowerArm). */
  readonly weaponParent?: string;
  /** Which socket holds the weapon; default 'weaponR'. */
  readonly weaponSocket?: 'weaponR' | 'weaponL';
  readonly springs: readonly SpringDef[];
  readonly face?: FaceSpec;
  /** Material instance family: 'character' (own face / glow uniforms) or 'enemy'. Default 'character'. */
  readonly material?: 'character' | 'enemy';
  /** Base glow (`uGlow`) at rest; default 0.3. */
  readonly idleGlow?: number;
}

export interface RigBuildOptions {
  /** Build the canvas face atlas (default true; Node tests and headless builds pass false). */
  readonly faceAtlas?: boolean;
  /** Canvas factory for the face atlas (default: document.createElement('canvas') when a DOM exists). */
  readonly canvas?: (width: number, height: number) => HTMLCanvasElement | OffscreenCanvas | null;
}

/** A held weapon: mesh, its outline (a child of the mesh) and the trail anchor points in mesh space. */
export interface WeaponBuild {
  readonly mesh: THREE.Mesh;
  readonly outline: THREE.Mesh;
  /** Blade root and tip (mesh space) for the VFX trail ribbon. */
  readonly anchors: { readonly base: THREE.Vector3; readonly tip: THREE.Vector3 };
  /** Mesh rotation while stored on the `back` socket. */
  readonly backRotation: THREE.Euler;
  /** Mesh position while stored on the `back` socket. */
  readonly backOffset: THREE.Vector3;
  /** Extra per-frame work (the bow string following the drawing hand). */
  update?(drawPoint: THREE.Vector3 | null): void;
  dispose(): void;
}

export interface RigBuild {
  readonly spec: RigSpec;
  readonly layout: RigLayout;
  /** Model root: feet at the origin, facing +Z. Holds the body (bones are its children) and the outline. */
  readonly root: THREE.Group;
  readonly skeleton: THREE.Skeleton;
  readonly body: THREE.SkinnedMesh;
  readonly outline: THREE.SkinnedMesh;
  readonly bones: ReadonlyMap<string, THREE.Bone>;
  readonly sockets: ReadonlyMap<SocketName, THREE.Bone>;
  /** This rig's own toon material instance (face, glow, flash uniforms). */
  readonly material: THREE.MeshToonMaterial;
  /** Current face cell (eye row, mouth column). */
  readonly faceCell: { readonly eye: 0 | 1 | 2; readonly mouth: 0 | 1 | 2 };
  readonly glow: number;
  readonly weapon: WeaponBuild | null;
  /** The rig's spring chains and collision spheres (60 Hz verlet, ./spring). */
  readonly springs: SpringSystem;
  /** Uniforms only: no geometry update, no extra draw call. */
  setFaceCell(eye: 0 | 1 | 2, mouth: 0 | 1 | 2): void;
  setGlow(v: number): void;
  /** Additive flash (hit flash white, hurt red); 0 = off. */
  setFlash(amount: number, color?: THREE.ColorRepresentation): void;
  setOpacity(opacity: number): void;
  /**
   * Death dissolve 0 → 1 (`uDissolve`, discard with a glowing edge; `rise`: from the feet up, Caelith). The outlines
   * and the aura hide while it runs.
   */
  setDissolve(amount: number, rise?: boolean): void;
  readonly dissolve: number;
  /** The Elite aura shell (same geometry and Skeleton, additive fresnel), once attached. */
  readonly aura: THREE.SkinnedMesh | null;
  /** Adds the aura shell (1 draw call) in `color`, pushed `width` m out; again returns the existing one. */
  attachAura(color: THREE.ColorRepresentation, width: number): THREE.SkinnedMesh;
  /** Replaces the weapon socket's children with `mesh` (and its `outline`). */
  attachWeapon(mesh: THREE.Mesh, outline: THREE.Mesh): void;
  /** Holds a built weapon (disposing the previous one) in the weapon socket. */
  equip(weapon: WeaponBuild | null): void;
  /** Moves the weapon between its hand socket and the `back` socket (climb, glide, swim). */
  stowWeapon(onBack: boolean): void;
  /** Frees the rig's material instance and (unless shared) geometry. */
  dispose(): void;
}
