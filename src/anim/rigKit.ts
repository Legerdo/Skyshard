/*
 * Rig kit (design.md "Rig kit", "Rigid skinning 병합", Req 40.4, 43.4): `buildRig(spec)` turns a RigSpec into a
 * Skeleton, one body SkinnedMesh and one outline SkinnedMesh sharing a single BufferGeometry and that Skeleton (two
 * draw calls; three.js updates the shared Skeleton once per frame).
 *
 * - Skeleton: the preset layout (./rigLayout) — VRM humanoid names for `humanoid`, plus `root`, the sockets weaponR ·
 *   weaponL · back · headTop and the spring joints. Every bone's rest world rotation is identity (+Z T-pose).
 * - Merge: every part gets the same attributes — position · normal · uv · skinIndex · skinWeight · color · aFx — and is
 *   indexed (non-indexed ones through mergeVertices) before `mergeGeometries`. A vertex has weight 1 on its part's
 *   joint; `chain` parts split between neighbouring chain joints by their coordinate along the chain, smoothstepped
 *   over ±25 % of a segment around each joint boundary. `color` is the palette zone (linear RGB); `aFx` = (glow, face).
 * - Material: the rig's own toon instance (face atlas, `uGlow`, flash: ./rigMaterial); the outline is the shared rig
 *   outline, which collapses the face plane.
 * - Deterministic: the same spec builds identical attribute arrays (seeded part builders, no Math.random).
 *
 * `prepareRig` (layout + merged geometry) and `assembleRig` (bones, meshes, material) are split so a VisualTemplate can
 * build the geometry once and instantiate many rigs sharing it.
 */
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { attachOutline } from '../render/outline';
import { faceAtlasTexture } from './face';
import { buildLayout } from './rigLayout';
import { createAuraMaterial, createRigMaterial, rigOutlineMaterial, rigUniformsOf } from './rigMaterial';
import type {
  ChainLayout, PaletteZone, PartDef, RigBuild, RigBuildOptions, RigLayout, RigSpec, SocketName, WeaponBuild,
} from './rigTypes';
import { SpringChain, SpringSystem, type SpringCollider } from './spring';

/** Attribute set every merged part carries (design "Rigid skinning 병합"). */
export const RIG_ATTRIBUTES = ['position', 'normal', 'uv', 'skinIndex', 'skinWeight', 'color', 'aFx'] as const;

/** Rest pose & merged geometry of a spec: build once, assemble many. */
export interface PreparedRig {
  readonly spec: RigSpec;
  readonly layout: RigLayout;
  readonly geometry: THREE.BufferGeometry;
  /** Triangle count of the body (outline excluded). */
  readonly triangles: number;
}

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Chain weights of a point: up to two (joint index, weight) pairs (exported for tests). */
export function chainWeights(chain: ChainLayout, p: readonly [number, number, number]): [number, number, number, number] {
  const start = chain.points[0]!;
  const n = chain.joints.length;
  const along = ((p[0] - start[0]) * chain.dir[0] + (p[1] - start[1]) * chain.dir[1] + (p[2] - start[2]) * chain.dir[2]) / chain.def.segLength;
  const s = Math.min(n - 1e-6, Math.max(0, along));
  const k = Math.floor(s);
  const f = s - k;
  // Returns [segment a, weight a, segment b, weight b] (segment indices into chain.joints).
  if (f < 0.25 && k > 0) {
    const w = smoothstep(-0.25, 0.25, f);
    return [k - 1, 1 - w, k, w];
  }
  if (f > 0.75 && k < n - 1) {
    const w = smoothstep(-0.25, 0.25, f - 1);
    return [k, 1 - w, k + 1, w];
  }
  return [k, 1, k, 0];
}

function linearRgb(hex: number): [number, number, number] {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
}

