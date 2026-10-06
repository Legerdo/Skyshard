/*
 * External model templates and instances (design.md "시각 모델 교체 구조 (Visual_Provider)", Req 43.2–43.8). A loader
 * (./externalLoaders, ./vrmAdapter) parses a glTF / GLB, FBX or VRM file into a LoadedModel; `buildExternalTemplate`
 * prepares it once per entity id and every `instantiate()` clones it (own skeletons, materials, sockets, mixer).
 *
 * Template build, in order:
 * 1. root → motion → model → file scene. `model` holds the normalisation: the front correction `yawDeg` (VRM 0.x
 *    defaults to 180°, the same turn as VRMUtils.rotateVRM0 and never applied twice), the scale that makes the rest
 *    bounding box `height` tall (default: the procedural model's height; FBX centimetres are absorbed here), the feet
 *    (min y) on the capsule bottom and `offset` (m). `motion` carries the generic models' procedural root animation.
 * 2. Humanoid bones: `boneMap` > VRM humanoid > automatic detection (./boneMap); a missing required bone rejects the
 *    load (the library then warns once and keeps the procedural model, Req 43.7). The table goes to the console once.
 * 3. Rest correction (`restPose` 'A' / per-bone degrees), then the rest info for `retargetPose` (./humanoidRetarget).
 * 4. Pose proxies: a normalized T-pose joint tree (identity rest rotations, joints at the raw bones' rest positions)
 *    under the root with the procedural rig's joint names, so the Animator, the procedural layers and every pose clip
 *    drive it unchanged. Each frame the proxies' rotations are retargeted onto the raw bones (raw = P⁻¹·q·P·R) and the
 *    pelvis-height change moves the raw hips.
 * 5. Sockets: weaponR → rightHand, weaponL → leftHand, back → chest (else spine), headTop → head, or `sockets`
 *    (bone, offset m, rotDeg), each with an identity rest world rotation like the procedural sockets; the heroes' and
 *    Caelith's procedural weapon hangs there unless `hideProceduralWeapon`.
 * 6. Clips: `clips` maps animation states (a clip name such as `kairen_n1` or `walk`, or a state such as `idle`,
 *    `move`, `attack`, `hurt`, `defeat`) to the file's clips, played by an AnimationMixer; the hips' horizontal
 *    translation is dropped (no root motion). A driven clip (attacks) is time-scaled to its AttackDef / pose clip
 *    length, so hits stay where the sim puts them (Req 43.3, 43.5). Switching between a mixer clip and the retargeted
 *    pose blends from a snapshot of the raw bones over the usual 0.1–0.25 s crossfade.
 * 7. States without a clip: humanoid models play the retargeted pose clips; generic models get the procedural root
 *    animation (bob, lean, windup scale, hurt shake, defeat sink) on `motion`.
 * Materials (`toon` / `original`), outlines and the hit flash / opacity / dissolve path live in ./externalMaterials;
 * VRM expressions (blink, talk) and spring bones come from the VRM parts, glTF / FBX expressions from morph targets.
 */
import * as THREE from 'three';
import type { AnimRequest, BlendDef, LayerName, LayerRequest } from '../anim/animator';
import { blendTime } from '../anim/blendTimes';
import { CAELITH_SWORD } from '../anim/caelithRig';
import { playbackRate, type PoseClip } from '../anim/clip';
import { FaceAnimator } from '../anim/face';
import { HERO_LOOKS } from '../anim/heroes';
import { modelRigSpec } from '../anim/models';
import { createRigMaterial, rigUniformsOf } from '../anim/rigMaterial';
import { buildLayout, RIG_HUMANOID_BONES, RIG_SOCKETS, type RigHumanoidBone } from '../anim/rigLayout';
import type { RigLayout, RigSpec, WeaponBuild } from '../anim/rigTypes';
import { createWeapon } from '../anim/weapons';
import { isCharacterId, isEliteId, isEnemyId, isNpcId, type VisualEntityId } from '../data/ids';
import type { ClipRef, ExternalSourceKind, HumanoidBoneName, SocketName, Vec3Tuple, VisualSpec } from '../data/visualManifest';
import { attachOutline, type OutlineTarget } from '../render/outline';
import {
  boneTable, detectHumanoidBones, findNodeByName, formatBoneTable, type BoneMapResult, type BoneNodeInfo, type BoneTableRow,
} from './boneMap';
import {
  applyFx, cloneMaterial, createFxUniforms, externalOutlineMaterial, toToonMaterial, type ExternalFxUniforms,
} from './externalMaterials';
import {
  applyRestCorrection, captureRestInfo, positionInRoot, restCorrections, retargetPose, rotationInRoot,
  type HumanoidRestInfo, type RawBoneRotations,
} from './humanoidRetarget';
import { ModelLoadError } from './modelFormat';
import type { HumanoidPoseTarget, VisualInstance, VisualTemplate } from './types';

// ── Loader output ───────────────────────────────────────────────────────────

/** What a loader hands to the template builder. */
export interface LoadedModel {
  readonly kind: ExternalSourceKind;
  readonly scene: THREE.Object3D;
  readonly animations: readonly THREE.AnimationClip[];
  /** VRM loads only. */
  readonly vrm?: VrmModelInfo;
}

/** The VRM side of a load (./vrmAdapter): humanoid definition, and per-instance springs and expressions. */
export interface VrmModelInfo {
  readonly version: '0' | '1';
  /** VRM humanoid bone → raw node of the loaded scene. */
  readonly humanBones: ReadonlyMap<HumanoidBoneName, THREE.Object3D>;
  /** Nodes an instance clone leaves out (spring colliders, expression nodes, three-vrm's normalized rig). */
  skip(node: THREE.Object3D): boolean;
  /** Springs and expressions over one clone (`map`: loaded node → cloned node). */
  instantiate(map: ReadonlyMap<THREE.Object3D, THREE.Object3D>): VrmInstanceParts;
  dispose(): void;
}

export interface VrmInstanceParts {
  /** Captures the spring rest (the instance assembled at rest, world matrices current). */
  setInitState(): void;
  /** Spring bones, `dt` scaled s. */
  update(dt: number): void;
  reset(): void;
  hasExpression(name: string): boolean;
  setExpression(name: string, weight: number): void;
  dispose(): void;
}

// ── Clip state ──────────────────────────────────────────────────────────────

/** What the instance may ask about the pose clips (AnimatedView passes its Animator and blends). */
export interface ClipContext {
  clip(name: string): PoseClip | undefined;
  readonly blends?: Readonly<Record<string, BlendDef>>;
}

/** The clip the top-most active layer plays this frame. */
export interface ActiveClip {
  readonly layer: LayerName;
  /** Clip name (a blend: its dominant clip). */
  readonly name: string;
  /** Names a manifest `clips` entry may use for it (the clip, the blend, the state). */
  readonly aliases: readonly string[];
  /** Driven clip time (attacks from the sim clock), or null for free-running clips. */
  readonly time: number | null;
  /** Speed parameter (m/s) of a speed-matched clip / blend, or null. */
  readonly speed: number | null;
}

