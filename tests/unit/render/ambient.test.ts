import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ATMOSPHERE_BOX, AtmosphereParticles, ATMOSPHERE_DEFS } from '../../../src/render/atmosphere';
import { BirdFlocks } from '../../../src/render/birds';
import {
  createFlock, DEFAULT_FLOCK_PARAMS, FLOCK_MAX, FLOCK_MIN, SCATTER_SECONDS, stepFlock, type Flock,
} from '../../../src/render/boids';
import { applyInterior, InteriorBlend, interiorLookFor, INTERIOR_BLEND_SECONDS } from '../../../src/render/interiorLighting';
import { createHeightTexture, MAX_RIPPLES, RIPPLE_SECONDS, RippleRings, waterSurfaceGeometry } from '../../../src/render/water';
import { HOLLOWROOT } from '../../../src/data/challengeAreas';
import { SANCTUM } from '../../../src/data/sanctum';
import { WATER_BODIES } from '../../../src/world/terrain';

// Task 18.5: deterministic boids-lite flocks, the camera-wrapped atmosphere, the 8 ripple rings, the water surfaces
// and the 1 s interior lighting blend.

const flat = (): number => 20;
const snapshot = (f: Flock) => f.birds.map((b) => [b.pos.x, b.pos.y, b.pos.z, b.vel.x, b.vel.y, b.vel.z]);

describe('boids-lite flocks', () => {
  it('seeds 8–12 birds and steps deterministically', () => {
    for (let seed = 1; seed < 30; seed++) {
      const n = createFlock(seed, { x: 0, y: 20, z: 0 }).birds.length;
      expect(n).toBeGreaterThanOrEqual(FLOCK_MIN);
      expect(n).toBeLessThanOrEqual(FLOCK_MAX);
    }
    const a = createFlock(7, { x: 10, y: 20, z: -5 });
    const b = createFlock(7, { x: 10, y: 20, z: -5 });
    for (let i = 0; i < 300; i++) {
      stepFlock(a, 1 / 60, flat, { pos: { x: 0, y: 20, z: 0 }, speed: 2 });
      stepFlock(b, 1 / 60, flat, { pos: { x: 0, y: 20, z: 0 }, speed: 2 });
    }
    expect(snapshot(a)).toEqual(snapshot(b));
  });

  it('keeps the flock near home, inside the altitude band and within the speed limits', () => {
    const f = createFlock(3, { x: 100, y: 20, z: 50 }, 20);
    for (let i = 0; i < 60 * 60; i++) stepFlock(f, 1 / 60, flat, null);
    const p = DEFAULT_FLOCK_PARAMS;
    for (const bird of f.birds) {
      expect(Math.hypot(bird.pos.x - 100, bird.pos.z - 50)).toBeLessThan(p.homeRadius * 2);
      expect(bird.pos.y).toBeGreaterThanOrEqual(20 + p.minHeight - 6);
      expect(bird.pos.y).toBeLessThanOrEqual(20 + p.maxHeight + 6);
      const speed = Math.hypot(bird.vel.x, bird.vel.y, bird.vel.z);
      expect(speed).toBeGreaterThanOrEqual(p.minSpeed - 1e-6);
      expect(speed).toBeLessThanOrEqual(p.maxSpeed + 1e-6);
    }
    // Separation: no two birds on top of each other.
    for (let i = 0; i < f.birds.length; i++) {
      for (let j = i + 1; j < f.birds.length; j++) {
        const a = f.birds[i].pos;
        const b = f.birds[j].pos;
        expect(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)).toBeGreaterThan(0.3);
      }
    }
  });

  it('scatters away from a sprinting Active_Character nearby, not from a walking one', () => {
    const walk = createFlock(5, { x: 0, y: 20, z: 0 });
    const runner = { pos: { ...walk.birds[0].pos, y: 20 }, speed: 3 };
    stepFlock(walk, 1 / 60, flat, runner);
    expect(walk.scatter).toBe(0);
    const sprint = createFlock(5, { x: 0, y: 20, z: 0 });
    const threat = { pos: { ...sprint.birds[0].pos, y: 20 }, speed: 9 };
    const before = sprint.birds.reduce((d, b) => d + Math.hypot(b.pos.x - threat.pos.x, b.pos.z - threat.pos.z), 0);
    stepFlock(sprint, 1 / 60, flat, threat);
    expect(sprint.scatter).toBeGreaterThan(SCATTER_SECONDS - 0.1);
    for (let i = 0; i < 90; i++) stepFlock(sprint, 1 / 60, flat, threat);
    const after = sprint.birds.reduce((d, b) => d + Math.hypot(b.pos.x - threat.pos.x, b.pos.z - threat.pos.z), 0);
    expect(after).toBeGreaterThan(before);
  });

  it('keeps one flock per Region (Verdant, Ember, Azure) in one instanced mesh', () => {
    const birds = new BirdFlocks(flat);
    const sizes = birds.sizes();
    expect(Object.keys(sizes).sort()).toEqual(['azure', 'ember', 'verdant']);
    birds.update(1 / 60, 0, { pos: { x: -250, y: 18, z: 300 }, speed: 0 });
    expect(birds.mesh.count).toBe(sizes.verdant + sizes.ember + sizes.azure);
    birds.dispose();
  });
});

