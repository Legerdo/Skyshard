/*
 * Instanced vegetation per chunk (design.md "식생·바위·소품", "품질 프리셋", "성능 예산"; Req 39.4, 39.5, 38.1, 38.5).
 *
 * Near the camera each 64 m chunk gets one InstancedMesh per kind and variant it holds: grass, flowers, bushes, its (at
 * most two) rock variants and its tree archetypes. Farther out, trees switch to their one-canopy LOD and rocks to one
 * low-poly far rock; those far levels draw per far block of FAR_BLOCK_CHUNKS × FAR_BLOCK_CHUNKS chunks (256 m), one
 * InstancedMesh per block and far geometry holding the far-state chunks of the block, so the 120–420 m ring costs a few
 * dozen draw calls instead of one per chunk and archetype. Every vegetation mesh uses the shared foliage material
 * with wind and bend (windMaterial.ts); rocks use the shared flat-shaded `rock` material. Instance colours tint the
 * grey grass / bush / rock gradients with the Region palette.
 *
 * Per update, with the camera's frustum and its distance to each chunk's bounding box:
 * - a chunk (or far block) box outside the frustum hides all its meshes (box culling; three.js' per-mesh culling is off);
 * - grass and flowers show within the grass distance of the vegetation step (45 / 70 / 90 m), bushes within 140 m,
 *   near rocks within 120 m and far rocks to 230 m, near trees within 120 m and far trees to 420 m;
 * - missing chunk kinds are placed (placement.ts) nearest first, a few per update, and far ones are released again;
 *   the sparse tree and rock records stay, so the far blocks rebuild from memory.
 * Instances inside a chunk batch are sorted by their keep value, so a vegetation step (0.4 / 1.0 / 1.6 ×) is a prefix
 * of the buffer. A settings change re-counts the batches of the chunks in view at once and refills the far blocks in
 * view on the next update (Req 38.2: well inside 1 s); chunks and blocks out of view catch up when they come into view,
 * and chunks built later use the new step.
 */
import * as THREE from 'three';
import type { Vec3 } from '../../core/types';
import { REGION_PALETTES } from '../../data/palettes';
import {
  FAR_BLOCK_CHUNKS, MAX_VEGETATION_DENSITY, VEGETATION_DISTANCES, VEGETATION_KINDS, vegetationStepFor, type VegetationKind, type VegetationStep,
} from '../../data/vegetation';
import { chunkBoundsFromSurface, distanceToBounds, type ChunkBounds } from '../terrain/terrainLod';
import { terrainChunkSpecs, type TerrainChunkSpec } from '../terrainMesh';
import { sharedMaterial } from '../toonMaterial';
import { geometryTriangles, vegetationGeometry } from './geometries';
import { createPlacementEnv, decodeVariant, FLOWER_COLORS, placeChunk, REC, RECORD_STRIDE, type PlacementEnv, type VegetationSurface } from './placement';
import { setVegetationBend, vegetationMaterial } from './windMaterial';

/** Chunk placements per update at most. */
export const VEGETATION_BUILD_BUDGET = 4;
/** Tallest vegetation above the ground (m): the chunk boxes reach this far up. */
const CANOPY_HEADROOM = 16;
/** A kind is placed this far before it shows, and released beyond its distance × this + 48 m. */
const PREFETCH = 24;
const RELEASE_FACTOR = 1.4;
/** Character speed (m/s) at which the bend push is full. */
const BEND_FULL_SPEED = 4;
/** Kinds with a far level drawn per far block. */
const FAR_KINDS = ['rock', 'tree'] as const;
type FarKind = (typeof FAR_KINDS)[number];

interface Batch {
  readonly key: string;
  readonly mesh: THREE.InstancedMesh;
  /** Keep values ascending (instance order). */
  readonly keeps: Float32Array;
  /** Density the count was last set for. */
  density: number;
}

export interface VegetationChunk {
  readonly spec: TerrainChunkSpec;
  readonly bounds: ChunkBounds;
  readonly box: THREE.Box3;
  readonly group: THREE.Group;
  /** Placement at the top step, per kind (null: not placed yet). */
  readonly records: Map<VegetationKind, Float32Array>;
  /** Near batches per kind. */
  readonly batches: Map<VegetationKind, Batch[]>;
  /** Index of its far block. */
  readonly block: number;
  /** Last update: camera distance to the box and whether the box was in the frustum. */
  distance: number;
  inFrustum: boolean;
}

interface FarBatch {
  readonly mesh: THREE.InstancedMesh;
  readonly capacity: number;
}