/** The clip of a blend with the most weight at (x, y). */
export function dominantBlendClip(def: BlendDef, x: number, y = 0): string {
  if (def.kind === '1d') {
    let best = def.points[0]!.clip;
    let dist = Infinity;
    for (const p of def.points) {
      const d = Math.abs(p.at - (Number.isFinite(x) ? x : 0));
      if (d < dist) {
        dist = d;
        best = p.clip;
      }
    }
    return best;
  }
  const fx = Number.isFinite(x) ? x : 0;
  const fy = Number.isFinite(y) ? y : 0;
  if (Math.hypot(fx, fy) < 0.35) return def.center;
  if (Math.abs(fx) > Math.abs(fy)) return fx > 0 ? def.right : def.left;
  return fy > 0 ? def.up : def.down;
}

const STATE_SUFFIX = /(?:^|_)(idle|move|walk|run|sprint|hurt|stagger|disabled|defeat|death|windup|charged|skill|burst|n\d)$/;

/** Manifest keys that may name `clip` (most specific first). */
export function stateAliases(clip: string, layer: LayerName, blend?: string): string[] {
  const out = [clip];
  if (blend !== undefined) out.push(blend);
  const kind = STATE_SUFFIX.exec(clip)?.[1];
  switch (kind) {
    case 'idle': out.push('idle'); break;
    case 'move': out.push('move', 'walk'); break;
    case 'walk': out.push('walk', 'move'); break;
    case 'run': out.push('run', 'move'); break;
    case 'sprint': out.push('sprint', 'run', 'move'); break;
    case 'hurt': out.push('hurt'); break;
    case 'stagger':
    case 'disabled': out.push('stagger'); break;
    case 'defeat':
    case 'death': out.push('defeat', 'death'); break;
    case 'windup': out.push('attackWindup', 'windup'); break;
    case 'charged': out.push('chargedAttack', 'attack'); break;
    case 'skill': out.push('skill', 'attack'); break;
    case 'burst': out.push('burst', 'attack'); break;
    case undefined: if (layer === 'action') out.push('attack'); break;
    default: out.push('normalAttack', 'attack');
  }
  return [...new Set(out)];
}

function layerClip(layer: LayerName, req: LayerRequest, blends?: Readonly<Record<string, BlendDef>>): ActiveClip {
  if ('clip' in req) {
    return { layer, name: req.clip, aliases: stateAliases(req.clip, layer), time: req.time ?? null, speed: req.speed ?? null };
  }
  const def = blends?.[req.blend];
  const name = def === undefined ? req.blend : dominantBlendClip(def, req.x, req.y);
  const speed = def?.kind === '1d' ? req.x : req.speed ?? null;
  return { layer, name, aliases: stateAliases(name, layer, req.blend), time: null, speed };
}

/** The top-most active layer's clip: override, then action, then base. */
export function activeClipOf(req: AnimRequest, blends?: Readonly<Record<string, BlendDef>>): ActiveClip | null {
  if (req.override !== null) return layerClip('override', req.override, blends);
  if (req.action !== null) return layerClip('action', req.action, blends);
  return layerClip('base', req.base, blends);
}

// ── Generic procedural root animation ───────────────────────────────────────

export type MotionKind = 'idle' | 'move' | 'windup' | 'attack' | 'hurt' | 'stagger' | 'defeat';

/** The procedural root-motion kind of a clip (from its aliases). */
export function motionKindOf(active: ActiveClip | null): MotionKind {
  if (active === null) return 'idle';
  const a = new Set(active.aliases);
  if (a.has('defeat')) return 'defeat';
  if (a.has('stagger')) return 'stagger';
  if (a.has('hurt')) return 'hurt';
  if (a.has('attackWindup')) return 'windup';
  if (a.has('attack')) return 'attack';
  if (a.has('move') || (active.speed !== null && active.speed > 0.3)) return 'move';
  return 'idle';
}

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;
const clamp01 = (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : x);
const smooth = (x: number): number => { const t = clamp01(x); return t * t * (3 - 2 * t); };

interface MotionPose { y: number; pitch: number; roll: number; sy: number; sxz: number }
const REST_MOTION: MotionPose = { y: 0, pitch: 0, roll: 0, sy: 1, sxz: 1 };

/** Bob, lean, windup scale, hurt shake and defeat sink of a generic model (visual only, on the `motion` node). */
export class GenericMotion {
  private key: string | null = null;
  private t = 0;
  private fadeFrom: MotionPose = { ...REST_MOTION };
  private fade = 1;
  private last: MotionPose = { ...REST_MOTION };

  constructor(private readonly node: THREE.Object3D, private readonly height: number) {
    node.rotation.order = 'YXZ';
  }

  /** The pose applied last (tests). */
  get pose(): Readonly<MotionPose> {
    return this.last;
  }

  /** `active` null → rest (a mixer clip plays, or nothing is requested); `duration` of the pose clip if known. */
  update(dt: number, active: ActiveClip | null, duration: number | null, suppressed: boolean): void {
    const kind = suppressed ? null : motionKindOf(active);
    const key = kind === null ? null : `${kind}:${active?.name ?? ''}`;
    if (key !== this.key) {
      this.fadeFrom = { ...this.last };
      this.fade = 0;
      this.key = key;
      this.t = 0;
    }
    this.t = active !== null && active.time !== null ? active.time : this.t + dt;
    this.fade = Math.min(1, this.fade + dt / 0.15);
    const target = kind === null ? { ...REST_MOTION } : this.targetOf(kind, this.t, duration ?? 1, active?.speed ?? null);
    const w = smooth(this.fade);
    const p: MotionPose = {
      y: this.fadeFrom.y + (target.y - this.fadeFrom.y) * w,
      pitch: this.fadeFrom.pitch + (target.pitch - this.fadeFrom.pitch) * w,
      roll: this.fadeFrom.roll + (target.roll - this.fadeFrom.roll) * w,
      sy: this.fadeFrom.sy + (target.sy - this.fadeFrom.sy) * w,
      sxz: this.fadeFrom.sxz + (target.sxz - this.fadeFrom.sxz) * w,
    };
    this.last = p;
    this.node.position.set(0, p.y, 0);
    this.node.rotation.set(p.pitch, 0, p.roll);
    this.node.scale.set(p.sxz, p.sy, p.sxz);
  }

