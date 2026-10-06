import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { blobPlacement, BLOB_MAX_HEIGHT } from '../../../src/render/blobShadows';
import {
  CharacterShadow, insideShadowBox, SHADOW_BOX_SIZE, shadowBasis, shadowMapSizeFor, shadowTexelSize, snapShadowCenter,
  type CharacterShadowState,
} from '../../../src/render/shadows';

// Task 18.5: the 80 m character shadow box, its texel snapping, the map sizes per setting and the blob fallback.

const SUN_DIRS = [
  { x: 0.3, y: 0.9, z: 0.2 },
  { x: -0.8, y: 0.12, z: 0.55 }, // dusk: low sun
  { x: 0.05, y: 0.99, z: -0.1 },
];

describe('shadow map sizes', () => {
  it('off / low / high → no map, 1024, 2048 over an 80 m box', () => {
    expect(shadowMapSizeFor('off')).toBe(0);
    expect(shadowMapSizeFor('low')).toBe(1024);
    expect(shadowMapSizeFor('high')).toBe(2048);
    expect(SHADOW_BOX_SIZE).toBe(80);
    expect(shadowTexelSize(1024)).toBeCloseTo(0.078125);
    expect(shadowTexelSize(2048)).toBeCloseTo(0.0390625);
    expect(shadowTexelSize(0)).toBe(0);
  });
});

describe('texel snapping', () => {
  it('uses the same axes as the shadow camera (Object3D.lookAt with +Y up)', () => {
    for (const d of SUN_DIRS) {
      const dir = new THREE.Vector3(d.x, d.y, d.z).normalize();
      const cam = new THREE.OrthographicCamera();
      cam.position.copy(dir).multiplyScalar(100);
      cam.lookAt(0, 0, 0);
      cam.updateMatrixWorld();
      const x = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
      const y = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
      const b = shadowBasis(d);
      expect(b.right.x).toBeCloseTo(x.x, 6);
      expect(b.right.y).toBeCloseTo(x.y, 6);
      expect(b.right.z).toBeCloseTo(x.z, 6);
      expect(b.up.x).toBeCloseTo(y.x, 6);
      expect(b.up.y).toBeCloseTo(y.y, 6);
      expect(b.up.z).toBeCloseTo(y.z, 6);
    }
  });

  it('puts the centre on whole texels in light space, within half a texel of the focus and nothing along the light', () => {
    const texel = shadowTexelSize(1024);
    for (const d of SUN_DIRS) {
      const { right, up, back } = shadowBasis(d);
      for (let i = 0; i < 40; i++) {
        const focus = { x: -300 + i * 17.37, y: 10 + i * 0.73, z: 250 - i * 11.91 };
        const c = snapShadowCenter(focus, d, texel);
        const dot = (a: typeof right, p: typeof focus): number => a.x * p.x + a.y * p.y + a.z * p.z;
        const a = dot(right, c) / texel;
        const bb = dot(up, c) / texel;
        expect(Math.abs(a - Math.round(a))).toBeLessThan(1e-6 * Math.max(1, Math.abs(a)));
        expect(Math.abs(bb - Math.round(bb))).toBeLessThan(1e-6 * Math.max(1, Math.abs(bb)));
        expect(Math.abs(dot(right, c) - dot(right, focus))).toBeLessThanOrEqual(texel / 2 + 1e-9);
        expect(Math.abs(dot(up, c) - dot(up, focus))).toBeLessThanOrEqual(texel / 2 + 1e-9);
        expect(dot(back, c)).toBeCloseTo(dot(back, focus), 9);
      }
    }
  });

  it('keeps the snapped box still while the focus moves inside one texel cell, and steps whole texels otherwise', () => {
    const texel = shadowTexelSize(2048);
    const d = SUN_DIRS[1];
    const { right } = shadowBasis(d);
    const base = snapShadowCenter({ x: 12.3, y: 4, z: -7.9 }, d, texel);
    const nudged = snapShadowCenter({ x: 12.3 + right.x * texel * 0.1, y: 4 + right.y * texel * 0.1, z: -7.9 + right.z * texel * 0.1 }, d, texel);
    // Either the same cell or exactly one texel over.
    const shift = (nudged.x - base.x) * right.x + (nudged.y - base.y) * right.y + (nudged.z - base.z) * right.z;
    expect([0, texel].some((v) => Math.abs(shift - v) < 1e-9)).toBe(true);
  });

  it('leaves the focus as it is without a map', () => {
    expect(snapShadowCenter({ x: 1.23, y: 2, z: 3.45 }, SUN_DIRS[0], 0)).toEqual({ x: 1.23, y: 2, z: 3.45 });
  });
});