export interface VegetationBlock {
  readonly chunks: readonly VegetationChunk[];
  readonly bounds: ChunkBounds;
  readonly box: THREE.Box3;
  readonly group: THREE.Group;
  /** Far batches per far geometry key ('tree:verdant:0:far', 'rock:far'). */
  readonly far: Map<string, FarBatch>;
  /** What the far batches of each kind were last filled from (member chunks and density). */
  readonly signature: Map<FarKind, string>;
  distance: number;
  inFrustum: boolean;
}

export interface VegetationFrameStats {
  /** Vegetation meshes drawn (instanced draw calls). */
  readonly drawCalls: number;
  readonly triangles: number;
  readonly instances: number;
  /** Chunk kinds placed or built this update. */
  readonly placed: number;
  /** Far block kinds refilled this update. */
  readonly refilled: number;
}

export interface VegetationSystemOptions {
  /** Placement seed (the terrain seed). */
  seed?: number;
  step?: VegetationStep;
  env?: PlacementEnv;
  /** Chunk placements per update. */
  buildBudget?: number;
  /** Chunk specs and bounds (shared with the terrain), else computed from the surface. */
  chunks?: readonly { readonly spec: TerrainChunkSpec; readonly bounds: ChunkBounds }[];
}

/** Distance (m) within which a kind draws from its chunk's own near batches, at grass distance `grass`. */
function nearDistance(kind: VegetationKind, grass: number): number {
  switch (kind) {
    case 'grass':
    case 'flower':
      return grass;
    case 'bush':
      return VEGETATION_DISTANCES.bush;
    case 'rock':
      return VEGETATION_DISTANCES.rockNear;
    case 'tree':
      return VEGETATION_DISTANCES.treeNear;
  }
}

/** Farthest distance (m) a far kind draws at (from its far block). */
function farDistance(kind: FarKind): number {
  return kind === 'rock' ? VEGETATION_DISTANCES.rock : VEGETATION_DISTANCES.treeFar;
}

const tmpColor = new THREE.Color();
const tmpB = new THREE.Color();
const tmpMatrix = new THREE.Matrix4();
const tmpPos = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const tmpScale = new THREE.Vector3();
const tmpEuler = new THREE.Euler();
const UP = new THREE.Vector3(0, 1, 0);

