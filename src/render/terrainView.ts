// Terrain view (task 18.4; design.md "지형 렌더링", "식생·바위·소품", "품질 프리셋"): the page-level world surface.
// - terrain: 64 m chunks with three LODs (2 / 4 / 8 m grids at 160 / 400 m × the preset's terrain LOD scale), skirts,
//   Region / slope / noise vertex colours and the strata shader; coarse chunks draw merged per 2 × 2 block or 4 × 4
//   superblock (src/render/terrain/);
// - vegetation: per-chunk instanced grass, flowers, bushes, rocks and Region trees with wind and bend, chunk-box
//   frustum culling, far trees / rocks per 256 m block, and the Settings vegetation step (src/render/vegetation/);
// - props: static key-location dressing merged per chunk (the Elderbough base, src/render/prefabs/).
// `update(camera, realDt, focus)` runs once per rendered frame before drawing: LOD swaps, culling, loading and the
// wind / bend uniforms. With a SettingsStore the view follows `vegetation` (density 0.4 / 1.0 / 1.6 ×, grass 45 / 70 /
// 90 m) and `qualityPreset` (terrain LOD scale) at once. Vertex arrays stay on the CPU side, so three.js re-uploads
// the geometry by itself after a WebGL context restore.

import * as THREE from 'three';
import type { Vec3 } from '../core/types';
import { renderQualityFor } from '../data/renderQuality';
import { LOCATIONS } from '../data/worldLayout';
import type { Settings } from '../settings/settings';
import type { TerrainField } from '../world/terrain';
import { elderboughBase } from './prefabs/keyLocations';
import { ChunkBatcher } from './props/propBatcher';
import { ChunkedTerrain } from './terrain/chunkedTerrain';
import type { TerrainSurface } from './terrainMesh';
import { VegetationSystem, type VegetationFrameStats } from './vegetation/vegetationSystem';

/** The Settings parts the view follows (SettingsStore satisfies it). */
export interface TerrainViewSettings {
  get(): Readonly<Pick<Settings, 'vegetation' | 'qualityPreset'>>;
  subscribe(listener: (next: Readonly<Settings>, changed: ReadonlySet<keyof Settings>) => void): () => void;
}

export interface TerrainViewOptions {
  /** Follow the vegetation step and the quality preset's terrain LOD scale. */
  settings?: TerrainViewSettings;
  /** Colour noise / placement seed; default the field's seed. */
  seed?: number;
  /** Instanced vegetation (default true). */
  vegetation?: boolean;
  /** Static key-location dressing (default true). */
  props?: boolean;
}

export interface TerrainViewFrameStats {
  /** Draw calls and triangles of the meshes inside the camera frustum. */
  readonly terrain: { readonly drawCalls: number; readonly triangles: number };
  readonly vegetation: VegetationFrameStats;
  readonly props: { readonly drawCalls: number; readonly triangles: number };
}

export interface TerrainView {
  /** Group holding the terrain chunks, the vegetation and the props. */
  readonly object: THREE.Group;
  /** Material shared by every terrain chunk (the shared `terrain` toon instance with strata). */
  readonly material: THREE.MeshToonMaterial;
  /** One mesh per 64 m chunk (its geometry swaps between the LODs). */
  readonly chunks: readonly THREE.Mesh[];
  readonly terrain: ChunkedTerrain;
  readonly vegetation: VegetationSystem | null;
  /** Static dressing merged per chunk. */
  readonly props: THREE.Group;
  /** Per rendered frame, before drawing: LODs, culling, loading, wind and bend. */
  update(camera: THREE.Camera, realDt: number, focus?: Readonly<Vec3> | null): TerrainViewFrameStats;
  /** Like update() but builds everything the camera wants at once (loading, tests). */
  prewarm(camera: THREE.Camera, focus?: Readonly<Vec3> | null): TerrainViewFrameStats;
  dispose(): void;
}

type ViewField = TerrainSurface & Partial<Pick<TerrainField, 'seed' | 'waterDepthAt'>>;

const frustum = new THREE.Frustum();
const projScreen = new THREE.Matrix4();
const sphere = new THREE.Sphere();

