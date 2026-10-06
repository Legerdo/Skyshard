import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createGameEventBus } from '../../../src/core/gameEvents';
import { REGION_IDS } from '../../../src/data/ids';
import { REGION_PALETTES } from '../../../src/data/palettes';
import { TIME_OF_DAY_PRESETS, type TimeOfDayProgress } from '../../../src/data/timeOfDay';
import { blendGrading, GRADING_UNIFORMS, RegionGrading, regionWeights } from '../../../src/render/grading';
import { SKY_RADIUS } from '../../../src/render/sky';
import { bossSkyOf, presetValues, SkyDirector, TimeOfDayState } from '../../../src/render/timeOfDay';
import { TOON_UNIFORMS } from '../../../src/render/toonMaterial';
import { createWorldScene } from '../../../src/render/worldScene';

// Task 18.2: sky dome, time-of-day blends and the SkyDirector, the Region grading blend and its world-scene wiring
// (three.js objects in Node, no WebGL).

const EMBER = { x: 300, y: 10, z: 250 };
const VERDANT = { x: -250, y: 20, z: 300 };
const SANCTUM = { x: 0, y: 181, z: 10 };

const sum = (w: Record<string, number>): number => Object.values(w).reduce((a, b) => a + b, 0);
const close = (a: THREE.Color, b: THREE.Color, eps = 1e-6): boolean =>
  Math.abs(a.r - b.r) < eps && Math.abs(a.g - b.g) < eps && Math.abs(a.b - b.b) < eps;

describe('Region weights and the grading blend', () => {
  it('normalises the Region weights to 1 everywhere (world corners, borders, crater, Sanctum heights)', () => {
    const ys = [0, 60, 150, 175, 200];
    for (let x = -560; x <= 560; x += 40) {
      for (let z = -560; z <= 560; z += 40) {
        for (const y of ys) {
          const w = regionWeights({ x, y, z });
          expect(sum(w)).toBeCloseTo(1, 9);
          for (const id of REGION_IDS) expect(w[id]).toBeGreaterThanOrEqual(0);
        }
      }
    }
    expect(regionWeights(EMBER).ember).toBeCloseTo(1, 9);
    expect(regionWeights(VERDANT).verdant).toBeCloseTo(1, 9);
    expect(regionWeights(SANCTUM).sanctum).toBeCloseTo(1, 9);
    expect(regionWeights({ x: 0, y: 5, z: 0 }).crater).toBeCloseTo(1, 9);
    expect(sum(regionWeights({ x: Number.NaN, y: Number.NaN, z: Number.NaN }))).toBeCloseTo(1, 9);
  });

  it('never cuts at a border: 1 m steps change a weight by a few percent at most', () => {
    // Verdant → crater → Ember along z 150, and Verdant → Azure along x −200.
    const lines: [number, number, number, number][] = [[-460, 150, 460, 150], [-200, 420, -200, -420]];
    for (const [x0, z0, x1, z1] of lines) {
      const steps = Math.round(Math.hypot(x1 - x0, z1 - z0));
      let prev = regionWeights({ x: x0, y: 10, z: z0 });
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const w = regionWeights({ x: x0 + (x1 - x0) * t, y: 10, z: z0 + (z1 - z0) * t });
        for (const id of REGION_IDS) expect(Math.abs(w[id] - prev[id])).toBeLessThan(0.1);
        prev = w;
      }
    }
  });

  it('blends fog tint, rim colour, saturation and contrast by the weights in linear colour', () => {
    const pure = blendGrading({ verdant: 0, ember: 1, azure: 0, crater: 0, sanctum: 0 });
    const g = REGION_PALETTES.ember.grading;
    expect(close(pure.rimColor, new THREE.Color(g.rimColor))).toBe(true);
    expect(close(pure.fogTint, new THREE.Color(g.fogTint))).toBe(true);
    expect([pure.saturation, pure.contrast]).toEqual([g.saturation, g.contrast]);
    const half = blendGrading({ verdant: 0.5, ember: 0.5, azure: 0, crater: 0, sanctum: 0 });
    const expected = new THREE.Color(REGION_PALETTES.verdant.grading.rimColor).lerp(new THREE.Color(g.rimColor), 0.5);
    expect(close(half.rimColor, expected)).toBe(true);
    expect(half.saturation).toBeCloseTo((1.1 + 1.05) / 2, 12);
  });

  it('drives the shared uRimColor every update and hands the grade to the GradingPass or the toon fallback', () => {
    const grading = new RegionGrading();
    grading.update(EMBER);
    expect(close(TOON_UNIFORMS.uRimColor.value, new THREE.Color(REGION_PALETTES.ember.grading.rimColor))).toBe(true);
    expect(grading.dominant).toBe('ember');
    expect(GRADING_UNIFORMS.uGradeSaturation.value).toBeCloseTo(1.05, 12);
    expect(GRADING_UNIFORMS.uGradeContrast.value).toBeCloseTo(1.12, 12);
    // Post-processing off: tint and saturation go to the toon materials.
    expect(TOON_UNIFORMS.uGradeSaturation.value).toBeCloseTo(1.05, 12);
    expect(close(TOON_UNIFORMS.uGradeTint.value, GRADING_UNIFORMS.uGradeTint.value)).toBe(true);
    grading.update(SANCTUM);
    expect(close(TOON_UNIFORMS.uRimColor.value, new THREE.Color(REGION_PALETTES.sanctum.grading.rimColor))).toBe(true);
    // GradingPass running: the toon fallback goes neutral (the grade is not applied twice).
    grading.gradingPassActive = true;
    grading.update(EMBER);
    expect(TOON_UNIFORMS.uGradeSaturation.value).toBe(1);
    expect(TOON_UNIFORMS.uGradeTint.value.getHex()).toBe(0xffffff);
    expect(GRADING_UNIFORMS.uGradeSaturation.value).toBeCloseTo(1.05, 12);
  });
});

