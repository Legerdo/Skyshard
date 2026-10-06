/*
 * Chunked terrain with three LODs (design.md "지형 렌더링", "성능 예산"; Req 38.5, 39.3). Every 64 m chunk picks its
 * LOD (2 / 4 / 8 m grid of terrainLod.ts) by the camera's distance to the chunk box (160 / 400 m × the preset's
 * terrain LOD scale, with 5 % hysteresis). Coarse chunks then draw merged, so the far terrain costs a few dozen draw
 * calls whatever the view (the far plane keeps the whole map in view):
 * - a 4 × 4 superblock (256 m) whose chunks are all coarse (LOD ≥ 1) draws as one mesh at the finest LOD among them;
 * - otherwise each of its 2 × 2 blocks (128 m) whose chunks are all coarse draws as one mesh the same way;
 * - the remaining chunks (those with a LOD 0 chunk in their block) draw one mesh each.
 * A merged mesh never draws coarser than any chunk in it asked for (a LOD 2 chunk inside a LOD 1 block draws at 4 m).
 *
 * Geometry is built lazily: LOD 2 for every chunk, block and superblock up front, LOD 1 and LOD 0 chunks and the LOD 1
 * blocks / superblocks when first wanted, at most `buildBudget` vertices per update (meanwhile a chunk shows its best
 * built level and a group its chunks). LOD 0 chunks and LOD 1 groups far from the camera are released again. Vertex
 * arrays stay on the CPU side, so three.js re-uploads them itself after a WebGL context restore. All meshes share the
 * terrain material (terrainMaterial.ts).
 */
import * as THREE from 'three';
import { terrainChunkSpecs, type TerrainChunkSpec } from '../terrainMesh';
import type { TerrainColorSurface } from './terrainColors';
import {
  buildLodChunk, chunkBoundsFromSurface, distanceToBounds, LOD_DISTANCES, mergeLodChunks, selectLod, SKIRT_MARGIN,
  type ChunkBounds, type LodChunkData, type TerrainLod,
} from './terrainLod';
import { terrainMaterial } from './terrainMaterial';

/** Vertices built per update at most (≈ 5 LOD 0 chunks). */
export const TERRAIN_BUILD_BUDGET = 6000;
/** LOD 0 chunk geometry is released beyond this multiple of the LOD 0 distance. */
const LOD0_RELEASE_FACTOR = 1.6;
/** LOD 1 group geometry is released beyond this multiple of the LOD 1 → 2 distance. */
const LOD1_RELEASE_FACTOR = 1.4;

export interface TerrainChunk {
  readonly spec: TerrainChunkSpec;
  readonly bounds: ChunkBounds;
  readonly mesh: THREE.Mesh;
  /** Built geometry per LOD (null until needed). */
  readonly geometries: [THREE.BufferGeometry | null, THREE.BufferGeometry | null, THREE.BufferGeometry | null];
  /** LOD the camera distance asks for. */
  wanted: TerrainLod;
  /** LOD drawn now (the best built level at or coarser than `wanted`). */
  shown: TerrainLod;
  /** Index of its 2 × 2 block and 4 × 4 superblock. */
  readonly block: number;
  readonly superblock: number;
}

/** A 2 × 2 block or 4 × 4 superblock of chunks, drawn as one mesh while all of them are coarse. */
export interface TerrainBlock {
  /** Chunks per side (2 or 4). */
  readonly size: 2 | 4;
  readonly mesh: THREE.Mesh;
  readonly chunks: readonly TerrainChunk[];
  readonly bounds: ChunkBounds;
  /** Merged geometry per coarse LOD (index 0 unused). */
  readonly geometries: [null, THREE.BufferGeometry | null, THREE.BufferGeometry | null];
  /** LOD drawn by the merged mesh now, or null (its parts draw). */
  drawn: TerrainLod | null;
}