describe('CharacterShadow', () => {
  const setup = () => {
    const renderer = { shadowMap: { enabled: true } } as unknown as THREE.WebGLRenderer;
    const sun = new THREE.DirectionalLight();
    sun.castShadow = true;
    const state: CharacterShadowState = { enabled: true, center: { x: 0, y: 0, z: 0 }, halfExtent: 40 };
    return { renderer, sun, state, shadow: new CharacterShadow(renderer, sun, state) };
  };

  it('allocates by size, frees the old map on a size change and switches the pass on / off', () => {
    const { renderer, sun, state, shadow } = setup();
    expect(shadow.setQuality('low')).toEqual({ reallocated: true, toggled: false });
    expect(sun.shadow.mapSize.x).toBe(1024);
    // A map three.js had made is freed and nulled, so the next frame allocates the new size.
    const old = new THREE.WebGLRenderTarget(1024, 1024);
    let disposed = false;
    old.addEventListener('dispose', () => { disposed = true; });
    sun.shadow.map = old;
    expect(shadow.setQuality('high')).toEqual({ reallocated: true, toggled: false });
    expect(disposed).toBe(true);
    expect(sun.shadow.map).toBeNull();
    expect(sun.shadow.mapSize.x).toBe(2048);
    expect(shadow.setQuality('off')).toEqual({ reallocated: false, toggled: true });
    expect(renderer.shadowMap.enabled).toBe(false);
    expect(sun.castShadow).toBe(false);
    expect(state.enabled).toBe(false);
    expect(shadow.setQuality('off')).toEqual({ reallocated: false, toggled: false });
    expect(shadow.setQuality('low')).toEqual({ reallocated: true, toggled: true });
    expect(renderer.shadowMap.enabled && sun.castShadow && state.enabled).toBe(true);
  });

  it('follows the focus with the snapped centre and the sun along its direction', () => {
    const { sun, state, shadow } = setup();
    shadow.setQuality('low');
    const dir = new THREE.Vector3(0.3, 0.9, 0.2).normalize();
    shadow.follow({ x: 100.02, y: 12, z: -40.07 }, dir);
    const c = snapShadowCenter({ x: 100.02, y: 12, z: -40.07 }, dir, shadowTexelSize(1024));
    expect(sun.target.position.x).toBeCloseTo(c.x, 9);
    expect(sun.target.position.z).toBeCloseTo(c.z, 9);
    const toSun = sun.position.clone().sub(sun.target.position).normalize();
    expect(toSun.dot(dir)).toBeCloseTo(1, 9);
    expect(state.center.x).toBeCloseTo(c.x, 9);
  });
});

describe('blob shadows', () => {
  const on: CharacterShadowState = { enabled: true, center: { x: 0, y: 0, z: 0 }, halfExtent: 40 };
  const off: CharacterShadowState = { ...on, enabled: false };

  it('shows only without a real shadow: shadows off, or outside the 80 m box', () => {
    expect(insideShadowBox({ x: 10, y: 0, z: 10 }, on)).toBe(true);
    expect(insideShadowBox({ x: 10, y: 0, z: 10 }, off)).toBe(false);
    expect(blobPlacement({ pos: { x: 10, y: 0, z: 10 }, radius: 0.4 }, 0, on).visible).toBe(false);
    expect(blobPlacement({ pos: { x: 10, y: 0, z: 10 }, radius: 0.4 }, 0, off).visible).toBe(true);
    expect(blobPlacement({ pos: { x: 45, y: 0, z: 0 }, radius: 0.6 }, 0, on).visible).toBe(true);
  });

  it('lies on the ground and fades with the height above it', () => {
    const low = blobPlacement({ pos: { x: 0, y: 5.5, z: 0 }, radius: 0.4 }, 5, off);
    const high = blobPlacement({ pos: { x: 0, y: 9, z: 0 }, radius: 0.4 }, 5, off);
    expect(low.y).toBeCloseTo(5.04);
    expect(high.opacity).toBeLessThan(low.opacity);
    expect(high.size).toBeGreaterThan(low.size);
    expect(blobPlacement({ pos: { x: 0, y: 5 + BLOB_MAX_HEIGHT + 0.1, z: 0 }, radius: 0.4 }, 5, off).visible).toBe(false);
  });
});
