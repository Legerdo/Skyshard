// TEMPORARY progress-object visuals, replaced by the Blight, altar and Sanctum art of the world art tasks:
// - Blight_Barrier gates: dark violet crystal walls with a row of spikes; on opening they flare for the first
//   quarter of the shatter, then burst into tumbling shards that fall and fade (Req 4.5, 4.6).
// - Blight veils: tall translucent violet curtains along their wall pieces (task 18.5: one merged mesh per veil with
//   the shimmering veil variant of the Blight material); on opening they thin out and rise.
// - Task 18.5: the gate walls and spikes use the one shared Blight material (src/render/blight.ts).
// - seal_sanctum: a faint shell around the Sanctum; on opening it swells and fades.
// - Resonance_Altar: stone dais and plinth with a star-shaped cap. Its light pillar (Req 5.3) is drawn by the
//   Landmark view since task 18.3 (src/render/landmarks.ts), culling excluded like the Landmarks.
// - Starlit_Stair: glowing floating slabs and the two starlit Updraft columns, shown while the stair is active.
// The view only reads GateSystem views and flags; it never changes simulation state.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { BARRIERS, wallPieces, type BarrierDef, type WallPiece } from '../data/barriers';
import type { BarrierId } from '../data/ids';
import { RESONANCE_ALTAR, STARLIT_STAIR, type StarlitStairDef } from '../data/starlitStair';
import { BARRIER_SHATTER_SECONDS, type BarrierView } from '../world/gateSystem';
import { addBlightAttributes, BLIGHT_COLOR, blightSurfaceMaterial, createBlightVeilMaterial } from './blight';

const GATE_COLOR = 0x3a1d5c;
const GATE_GLOW = new THREE.Color(0x9b4dff);
/** Task 18.5: the gate walls and spikes share the one Blight material (src/render/blight.ts) with these colours. */
const GATE_WALL_COLOR = 0x4a2470;
const GATE_SPIKE_COLOR = 0x7c46c4;
const VEIL_COLOR = BLIGHT_COLOR;
/** Task 18.5: the veil shimmer shader's base opacity (its bands vary it between 55 % and 100 %). */
const VEIL_OPACITY = 0.34;
/** Veil curtain subdivision for the shimmer waves (m per segment along / up). */
const VEIL_SEGMENT = 10;
const SEAL_COLOR = 0xb9c8ff;
const SEAL_OPACITY = 0.12;
const STONE_COLOR = 0x9a927f;
const ALTAR_CAP_COLOR = 0xe9c46a;
const PLATFORM_COLOR = 0x2c3f7a;
const PLATFORM_GLOW = 0x7fb6ff;
const UPDRAFT_COLOR = 0xa9d8ff;

/** Shards per gate wall. */
const SHARD_COUNT = 48;
/** Part of the shatter the wall spends flaring before it breaks. */
const FLARE_PART = 0.25;
const SHARD_GRAVITY = 9;

/** Per-frame scratch for the shard matrices. */
const SCRATCH = {
  m: new THREE.Matrix4(),
  q: new THREE.Quaternion(),
  e: new THREE.Euler(),
  pos: new THREE.Vector3(),
  scale: new THREE.Vector3(),
};