describe('TimeOfDayState', () => {
  it('cuts at once, or blends every value over the given seconds (colours lerp, sun direction slerp)', () => {
    const state = new TimeOfDayState('noon');
    const noon = presetValues(TIME_OF_DAY_PRESETS.noon);
    const dusk = presetValues(TIME_OF_DAY_PRESETS.dusk);
    expect(close(state.current.fogColor, noon.fogColor)).toBe(true);
    state.set('dusk', 4);
    expect([state.target, state.blending]).toEqual(['dusk', true]);
    state.update(2);
    // Half-way (eased 0.5): colours are the linear midpoint, the sun direction half the arc.
    expect(close(state.current.skyTop, noon.skyTop.clone().lerp(dusk.skyTop, 0.5))).toBe(true);
    expect(state.current.hemiIntensity).toBeCloseTo((noon.hemiIntensity + dusk.hemiIntensity) / 2, 12);
    expect(state.current.sunDir.length()).toBeCloseTo(1, 12);
    const total = noon.sunDir.angleTo(dusk.sunDir);
    expect(noon.sunDir.angleTo(state.current.sunDir)).toBeCloseTo(total / 2, 6);
    expect(state.current.sunDir.angleTo(dusk.sunDir)).toBeCloseTo(total / 2, 6);
    state.update(1.99);
    expect(state.blending).toBe(true);
    state.update(0.02);
    expect(state.blending).toBe(false);
    expect(close(state.current.fogColor, dusk.fogColor)).toBe(true);
    expect(state.current.sunDir.distanceTo(dusk.sunDir)).toBeLessThan(1e-9);
    // A cut (a load) applies the whole preset in the same call.
    state.set('starNight', 0);
    expect(state.current.moon).toBe(1);
    expect(state.current.stars).toBe(1);
  });
});

describe('SkyDirector', () => {
  const progress = (skyshards: 0 | 1 | 2 | 3, altarActivated = false, gameCompleted = false): TimeOfDayProgress =>
    ({ skyshards, altarActivated, gameCompleted });

  it('cuts after a load and outside the cinematics, blends 4 s inside cin_skyshard_1–3 and cin_altar', () => {
    const bus = createGameEventBus();
    const director = new SkyDirector(bus);
    expect(director.update(0.016, progress(2), null, null)).toEqual({ preset: 'afternoon', blendSeconds: 0 });
    // The acquisition event (it starts cin_skyshard_3) opens the blend.
    bus.emit('skyshard:acquired', { index: 3, regionId: 'azure' });
    bus.dispatch();
    expect(director.update(0.016, progress(3), null, 'cin_skyshard_3')).toEqual({ preset: 'dusk', blendSeconds: 4 });
    expect(director.update(0.016, progress(3), null, 'cin_skyshard_3')).toEqual({ preset: 'dusk', blendSeconds: 4 });
    // Inside cin_altar.
    expect(director.update(0.016, progress(3, true), null, 'cin_altar')).toEqual({ preset: 'starNight', blendSeconds: 4 });
    // The ending's sunrise cuts (under the Victory Screen).
    expect(director.update(0.016, progress(3, true, true), null, null)).toEqual({ preset: 'sunrise', blendSeconds: 0 });
    director.dispose();

    // A progress change with no cinematic (debug set, a harness) cuts.
    const other = new SkyDirector(bus);
    other.update(0.016, progress(0), null, null);
    expect(other.update(5, progress(1), null, null)).toEqual({ preset: 'noon', blendSeconds: 0 });
    other.dispose();
  });

  it('shows the arena dusk in Phases 1–2 and the starlit night from the Final Phase, from the boss snapshot', () => {
    const director = new SkyDirector(createGameEventBus());
    const after = progress(3, true);
    expect(director.update(0.016, after, bossSkyOf({ state: 'dormant', skyPreset: 'dusk' }), null).preset).toBe('starNight');
    expect(director.update(0.016, after, bossSkyOf({ state: 'intro', skyPreset: 'dusk' }), null)).toEqual({ preset: 'dusk', blendSeconds: 4 });
    expect(director.update(0.016, after, bossSkyOf({ state: 'attack', skyPreset: 'dusk' }), null).preset).toBe('dusk');
    expect(director.update(0.016, after, bossSkyOf({ state: 'transition', skyPreset: 'starNight' }), null))
      .toEqual({ preset: 'starNight', blendSeconds: 4 });
    expect(bossSkyOf({ state: 'dead', skyPreset: 'starNight' })).toBeNull();
    director.dispose();
  });
});