  private targetOf(kind: MotionKind, t: number, dur: number, speed: number | null): MotionPose {
    const H = this.height;
    const out: MotionPose = { ...REST_MOTION };
    switch (kind) {
      case 'idle':
        out.y = 0.01 * H * Math.sin((TAU * t) / 2.4);
        out.roll = 1.2 * DEG * Math.sin((TAU * t) / 3.1);
        break;
      case 'move': {
        const f = 1.6 * Math.max(0.6, Math.min(2.5, (speed ?? 2) / 2));
        out.y = 0.035 * H * Math.abs(Math.sin(Math.PI * f * t));
        out.pitch = 6 * DEG;
        out.roll = 3 * DEG * Math.sin(Math.PI * f * t);
        break;
      }
      case 'windup': {
        const p = clamp01(t / Math.max(0.05, dur));
        out.sy = 1 + 0.06 * p;
        out.sxz = 1 + 0.04 * p;
        out.pitch = -8 * DEG * p;
        break;
      }
      case 'attack': {
        const p = clamp01(t / 0.35);
        out.pitch = 14 * DEG * Math.sin(Math.PI * p);
        out.sy = 1 - 0.04 * Math.sin(Math.PI * p);
        break;
      }
      case 'hurt':
        out.roll = 7 * DEG * Math.exp(-t / 0.12) * Math.sin(55 * t);
        out.pitch = -6 * DEG * Math.exp(-t / 0.15);
        break;
      case 'stagger':
        out.roll = 9 * DEG * Math.sin(TAU * 1.6 * t);
        out.y = -0.02 * H;
        break;
      case 'defeat': {
        const p = clamp01(t / Math.max(0.2, dur));
        out.y = -0.35 * H * p * p;
        out.roll = 25 * DEG * p;
        out.sy = 1 - 0.1 * p;
        break;
      }
    }
    return out;
  }
}

// ── Cloning ─────────────────────────────────────────────────────────────────

/**
 * Deep clone with a node map (loaded → clone), skipping `skip` subtrees, skinned meshes rebound to cloned bones (as
 * SkeletonUtils.clone does); VRM helper nodes that cannot be cloned are left out through `skip`.
 */
export function cloneWithMap(source: THREE.Object3D, skip: (node: THREE.Object3D) => boolean = () => false): {
  root: THREE.Object3D; map: Map<THREE.Object3D, THREE.Object3D>;
} {
  const map = new Map<THREE.Object3D, THREE.Object3D>();
  const visit = (node: THREE.Object3D): THREE.Object3D => {
    const copy = node.clone(false);
    map.set(node, copy);
    for (const child of node.children) if (!skip(child)) copy.add(visit(child));
    return copy;
  };
  const root = visit(source);
  for (const [src, copy] of map) {
    if (!(src instanceof THREE.SkinnedMesh) || !(copy instanceof THREE.SkinnedMesh)) continue;
    const skeleton = src.skeleton.clone();
    skeleton.bones = src.skeleton.bones.map((b) => (map.get(b) as THREE.Bone | undefined) ?? b);
    copy.bindMatrix.copy(src.bindMatrix);
    copy.bind(skeleton, copy.bindMatrix);
  }
  return { root, map };
}

// ── Template ────────────────────────────────────────────────────────────────

interface ProxyDef {
  readonly name: string;
  readonly parent: string | null;
  /** Root-frame rest position (m). */
  readonly pos: THREE.Vector3;
}

interface MappedClip {
  readonly clip: THREE.AnimationClip;
  readonly speed: number;
  readonly loop: boolean | null;
}

interface SocketDef {
  readonly parent: THREE.Object3D;
  readonly matrix: THREE.Matrix4;
}

export interface ExternalTemplateOptions {
  /** Non-fatal problems (unknown clip names, socket bones); default console.warn. */
  readonly warn?: (message: string) => void;
  /** The bone table (once per template); default console.info. */
  readonly log?: (message: string) => void;
}

const HUMANOID_RIG_PARENT: Readonly<Record<RigHumanoidBone, RigHumanoidBone | null>> = {
  hips: null, spine: 'hips', chest: 'spine', neck: 'chest', head: 'neck',
  leftShoulder: 'chest', leftUpperArm: 'leftShoulder', leftLowerArm: 'leftUpperArm', leftHand: 'leftLowerArm',
  rightShoulder: 'chest', rightUpperArm: 'rightShoulder', rightLowerArm: 'rightUpperArm', rightHand: 'rightLowerArm',
  leftUpperLeg: 'hips', leftLowerLeg: 'leftUpperLeg', leftFoot: 'leftLowerLeg',
  rightUpperLeg: 'hips', rightLowerLeg: 'rightUpperLeg', rightFoot: 'rightLowerLeg',
};
const RIG_HUMANOID_SET: ReadonlySet<string> = new Set(RIG_HUMANOID_BONES);
const SOCKET_SET: ReadonlySet<string> = new Set(RIG_SOCKETS);

const v3 = (t: Vec3Tuple | readonly [number, number, number]): THREE.Vector3 => new THREE.Vector3(t[0], t[1], t[2]);

function outlineTargetOf(id: VisualEntityId): OutlineTarget {
  if (id === 'caelith') return 'caelith';
  if (isNpcId(id)) return 'npc';
  if (isEnemyId(id) || isEliteId(id)) return 'enemy';
  return 'character';
}

function findClip(animations: readonly THREE.AnimationClip[], name: string): THREE.AnimationClip | undefined {
  const lower = name.toLowerCase();
  return animations.find((c) => c.name === name)
    ?? animations.find((c) => c.name.toLowerCase() === lower)
    ?? animations.find((c) => c.name.toLowerCase().endsWith(`|${lower}`));
}

/** `clip` without the horizontal translation of `node`'s position track (the model never root-moves). */
function withoutRootMotion(clip: THREE.AnimationClip, node: THREE.Object3D | null): THREE.AnimationClip {
  const out = clip.clone();
  if (node === null) return out;
  for (const track of out.tracks) {
    const parsed = THREE.PropertyBinding.parseTrackName(track.name);
    if (parsed.propertyName !== 'position' || parsed.nodeName !== node.name) continue;
    const values = track.values;
    for (let i = 0; i + 2 < values.length; i += 3) {
      values[i] = node.position.x;
      values[i + 2] = node.position.z;
    }
  }
  return out;
}

/** Everything an instance needs, prepared once per entity. */
export class ExternalVisualTemplate implements VisualTemplate {
  readonly kind: ExternalSourceKind;
  readonly height: number;
  /** Material mode and outline after defaults (VRM: original; glTF / FBX: toon with outline). */
  readonly materials: 'toon' | 'original';
  readonly outline: boolean;
  /** root → motion → model → scene, normalised, at rest. */
  readonly root = new THREE.Group();
  readonly motion = new THREE.Group();
  readonly model = new THREE.Group();
  readonly scene: THREE.Object3D;
  readonly nodes: readonly THREE.Object3D[];
  readonly nodeInfo: readonly BoneNodeInfo[];
  /** Bone detection result and its table (humanoid rigs; generic: detection for display only). */
  readonly bones: BoneMapResult;
  readonly boneRows: readonly BoneTableRow[];
  readonly humanoidNodes: ReadonlyMap<HumanoidBoneName, THREE.Object3D> | null;
  readonly rest: HumanoidRestInfo | null;
  readonly yawDeg: number;
  readonly scale: number;
  /** Non-fatal problems found while preparing (also sent to `warn`). */
  readonly warnings: string[] = [];
  readonly clips = new Map<string, MappedClip>();
  readonly rigSpec: RigSpec;
  private readonly proxyDefs: ProxyDef[] = [];
  private readonly socketDefs = new Map<SocketName, SocketDef>();
  private readonly hips: { node: THREE.Object3D; restLocal: THREE.Vector3; restRoot: THREE.Vector3; parentInv: THREE.Matrix4 } | null = null;
  private readonly warnSink: (message: string) => void;