export interface TerrainFrameStats {
  /** Terrain meshes drawn if inside the frustum (chunk meshes + block meshes + superblock meshes). */
  readonly meshes: number;
  readonly triangles: number;
  /** Chunks per shown LOD. */
  readonly lods: readonly [number, number, number];
  /** Meshes drawn per level: chunks, 2 × 2 blocks, 4 × 4 superblocks. */
  readonly levels: readonly [number, number, number];
}

export interface ChunkedTerrainOptions {
  /** Colour noise seed (the terrain seed). */
  seed?: number;
  /** Terrain LOD distance scale (renderQualityFor(preset).terrainLodScale). */
  lodScale?: number;
  /** Vertices built per update; Infinity builds everything wanted at once. */
  buildBudget?: number;
}

type MeshArrays = { positions: Float32Array; normals: Float32Array; colors: Float32Array; strata: Float32Array; indices: Uint16Array | Uint32Array };

function toGeometry(data: MeshArrays): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(data.colors, 3));
  geometry.setAttribute('aStrata', new THREE.BufferAttribute(data.strata, 1));
  geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  return geometry;
}

const triangleCount = (g: THREE.BufferGeometry | null): number => (g?.index?.count ?? 0) / 3;

function unionBounds(chunks: readonly TerrainChunk[]): ChunkBounds {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const c of chunks) {
    minX = Math.min(minX, c.bounds.minX);
    maxX = Math.max(maxX, c.bounds.maxX);
    minZ = Math.min(minZ, c.bounds.minZ);
    maxZ = Math.max(maxZ, c.bounds.maxZ);
    minY = Math.min(minY, c.bounds.minY);
    maxY = Math.max(maxY, c.bounds.maxY);
  }
  return { minX, maxX, minZ, maxZ, minY, maxY };
}

function coarseMesh(geometry: THREE.BufferGeometry, material: THREE.Material, name: string): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  mesh.visible = false;
  return mesh;
}

export class ChunkedTerrain {
  readonly object = new THREE.Group();
  readonly material: THREE.MeshToonMaterial;
  readonly chunks: readonly TerrainChunk[];
  /** 2 × 2 blocks. */
  readonly blocks: readonly TerrainBlock[];
  /** 4 × 4 superblocks. */
  readonly superblocks: readonly TerrainBlock[];
  private readonly blocksOf = new Map<TerrainBlock, TerrainBlock[]>();
  private readonly field: TerrainColorSurface;
  private readonly seed: number;
  private scale: number;
  private budget: number;
  private lastStats: TerrainFrameStats = { meshes: 0, triangles: 0, lods: [0, 0, 0], levels: [0, 0, 0] };