/** Copies an attribute into a fresh Float32 attribute of `itemSize` (padding / truncating components). */
function floatAttribute(src: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, itemSize: number): THREE.BufferAttribute {
  const out = new Float32Array(src.count * itemSize);
  for (let i = 0; i < src.count; i++) {
    for (let c = 0; c < itemSize; c++) out[i * itemSize + c] = c < src.itemSize ? src.getComponent(i, c) : 0;
  }
  return new THREE.BufferAttribute(out, itemSize);
}

/** One part → indexed geometry with exactly RIG_ATTRIBUTES (exported for weapons, which use the same layout). */
export function normalizePart(
  part: PartDef,
  palette: Readonly<Record<PaletteZone, number>>,
  jointIndex: (name: string) => number,
  chain?: ChainLayout,
): THREE.BufferGeometry {
  let source = part.geometry;
  if (source.getAttribute('normal') === undefined) source.computeVertexNormals();
  if (source.getIndex() === null) {
    // ExtrudeGeometry and friends: weld to an indexed mesh (uv / normal seams stay split).
    const stripped = new THREE.BufferGeometry();
    for (const name of ['position', 'normal', 'uv'] as const) {
      const a = source.getAttribute(name);
      if (a !== undefined) stripped.setAttribute(name, a);
    }
    source = mergeVertices(stripped, 1e-5);
  }
  const pos = source.getAttribute('position');
  const count = pos.count;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', floatAttribute(pos, 3));
  g.setAttribute('normal', floatAttribute(source.getAttribute('normal'), 3));
  const uv = source.getAttribute('uv');
  g.setAttribute('uv', uv === undefined ? new THREE.BufferAttribute(new Float32Array(count * 2), 2) : floatAttribute(uv, 2));
  const skinIndex = new Uint16Array(count * 4);
  const skinWeight = new Float32Array(count * 4);
  if (part.chain !== undefined) {
    if (chain === undefined) throw new Error(`rigKit: part chain '${part.chain}' is not a spring of this rig`);
    const ids = chain.joints.map(jointIndex);
    const p: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < count; i++) {
      p[0] = pos.getX(i);
      p[1] = pos.getY(i);
      p[2] = pos.getZ(i);
      const [a, wa, b, wb] = chainWeights(chain, p);
      skinIndex[i * 4] = ids[a]!;
      skinWeight[i * 4] = wa;
      skinIndex[i * 4 + 1] = ids[b]!;
      skinWeight[i * 4 + 1] = wb;
    }
  } else {
    const joint = jointIndex(part.joint);
    for (let i = 0; i < count; i++) {
      skinIndex[i * 4] = joint;
      skinWeight[i * 4] = 1;
    }
  }
  g.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
  const rgb = linearRgb(part.color ?? palette[part.zone]);
  const color = new Float32Array(count * 3);
  const fx = new Float32Array(count * 2);
  const glow = Math.min(1, Math.max(0, part.glow ?? 0));
  const face = part.face === true ? 1 : 0;
  for (let i = 0; i < count; i++) {
    color.set(rgb, i * 3);
    fx[i * 2] = glow;
    fx[i * 2 + 1] = face;
  }
  g.setAttribute('color', new THREE.BufferAttribute(color, 3));
  g.setAttribute('aFx', new THREE.BufferAttribute(fx, 2));
  const index = source.getIndex()!;
  const indices = new Uint32Array(index.count);
  for (let i = 0; i < index.count; i++) indices[i] = index.getX(i);
  g.setIndex(new THREE.BufferAttribute(indices, 1));
  if (source !== part.geometry) source.dispose();
  return g;
}