  constructor(readonly id: VisualEntityId, readonly spec: VisualSpec, readonly loaded: LoadedModel, options: ExternalTemplateOptions = {}) {
    this.warnSink = options.warn ?? ((m) => console.warn(m));
    this.kind = loaded.kind;
    this.scene = loaded.scene;
    this.rigSpec = modelRigSpec(id);
    this.materials = spec.materials ?? (loaded.kind === 'vrm' ? 'original' : 'toon');
    this.outline = spec.outline ?? this.materials === 'toon';
    this.root.name = `external:${id}`;
    this.motion.name = 'motion';
    this.model.name = 'model';
    this.root.add(this.motion);
    this.motion.add(this.model);
    this.model.add(loaded.scene);
    // 1. Front correction first (the rest correction and all rest data are in the +Z-facing root frame).
    this.yawDeg = spec.yawDeg ?? (loaded.vrm?.version === '0' ? 180 : 0);
    this.model.rotation.y = this.yawDeg * DEG;
    this.root.updateMatrixWorld(true);
    // 2. Bones.
    const nodes: THREE.Object3D[] = [];
    const index = new Map<THREE.Object3D, number>();
    loaded.scene.traverse((o) => {
      index.set(o, nodes.length);
      nodes.push(o);
    });
    this.nodes = nodes;
    this.nodeInfo = nodes.map((o) => ({
      name: o.name, parent: o.parent !== null && index.has(o.parent) ? index.get(o.parent)! : -1, isBone: (o as THREE.Bone).isBone === true,
    }));
    const vrmIndices = new Map<HumanoidBoneName, number>();
    for (const [bone, node] of loaded.vrm?.humanBones ?? []) {
      const i = index.get(node);
      if (i !== undefined) vrmIndices.set(bone, i);
    }
    this.bones = detectHumanoidBones(this.nodeInfo, { manual: spec.boneMap, vrm: loaded.vrm === undefined ? undefined : vrmIndices });
    this.boneRows = boneTable(this.nodeInfo, this.bones);
    const humanoid = spec.rig === 'humanoid';
    if (humanoid && this.bones.missing.length > 0) {
      const extra = this.bones.problems.length > 0 ? `; ${this.bones.problems.join('; ')}` : '';
      throw new ModelLoadError(`missing humanoid bones: ${this.bones.missing.join(', ')}${extra}`);
    }
    for (const p of this.bones.problems) this.problem(`visual ${id}: ${p}`);
    (options.log ?? ((m) => console.info(m)))(`visual ${id} (${loaded.kind}, ${spec.rig}): ${humanoid ? formatBoneTable(this.boneRows) : 'generic rig'}`);
    let humanoidNodes: Map<HumanoidBoneName, THREE.Object3D> | null = null;
    if (humanoid) {
      humanoidNodes = new Map();
      for (const [bone, i] of this.bones.map) humanoidNodes.set(bone, nodes[i]!);
      // 3. Rest correction (A-pose / per-bone degrees) before any rest data.
      applyRestCorrection(this.root, humanoidNodes, restCorrections(spec.restPose));
    }
    this.humanoidNodes = humanoidNodes;
    // Height, feet and offset from the rest bounding box (skinned vertices included).
    this.root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(this.model, true);
    if (box.isEmpty() || !(box.max.y - box.min.y > 1e-6)) throw new ModelLoadError('the model has no visible mesh');
    this.height = spec.height ?? this.rigSpec.height;
    this.scale = this.height / (box.max.y - box.min.y);
    const offset = spec.offset ?? [0, 0, 0];
    this.model.scale.setScalar(this.scale);
    this.model.position.set(offset[0], -box.min.y * this.scale + offset[1], offset[2]);
    this.root.updateMatrixWorld(true);
    this.rest = humanoidNodes === null ? null : captureRestInfo(this.root, humanoidNodes);
    // Meshes: shadows, generous bounds for posed limbs (culling), computed once and copied by the clones.
    loaded.scene.traverse((o) => {
      if ((o as THREE.Mesh).isMesh !== true) return;
      o.castShadow = true;
      if (o instanceof THREE.SkinnedMesh) {
        o.computeBoundingSphere();
        if (o.boundingSphere !== null) o.boundingSphere.radius *= 1.5;
      }
    });
    // 4. Proxies, hips; 5. sockets; 6. clips.
    let layout: RigLayout | null = null;
    try {
      layout = buildLayout(this.rigSpec);
    } catch {
      layout = null;
    }
    this.buildProxies(layout, humanoidNodes);
    if (humanoidNodes !== null) {
      const hips = humanoidNodes.get('hips')!;
      const parentMatrix = hips.parent === null || hips.parent === this.root
        ? new THREE.Matrix4()
        : new THREE.Matrix4().multiplyMatrices(new THREE.Matrix4().copy(this.root.matrixWorld).invert(), hips.parent.matrixWorld);
      this.hips = {
        node: hips, restLocal: hips.position.clone(), restRoot: positionInRoot(hips, this.root), parentInv: parentMatrix.invert(),
      };
    }
    this.buildSockets(layout, humanoidNodes);
    this.buildClips(humanoidNodes?.get('hips') ?? null);
  }

  private problem(message: string): void {
    this.warnings.push(message);
    this.warnSink(message);
  }

  /** The normalized joint tree the Animator drives (humanoid bones at the raw rest positions). */
  private buildProxies(layout: RigLayout | null, humanoid: ReadonlyMap<HumanoidBoneName, THREE.Object3D> | null): void {
    const ratio = layout === null ? 1 : this.height / layout.height;
    const scaled = (name: string): THREE.Vector3 => (layout !== null && layout.has(name) ? v3(layout.pos(name)).multiplyScalar(ratio) : new THREE.Vector3());
    const defs = new Map<string, ProxyDef>();
    const add = (name: string, parent: string | null, pos: THREE.Vector3): void => {
      if (defs.has(name)) return;
      const def = { name, parent, pos };
      defs.set(name, def);
      this.proxyDefs.push(def);
    };
    add('root', null, new THREE.Vector3());
    if (humanoid !== null) {
      const at = new Map<RigHumanoidBone, THREE.Vector3>();
      for (const bone of RIG_HUMANOID_BONES) {
        const node = humanoid.get(bone);
        if (node !== undefined) at.set(bone, positionInRoot(node, this.root));
      }
      const lerp = (a: THREE.Vector3, b: THREE.Vector3, t: number): THREE.Vector3 => a.clone().lerp(b, t);
      // Unmapped optional bones between their neighbours.
      if (!at.has('chest')) at.set('chest', lerp(at.get('spine')!, (humanoid.has('neck') ? at.get('neck') : undefined) ?? at.get('head')!, 0.45));
      if (!at.has('neck')) at.set('neck', lerp(at.get('chest')!, at.get('head')!, 0.65));
      for (const side of ['left', 'right'] as const) {
        const shoulder = `${side}Shoulder` as const;
        if (at.has(shoulder)) continue;
        const arm = at.get(`${side}UpperArm`)!;
        const chest = at.get('chest')!;
        at.set(shoulder, lerp(new THREE.Vector3(chest.x, arm.y, chest.z), arm, 0.25));
      }
      for (const bone of RIG_HUMANOID_BONES) add(bone, HUMANOID_RIG_PARENT[bone] ?? 'root', at.get(bone)!);
    }
    // Every other joint of the procedural layout (spring chains, extra joints; generic: all), scaled to the height.
    for (const joint of layout?.joints ?? []) {
      if (joint.name === 'root' || SOCKET_SET.has(joint.name) || defs.has(joint.name)) continue;
      const parent = joint.parent !== null && defs.has(joint.parent) ? joint.parent : 'root';
      const base = defs.get(parent)!.pos;
      const rel = scaled(joint.name).sub(joint.parent !== null ? scaled(joint.parent) : new THREE.Vector3());
      add(joint.name, parent, parent === joint.parent ? base.clone().add(rel) : scaled(joint.name));
    }
  }