  constructor(field: TerrainColorSurface, options: ChunkedTerrainOptions = {}) {
    this.field = field;
    this.seed = options.seed ?? 0;
    this.scale = sanitizeScale(options.lodScale);
    this.budget = options.buildBudget ?? TERRAIN_BUILD_BUDGET;
    this.material = terrainMaterial();
    this.object.name = 'terrainChunks';
    this.object.matrixAutoUpdate = false;

    const specs = terrainChunkSpecs();
    const perSide = Math.round(Math.sqrt(specs.length));
    const blocksPerSide = Math.ceil(perSide / 2);
    const superPerSide = Math.ceil(perSide / 4);
    const chunks: TerrainChunk[] = [];
    const lod2 = new Map<TerrainChunk, LodChunkData>();
    for (const spec of specs) {
      const data = buildLodChunk(field, spec, 2, this.seed);
      const geometry = toGeometry(data);
      const mesh = new THREE.Mesh(geometry, this.material);
      mesh.name = `terrain_${spec.cx}_${spec.cz}`;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      const b = chunkBoundsFromSurface(field, spec);
      const chunk: TerrainChunk = {
        spec,
        bounds: { ...b, minY: b.minY - SKIRT_MARGIN - 8 },
        mesh,
        geometries: [null, null, geometry],
        wanted: 2,
        shown: 2,
        block: Math.floor(spec.cz / 2) * blocksPerSide + Math.floor(spec.cx / 2),
        superblock: Math.floor(spec.cz / 4) * superPerSide + Math.floor(spec.cx / 4),
      };
      chunks.push(chunk);
      lod2.set(chunk, data);
      this.object.add(mesh);
    }
    this.chunks = chunks;

    const group = (size: 2 | 4, members: TerrainChunk[], name: string): TerrainBlock => {
      const merged = mergeLodChunks(members.map((c) => lod2.get(c) as LodChunkData));
      const geometry = toGeometry(merged);
      const mesh = coarseMesh(geometry, this.material, name);
      this.object.add(mesh);
      return { size, mesh, chunks: members, bounds: unionBounds(members), geometries: [null, null, geometry], drawn: null };
    };
    const blocks: TerrainBlock[] = [];
    const blockAt = new Map<number, TerrainBlock>();
    for (let b = 0; b < blocksPerSide * blocksPerSide; b++) {
      const members = chunks.filter((c) => c.block === b);
      if (members.length === 0) continue;
      const block = group(2, members, `terrainBlock_${b}`);
      blocks.push(block);
      blockAt.set(b, block);
    }
    this.blocks = blocks;
    const superblocks: TerrainBlock[] = [];
    for (let s = 0; s < superPerSide * superPerSide; s++) {
      const members = chunks.filter((c) => c.superblock === s);
      if (members.length === 0) continue;
      const sb = group(4, members, `terrainSuperblock_${s}`);
      superblocks.push(sb);
      const inner = [...new Set(members.map((c) => c.block))].map((b) => blockAt.get(b) as TerrainBlock);
      this.blocksOf.set(sb, inner);
    }
    this.superblocks = superblocks;
  }

  /** Terrain LOD distance scale (quality preset); takes effect at the next update. */
  get lodScale(): number {
    return this.scale;
  }

  setLodScale(scale: number): void {
    this.scale = sanitizeScale(scale);
  }

  setBuildBudget(vertices: number): void {
    this.budget = vertices;
  }

  /** Stats of the last update. */
  get stats(): TerrainFrameStats {
    return this.lastStats;
  }