/** Deterministic 0..1 value for shard `i`, channel `k` (no Math.random, so every opening looks the same). */
function hash01(i: number, k: number): number {
  const s = Math.sin(i * 127.1 + k * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

interface GateVisual {
  readonly kind: 'gate';
  readonly wall: THREE.Group;
  /** The shared Blight material (never disposed here). */
  readonly wallMaterial: THREE.Material;
  readonly shards: THREE.InstancedMesh;
  readonly shardMaterial: THREE.MeshLambertMaterial;
  readonly shardStart: readonly THREE.Vector3[];
  readonly shardVelocity: readonly THREE.Vector3[];
  readonly duration: number;
}

interface FadeVisual {
  readonly kind: 'veil' | 'seal';
  readonly group: THREE.Group;
  readonly material: THREE.Material;
  readonly baseOpacity: number;
}

type BarrierVisual = GateVisual | FadeVisual;

/** A box standing on a wall piece: local x across the thickness, z along a → b. */
function placeOnPiece(obj: THREE.Object3D, piece: WallPiece): void {
  const dx = piece.b.x - piece.a.x;
  const dz = piece.b.z - piece.a.z;
  obj.position.set((piece.a.x + piece.b.x) / 2, (piece.bottomY + piece.topY) / 2, (piece.a.z + piece.b.z) / 2);
  obj.rotation.y = Math.atan2(dx, dz);
}

export interface WorldObjectsState {
  readonly barriers: readonly BarrierView[];
  readonly stairActive: boolean;
  /** Unused since task 18.3: the Landmark view draws the light pillar. */
  readonly pillarVisible?: boolean;
}

export class WorldObjectsView {
  readonly object = new THREE.Group();
  private readonly barriers = new Map<BarrierId, BarrierVisual>();
  private readonly stair: THREE.Group;
  private readonly updraftMaterial: THREE.MeshBasicMaterial;
  private readonly disposables: { dispose(): void }[] = [];

  constructor(options: { barriers?: Readonly<Record<BarrierId, BarrierDef>>; stair?: StarlitStairDef } = {}) {
    this.object.name = 'worldObjects';
    for (const def of Object.values(options.barriers ?? BARRIERS)) this.barriers.set(def.id, this.createBarrier(def));
    const altar = this.createAltar();
    this.object.add(altar);
    this.updraftMaterial = this.track(
      new THREE.MeshBasicMaterial({ color: UPDRAFT_COLOR, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.stair = this.createStair(options.stair ?? STARLIT_STAIR);
    this.stair.visible = false;
    this.object.add(this.stair);
  }

  /** Mirrors the barrier phases and the stair; `time` (s) drives the idle shimmer. */
  update(state: WorldObjectsState, time: number): void {
    for (const view of state.barriers) {
      const visual = this.barriers.get(view.id);
      if (visual !== undefined) this.updateBarrier(visual, view, time);
    }
    this.stair.visible = state.stairActive;
    if (state.stairActive) this.updraftMaterial.opacity = 0.13 + 0.05 * Math.sin(time * 2.3);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.object.clear();
  }

  private track<T extends { dispose(): void }>(resource: T): T {
    this.disposables.push(resource);
    return resource;
  }

  private createBarrier(def: BarrierDef): BarrierVisual {
    switch (def.kind) {
      case 'gate':
        return this.createGate(def, wallPieces(def)[0]);
      case 'veil': {
        const group = new THREE.Group();
        group.name = `barrier:${def.id}`;
        // Task 18.5: the veil shimmer variant of the Blight material (waves and drifting bands), one per veil.
        const material = this.track(createBlightVeilMaterial(VEIL_OPACITY));
        // The curtain pieces merged into one mesh per veil (one draw call).
        const place = new THREE.Object3D();
        const pieces = wallPieces(def).map((piece) => {
          const length = Math.hypot(piece.b.x - piece.a.x, piece.b.z - piece.a.z);
          const height = piece.topY - piece.bottomY;
          const geometry = new THREE.PlaneGeometry(length, height, Math.max(1, Math.ceil(length / VEIL_SEGMENT)), Math.max(1, Math.ceil(height / VEIL_SEGMENT)));
          placeOnPiece(place, piece);
          place.rotation.y += Math.PI / 2; // the plane spans local x: turn it to run along a → b
          place.updateMatrix();
          return geometry.applyMatrix4(place.matrix);
        });
        const merged = mergeGeometries(pieces);
        for (const g of pieces) g.dispose();
        const curtain = new THREE.Mesh(this.track(addBlightAttributes(merged, VEIL_COLOR)), material);
        curtain.name = `veil:${def.id}`;
        group.add(curtain);
        this.object.add(group);
        return { kind: 'veil', group, material, baseOpacity: VEIL_OPACITY };
      }
      case 'seal': {
        const group = new THREE.Group();
        group.name = `barrier:${def.id}`;
        const material = this.track(
          new THREE.MeshBasicMaterial({ color: SEAL_COLOR, transparent: true, opacity: SEAL_OPACITY, side: THREE.DoubleSide, depthWrite: false }),
        );
        const sphere = new THREE.Mesh(this.track(new THREE.SphereGeometry(def.radius, 48, 24)), material);
        group.position.set(def.center.x, def.center.y, def.center.z);
        group.add(sphere);
        this.object.add(group);
        return { kind: 'seal', group, material, baseOpacity: SEAL_OPACITY };
      }
    }
  }

  private createGate(def: BarrierDef, piece: WallPiece): GateVisual {
    const length = Math.hypot(piece.b.x - piece.a.x, piece.b.z - piece.a.z);
    const height = piece.topY - piece.bottomY;
    // Task 18.5: the one Blight material of every Blight surface (shared, so not tracked for disposal here).
    const wallMaterial = blightSurfaceMaterial();
    const wall = new THREE.Group();
    wall.name = `barrier:${def.id}`;
    placeOnPiece(wall, piece);
    const slabGeometry = new THREE.BoxGeometry(piece.thickness, height, length, 1, Math.max(1, Math.round(height / 4)), Math.max(1, Math.round(length / 4)));
    const slab = new THREE.Mesh(this.track(addBlightAttributes(slabGeometry, GATE_WALL_COLOR)), wallMaterial);
    slab.castShadow = true;
    wall.add(slab);
    const spike = this.track(addBlightAttributes(new THREE.ConeGeometry(0.9, 4, 5), GATE_SPIKE_COLOR));
    const spikes = Math.max(3, Math.round(length / 3));
    for (let i = 0; i < spikes; i++) {
      const cone = new THREE.Mesh(spike, wallMaterial);
      const along = -length / 2 + ((i + 0.5) / spikes) * length;
      cone.position.set((hash01(i, 1) - 0.5) * 0.8, height / 2 + 1.2 + hash01(i, 2) * 1.5, along);
      cone.rotation.set((hash01(i, 3) - 0.5) * 0.5, hash01(i, 4) * Math.PI, (hash01(i, 5) - 0.5) * 0.5);
      wall.add(cone);
    }
    this.object.add(wall);

    const shardMaterial = this.track(
      new THREE.MeshLambertMaterial({ color: GATE_COLOR, emissive: GATE_GLOW, emissiveIntensity: 0.8, flatShading: true, transparent: true }),
    );
    const shards = new THREE.InstancedMesh(this.track(new THREE.TetrahedronGeometry(0.7)), shardMaterial, SHARD_COUNT);
    shards.visible = false;
    shards.frustumCulled = false;
    const yaw = wall.rotation.y;
    const along = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const across = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    const start: THREE.Vector3[] = [];
    const velocity: THREE.Vector3[] = [];
    for (let i = 0; i < SHARD_COUNT; i++) {
      const p = wall.position.clone()
        .addScaledVector(along, (hash01(i, 6) - 0.5) * length)
        .add(new THREE.Vector3(0, (hash01(i, 7) - 0.5) * height, 0));
      start.push(p);
      const side = hash01(i, 8) < 0.5 ? -1 : 1;
      velocity.push(
        across.clone().multiplyScalar(side * (3 + hash01(i, 9) * 6))
          .addScaledVector(along, (hash01(i, 10) - 0.5) * 4)
          .add(new THREE.Vector3(0, 2 + hash01(i, 11) * 5, 0)),
      );
    }
    this.object.add(shards);
    return {
      kind: 'gate', wall, wallMaterial, shards, shardMaterial, shardStart: start, shardVelocity: velocity, duration: BARRIER_SHATTER_SECONDS.gate,
    };
  }

  private updateBarrier(visual: BarrierVisual, view: BarrierView, time: number): void {
    if (visual.kind === 'gate') {
      this.updateGate(visual, view, time);
      return;
    }
    const group = visual.group;
    if (view.phase === 'open') {
      group.visible = false;
      return;
    }
    group.visible = true;
    const p = view.phase === 'shattering' ? view.progress : 0;
    visual.material.opacity = visual.baseOpacity * (1 - p) * (0.85 + 0.15 * Math.sin(time * 1.3));
    if (visual.kind === 'seal') group.scale.setScalar(1 + 0.15 * p);
    else group.position.y = 40 * p * p;
  }

  private updateGate(visual: GateVisual, view: BarrierView, time: number): void {
    if (view.phase === 'open') {
      visual.wall.visible = false;
      visual.shards.visible = false;
      return;
    }
    // The shared Blight material pulses by itself (uBlightTime); the flare swells the wall before it breaks.
    if (view.phase === 'closed') {
      visual.wall.visible = true;
      visual.wall.scale.setScalar(1);
      visual.shards.visible = false;
      return;
    }
    const p = view.progress;
    if (p < FLARE_PART) {
      const f = p / FLARE_PART;
      visual.wall.visible = true;
      visual.wall.scale.set(1 + 0.3 * f + 0.05 * Math.sin(time * 40) * f, 1 + 0.02 * f, 1);
      visual.shards.visible = false;
      return;
    }
    visual.wall.visible = false;
    visual.shards.visible = true;
    const t = ((p - FLARE_PART) / (1 - FLARE_PART)) * visual.duration;
    visual.shardMaterial.opacity = 1 - (p - FLARE_PART) / (1 - FLARE_PART);
    const { m, q, e, pos, scale } = SCRATCH;
    for (let i = 0; i < SHARD_COUNT; i++) {
      const v = visual.shardVelocity[i];
      pos.copy(visual.shardStart[i]).addScaledVector(v, t);
      pos.y -= 0.5 * SHARD_GRAVITY * t * t;
      e.set(t * (2 + hash01(i, 12) * 4), t * (1 + hash01(i, 13) * 3), 0);
      q.setFromEuler(e);
      scale.setScalar(0.6 + hash01(i, 14) * 0.9);
      m.compose(pos, q, scale);
      visual.shards.setMatrixAt(i, m);
    }
    visual.shards.instanceMatrix.needsUpdate = true;
  }

  private createAltar(): THREE.Group {
    const a = RESONANCE_ALTAR;
    const group = new THREE.Group();
    group.name = 'resonanceAltar';
    group.position.set(a.pos.x, a.pos.y, a.pos.z);
    const stone = this.track(new THREE.MeshLambertMaterial({ color: STONE_COLOR, flatShading: true }));
    const dais = new THREE.Mesh(this.track(new THREE.CylinderGeometry(a.daisRadius, a.daisRadius * 1.04, a.daisHeight, 8)), stone);
    dais.position.y = a.daisHeight / 2;
    dais.receiveShadow = true;
    const plinth = new THREE.Mesh(this.track(new THREE.CylinderGeometry(a.plinthRadius * 0.8, a.plinthRadius, a.plinthHeight, 8)), stone);
    plinth.position.y = a.daisHeight + a.plinthHeight / 2;
    plinth.castShadow = true;
    const capMaterial = this.track(new THREE.MeshLambertMaterial({ color: ALTAR_CAP_COLOR, emissive: ALTAR_CAP_COLOR, emissiveIntensity: 0.5, flatShading: true }));
    const cap = new THREE.Mesh(this.track(new THREE.OctahedronGeometry(0.45)), capMaterial);
    cap.position.y = a.daisHeight + a.plinthHeight + 0.5;
    group.add(dais, plinth, cap);
    return group;
  }

  private createStair(def: StarlitStairDef): THREE.Group {
    const group = new THREE.Group();
    group.name = 'starlitStair';
    const slab = this.track(
      new THREE.MeshLambertMaterial({ color: PLATFORM_COLOR, emissive: PLATFORM_GLOW, emissiveIntensity: 0.45, flatShading: true }),
    );
    for (const p of def.platforms) {
      const mesh = new THREE.Mesh(this.track(new THREE.BoxGeometry(p.halfX * 2, def.thickness, p.halfZ * 2)), slab);
      mesh.position.set(p.x, p.topY - def.thickness / 2, p.z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
    for (const u of def.updrafts) {
      const { shape } = u;
      const height = shape.maxY - shape.minY;
      const column = new THREE.Mesh(this.track(new THREE.CylinderGeometry(shape.radius, shape.radius, height, 20, 1, true)), this.updraftMaterial);
      column.position.set(shape.x, shape.minY + height / 2, shape.z);
      group.add(column);
    }
    return group;
  }
}