/** Draw calls and triangles of the visible meshes under `root` inside the camera frustum. */
function countVisible(root: THREE.Object3D, camera: THREE.Camera): { drawCalls: number; triangles: number } {
  camera.updateMatrixWorld();
  projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  frustum.setFromProjectionMatrix(projScreen);
  let drawCalls = 0;
  let triangles = 0;
  const visit = (o: THREE.Object3D): void => {
    if (!o.visible) return;
    if (o instanceof THREE.Mesh && !(o instanceof THREE.InstancedMesh)) {
      const g = o.geometry as THREE.BufferGeometry;
      if (g.boundingSphere === null) g.computeBoundingSphere();
      sphere.copy(g.boundingSphere as THREE.Sphere).applyMatrix4(o.matrixWorld);
      if (!o.frustumCulled || frustum.intersectsSphere(sphere)) {
        drawCalls++;
        triangles += (g.index?.count ?? g.getAttribute('position').count) / 3;
      }
    }
    for (const c of o.children) visit(c);
  };
  visit(root);
  return { drawCalls, triangles };
}

/** Builds the terrain (LOD 2 at once, finer levels as the camera needs them), its vegetation and props. */
export function createTerrainView(field: ViewField, options: TerrainViewOptions = {}): TerrainView {
  const seed = options.seed ?? field.seed ?? 0;
  const settings = options.settings;
  const preset = settings?.get().qualityPreset ?? 'medium';
  const terrain = new ChunkedTerrain(field, { seed, lodScale: renderQualityFor(preset).terrainLodScale });
  const object = new THREE.Group();
  object.name = 'terrain';
  object.matrixAutoUpdate = false;
  object.add(terrain.object);

  const vegetation = options.vegetation === false
    ? null
    : new VegetationSystem(field, { seed, step: settings?.get().vegetation ?? 'medium', chunks: terrain.chunks });
  if (vegetation !== null) object.add(vegetation.object);

  const props = new THREE.Group();
  props.name = 'terrainProps';
  props.matrixAutoUpdate = false;
  if (options.props !== false) {
    const batcher = new ChunkBatcher();
    const loc = LOCATIONS.lm_elderbough;
    const trunk = { x: loc.x - 8, z: loc.z - 8 }; // the old tree's trunk (landmarks.ts)
    batcher.at(trunk.x, trunk.z).appendGeometry(elderboughBase(trunk, (x, z) => field.heightAt(x, z)));
    for (const mesh of batcher.build('terrainProps', undefined, false)) props.add(mesh);
  }
  object.add(props);

  const unsubscribe = settings?.subscribe((next, changed) => {
    if (changed.has('vegetation')) vegetation?.setStep(next.vegetation);
    if (changed.has('qualityPreset')) terrain.setLodScale(renderQualityFor(next.qualityPreset).terrainLodScale);
  });

  let time = 0;
  let lastDt = 0;
  const eye = new THREE.Vector3();
  const run = (camera: THREE.Camera, focus: Readonly<Vec3> | null, full: boolean): TerrainViewFrameStats => {
    camera.updateMatrixWorld();
    camera.getWorldPosition(eye);
    if (full) terrain.prewarm(eye);
    else terrain.update(eye);
    const veg = vegetation === null
      ? { drawCalls: 0, triangles: 0, instances: 0, placed: 0, refilled: 0 }
      : full ? vegetation.prewarm(camera, time, focus) : vegetation.update(camera, time, focus, lastDt);
    return { terrain: countVisible(terrain.object, camera), vegetation: veg, props: countVisible(props, camera) };
  };

  return {
    object,
    material: terrain.material,
    chunks: terrain.chunks.map((c) => c.mesh),
    terrain,
    vegetation,
    props,
    update(camera, realDt, focus = null): TerrainViewFrameStats {
      lastDt = Number.isFinite(realDt) && realDt > 0 ? Math.min(realDt, 0.25) : 0;
      time += lastDt;
      return run(camera, focus, false);
    },
    prewarm(camera, focus = null): TerrainViewFrameStats {
      return run(camera, focus, true);
    },
    dispose(): void {
      unsubscribe?.();
      vegetation?.dispose();
      terrain.dispose();
      for (const m of props.children) if (m instanceof THREE.Mesh) m.geometry.dispose();
      props.clear();
      object.clear();
    },
  };
}