  private socketParent(name: SocketName, bone: string, humanoid: ReadonlyMap<HumanoidBoneName, THREE.Object3D> | null): THREE.Object3D | null {
    const human = humanoid?.get(bone as HumanoidBoneName);
    if (human !== undefined) return human;
    const i = findNodeByName(this.nodeInfo, bone);
    if (i >= 0) return this.nodes[i]!;
    this.problem(`visual ${this.id}: sockets.${name}.bone '${bone}' is not a bone of the model; using the default`);
    return null;
  }

  private buildSockets(layout: RigLayout | null, humanoid: ReadonlyMap<HumanoidBoneName, THREE.Object3D> | null): void {
    const H = this.height;
    const rootInv = new THREE.Matrix4().copy(this.root.matrixWorld).invert();
    const ratio = layout === null ? 1 : H / layout.height;
    for (const name of RIG_SOCKETS) {
      const custom = this.spec.sockets?.[name];
      let parent: THREE.Object3D | null = null;
      let offset = new THREE.Vector3();
      let rot = new THREE.Quaternion();
      if (custom !== undefined) {
        parent = this.socketParent(name, custom.bone, humanoid);
        if (custom.offset !== undefined) offset = v3(custom.offset);
        if (custom.rotDeg !== undefined) rot = new THREE.Quaternion().setFromEuler(new THREE.Euler(custom.rotDeg[0] * DEG, custom.rotDeg[1] * DEG, custom.rotDeg[2] * DEG, 'XYZ'));
      }
      if (parent === null && humanoid !== null) {
        // Defaults: the procedural rig's socket offsets for this height.
        const head = humanoid.get('head')!;
        switch (name) {
          case 'weaponR': parent = humanoid.get('rightHand')!; offset = new THREE.Vector3(-0.03 * H, -0.008 * H, 0); break;
          case 'weaponL': parent = humanoid.get('leftHand')!; offset = new THREE.Vector3(0.03 * H, -0.008 * H, 0); break;
          case 'back': parent = humanoid.get('chest') ?? humanoid.get('upperChest') ?? humanoid.get('spine')!; offset = new THREE.Vector3(0, 0.02 * H, -0.1 * H); break;
          case 'headTop': parent = head; offset = new THREE.Vector3(0, 1.01 * H - positionInRoot(head, this.root).y, 0); break;
        }
      }
      let desired: THREE.Matrix4;
      if (parent === null) {
        // Generic model: the procedural socket position (scaled), riding on `motion`.
        parent = this.motion;
        const at = layout !== null && layout.has(name) ? v3(layout.pos(name)).multiplyScalar(ratio) : new THREE.Vector3(0, name === 'headTop' ? H : 0.5 * H, 0);
        desired = new THREE.Matrix4().compose(at.add(offset), rot, new THREE.Vector3(1, 1, 1));
      } else {
        desired = new THREE.Matrix4().compose(positionInRoot(parent, this.root).add(offset), rot, new THREE.Vector3(1, 1, 1));
      }
      // Local = parentRootFrame⁻¹ · desired (identity rest world rotation, unit world scale).
      const parentRoot = new THREE.Matrix4().multiplyMatrices(rootInv, parent.matrixWorld);
      this.socketDefs.set(name, { parent, matrix: parentRoot.invert().multiply(desired) });
    }
  }

  private buildClips(hips: THREE.Object3D | null): void {
    const clips = this.spec.clips;
    if (clips === undefined) return;
    // Generic models: the shallowest node with a position track stands in for the hips.
    let rootNode = hips;
    if (rootNode === null) {
      const depth = (o: THREE.Object3D): number => { let d = 0; for (let p = o.parent; p !== null; p = p.parent) d++; return d; };
      let best: THREE.Object3D | null = null;
      for (const clip of this.loaded.animations) {
        for (const track of clip.tracks) {
          const parsed = THREE.PropertyBinding.parseTrackName(track.name);
          if (parsed.propertyName !== 'position') continue;
          const node = this.scene.getObjectByName(parsed.nodeName);
          if (node !== undefined && (best === null || depth(node) < depth(best))) best = node;
        }
      }
      rootNode = best;
    }
    for (const [state, ref] of Object.entries(clips) as [string, ClipRef | undefined][]) {
      if (ref === undefined) continue;
      const name = typeof ref === 'string' ? ref : ref.name;
      const clip = findClip(this.loaded.animations, name);
      if (clip === undefined) {
        const known = this.loaded.animations.map((c) => c.name).join(', ') || 'none';
        this.problem(`visual ${this.id}: clips.${state}: no clip '${name}' in the file (${known})`);
        continue;
      }
      this.clips.set(state, {
        clip: withoutRootMotion(clip, rootNode),
        speed: typeof ref === 'string' ? 1 : ref.speed ?? 1,
        loop: typeof ref === 'string' ? null : ref.loop ?? null,
      });
    }
  }

  /** The mapped clip of a state (its aliases in order), or null. */
  clipFor(active: ActiveClip | null): MappedClip | null {
    if (active === null || this.clips.size === 0) return null;
    for (const alias of active.aliases) {
      const hit = this.clips.get(alias);
      if (hit !== undefined) return hit;
    }
    return null;
  }

  instantiate(): ExternalVisualInstance {
    const skip = this.loaded.vrm === undefined ? undefined : (o: THREE.Object3D) => this.loaded.vrm!.skip(o);
    const { root, map } = cloneWithMap(this.root, skip);
    return new ExternalVisualInstance(this, root as THREE.Group, map, this.proxyDefs, this.socketDefs, this.hips);
  }

  dispose(): void {
    this.loaded.vrm?.dispose();
    const textures = new Set<THREE.Texture>();
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh !== true) return;
      mesh.geometry.dispose();
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        for (const value of Object.values(m)) if (value instanceof THREE.Texture) textures.add(value);
        m.dispose();
      }
    });
    for (const t of textures) t.dispose();
  }
}

