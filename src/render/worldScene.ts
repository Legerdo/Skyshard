// Open-world scene: the sky dome, one sun (or moon) DirectionalLight and one HemisphereLight driven by the
// time-of-day preset (task 18.2, src/render/timeOfDay.ts), and the distance fog whose colour is the preset's fog
// colour × the Region fog tint of the grading blend at the player (src/render/grading.ts); the dome's horizon haze
// uses the same colour, so far terrain meets the sky without a seam. The sun's shadow defaults set here are replaced
// by the render pipeline (task 18.5, src/render/shadows.ts): the 80 m texel-snapped box at the Active_Character, the
// map size from the shadow setting, and the interior lighting blend applied over this scene's values.
//
// Per frame (main.ts): `follow(focus)` for the shadow box, then `update(realDt, { focus, sky })` with the session's
// SkyDirector request; before the first request the scene shows the morning preset.

import * as THREE from 'three';
import type { Vec3 } from '../core/types';
import { RegionGrading } from './grading';
import { createSkyDome, type SkyDome } from './sky';
import { TimeOfDayState, type SkyRequest } from './timeOfDay';
import { TOON_UNIFORMS } from './toonMaterial';

/** Sun placed this far from the focus along its direction; the shadow box spans ±SHADOW_HALF_EXTENT. */
const SUN_DISTANCE = 100;
const SHADOW_HALF_EXTENT = 24;
const SHADOW_MAP_SIZE = 1024;

export interface WorldSceneFrame {
  /** The Active_Character's feet: the Region grading blend is taken here. */
  readonly focus: Readonly<Vec3>;
  /** The session's time-of-day request (cut or blend); omitted keeps the current look. */
  readonly sky?: SkyRequest;
}

export interface WorldScene {
  readonly scene: THREE.Scene;
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly sky: SkyDome;
  readonly timeOfDay: TimeOfDayState;
  readonly grading: RegionGrading;
  /** Final fog colour (linear): scene.fog, the background and the dome haze share it. */
  readonly fogColor: THREE.Color;
  /** Centres the sun's shadow box on `focus` (the Active_Character's feet). */
  follow(focus: Readonly<Vec3>): void;
  /** Advances the time-of-day blend and the grading, then applies lights, fog, dome and toon uniforms. */
  update(realDt: number, frame: WorldSceneFrame): void;
  dispose(): void;
}

export function createWorldScene(): WorldScene {
  const scene = new THREE.Scene();
  const fogColor = new THREE.Color(0xd2e6f4);
  const fog = new THREE.Fog(fogColor.getHex(), 160, 1450);
  scene.fog = fog;
  scene.background = fogColor; // under the dome; only seen if the dome were missing

  const timeOfDay = new TimeOfDayState('morning');
  const grading = new RegionGrading();
  const sky = createSkyDome();
  scene.add(sky.mesh);

  const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
  hemi.name = 'hemisphere';
  const sun = new THREE.DirectionalLight(0xffffff, 1);
  sun.name = 'sun';
  sun.castShadow = true;
  sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.02;
  const box = sun.shadow.camera;
  box.left = -SHADOW_HALF_EXTENT;
  box.right = SHADOW_HALF_EXTENT;
  box.top = SHADOW_HALF_EXTENT;
  box.bottom = -SHADOW_HALF_EXTENT;
  box.near = 1;
  box.far = SUN_DISTANCE * 2;
  box.updateProjectionMatrix();
  scene.add(hemi, sun, sun.target); // the target must be in the scene for its matrix to update

  const focusNow = new THREE.Vector3();
  let time = 0;

  const placeSun = (): void => {
    const dir = timeOfDay.current.sunDir;
    sun.target.position.copy(focusNow);
    sun.position.copy(focusNow).addScaledVector(dir, SUN_DISTANCE);
  };

  const apply = (): void => {
    const v = timeOfDay.current;
    sun.color.copy(v.sunColor);
    sun.intensity = v.sunIntensity;
    hemi.color.copy(v.hemiSky);
    hemi.groundColor.copy(v.hemiGround);
    hemi.intensity = v.hemiIntensity;
    // Final fog colour: the preset's fog × the blended Region fog tint (linear).
    fogColor.copy(v.fogColor).multiply(grading.blend.fogTint);
    fog.color.copy(fogColor);
    fog.near = v.fogNear;
    fog.far = v.fogFar;
    const u = sky.uniforms;
    u.uTop.value.copy(v.skyTop);
    u.uHorizon.value.copy(v.skyHorizon);
    u.uHaze.value.copy(fogColor);
    u.uSunDir.value.copy(v.sunDir);
    u.uSunColor.value.copy(v.sunColor);
    u.uMoon.value = v.moon;
    u.uClouds.value = v.clouds;
    u.uStars.value = v.stars;
    u.uTime.value = time;
    TOON_UNIFORMS.uRimStrength.value = v.rimStrength;
    placeSun();
  };
  grading.update({ x: 0, y: 0, z: 0 });
  apply();

  return {
    scene,
    sun,
    hemi,
    sky,
    timeOfDay,
    grading,
    fogColor,
    follow(focus: Readonly<Vec3>): void {
      focusNow.set(focus.x, focus.y, focus.z);
      placeSun();
    },
    update(realDt: number, frame: WorldSceneFrame): void {
      const dt = Number.isFinite(realDt) && realDt > 0 ? realDt : 0;
      time += dt;
      if (frame.sky !== undefined) timeOfDay.set(frame.sky.preset, frame.sky.blendSeconds);
      timeOfDay.update(dt);
      focusNow.set(frame.focus.x, frame.focus.y, frame.focus.z);
      grading.update(frame.focus);
      apply();
    },
    dispose(): void {
      sun.shadow.dispose();
      sky.dispose();
      scene.clear();
    },
  };
}