describe('atmosphere particles', () => {
  it('wraps a 40 m box, one cloud per Region, counts × the preset particle scale, hidden without weight or indoors', () => {
    expect(ATMOSPHERE_BOX).toBe(40);
    const a = new AtmosphereParticles();
    expect(a.counts()).toEqual({ verdant: ATMOSPHERE_DEFS.verdant.count, ember: ATMOSPHERE_DEFS.ember.count, azure: ATMOSPHERE_DEFS.azure.count });
    a.setScale(0.5);
    expect(a.counts().verdant).toBe(Math.round(ATMOSPHERE_DEFS.verdant.count * 0.5));
    a.setScale(1.5);
    expect(a.counts().ember).toBe(Math.round(ATMOSPHERE_DEFS.ember.count * 1.5));
    a.update(1, { verdant: 0.7, ember: 0.3, azure: 0 }, 0);
    const visible = a.object.children.filter((c) => c.visible).map((c) => c.name).sort();
    expect(visible).toEqual(['atmosphere:ember', 'atmosphere:verdant']);
    a.update(1, { verdant: 1, ember: 0, azure: 0 }, 1);
    expect(a.object.children.every((c) => !c.visible)).toBe(true);
    a.dispose();
  });
});

describe('water', () => {
  it('keeps the newest 8 ripple rings, expired slots first', () => {
    const r = new RippleRings();
    for (let i = 0; i < 12; i++) r.add(i, 0, i * 0.1);
    expect(r.rings.length).toBe(MAX_RIPPLES);
    expect(r.active(1.15)).toBe(MAX_RIPPLES);
    expect(r.rings.map((v) => v.x).sort((a, b) => a - b)).toEqual([4, 5, 6, 7, 8, 9, 10, 11]);
    expect(r.active(1.1 + RIPPLE_SECONDS + 0.01)).toBe(0);
  });

  it('makes a 561 × 561 half-float height texture and a surface for every water body', () => {
    const heights = new Float32Array(561 * 561).fill(12.5);
    const tex = createHeightTexture(heights);
    expect(tex.image.width).toBe(561);
    expect(tex.type).toBe(THREE.HalfFloatType);
    expect(THREE.DataUtils.fromHalfFloat((tex.image.data as Uint16Array)[1000])).toBeCloseTo(12.5, 2);
    for (const body of WATER_BODIES) {
      const g = waterSurfaceGeometry(body);
      g.computeBoundingBox();
      expect(g.getAttribute('position').count, body.id).toBeGreaterThan(8);
      if (body.kind === 'circle') expect(g.boundingBox?.max.y).toBeCloseTo(body.level, 6);
    }
  });
});

describe('interior lighting', () => {
  it('names the InteriorVolume: a Challenge_Area, or the Sanctum hall, else none', () => {
    expect(interiorLookFor(HOLLOWROOT, { x: 0, y: 0, z: 0 })?.id).toBe('hollowroot');
    const hall = SANCTUM.hall;
    expect(interiorLookFor(null, { x: 0, y: hall.max.y, z: (hall.min.z + hall.max.z) / 2 })?.id).toBe('sanctum_hall');
    expect(interiorLookFor(null, { x: 0, y: 20, z: 0 })).toBeNull();
  });

  it('blends fog, ambient and exposure in over 1 s and back out over 1 s', () => {
    expect(INTERIOR_BLEND_SECONDS).toBe(1);
    const look = interiorLookFor(HOLLOWROOT, { x: 0, y: 0, z: 0 });
    const blend = new InteriorBlend();
    blend.update(0.5, look);
    expect(blend.weight).toBeCloseTo(0.5, 9);
    blend.update(0.5, look);
    expect(blend.weight).toBe(1);
    const fog = new THREE.Fog(0xffffff, 160, 1450);
    const hemi = new THREE.HemisphereLight(0xffffff, 0x000000, 1.4);
    const renderer = { toneMappingExposure: 1 };
    applyInterior({ fog, background: new THREE.Color(), haze: new THREE.Color(), hemi, renderer }, blend.look, blend.eased);
    expect(fog.near).toBeCloseTo(HOLLOWROOT.lighting.fogNear, 6);
    expect(fog.far).toBeCloseTo(HOLLOWROOT.lighting.fogFar, 6);
    expect(fog.color.getHex()).toBe(new THREE.Color(HOLLOWROOT.lighting.fogColor).getHex());
    expect(hemi.intensity).toBeLessThan(1.4);
    expect(renderer.toneMappingExposure).toBeGreaterThan(1);
    blend.update(0.5, null);
    expect(blend.weight).toBeCloseTo(0.5, 9);
    blend.update(0.5, null);
    expect(blend.weight).toBe(0);
    expect(blend.look).toBeNull();
    applyInterior({ fog, background: new THREE.Color(), haze: new THREE.Color(), hemi, renderer }, blend.look, blend.eased);
    expect(renderer.toneMappingExposure).toBe(1);
  });
});
