/*
 * Prop batching per chunk (design.md "식생·바위·소품", "성능 예산"; Req 38.5, 39.3). Village props (fences, crates,
 * lanterns, carts, the well, stall, field …) share the toon material and carry vertex colours, so everything static
 * in one 64 m chunk merges into one geometry: ≈ 1 draw call per chunk.
 *
 * `bakeMesh` turns a flat-coloured stand-in mesh into kit geometry on the way (Req 39.3: no raw primitive): unit
 * boxes become chamfered boxes of their scaled size, cylinders bevelled cylinders, cones displaced cones and spheres
 * displaced icospheres, painted with the material's colour. Meshes that already carry vertex colours (prefabs) are
 * copied as they are.
 */
import * as THREE from 'three';
import { TERRAIN_GRID } from '../../data/worldLayout';
import { TERRAIN_CHUNK_SIZE } from '../terrainMesh';
import { PartBuilder, prefabMaterial } from '../prefabs/kit';

/** Chunk column / row of a world position (the terrain's 64 m grid). */
export function chunkOf(x: number, z: number): { cx: number; cz: number } {
  const max = Math.ceil((TERRAIN_GRID.halfExtent * 2) / TERRAIN_CHUNK_SIZE) - 1;
  const clampI = (v: number): number => Math.max(0, Math.min(max, v));
  return {
    cx: clampI(Math.floor((x + TERRAIN_GRID.halfExtent) / TERRAIN_CHUNK_SIZE)),
    cz: clampI(Math.floor((z + TERRAIN_GRID.halfExtent) / TERRAIN_CHUNK_SIZE)),
  };
}

const pos = new THREE.Vector3();
const quat = new THREE.Quaternion();
const scl = new THREE.Vector3();

/**
 * Appends `mesh` to `out` in the space of `relative` (mesh.matrixWorld = relative.matrixWorld · result): kit
 * geometry for the stand-in primitives, painted with the material's colour, or the vertex-coloured geometry as is.
 * Returns false (nothing appended) for geometry it does not know.
 */
export function bakeMesh(mesh: THREE.Mesh, relative: THREE.Object3D, out: PartBuilder): boolean {
  const matrix = new THREE.Matrix4().copy(relative.matrixWorld).invert().multiply(mesh.matrixWorld);
  const material = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.Material & { color?: THREE.Color; vertexColors?: boolean };
  const g = mesh.geometry;
  if (material.vertexColors === true && g.getAttribute('color') !== undefined) {
    out.appendGeometry(g, matrix);
    return true;
  }
  const hex = material.color?.getHex() ?? 0xffffff;
  matrix.decompose(pos, quat, scl);
  const rigid = new THREE.Matrix4().compose(pos, quat, new THREE.Vector3(1, 1, 1));
  if (g instanceof THREE.BoxGeometry) {
    const p = g.parameters;
    const w = p.width * scl.x;
    const h = p.height * scl.y;
    const d = p.depth * scl.z;
    out.box(w, h, d, rigid, hex, Math.min(0.05, Math.min(w, h, d) * 0.2));
    return true;
  }
  if (g instanceof THREE.ConeGeometry) {
    const p = g.parameters;
    const r = p.radius * scl.x;
    const h = p.height * scl.y;
    const m = rigid.clone().multiply(new THREE.Matrix4().makeScale(1, 1, scl.z / (scl.x || 1))).multiply(new THREE.Matrix4().makeTranslation(0, -h / 2, 0));
    out.cylinder(r, r * 0.05, h, Math.max(4, p.radialSegments), m, hex, { rings: 2, noise: Math.min(0.08, r * 0.06), seed: r + h });
    return true;
  }
  if (g instanceof THREE.CylinderGeometry) {
    const p = g.parameters;
    const r0 = p.radiusBottom * scl.x;
    const r1 = p.radiusTop * scl.x;
    const h = p.height * scl.y;
    const m = rigid.clone().multiply(new THREE.Matrix4().makeScale(1, 1, scl.z / (scl.x || 1))).multiply(new THREE.Matrix4().makeTranslation(0, -h / 2, 0));
    out.cylinder(r0, r1, h, Math.max(6, p.radialSegments), m, hex, { bevel: Math.min(0.05, h * 0.2, Math.min(r0, r1) * 0.3), open: p.openEnded });
    return true;
  }
  if (g instanceof THREE.SphereGeometry) {
    const r = g.parameters.radius;
    out.blob(r, matrix, hex, 0.12, r * 7.1);
    return true;
  }
  if (g instanceof THREE.OctahedronGeometry || g instanceof THREE.IcosahedronGeometry) {
    const src = g.toNonIndexed();
    const p = src.getAttribute('position') as THREE.BufferAttribute;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    for (let f = 0; f + 2 < p.count; f += 3) {
      out.triangle(a.fromBufferAttribute(p, f).applyMatrix4(matrix), b.fromBufferAttribute(p, f + 1).applyMatrix4(matrix), c.fromBufferAttribute(p, f + 2).applyMatrix4(matrix), hex);
    }
    src.dispose();
    return true;
  }
  return false;
}

/** Collects world-space parts per chunk and builds one merged mesh for each. */
export class ChunkBatcher {
  private readonly bins = new Map<string, PartBuilder>();

  /** The builder of the chunk holding (x, z). */
  at(x: number, z: number): PartBuilder {
    const { cx, cz } = chunkOf(x, z);
    const key = `${cx}_${cz}`;
    let b = this.bins.get(key);
    if (b === undefined) this.bins.set(key, (b = new PartBuilder()));
    return b;
  }

  /** Bakes `mesh` (world space) into the chunk of its world position. */
  addMesh(mesh: THREE.Mesh, root: THREE.Object3D): boolean {
    mesh.getWorldPosition(pos);
    return bakeMesh(mesh, root, this.at(pos.x, pos.z));
  }

  get chunkCount(): number {
    return this.bins.size;
  }

  /** One mesh per non-empty chunk, named `${prefix}:${cx}_${cz}`. */
  build(prefix: string, material: THREE.Material = prefabMaterial(), castShadow = true): THREE.Mesh[] {
    const meshes: THREE.Mesh[] = [];
    for (const [key, builder] of this.bins) {
      if (builder.empty) continue;
      const mesh = new THREE.Mesh(builder.build(`${prefix}:${key}`), material);
      mesh.name = `${prefix}:${key}`;
      mesh.castShadow = castShadow;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      meshes.push(mesh);
    }
    return meshes;
  }
}