/** Layout and merged body geometry of `spec` (the expensive, shareable half of buildRig). */
export function prepareRig(spec: RigSpec): PreparedRig {
  const layout = buildLayout(spec);
  const index = new Map<string, number>(layout.joints.map((j, i) => [j.name, i]));
  const jointIndex = (name: string): number => {
    const i = index.get(name);
    if (i === undefined) throw new Error(`rigKit: ${spec.id} part joint '${name}' is not a joint of preset ${spec.preset}`);
    return i;
  };
  const parts = typeof spec.parts === 'function' ? spec.parts(layout) : spec.parts;
  if (parts.length === 0) throw new Error(`rigKit: ${spec.id} has no parts`);
  const geometries = parts.map((part) => normalizePart(part, spec.palette, jointIndex, part.chain === undefined ? undefined : layout.chains.get(part.chain)));
  for (const part of parts) part.geometry.dispose();
  const geometry = mergeGeometries(geometries, false);
  for (const g of geometries) g.dispose();
  if (geometry === null) throw new Error(`rigKit: ${spec.id} parts could not be merged`);
  geometry.name = `rig:${spec.id}`;
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return { spec, layout, geometry, triangles: (geometry.getIndex()?.count ?? 0) / 3 };
}

const DEFAULT_IDLE_GLOW = 0.3;

class ProceduralRig implements RigBuild {
  readonly root = new THREE.Group();
  readonly skeleton: THREE.Skeleton;
  readonly body: THREE.SkinnedMesh;
  readonly outline: THREE.SkinnedMesh;
  readonly bones = new Map<string, THREE.Bone>();
  readonly sockets = new Map<SocketName, THREE.Bone>();
  readonly material: THREE.MeshToonMaterial;
  readonly springs: SpringSystem;
  private cell: { eye: 0 | 1 | 2; mouth: 0 | 1 | 2 } = { eye: 0, mouth: 0 };
  private glowValue: number;
  private opacityValue = 1;
  private held: WeaponBuild | null = null;
  private onBack = false;
  private dissolveValue = 0;
  private auraMesh: THREE.SkinnedMesh | null = null;

  constructor(
    readonly spec: RigSpec,
    readonly layout: RigLayout,
    geometry: THREE.BufferGeometry,
    private readonly ownsGeometry: boolean,
    options: RigBuildOptions,
  ) {
    this.root.name = `rig:${spec.id}`;
    const ordered: THREE.Bone[] = [];
    for (const joint of layout.joints) {
      const bone = new THREE.Bone();
      bone.name = joint.name;
      const parentPos = joint.parent === null ? [0, 0, 0] : layout.pos(joint.parent);
      bone.position.set(joint.pos[0] - parentPos[0]!, joint.pos[1] - parentPos[1]!, joint.pos[2] - parentPos[2]!);
      if (joint.parent !== null) this.bones.get(joint.parent)!.add(bone);
      this.bones.set(joint.name, bone);
      ordered.push(bone);
    }
    for (const name of ['weaponR', 'weaponL', 'back', 'headTop'] as const) {
      const bone = this.bones.get(name);
      if (bone !== undefined) this.sockets.set(name, bone);
    }
    const face = spec.face !== undefined && options.faceAtlas !== false ? faceAtlasTexture(spec.face, options.canvas) : null;
    this.glowValue = spec.idleGlow ?? DEFAULT_IDLE_GLOW;
    this.material = createRigMaterial({
      kind: spec.material ?? 'character', faceMap: face, glowColor: spec.palette.element, glow: this.glowValue, height: spec.height,
    });
    this.body = new THREE.SkinnedMesh(geometry, this.material);
    this.body.name = `${spec.id}:body`;
    this.body.castShadow = true;
    this.body.add(ordered[0]!);
    this.root.add(this.body);
    this.root.updateMatrixWorld(true);
    this.skeleton = new THREE.Skeleton(ordered);
    this.body.bind(this.skeleton, this.body.matrixWorld.clone());
    this.outline = attachOutline(this.body, 'character', { material: rigOutlineMaterial() }) as THREE.SkinnedMesh;
    // Posed limbs and chains reach past the rest bounds: one generous sphere, never recomputed from the rest pose.
    const sphere = new THREE.Sphere(new THREE.Vector3(0, spec.height * 0.5, 0), spec.height * 0.95);
    this.body.boundingSphere = sphere;
    this.outline.boundingSphere = sphere.clone();
    this.springs = new SpringSystem(this.makeChains(), this.makeColliders());
    this.root.updateMatrixWorld(true);
    this.springs.reset();
  }