/** Builds the template of a loaded model (throws ModelLoadError: missing required bones, no mesh). */
export function buildExternalTemplate(id: VisualEntityId, spec: VisualSpec, loaded: LoadedModel, options?: ExternalTemplateOptions): ExternalVisualTemplate {
  return new ExternalVisualTemplate(id, spec, loaded, options);
}

// ── Instance ────────────────────────────────────────────────────────────────

const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();

/** Weapon of heroes and Caelith, drawn with a rig material instance (glow line, flash). */
function proceduralWeapon(id: VisualEntityId, spec: RigSpec): { weapon: WeaponBuild; material: THREE.MeshToonMaterial } | null {
  const params = isCharacterId(id) ? HERO_LOOKS[id].weapon : id === 'caelith' ? CAELITH_SWORD : null;
  if (params === null) return null;
  const material = createRigMaterial({ kind: 'character', glowColor: spec.palette.element, glow: spec.idleGlow ?? 0.3, height: spec.height });
  material.name = `toon:weapon:${id}`;
  return { weapon: createWeapon(params, spec.palette, material), material };
}

export class ExternalVisualInstance implements VisualInstance {
  readonly root: THREE.Group;
  readonly humanoid: HumanoidPoseTarget | null;
  readonly mixer: THREE.AnimationMixer | null;
  readonly sockets: ReadonlyMap<SocketName, THREE.Object3D>;
  readonly joints: ReadonlyMap<string, THREE.Object3D>;
  readonly height: number;
  /** The file scene of this instance (mixer root). */
  readonly scene: THREE.Object3D;
  readonly fx: ExternalFxUniforms;
  readonly face: FaceAnimator | null;
  readonly vrm: VrmInstanceParts | null;
  /** Raw humanoid bones of this clone. */
  readonly rawBones: ReadonlyMap<HumanoidBoneName, THREE.Object3D>;
  private readonly motion: THREE.Object3D;
  private readonly generic: GenericMotion | null;
  private readonly materialsList: THREE.Material[] = [];
  private readonly baseTransparent = new Map<THREE.Material, boolean>();
  private readonly outlines: THREE.Mesh[] = [];
  private readonly pose = new Map<HumanoidBoneName, THREE.Quaternion>();
  private readonly raw: RawBoneRotations = new Map();
  private readonly proxyHips: THREE.Object3D | null;
  private readonly proxyHipsRest = new THREE.Vector3();
  private readonly hips: { node: THREE.Object3D; restLocal: THREE.Vector3; restRoot: THREE.Vector3; parentInv: THREE.Matrix4 } | null;
  private readonly weaponBuild: { weapon: WeaponBuild; material: THREE.MeshToonMaterial } | null;
  private readonly weaponSocket: SocketName;
  private readonly morphs = new Map<'blink' | 'talk', { mesh: THREE.Mesh; index: number }[]>();
  private readonly expressionNames: { blink: string; talk: string };
  private pending: { req: AnimRequest; ctx: ClipContext | null } | null = null;
  private modeKey: string | null = null;
  private modeLabel: string | null = null;
  private action: THREE.AnimationAction | null = null;
  private fade: { snapshot: THREE.Quaternion[]; hips: THREE.Vector3 | null; elapsed: number; duration: number } | null = null;
  private onBack = false;
  private opacityValue = 1;
  private dissolveValue = 0;
  private blinkWeight = 0;
  private disposed = false;