describe('world scene sky, lights and fog', () => {
  it('has a 2,000 m BackSide dome without depth writes that follows the camera, drawn first', () => {
    const world = createWorldScene();
    const { mesh } = world.sky;
    const material = mesh.material as THREE.ShaderMaterial;
    expect(material).toBeInstanceOf(THREE.ShaderMaterial);
    expect([material.side, material.depthWrite, material.fog]).toEqual([THREE.BackSide, false, false]);
    expect((mesh.geometry as THREE.SphereGeometry).parameters.radius).toBe(SKY_RADIUS);
    expect(SKY_RADIUS).toBe(2000);
    for (const s of ['uStars', 'uClouds', 'uSunDir', 'uMoon', 'uHaze']) expect(material.fragmentShader).toContain(s);
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 2200);
    camera.position.set(120, 40, -300);
    camera.updateMatrixWorld();
    mesh.onBeforeRender({} as THREE.WebGLRenderer, world.scene, camera, mesh.geometry, material, null as unknown as THREE.Group);
    expect(mesh.matrixWorld.elements.slice(12, 15)).toEqual([120, 40, -300]);
    expect(world.scene.children.filter((o) => o instanceof THREE.DirectionalLight)).toHaveLength(1);
    expect(world.scene.children.filter((o) => o instanceof THREE.HemisphereLight)).toHaveLength(1);
    world.dispose();
  });

  it('drives the sun, hemisphere, fog and dome from the preset, the fog colour shared by scene.fog and the dome haze', () => {
    const world = createWorldScene();
    world.update(0.016, { focus: EMBER, sky: { preset: 'noon', blendSeconds: 0 } });
    const noon = TIME_OF_DAY_PRESETS.noon;
    const fog = world.scene.fog as THREE.Fog;
    const expected = new THREE.Color(noon.fogColor).multiply(new THREE.Color(REGION_PALETTES.ember.grading.fogTint));
    expect(close(fog.color, expected)).toBe(true);
    expect(close(world.sky.uniforms.uHaze.value, fog.color)).toBe(true);
    expect(close(world.fogColor, fog.color)).toBe(true);
    expect([fog.near, fog.far]).toEqual([noon.fogNear, noon.fogFar]);
    expect([world.sun.intensity, world.hemi.intensity]).toEqual([noon.sunIntensity, noon.hemiIntensity]);
    expect(close(world.hemi.color, new THREE.Color(noon.hemiSky))).toBe(true);
    expect(close(TOON_UNIFORMS.uRimColor.value, new THREE.Color(REGION_PALETTES.ember.grading.rimColor))).toBe(true);
    expect(TOON_UNIFORMS.uRimStrength.value).toBe(noon.rimStrength);
    // The sun sits along the preset direction from the focus.
    const toSun = world.sun.position.clone().sub(world.sun.target.position).normalize();
    expect(toSun.distanceTo(presetValues(noon).sunDir)).toBeLessThan(1e-9);
    expect(world.sun.target.position.toArray()).toEqual([EMBER.x, EMBER.y, EMBER.z]);

    // Walking into Verdant retints the fog and the dome haze together, the same frame.
    world.update(0.016, { focus: VERDANT, sky: { preset: 'noon', blendSeconds: 0 } });
    const verdantFog = new THREE.Color(noon.fogColor).multiply(new THREE.Color(REGION_PALETTES.verdant.grading.fogTint));
    expect(close(fog.color, verdantFog)).toBe(true);
    expect(close(world.sky.uniforms.uHaze.value, verdantFog)).toBe(true);

    // A 4 s blend to the starlit night: in between after 2 s, there after 4 s; the night hemisphere stays ≥ 60 % of noon.
    world.update(0.016, { focus: VERDANT, sky: { preset: 'starNight', blendSeconds: 4 } });
    world.update(2, { focus: VERDANT, sky: { preset: 'starNight', blendSeconds: 4 } });
    expect(world.sky.uniforms.uStars.value).toBeGreaterThan(0);
    expect(world.sky.uniforms.uStars.value).toBeLessThan(1);
    world.update(2.1, { focus: VERDANT, sky: { preset: 'starNight', blendSeconds: 4 } });
    expect(world.sky.uniforms.uStars.value).toBe(1);
    expect(world.sky.uniforms.uMoon.value).toBe(1);
    expect(world.hemi.intensity).toBeGreaterThanOrEqual(0.6 * noon.hemiIntensity);
    world.dispose();
  });
});
