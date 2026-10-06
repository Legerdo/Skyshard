import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { cullChildren, distanceCulled, mergeStaticMeshes } from '../../../src/render/distanceCull';

// Task 18.4 (draw-call budget): small world details hide beyond their distance through a THREE.LOD with an empty far
// level, and static parts sharing a material merge into one mesh.

const cameraAt = (x: number, z: number): THREE.PerspectiveCamera => {
  const c = new THREE.PerspectiveCamera();
  c.position.set(x, 2, z);
  c.updateMatrixWorld();
  return c;
};

describe('distanceCulled', () => {
  it('keeps world coordinates and hides the content beyond the distance (with a little hysteresis)', () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
    mesh.position.set(100, 5, -40);
    const lod = distanceCulled(mesh, mesh.position.clone(), 160);
    const scene = new THREE.Scene().add(lod);
    scene.updateMatrixWorld(true);
    expect(mesh.getWorldPosition(new THREE.Vector3()).toArray()).toEqual([100, 5, -40]);
    const holder = lod.levels[0]?.object as THREE.Object3D;
    lod.update(cameraAt(100, 60));
    expect(holder.visible).toBe(true);
    lod.update(cameraAt(100, 130)); // 170 m
    expect(holder.visible).toBe(false);
    lod.update(cameraAt(100, 115)); // 155 m: inside the 5 % band, still hidden
    expect(holder.visible).toBe(false);
    lod.update(cameraAt(100, 100)); // 140 m
    expect(holder.visible).toBe(true);
  });

  it('wraps a group of children centred on their bounds', () => {
    const parent = new THREE.Group();
    const a = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial());
    const b = a.clone();
    a.position.set(0, 0, 0);
    b.position.set(20, 0, 0);
    parent.add(a, b);
    const lod = cullChildren(parent, [a, b], 'pair', 50);
    expect(lod).not.toBeNull();
    expect(parent.children).toEqual([lod]);
    expect(lod?.position.x).toBeCloseTo(10, 6);
    expect(lod?.levels[1]?.distance).toBeGreaterThan(50 + 10);
    expect(cullChildren(parent, [], 'none')).toBeNull();
  });
});

describe('mergeStaticMeshes', () => {
  it('bakes the parts into one mesh with their transforms', () => {
    const material = new THREE.MeshBasicMaterial();
    const parts = [0, 1, 2].map((i) => {
      const m = new THREE.Mesh(i === 2 ? new THREE.OctahedronGeometry(0.5) : new THREE.BoxGeometry(1, 1, 1), material);
      m.position.set(i * 10, 0, 0);
      return m;
    });
    const merged = mergeStaticMeshes(parts, material, 'merged');
    expect(merged).not.toBeNull();
    const g = (merged as THREE.Mesh).geometry;
    expect(g.index).toBeNull();
    expect(g.getAttribute('position').count).toBe(36 + 36 + 24);
    g.computeBoundingBox();
    expect(g.boundingBox?.max.x).toBeCloseTo(20.5, 6);
    expect((merged as THREE.Mesh).material).toBe(material);
  });
});