  private makeChains(): SpringChain[] {
    const chains: SpringChain[] = [];
    for (const chain of this.layout.chains.values()) {
      const bones = chain.joints.map((name) => this.bones.get(name)!);
      const d = chain.def;
      const tip = new THREE.Vector3(chain.dir[0], chain.dir[1], chain.dir[2]).multiplyScalar(d.segLength);
      chains.push(new SpringChain(bones, tip, { stiffness: d.stiffness, drag: d.drag, gravity: d.gravity }));
    }
    return chains;
  }

  /** Collision spheres on head, chest, hips and the upper legs (humanoid; the other presets use what they have). */
  private makeColliders(): SpringCollider[] {
    const H = this.spec.height;
    const dims = this.layout.dims;
    const out: SpringCollider[] = [];
    const add = (joint: string, offset: readonly [number, number, number], radius: number): void => {
      const bone = this.bones.get(joint);
      if (bone !== undefined) out.push({ bone, offset: new THREE.Vector3(...offset), radius });
    };
    if (this.layout.has('head')) {
      const hp = this.layout.pos('head');
      const c = dims.headCenter;
      add('head', [c[0] - hp[0], c[1] - hp[1], c[2] - hp[2]], dims.headRadius * 0.92);
    }
    if (this.spec.preset === 'humanoid') {
      add('chest', [0, 0.03 * H, 0], 0.072 * H * Math.max(1, this.spec.shoulderScale * 0.85));
      add('hips', [0, 0, 0], 0.07 * H);
      add('leftUpperLeg', [0, -0.11 * H, 0], 0.045 * H);
      add('rightUpperLeg', [0, -0.11 * H, 0], 0.045 * H);
    }
    return out;
  }

  get faceCell(): { eye: 0 | 1 | 2; mouth: 0 | 1 | 2 } {
    return this.cell;
  }

  get glow(): number {
    return this.glowValue;
  }

  get weapon(): WeaponBuild | null {
    return this.held;
  }

  setFaceCell(eye: 0 | 1 | 2, mouth: 0 | 1 | 2): void {
    this.cell = { eye, mouth };
    rigUniformsOf(this.material)?.faceCell.value.set(mouth, eye);
  }

  setGlow(v: number): void {
    this.glowValue = Number.isFinite(v) ? Math.max(0, v) : 0;
    const u = rigUniformsOf(this.material);
    if (u !== undefined) u.uGlow.value = this.glowValue;
  }

  setFlash(amount: number, color: THREE.ColorRepresentation = 0xffffff): void {
    const u = rigUniformsOf(this.material);
    if (u === undefined) return;
    u.uFlash.value = Number.isFinite(amount) ? Math.max(0, amount) : 0;
    u.uFlashColor.value.set(color);
  }

  setOpacity(opacity: number): void {
    const next = Number.isFinite(opacity) ? Math.min(1, Math.max(0, opacity)) : 1;
    if (next === this.opacityValue) return;
    this.opacityValue = next;
    const transparent = next < 1;
    this.material.opacity = next;
    if (this.material.transparent !== transparent) {
      this.material.transparent = transparent; // switching blending recompiles, so only on change
      this.material.needsUpdate = true;
    }
    this.refreshOutlines();
  }

  /** The shared outline cannot fade or dissolve per rig: hidden while the body is see-through or dissolving. */
  private refreshOutlines(): void {
    const solid = this.opacityValue >= 1 && this.dissolveValue <= 0;
    this.outline.visible = solid;
    const weaponOutline = this.held?.outline;
    if (weaponOutline !== undefined) weaponOutline.visible = solid;
    if (this.auraMesh !== null) this.auraMesh.visible = this.dissolveValue <= 0;
  }

  get dissolve(): number {
    return this.dissolveValue;
  }

  get aura(): THREE.SkinnedMesh | null {
    return this.auraMesh;
  }

