/*
 * Distance culling for small world details (design.md "성능 예산": 표시 거리 밖은 숨긴다; Req 38.5). Chests, tablets,
 * herbs, puzzle devices, Challenge_Area runes / knots / stand-ins and the like are a few decimetres to a few metres
 * big: beyond a couple of hundred metres they cover a pixel or two but still cost a draw call each, and the far
 * plane (2,200 m) keeps the whole world in view. `distanceCulled` wraps such content in a THREE.LOD whose far level is
 * empty, so the renderer itself hides it beyond `distance` from the rendering camera (three.js updates every LOD while
 * projecting the scene, before the shadow pass, so the shadow map skips it too). Landmarks, the terrain and large
 * structures are not wrapped.
 *
 * The content keeps its world-space coordinates: the LOD sits at `center` and an inner holder undoes that offset, so
 * the views keep positioning (and hiding) their meshes exactly as before.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** Default distance (m) beyond which small details hide. */
export const DETAIL_CULL_DISTANCE = 160;
/** Fraction of the distance a shown detail keeps showing beyond it (no flicker at the edge). */
const CULL_HYSTERESIS = 0.05;

/**
 * `content` (world coordinates) inside an LOD at `center` that shows it within `distance` m of the camera and nothing
 * beyond. Add the returned LOD where `content` would have gone.
 */
export function distanceCulled(content: THREE.Object3D, center: Readonly<{ x: number; y: number; z: number }>, distance = DETAIL_CULL_DISTANCE): THREE.LOD {
  const lod = new THREE.LOD();
  lod.name = `cull:${content.name}`;
  lod.position.set(center.x, center.y, center.z);
  const holder = new THREE.Group();
  holder.name = `cullHolder:${content.name}`;
  holder.position.set(-center.x, -center.y, -center.z);
  holder.add(content);
  lod.addLevel(holder, 0, CULL_HYSTERESIS);
  lod.addLevel(new THREE.Object3D(), Math.max(1, distance), CULL_HYSTERESIS);
  return lod;
}

/** Centre and radius (m) of the world-space bounding sphere of every mesh under `root` (matrices updated first). */
export function worldBoundsOf(root: THREE.Object3D): { center: THREE.Vector3; radius: number } {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  if (box.isEmpty()) {
    const p = root.getWorldPosition(new THREE.Vector3());
    return { center: p, radius: 0 };
  }
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  return { center: sphere.center, radius: sphere.radius };
}

/**
 * Moves `children` of `parent` into one distance-culled group centred on their bounds: shown within `margin` m of
 * that sphere. Returns the LOD (added to `parent`), or null when there was nothing to wrap.
 */
export function cullChildren(parent: THREE.Object3D, children: readonly THREE.Object3D[], name: string, margin = DETAIL_CULL_DISTANCE): THREE.LOD | null {
  if (children.length === 0) return null;
  const group = new THREE.Group();
  group.name = name;
  for (const c of children) group.add(c); // the parent is at the origin: world coordinates stay
  const { center, radius } = worldBoundsOf(group);
  const lod = distanceCulled(group, center, radius + margin);
  parent.add(lod);
  return lod;
}

/**
 * One mesh with `material` holding the geometry of every mesh in `meshes` (static parts sharing that material), in
 * the space of `root` (default: the scene space, every ancestor at the origin). Positions and normals only; null
 * when the parts cannot merge. The parts themselves are left for the caller to remove.
 */
export function mergeStaticMeshes(meshes: readonly THREE.Mesh[], material: THREE.Material, name: string, root: THREE.Object3D | null = null): THREE.Mesh | null {
  if (meshes.length === 0) return null;
  const toRoot = new THREE.Matrix4();
  if (root !== null) {
    root.updateWorldMatrix(true, false);
    toRoot.copy(root.matrixWorld).invert();
  }
  const parts: THREE.BufferGeometry[] = [];
  const m = new THREE.Matrix4();
  for (const mesh of meshes) {
    mesh.updateWorldMatrix(true, false);
    const source = mesh.geometry as THREE.BufferGeometry;
    const flat = source.index !== null ? source.toNonIndexed() : source.clone();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', flat.getAttribute('position'));
    const normal = flat.getAttribute('normal');
    if (normal !== undefined) g.setAttribute('normal', normal);
    g.applyMatrix4(m.multiplyMatrices(toRoot, mesh.matrixWorld));
    if (normal === undefined) g.computeVertexNormals();
    parts.push(g);
    flat.dispose();
  }
  const merged = parts.length === 1 ? parts[0] as THREE.BufferGeometry : mergeGeometries(parts, false);
  if (merged === null) return null;
  if (merged !== parts[0]) for (const p of parts) p.dispose();
  merged.name = name;
  merged.computeBoundingSphere();
  const mesh = new THREE.Mesh(merged, material);
  mesh.name = name;
  return mesh;
}