  constructor(
    readonly template: ExternalVisualTemplate,
    root: THREE.Group,
    map: ReadonlyMap<THREE.Object3D, THREE.Object3D>,
    proxyDefs: readonly ProxyDef[],
    socketDefs: ReadonlyMap<SocketName, SocketDef>,
    hips: { node: THREE.Object3D; restLocal: THREE.Vector3; restRoot: THREE.Vector3; parentInv: THREE.Matrix4 } | null,
  ) {
    const id = template.id;
    this.root = root;
    this.root.userData.visualEntity = id;
    this.height = template.height;
    this.scene = map.get(template.scene)!;
    this.motion = map.get(template.motion)!;
    this.fx = createFxUniforms(this.height);
    // Materials: per-instance copies (toon or original) with the shared effect path; outlines.
    const toon = template.materials === 'toon';
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh !== true) return;
      const convert = (m: THREE.Material): THREE.Material => {
        const next = toon ? toToonMaterial(m, mesh.geometry) : cloneMaterial(m);
        applyFx(next, this.fx);
        this.materialsList.push(next);
        this.baseTransparent.set(next, next.transparent);
        return next;
      };
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(convert) : convert(mesh.material);
    });
    if (template.outline) {
      const target = outlineTargetOf(id);
      const meshes: THREE.Mesh[] = [];
      this.scene.traverse((o) => { if ((o as THREE.Mesh).isMesh === true) meshes.push(o as THREE.Mesh); });
      for (const mesh of meshes) {
        const outline = attachOutline(mesh, target, { material: externalOutlineMaterial() });
        // The outline shares the body's morph weights (blink) and posed bounds.
        if (mesh.morphTargetInfluences !== undefined) outline.morphTargetInfluences = mesh.morphTargetInfluences;
        if (mesh instanceof THREE.SkinnedMesh && outline instanceof THREE.SkinnedMesh) outline.boundingSphere = mesh.boundingSphere?.clone() ?? null;
        this.outlines.push(outline);
      }
    }
    // Humanoid raw bones and the pose proxies.
    const rawBones = new Map<HumanoidBoneName, THREE.Object3D>();
    for (const [bone, node] of template.humanoidNodes ?? []) {
      const clone = map.get(node);
      if (clone !== undefined) rawBones.set(bone, clone);
    }
    this.rawBones = rawBones;
    const proxyRoot = new THREE.Group();
    proxyRoot.name = 'proxies';
    (template.humanoidNodes === null ? this.motion : this.root).add(proxyRoot);
    const proxies = new Map<string, THREE.Object3D>();
    for (const def of proxyDefs) {
      const node = new THREE.Object3D();
      node.name = def.name;
      const parent = def.parent === null ? null : proxies.get(def.parent) ?? null;
      const parentPos = def.parent === null ? new THREE.Vector3() : proxyDefs.find((d) => d.name === def.parent)?.pos ?? new THREE.Vector3();
      node.position.copy(def.pos).sub(parentPos);
      (parent ?? proxyRoot).add(node);
      proxies.set(def.name, node);
    }
    const joints = new Map<string, THREE.Object3D>(proxies);
    if (template.humanoidNodes !== null) {
      const bones = new Map<HumanoidBoneName, THREE.Object3D>();
      for (const bone of RIG_HUMANOID_BONES) {
        const proxy = proxies.get(bone)!;
        bones.set(bone, proxy);
        this.pose.set(bone, proxy.quaternion);
      }
      this.proxyHips = proxies.get('hips')!;
      this.proxyHipsRest.copy(this.proxyHips.position);
      this.humanoid = { bones, restHipsHeight: this.proxyHips.position.y };
      this.hips = hips === null ? null : { ...hips, node: map.get(hips.node) ?? hips.node };
      this.generic = null;
    } else {
      this.proxyHips = null;
      this.humanoid = null;
      this.hips = null;
      this.generic = new GenericMotion(this.motion, this.height);
    }
    // Sockets on the cloned bones.
    const sockets = new Map<SocketName, THREE.Object3D>();
    for (const [name, def] of socketDefs) {
      const socket = new THREE.Object3D();
      socket.name = `socket:${name}`;
      def.matrix.decompose(socket.position, socket.quaternion, socket.scale);
      (map.get(def.parent) ?? this.motion).add(socket);
      sockets.set(name, socket);
      joints.set(name, socket);
    }
    this.sockets = sockets;
    this.joints = joints;
    // Weapon.
    this.weaponSocket = template.rigSpec.weaponSocket ?? 'weaponR';
    this.weaponBuild = template.spec.hideProceduralWeapon === true ? null : proceduralWeapon(id, template.rigSpec);
    if (this.weaponBuild !== null) {
      const { weapon } = this.weaponBuild;
      if (weapon.outline.parent !== weapon.mesh) weapon.mesh.add(weapon.outline);
      sockets.get(this.weaponSocket)?.add(weapon.mesh);
    }
    // Mixer.
    this.mixer = template.clips.size > 0 ? new THREE.AnimationMixer(this.scene) : null;
    // VRM springs and expressions, then the face timing.
    this.root.updateMatrixWorld(true);
    this.vrm = template.loaded.vrm?.instantiate(map) ?? null;
    this.vrm?.setInitState();
    const names = template.spec.expressions ?? {};
    this.expressionNames = { blink: names.blink ?? 'blink', talk: names.talk ?? 'aa' };
    this.collectMorphs(names);
    const hasFace = this.vrm !== null
      ? this.vrm.hasExpression(this.expressionNames.blink) || this.vrm.hasExpression(this.expressionNames.talk)
      : this.morphs.size > 0;
    this.face = hasFace ? new FaceAnimator(`face:${id}`, (eye, mouth) => this.applyFace(eye / 2, mouth / 2)) : null;
  }

  /** glTF / FBX expressions: morph targets named by `expressions`, else a blink / mouth-open target found by name. */
  private collectMorphs(names: { blink?: string; talk?: string }): void {
    if (this.template.loaded.vrm !== undefined) return;
    const blinkRe = names.blink === undefined ? /blink|eye.?clos|close.?eye/i : null;
    const talkRe = names.talk === undefined ? /^(aa|a|mouth.?open|jaw.?open|vrc\.v_aa|fcl_mth_a)$/i : null;
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      const dict = mesh.morphTargetDictionary;
      if (mesh.isMesh !== true || dict === undefined) return;
      for (const [key, index] of Object.entries(dict)) {
        for (const [slot, name, re] of [['blink', names.blink, blinkRe], ['talk', names.talk, talkRe]] as const) {
          if (name !== undefined ? key === name : re !== null && re.test(key)) {
            const list = this.morphs.get(slot) ?? [];
            if (!list.some((m) => m.mesh === mesh)) list.push({ mesh, index });
            this.morphs.set(slot, list);
          }
        }
      }
    });
  }

  private applyFace(blink: number, talk: number): void {
    if (this.vrm !== null) {
      this.vrm.setExpression(this.expressionNames.blink, blink);
      this.vrm.setExpression(this.expressionNames.talk, talk);
      return;
    }
    for (const [slot, value] of [['blink', blink], ['talk', talk]] as const) {
      for (const m of this.morphs.get(slot) ?? []) if (m.mesh.morphTargetInfluences !== undefined) m.mesh.morphTargetInfluences[m.index] = value;
    }
  }

  get weapon(): WeaponBuild | null {
    return this.weaponBuild?.weapon ?? null;
  }

  /** The mixer action playing now (tests, model-lab). */
  get currentAction(): THREE.AnimationAction | null {
    return this.action;
  }

  /** 'pose' (retargeted pose clips / generic motion) or 'mixer:<clip>' (tests, model-lab). */
  get mode(): string | null {
    return this.modeKey;
  }

  setOpacity(a: number): void {
    const next = Number.isFinite(a) ? Math.min(1, Math.max(0, a)) : 1;
    if (next === this.opacityValue) return;
    this.opacityValue = next;
    this.fx.uFxOpacity.value = next;
    for (const m of this.materialsList) {
      const transparent = (this.baseTransparent.get(m) ?? false) || next < 1;
      if (m.transparent !== transparent) {
        m.transparent = transparent;
        m.needsUpdate = true;
      }
    }
    const w = this.weaponBuild?.material;
    if (w !== undefined) {
      w.opacity = next;
      if (w.transparent !== next < 1) {
        w.transparent = next < 1;
        w.needsUpdate = true;
      }
    }
    this.refreshOutlines();
  }

  setFlash(t: number, color: THREE.ColorRepresentation = 0xffffff): void {
    const amount = Number.isFinite(t) ? Math.max(0, t) : 0;
    this.fx.uFxFlash.value = amount;
    this.fx.uFxFlashColor.value.set(color);
    const u = this.weaponBuild === null ? undefined : rigUniformsOf(this.weaponBuild.material);
    if (u !== undefined) {
      u.uFlash.value = amount;
      u.uFlashColor.value.set(color);
    }
  }

  setDissolve(amount: number, rise = false): void {
    const next = Number.isFinite(amount) ? Math.min(1, Math.max(0, amount)) : 0;
    this.fx.uFxDissolve.value = next;
    this.fx.uFxDissolveRise.value = rise ? 1 : 0;
    const u = this.weaponBuild === null ? undefined : rigUniformsOf(this.weaponBuild.material);
    if (u !== undefined) {
      u.uDissolve.value = next;
      u.uDissolveRise.value = rise ? 1 : 0;
    }
    this.dissolveValue = next;
    this.refreshOutlines();
  }

  private refreshOutlines(): void {
    const solid = this.opacityValue >= 1 && this.dissolveValue <= 0;
    for (const o of this.outlines) o.visible = solid;
    if (this.weaponBuild !== null) this.weaponBuild.weapon.outline.visible = solid;
  }

  /** blink ≥ 0.5 starts one blink; talk > 0 moves the mouth (like the procedural face). */
  setExpression(name: 'blink' | 'talk', weight: number): void {
    if (this.face === null) return;
    if (name === 'talk') this.face.talking = weight > 0;
    else {
      if (weight >= 0.5 && this.blinkWeight < 0.5) this.face.blink();
      this.blinkWeight = weight;
    }
  }

  setGlow(v: number): void {
    const u = this.weaponBuild === null ? undefined : rigUniformsOf(this.weaponBuild.material);
    if (u !== undefined) u.uGlow.value = Number.isFinite(v) ? Math.max(0, v) : 0;
  }

  stowWeapon(onBack: boolean): void {
    const weapon = this.weaponBuild?.weapon;
    if (weapon === undefined || onBack === this.onBack) return;
    const target = this.sockets.get(onBack ? 'back' : this.weaponSocket);
    if (target === undefined) return;
    this.onBack = onBack;
    target.add(weapon.mesh);
    if (onBack) {
      weapon.mesh.position.copy(weapon.backOffset);
      weapon.mesh.rotation.copy(weapon.backRotation);
    } else {
      weapon.mesh.position.set(0, 0, 0);
      weapon.mesh.rotation.set(0, 0, 0);
    }
  }

  resetSecondary(): void {
    this.root.updateMatrixWorld(true);
    this.vrm?.reset();
  }

  /** This frame's clip request (AnimatedView, before update): picks mixer clips, pose retarget or generic motion. */
  animate(_dt: number, req: AnimRequest, ctx?: ClipContext): void {
    this.pending = { req, ctx: ctx ?? null };
  }

  update(dt: number, _wind?: Readonly<{ x: number; y: number; z: number }>): void {
    if (this.disposed) return;
    const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.25) : 0;
    const pending = this.pending;
    const active = pending === null ? null : activeClipOf(pending.req, pending.ctx?.blends);
    const poseClip = active === null ? undefined : pending?.ctx?.clip(active.name);
    const mapped = this.template.clipFor(active);
    const key = mapped === null ? 'pose' : `mixer:${mapped.clip.name}`;
    const label = active?.name ?? null;
    if (key !== this.modeKey) this.switchMode(key, mapped, label);
    this.modeLabel = label;
    if (mapped !== null && this.action !== null) {
      this.driveAction(this.action, mapped, active!, poseClip, step);
    } else {
      this.mixer?.update(step);
    }
    if (this.generic !== null) {
      this.generic.update(step, active, poseClip?.duration ?? null, mapped !== null);
    } else if (mapped === null) {
      this.retarget();
    }
    this.blendFade(step);
    this.root.updateMatrixWorld(true);
    this.fx.uFxRootInverse.value.copy(this.root.matrixWorld).invert();
    this.vrm?.update(step);
    this.face?.update(step);
    for (const m of this.materialsList) (m as THREE.Material & { update?: (delta: number) => void }).update?.(step);
  }

  private switchMode(key: string, mapped: MappedClip | null, label: string | null): void {
    const first = this.modeKey === null;
    const duration = blendTime(this.modeLabel, label);
    const previous = this.action;
    this.modeKey = key;
    this.action = null;
    if (this.generic !== null) {
      // Generic: the mixer crossfades its own actions; the procedural motion fades itself.
      if (previous !== null) previous.fadeOut(duration);
      if (mapped !== null && this.mixer !== null) {
        const next = this.mixer.clipAction(mapped.clip);
        next.reset();
        if (!first) next.fadeIn(duration);
        next.play();
        this.action = next;
      }
      return;
    }
    // Humanoid: snapshot the raw bones and blend from it (mixer ↔ retarget and mixer ↔ mixer alike).
    if (!first) {
      const snapshot = [...this.rawBones.values()].map((b) => b.quaternion.clone());
      this.fade = { snapshot, hips: this.hips?.node.position.clone() ?? null, elapsed: 0, duration };
    }
    if (previous !== null) previous.stop();
    if (mapped !== null && this.mixer !== null) {
      const next = this.mixer.clipAction(mapped.clip);
      next.reset();
      next.play();
      this.action = next;
    }
  }

  /** Loop, speed and (driven) time of the playing mixer clip. */
  private driveAction(action: THREE.AnimationAction, mapped: MappedClip, active: ActiveClip, poseClip: PoseClip | undefined, step: number): void {
    const duration = mapped.clip.duration > 0 ? mapped.clip.duration : 1;
    const loop = mapped.loop ?? (active.time === null ? poseClip?.loop ?? true : poseClip?.loop ?? false);
    action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    action.clampWhenFinished = !loop;
    if (active.time !== null) {
      // Driven by the sim clock: the file clip spans the AttackDef / pose clip length.
      const span = poseClip !== undefined && poseClip.duration > 0 ? poseClip.duration : duration;
      const t = (active.time / span) * duration * mapped.speed;
      action.timeScale = 0;
      action.time = loop ? ((t % duration) + duration) % duration : Math.min(duration, Math.max(0, t));
      this.mixer!.update(0);
      return;
    }
    let rate = mapped.speed;
    if (poseClip !== undefined && active.speed !== null && poseClip.rootMotion !== undefined) {
      // Speed-matched like the pose clip it replaces (one cycle of the file clip = one cycle of the pose clip).
      rate *= playbackRate(poseClip, active.speed) * (duration / poseClip.duration);
    }
    action.timeScale = rate;
    this.mixer!.update(step);
  }

  /** Proxies → raw bones (raw = P⁻¹·q·P·R) and the pelvis height onto the raw hips. */
  private retarget(): void {
    const rest = this.template.rest;
    if (rest === null) return;
    retargetPose(this.pose, rest, this.raw);
    for (const [bone, q] of this.raw) this.rawBones.get(bone)?.quaternion.copy(q);
    if (this.hips !== null && this.proxyHips !== null) {
      _v.copy(this.proxyHips.position).sub(this.proxyHipsRest).add(this.hips.restRoot).applyMatrix4(this.hips.parentInv);
      this.hips.node.position.copy(_v);
    }
  }

  private blendFade(step: number): void {
    const fade = this.fade;
    if (fade === null) return;
    fade.elapsed += step;
    const w = smooth(fade.duration > 0 ? fade.elapsed / fade.duration : 1);
    if (w >= 1) {
      this.fade = null;
      return;
    }
    let i = 0;
    for (const bone of this.rawBones.values()) {
      _q.copy(bone.quaternion);
      bone.quaternion.copy(fade.snapshot[i++]!).slerp(_q, w);
    }
    if (fade.hips !== null && this.hips !== null) this.hips.node.position.lerpVectors(fade.hips, this.hips.node.position.clone(), w);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.root.parent?.remove(this.root);
    this.mixer?.stopAllAction();
    this.mixer?.uncacheRoot(this.scene);
    this.vrm?.dispose();
    for (const m of this.materialsList) m.dispose();
    if (this.weaponBuild !== null) {
      this.weaponBuild.weapon.mesh.parent?.remove(this.weaponBuild.weapon.mesh);
      this.weaponBuild.weapon.dispose();
      this.weaponBuild.material.dispose();
    }
    this.scene.traverse((o) => { if (o instanceof THREE.SkinnedMesh) o.skeleton.dispose(); });
  }
}

/** Rest world rotation of a raw bone in the instance root frame (tests, model-lab). */
export function restRotationOf(instance: ExternalVisualInstance, bone: HumanoidBoneName): THREE.Quaternion | null {
  const node = instance.rawBones.get(bone);
  if (node === undefined) return null;
  instance.root.updateMatrixWorld(true);
  return rotationInRoot(node, instance.root);
}