  /** Picks each chunk's LOD for a camera at `eye`, builds missing levels within the budget and swaps geometry. */
  update(eye: Readonly<{ x: number; y: number; z: number }>): TerrainFrameStats {
    const near = LOD_DISTANCES[0] * this.scale;
    const far = LOD_DISTANCES[1] * this.scale;
    // Nearest chunks first, so the budget goes where it shows.
    const order = this.chunks.map((chunk) => ({ chunk, d: distanceToBounds(chunk.bounds, eye.x, eye.y, eye.z) }));
    for (const o of order) o.chunk.wanted = selectLod(o.d, this.scale, o.chunk.wanted);
    order.sort((a, b) => a.d - b.d);
    let budget = this.budget;
    for (const { chunk, d } of order) {
      let lod = chunk.wanted;
      if (chunk.geometries[lod] === null && budget > 0) {
        const data = buildLodChunk(this.field, chunk.spec, lod, this.seed);
        budget -= data.positions.length / 3;
        chunk.geometries[lod] = toGeometry(data);
      }
      while (chunk.geometries[lod] === null) lod = (lod + 1) as TerrainLod;
      if (chunk.shown !== lod || chunk.mesh.geometry !== chunk.geometries[lod]) {
        chunk.mesh.geometry = chunk.geometries[lod] as THREE.BufferGeometry;
        chunk.shown = lod;
      }
      // Release LOD 0 far from the camera (rebuilt on the way back).
      const fine = chunk.geometries[0];
      if (fine !== null && chunk.shown !== 0 && d > near * LOD0_RELEASE_FACTOR) {
        fine.dispose();
        chunk.geometries[0] = null;
      }
    }

    // Merged groups: the LOD 1 merges the camera wants (nearest first, within what is left of the budget).
    const wantsLod1: { group: TerrainBlock; d: number }[] = [];
    const finest = (g: TerrainBlock): TerrainLod => g.chunks.reduce<TerrainLod>((m, c) => (c.wanted < m ? c.wanted : m), 2);
    for (const sb of this.superblocks) {
      for (const g of [sb, ...(this.blocksOf.get(sb) ?? [])]) {
        const d = distanceToBounds(g.bounds, eye.x, eye.y, eye.z);
        if (finest(g) === 1 && g.geometries[1] === null) wantsLod1.push({ group: g, d });
        else if (g.geometries[1] !== null && finest(g) !== 1 && d > far * LOD1_RELEASE_FACTOR) {
          g.geometries[1].dispose();
          g.geometries[1] = null;
        }
      }
    }
    wantsLod1.sort((a, b) => a.d - b.d || b.group.size - a.group.size);
    for (const { group } of wantsLod1) {
      if (budget <= 0) break;
      const merged = mergeLodChunks(group.chunks.map((c) => buildLodChunk(this.field, c.spec, 1, this.seed)));
      budget -= merged.positions.length / 3;
      group.geometries[1] = toGeometry(merged);
    }

    let meshes = 0;
    let triangles = 0;
    const lods: [number, number, number] = [0, 0, 0];
    const levels: [number, number, number] = [0, 0, 0];
    const drawGroup = (g: TerrainBlock): boolean => {
      // The finest LOD any chunk shows; a merged mesh needs every chunk coarse and its geometry built.
      const m = g.chunks.reduce<TerrainLod>((acc, c) => (c.shown < acc ? c.shown : acc), 2);
      const geometry = m >= 1 ? g.geometries[m as 1 | 2] : null;
      if (geometry === null) {
        g.drawn = null;
        g.mesh.visible = false;
        return false;
      }
      if (g.mesh.geometry !== geometry) g.mesh.geometry = geometry;
      g.drawn = m;
      g.mesh.visible = true;
      meshes++;
      triangles += triangleCount(geometry);
      levels[g.size === 4 ? 2 : 1]++;
      for (const c of g.chunks) c.mesh.visible = false;
      return true;
    };
    for (const sb of this.superblocks) {
      const inner = this.blocksOf.get(sb) ?? [];
      if (drawGroup(sb)) {
        for (const b of inner) {
          b.drawn = null;
          b.mesh.visible = false;
        }
      } else {
        for (const b of inner) {
          if (drawGroup(b)) continue;
          for (const c of b.chunks) {
            c.mesh.visible = true;
            meshes++;
            triangles += triangleCount(c.mesh.geometry);
            levels[0]++;
          }
        }
      }
      for (const c of sb.chunks) lods[c.shown]++;
    }
    this.lastStats = { meshes, triangles, lods, levels };
    return this.lastStats;
  }

  /** Builds every level the camera at `eye` wants now, ignoring the budget (tests, first frame). */
  prewarm(eye: Readonly<{ x: number; y: number; z: number }>): TerrainFrameStats {
    const budget = this.budget;
    this.budget = Number.POSITIVE_INFINITY;
    try {
      return this.update(eye);
    } finally {
      this.budget = budget;
    }
  }

  dispose(): void {
    const seen = new Set<THREE.BufferGeometry>();
    for (const chunk of this.chunks) {
      for (const g of chunk.geometries) if (g !== null) seen.add(g);
      seen.add(chunk.mesh.geometry);
    }
    for (const g of [...this.blocks, ...this.superblocks]) {
      for (const geo of g.geometries) if (geo !== null) seen.add(geo);
      seen.add(g.mesh.geometry);
    }
    for (const g of seen) g.dispose();
    this.object.clear();
  }
}

function sanitizeScale(scale: number | undefined): number {
  return scale !== undefined && Number.isFinite(scale) && scale > 0 ? scale : 1;
}