/** Instance count of a batch at density `density`: the prefix of keep values below density ÷ 1.6. */
function prefixCount(keeps: Float32Array, density: number): number {
  const limit = density / MAX_VEGETATION_DENSITY;
  let lo = 0;
  let hi = keeps.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((keeps[mid] as number) < limit) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const boxOf = (b: ChunkBounds): THREE.Box3 => new THREE.Box3(
  new THREE.Vector3(b.minX - 5, b.minY - 2, b.minZ - 5),
  new THREE.Vector3(b.maxX + 5, b.maxY + CANOPY_HEADROOM, b.maxZ + 5),
);

export class VegetationSystem {
  readonly object = new THREE.Group();
  readonly chunks: readonly VegetationChunk[];
  readonly blocks: readonly VegetationBlock[];
  private readonly surface: VegetationSurface;
  private readonly env: PlacementEnv;
  private readonly foliage: THREE.MeshToonMaterial;
  private readonly rock: THREE.MeshToonMaterial;
  private stepName: VegetationStep;
  private density: number;
  private grassDistance: number;
  private budget: number;
  private readonly frustum = new THREE.Frustum();
  private readonly projScreen = new THREE.Matrix4();
  private readonly eye = new THREE.Vector3();
  private lastFocus: { x: number; y: number; z: number } | null = null;
  private windTime = 0;
  private lastStats: VegetationFrameStats = { drawCalls: 0, triangles: 0, instances: 0, placed: 0, refilled: 0 };

  constructor(surface: VegetationSurface, options: VegetationSystemOptions = {}) {
    this.surface = surface;
    this.env = options.env ?? createPlacementEnv(options.seed ?? 0);
    this.foliage = vegetationMaterial();
    this.rock = sharedMaterial('rock');
    this.stepName = options.step ?? 'medium';
    const step = vegetationStepFor(this.stepName);
    this.density = step.density;
    this.grassDistance = step.grassDistance;
    this.budget = options.buildBudget ?? VEGETATION_BUILD_BUDGET;
    this.object.name = 'vegetation';
    this.object.matrixAutoUpdate = false;
    const source = options.chunks ?? terrainChunkSpecs().map((spec) => ({ spec, bounds: chunkBoundsFromSurface(surface, spec) }));
    const perSide = Math.max(1, ...source.map((c) => c.spec.cx + 1));
    const blocksPerSide = Math.ceil(perSide / FAR_BLOCK_CHUNKS);
    const blockOf = (spec: TerrainChunkSpec): number =>
      Math.floor(spec.cz / FAR_BLOCK_CHUNKS) * blocksPerSide + Math.floor(spec.cx / FAR_BLOCK_CHUNKS);
    this.chunks = source.map(({ spec, bounds }) => {
      const group = new THREE.Group();
      group.name = `vegetation_${spec.cx}_${spec.cz}`;
      group.matrixAutoUpdate = false;
      this.object.add(group);
      return {
        spec, bounds, box: boxOf(bounds), group, records: new Map(), batches: new Map(), block: blockOf(spec), distance: Infinity, inFrustum: false,
      };
    });
    const blocks: VegetationBlock[] = [];
    for (let b = 0; b < blocksPerSide * blocksPerSide; b++) {
      const members = this.chunks.filter((c) => c.block === b);
      const first = members[0];
      if (first === undefined) continue;
      const bounds = members.reduce<ChunkBounds>((acc, c) => ({
        minX: Math.min(acc.minX, c.bounds.minX), maxX: Math.max(acc.maxX, c.bounds.maxX), minZ: Math.min(acc.minZ, c.bounds.minZ),
        maxZ: Math.max(acc.maxZ, c.bounds.maxZ), minY: Math.min(acc.minY, c.bounds.minY), maxY: Math.max(acc.maxY, c.bounds.maxY),
      }), first.bounds);
      const group = new THREE.Group();
      group.name = `vegetationFar_${b}`;
      group.matrixAutoUpdate = false;
      this.object.add(group);
      blocks.push({ chunks: members, bounds, box: boxOf(bounds), group, far: new Map(), signature: new Map(), distance: Infinity, inFrustum: false });
    }
    this.blocks = blocks;
  }

  get step(): VegetationStep {
    return this.stepName;
  }

  /** Density multiplier and grass distance now. */
  get settings(): { readonly density: number; readonly grassDistance: number } {
    return { density: this.density, grassDistance: this.grassDistance };
  }

  get stats(): VegetationFrameStats {
    return this.lastStats;
  }

  setBuildBudget(placements: number): void {
    this.budget = placements;
  }

  /**
   * Applies a vegetation step: the batches of the chunks in view (last update) re-count their prefix now; the rest,
   * and the far blocks, refill when they are next in view; chunks built later use the new step. Returns the chunks
   * re-counted now.
   */
  setStep(step: VegetationStep): number {
    const def = vegetationStepFor(step);
    this.stepName = step;
    this.density = def.density;
    this.grassDistance = def.grassDistance;
    let chunks = 0;
    for (const chunk of this.chunks) {
      if (!chunk.inFrustum || chunk.batches.size === 0) continue;
      chunks++;
      for (const batches of chunk.batches.values()) for (const b of batches) this.applyCount(b);
    }
    return chunks;
  }

  /**
   * Culls, loads and swaps LODs for `camera`; `time` (s) drives the wind, `focus` (the Active_Character's feet) the
   * bend. Returns this frame's vegetation draw calls and triangles.
   */
  update(camera: THREE.Camera, time: number, focus: Readonly<Vec3> | null = null, dt = 0): VegetationFrameStats {
    this.updateBend(time, focus, dt);
    camera.updateMatrixWorld();
    this.projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreen);
    camera.getWorldPosition(this.eye);
    const eye = this.eye;
    for (const chunk of this.chunks) {
      chunk.distance = distanceToBounds(chunk.bounds, eye.x, eye.y, eye.z);
      chunk.inFrustum = this.frustum.intersectsBox(chunk.box);
    }
    for (const block of this.blocks) {
      block.distance = distanceToBounds(block.bounds, eye.x, eye.y, eye.z);
      block.inFrustum = this.frustum.intersectsBox(block.box);
    }
    // Place missing kinds, nearest first (visible chunks before the others at the same distance).
    const wanting: { chunk: VegetationChunk; kind: VegetationKind; d: number; build: boolean }[] = [];
    for (const chunk of this.chunks) {
      const bias = chunk.inFrustum ? 1000 : 0;
      for (const kind of VEGETATION_KINDS) {
        const reach = nearDistance(kind, this.grassDistance);
        if (chunk.distance < reach + PREFETCH && !chunk.batches.has(kind)) {
          wanting.push({ chunk, kind, d: chunk.distance - bias, build: true });
        } else if (chunk.batches.has(kind) && chunk.distance > reach * RELEASE_FACTOR + 48) {
          this.release(chunk, kind);
        }
      }
      for (const kind of FAR_KINDS) {
        if (chunk.distance < farDistance(kind) + PREFETCH && !chunk.records.has(kind)) wanting.push({ chunk, kind, d: chunk.distance - bias, build: false });
      }
    }
    wanting.sort((a, b) => a.d - b.d);
    let placed = 0;
    for (const w of wanting) {
      if (placed >= this.budget) break;
      // A far-only record placement may already have been done by a near build of the same chunk kind.
      if (w.build) {
        if (w.chunk.batches.has(w.kind)) continue;
        this.build(w.chunk, w.kind);
      } else {
        if (w.chunk.records.has(w.kind)) continue;
        this.recordsOf(w.chunk, w.kind);
      }
      placed++;
    }
    const refilled = this.updateBlocks();
    return (this.lastStats = { ...this.applyVisibility(), placed, refilled });
  }

  /** update() with no placement budget: everything the camera wants is built at once (loading, tests). */
  prewarm(camera: THREE.Camera, time = 0, focus: Readonly<Vec3> | null = null): VegetationFrameStats {
    const budget = this.budget;
    this.budget = Number.POSITIVE_INFINITY;
    try {
      return this.update(camera, time, focus);
    } finally {
      this.budget = budget;
    }
  }

  /** The chunk at chunk coordinates (cx, cz), or undefined. */
  chunkAt(cx: number, cz: number): VegetationChunk | undefined {
    return this.chunks.find((c) => c.spec.cx === cx && c.spec.cz === cz);
  }

  /** Placement records of a kind in a chunk (placed now if needed). */
  recordsOf(chunk: VegetationChunk, kind: VegetationKind): Float32Array {
    let records = chunk.records.get(kind);
    if (records === undefined) {
      records = placeChunk(this.surface, chunk.spec, kind, this.env);
      chunk.records.set(kind, records);
    }
    return records;
  }

  /** Instances a chunk's near batches of `kind` draw now (after the last update / setStep). */
  countOf(chunk: VegetationChunk, kind: VegetationKind): number {
    let n = 0;
    for (const b of chunk.batches.get(kind) ?? []) n += b.mesh.count;
    return n;
  }

  dispose(): void {
    for (const chunk of this.chunks) for (const kind of [...chunk.batches.keys()]) this.release(chunk, kind);
    for (const block of this.blocks) this.releaseBlock(block);
    this.object.clear();
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private updateBend(time: number, focus: Readonly<Vec3> | null, dt: number): void {
    this.windTime = Number.isFinite(time) ? time : this.windTime;
    if (focus === null) {
      this.lastFocus = null;
      setVegetationBend(this.windTime, null);
      return;
    }
    let dx = 0;
    let dz = 0;
    if (this.lastFocus !== null && dt > 1e-4) {
      dx = (focus.x - this.lastFocus.x) / dt / BEND_FULL_SPEED;
      dz = (focus.z - this.lastFocus.z) / dt / BEND_FULL_SPEED;
      // A teleport (fast travel, respawn) is no movement.
      if (Math.hypot(dx, dz) > 10) dx = dz = 0;
    }
    this.lastFocus = { x: focus.x, y: focus.y, z: focus.z };
    setVegetationBend(this.windTime, focus, dx, dz);
  }

  private applyCount(b: Batch): void {
    b.mesh.count = prefixCount(b.keeps, this.density);
    b.density = this.density;
  }

  private build(chunk: VegetationChunk, kind: VegetationKind): void {
    const records = this.recordsOf(chunk, kind);
    // Group the records by geometry, then sort each group by keep value.
    const groups = new Map<string, number[]>();
    for (let r = 0; r < records.length; r += RECORD_STRIDE) {
      const key = geometryKey(kind, records[r + REC.variant] as number);
      let list = groups.get(key);
      if (list === undefined) groups.set(key, (list = []));
      list.push(r);
    }
    const batches: Batch[] = [];
    for (const [key, list] of groups) {
      list.sort((a, b) => (records[a + REC.keep] as number) - (records[b + REC.keep] as number));
      const material = kind === 'rock' ? this.rock : this.foliage;
      const mesh = new THREE.InstancedMesh(vegetationGeometry(kind === 'tree' ? `${key}:near` : key), material, list.length);
      mesh.name = `veg:${key}:${chunk.spec.cx}_${chunk.spec.cz}`;
      const keeps = new Float32Array(list.length);
      list.forEach((r, i) => {
        keeps[i] = records[r + REC.keep] as number;
        mesh.setMatrixAt(i, instanceMatrix(kind, records, r, tmpMatrix));
        mesh.setColorAt(i, instanceColor(kind, records, r, tmpColor));
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
      prepareInstanced(mesh);
      chunk.group.add(mesh);
      const batch: Batch = { key, mesh, keeps, density: this.density };
      this.applyCount(batch);
      batches.push(batch);
    }
    chunk.batches.set(kind, batches);
  }

  private release(chunk: VegetationChunk, kind: VegetationKind): void {
    const batches = chunk.batches.get(kind);
    if (batches === undefined) return;
    for (const b of batches) {
      chunk.group.remove(b.mesh);
      b.mesh.dispose();
    }
    chunk.batches.delete(kind);
    // Dense kinds are placed again when needed (deterministic); the sparse ones keep their few records.
    if (kind === 'grass' || kind === 'flower') chunk.records.delete(kind);
  }

  /** Whether a chunk draws `kind` from its far block now. */
  private farState(chunk: VegetationChunk, kind: FarKind): boolean {
    return chunk.distance >= nearDistance(kind, this.grassDistance) && chunk.distance < farDistance(kind) && chunk.records.has(kind);
  }

  /** Refills the far batches of the blocks in view whose far-state chunks or density changed; frees far blocks. */
  private updateBlocks(): number {
    let refilled = 0;
    for (const block of this.blocks) {
      if (block.distance > VEGETATION_DISTANCES.treeFar * RELEASE_FACTOR + 48) {
        if (block.far.size > 0) this.releaseBlock(block);
        continue;
      }
      if (!block.inFrustum) continue; // out of view: refilled when it comes into view
      for (const kind of FAR_KINDS) {
        const members = block.chunks.filter((c) => this.farState(c, kind));
        const signature = members.length === 0 ? '' : `${this.density}|${members.map((c) => `${c.spec.cx},${c.spec.cz}`).join(';')}`;
        if (block.signature.get(kind) === signature) continue;
        block.signature.set(kind, signature);
        this.fillBlock(block, kind, members);
        refilled++;
      }
    }
    return refilled;
  }

  /** Far batches of `kind` for the block, from the kept instances of `members`. */
  private fillBlock(block: VegetationBlock, kind: FarKind, members: readonly VegetationChunk[]): void {
    const limit = this.density / MAX_VEGETATION_DENSITY;
    const groups = new Map<string, { records: Float32Array; r: number }[]>();
    for (const chunk of members) {
      const records = chunk.records.get(kind);
      if (records === undefined) continue;
      for (let r = 0; r < records.length; r += RECORD_STRIDE) {
        if (!((records[r + REC.keep] as number) < limit)) continue;
        const key = farGeometryKey(kind, records[r + REC.variant] as number);
        let list = groups.get(key);
        if (list === undefined) groups.set(key, (list = []));
        list.push({ records, r });
      }
    }
    // Empty every far batch of this kind, then fill (reusing buffers that are large enough).
    for (const [key, fb] of block.far) {
      if (!key.startsWith(`${kind}:`)) continue;
      fb.mesh.count = 0;
      if (!groups.has(key)) {
        block.group.remove(fb.mesh);
        fb.mesh.dispose();
        block.far.delete(key);
      }
    }
    for (const [key, list] of groups) {
      let fb = block.far.get(key);
      if (fb === undefined || fb.capacity < list.length) {
        if (fb !== undefined) {
          block.group.remove(fb.mesh);
          fb.mesh.dispose();
        }
        const capacity = Math.ceil(list.length * 1.25) + 4;
        const mesh = new THREE.InstancedMesh(vegetationGeometry(key), kind === 'rock' ? this.rock : this.foliage, capacity);
        mesh.name = `vegFar:${key}:${block.group.name}`;
        prepareInstanced(mesh);
        block.group.add(mesh);
        fb = { mesh, capacity };
        block.far.set(key, fb);
      }
      const mesh = fb.mesh;
      list.forEach(({ records, r }, i) => {
        mesh.setMatrixAt(i, instanceMatrix(kind, records, r, tmpMatrix));
        mesh.setColorAt(i, instanceColor(kind, records, r, tmpColor));
      });
      mesh.count = list.length;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
    }
  }

  private releaseBlock(block: VegetationBlock): void {
    for (const fb of block.far.values()) {
      block.group.remove(fb.mesh);
      fb.mesh.dispose();
    }
    block.far.clear();
    block.signature.clear();
  }

  private applyVisibility(): Omit<VegetationFrameStats, 'placed' | 'refilled'> {
    let drawCalls = 0;
    let triangles = 0;
    let instances = 0;
    const show = (mesh: THREE.InstancedMesh, on: boolean): void => {
      mesh.visible = on && mesh.count > 0;
      if (!mesh.visible) return;
      drawCalls++;
      instances += mesh.count;
      triangles += mesh.count * geometryTriangles(mesh.geometry);
    };
    for (const chunk of this.chunks) {
      const d = chunk.distance;
      for (const [kind, batches] of chunk.batches) {
        const on = chunk.inFrustum && d < nearDistance(kind, this.grassDistance);
        for (const b of batches) {
          // A step change made while the chunk was out of view catches up now.
          if (on && b.density !== this.density) this.applyCount(b);
          show(b.mesh, on);
        }
      }
    }
    for (const block of this.blocks) {
      for (const fb of block.far.values()) show(fb.mesh, block.inFrustum && block.distance < VEGETATION_DISTANCES.treeFar);
    }
    return { drawCalls, triangles, instances };
  }
}

/** Box culling happens per chunk / block; the mesh itself never casts shadows. */
function prepareInstanced(mesh: THREE.InstancedMesh): void {
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.visible = false;
}

/** Geometry key of a record ('grass', 'rock:3', 'tree:verdant:1' …; near trees add ':near'). */
function geometryKey(kind: VegetationKind, variant: number): string {
  const v = decodeVariant(variant);
  switch (kind) {
    case 'rock':
      return `rock:${v.sub}`;
    case 'tree':
      return `tree:${v.region}:${v.sub}`;
    default:
      return kind;
  }
}

/** Far geometry key of a record: 'rock:far' for every rock, 'tree:<region>:<archetype>:far'. */
function farGeometryKey(kind: FarKind, variant: number): string {
  if (kind === 'rock') return 'rock:far';
  const v = decodeVariant(variant);
  return `tree:${v.region}:${v.sub}:far`;
}

function instanceMatrix(kind: VegetationKind, rec: Float32Array, r: number, out: THREE.Matrix4): THREE.Matrix4 {
  const x = rec[r + REC.x] as number;
  const y = rec[r + REC.y] as number;
  const z = rec[r + REC.z] as number;
  const yaw = rec[r + REC.yaw] as number;
  const s = rec[r + REC.scale] as number;
  const tint = rec[r + REC.tint] as number;
  let sink = 0.03;
  let sy = s;
  switch (kind) {
    case 'grass':
      sy = s * (0.8 + 0.4 * tint);
      break;
    case 'bush':
      sink = 0.15 * s;
      break;
    case 'rock':
      sink = 0.22 * s;
      break;
    case 'tree':
      sink = 0.25;
      break;
    default:
      break;
  }
  if (kind === 'rock') {
    tmpEuler.set((tint - 0.5) * 0.35, yaw, (0.5 - ((tint * 7.31) % 1)) * 0.35);
    tmpQuat.setFromEuler(tmpEuler);
  } else {
    tmpQuat.setFromAxisAngle(UP, yaw);
  }
  tmpPos.set(x, y - sink, z);
  tmpScale.set(s, sy, s);
  return out.compose(tmpPos, tmpQuat, tmpScale);
}

function instanceColor(kind: VegetationKind, rec: Float32Array, r: number, out: THREE.Color): THREE.Color {
  const { region, sub } = decodeVariant(rec[r + REC.variant] as number);
  const t = rec[r + REC.tint] as number;
  const sw = REGION_PALETTES[region].swatches;
  switch (kind) {
    case 'grass':
      return out.setHex(sw.grass).lerp(tmpB.setHex(sw.grassLight), t);
    case 'flower':
      return out.setHex(FLOWER_COLORS[region][sub] ?? 0xffffff);
    case 'bush':
      return out.setHex(sw.foliage).lerp(tmpB.setHex(sw.foliageLight), t * 0.6);
    case 'rock':
      return out.setHex(sw.rockDark).lerp(tmpB.setHex(sw.rock), 0.35 + 0.65 * t);
    case 'tree':
      return out.setRGB(0.88 + 0.24 * t, 0.88 + 0.24 * t, 0.88 + 0.24 * t);
  }
}