  setDissolve(amount: number, rise = false): void {
    const next = Number.isFinite(amount) ? Math.min(1, Math.max(0, amount)) : 0;
    const u = rigUniformsOf(this.material);
    if (u !== undefined) {
      u.uDissolve.value = next;
      u.uDissolveRise.value = rise ? 1 : 0;
    }
    if (next === this.dissolveValue) return;
    this.dissolveValue = next;
    this.refreshOutlines();
  }

  attachAura(color: THREE.ColorRepresentation, width: number): THREE.SkinnedMesh {
    if (this.auraMesh !== null) return this.auraMesh;
    const aura = new THREE.SkinnedMesh(this.body.geometry, createAuraMaterial(color, width));
    aura.name = `${this.spec.id}:aura`;
    aura.bindMode = this.body.bindMode;
    aura.bind(this.skeleton, this.body.bindMatrix);
    aura.castShadow = false;
    aura.receiveShadow = false;
    aura.renderOrder = 1; // after the opaque body and its outline
    aura.boundingSphere = this.body.boundingSphere?.clone() ?? null;
    this.body.add(aura);
    this.auraMesh = aura;
    this.refreshOutlines();
    return aura;
  }

  private heldSocket(): THREE.Bone {
    const name = this.spec.weaponSocket ?? 'weaponR';
    const socket = this.sockets.get(name);
    if (socket === undefined) throw new Error(`rigKit: ${this.spec.id} has no ${name} socket`);
    return socket;
  }

  attachWeapon(mesh: THREE.Mesh, outline: THREE.Mesh): void {
    const socket = this.heldSocket();
    for (const child of [...socket.children]) socket.remove(child);
    const back = this.sockets.get('back');
    if (back !== undefined) for (const child of [...back.children]) if (child.userData.rigWeapon === true) back.remove(child);
    mesh.userData.rigWeapon = true;
    if (outline.parent !== mesh) mesh.add(outline);
    mesh.position.set(0, 0, 0);
    mesh.rotation.set(0, 0, 0);
    socket.add(mesh);
    this.onBack = false;
  }

  equip(weapon: WeaponBuild | null): void {
    if (this.held !== null && this.held !== weapon) {
      this.held.mesh.parent?.remove(this.held.mesh);
      this.held.dispose();
    }
    this.held = weapon;
    if (weapon !== null) {
      this.attachWeapon(weapon.mesh, weapon.outline);
      this.refreshOutlines();
    }
  }

  stowWeapon(onBack: boolean): void {
    const weapon = this.held;
    if (weapon === null || onBack === this.onBack) return;
    const back = this.sockets.get('back');
    if (back === undefined) return;
    this.onBack = onBack;
    const target = onBack ? back : this.heldSocket();
    target.add(weapon.mesh);
    if (onBack) {
      weapon.mesh.position.copy(weapon.backOffset);
      weapon.mesh.rotation.copy(weapon.backRotation);
    } else {
      weapon.mesh.position.set(0, 0, 0);
      weapon.mesh.rotation.set(0, 0, 0);
    }
  }

  dispose(): void {
    this.equip(null);
    if (this.auraMesh !== null) (this.auraMesh.material as THREE.Material).dispose();
    this.material.dispose();
    if (this.ownsGeometry) this.body.geometry.dispose();
    this.skeleton.dispose();
    this.root.clear();
  }
}

/** Bones, meshes and material over prepared geometry (shared: `ownsGeometry` false leaves it to the template). */
export function assembleRig(prepared: PreparedRig, options: RigBuildOptions = {}, ownsGeometry = false): RigBuild {
  return new ProceduralRig(prepared.spec, prepared.layout, prepared.geometry, ownsGeometry, options);
}

/** Builds one procedural model from its spec (geometry owned by the rig). */
export function buildRig(spec: RigSpec, options: RigBuildOptions = {}): RigBuild {
  return assembleRig(prepareRig(spec), options, true);
}
