/*
 * Wind and bend for the vegetation (design.md "식생·바위·소품"; Req 39.4, 39.5): the shared `foliage` toon instance
 * (toonMaterial.ts, rim 0.7) with a vertex patch. Every grass clump, flower, bush and tree draws with this one
 * material; how much each vertex moves is in the geometry's `aSway` attribute:
 * - aSway.x: wind weight, 0 at the base rising with height, so bases stay planted and tips sway the most. The offset
 *   is `uWindDir × uWindStrength × aSway.x` times a two-sine wave phased by the instance's world position, under a
 *   slow gust envelope;
 * - aSway.y: bend weight (grass and flowers). Within `uBendRadius` (1 m) of `uBendPos` (the Active_Character's feet)
 *   the vertex is pushed along `uBendDir` (the character's movement direction, scaled by speed) plus a little away
 *   from the feet, and lowered, so the grass lies down where the character walks.
 * Meshes without the attribute (it reads 0) do not move. The patch replaces three.js' project_vertex chunk with the
 * same transform plus the world-space offsets, and gets its own program key. Idempotent.
 */
import * as THREE from 'three';
import { VEGETATION_WIND } from '../../data/vegetation';
import { sharedMaterial } from '../toonMaterial';

export const VEGETATION_PROGRAM_KEY = 'skyshard-toon-foliage-wind-v1';

/** Uniforms shared by every vegetation program (one object each). */
export const VEGETATION_UNIFORMS = {
  uWindTime: { value: 0 },
  uWindDir: { value: new THREE.Vector2(VEGETATION_WIND.dirX, VEGETATION_WIND.dirZ).normalize() },
  uWindStrength: { value: VEGETATION_WIND.strength as number },
  uBendPos: { value: new THREE.Vector3(0, -10000, 0) },
  uBendDir: { value: new THREE.Vector2(0, 0) },
  uBendRadius: { value: VEGETATION_WIND.bendRadius as number },
};

function replaceOnce(source: string, search: string, replacement: string, what: string): string {
  const at = source.indexOf(search);
  if (at < 0) throw new Error(`windMaterial: ${what} not found in the shader (three.js chunk layout changed?)`);
  return source.slice(0, at) + replacement + source.slice(at + search.length);
}

const WIND_PARS = /* glsl */ `#include <common>
attribute vec2 aSway;
uniform float uWindTime;
uniform vec2 uWindDir;
uniform float uWindStrength;
uniform vec3 uBendPos;
uniform vec2 uBendDir;
uniform float uBendRadius;`;

const WIND_PROJECT = /* glsl */ `vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_BATCHING
	mvPosition = batchingMatrix * mvPosition;
#endif
#ifdef USE_INSTANCING
	mvPosition = instanceMatrix * mvPosition;
	vec3 swayOrigin = ( modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
#else
	vec3 swayOrigin = ( modelMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
#endif
vec4 swayWorld = modelMatrix * mvPosition;
{
	// Wind (task 18.4): height-weighted sway, phased by the instance position, under a slow gust.
	float swayPhase = dot( swayOrigin.xz, vec2( 0.173, 0.131 ) );
	float gust = 0.6 + 0.4 * sin( uWindTime * 0.37 + swayOrigin.x * 0.013 - swayOrigin.z * 0.009 );
	float wave = sin( uWindTime * 1.9 + swayPhase ) * 0.7 + sin( uWindTime * 3.3 + swayPhase * 1.7 ) * 0.3;
	swayWorld.xz += uWindDir * ( 0.45 + 0.55 * wave ) * gust * uWindStrength * aSway.x;
	// Bend: grass within uBendRadius of the character lies down along its movement.
	vec2 toBlade = swayOrigin.xz - uBendPos.xz;
	float bendDist = length( toBlade );
	float bendFall = ( 1.0 - smoothstep( uBendRadius * 0.35, uBendRadius, bendDist ) )
		* ( 1.0 - smoothstep( 1.0, 2.5, abs( swayOrigin.y - uBendPos.y ) ) ) * aSway.y;
	vec2 away = bendDist > 1e-3 ? toBlade / bendDist : vec2( 0.0 );
	swayWorld.xz += ( uBendDir + away * 0.35 ) * bendFall * 0.5;
	swayWorld.y -= bendFall * 0.3;
}
mvPosition = viewMatrix * swayWorld;
gl_Position = projectionMatrix * mvPosition;`;

/** The foliage vertex shader with wind and bend (exported for tests). */
export function patchWindVertex(vertex: string): string {
  const out = replaceOnce(vertex, '#include <common>', WIND_PARS, 'common chunk');
  return replaceOnce(out, '#include <project_vertex>', WIND_PROJECT, 'project_vertex chunk');
}

const PATCHED = Symbol('skyshard.wind');

/** The shared foliage material with the wind / bend patch (patched on first use). */
export function vegetationMaterial(): THREE.MeshToonMaterial {
  const material = sharedMaterial('foliage');
  const tagged = material as THREE.MeshToonMaterial & { [PATCHED]?: true };
  if (tagged[PATCHED] === true) return material;
  tagged[PATCHED] = true;
  const toonCompile = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    toonCompile.call(material, shader, renderer);
    Object.assign(shader.uniforms, VEGETATION_UNIFORMS);
    shader.vertexShader = patchWindVertex(shader.vertexShader);
  };
  material.customProgramCacheKey = () => VEGETATION_PROGRAM_KEY;
  material.needsUpdate = true;
  return material;
}

/** Advances the wind clock and moves the bend to the character (`dir`: movement direction × speed factor 0–1). */
export function setVegetationBend(time: number, pos: Readonly<{ x: number; y: number; z: number }> | null, dirX = 0, dirZ = 0): void {
  const u = VEGETATION_UNIFORMS;
  u.uWindTime.value = Number.isFinite(time) ? time % 3600 : 0;
  if (pos === null || !Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) {
    u.uBendPos.value.set(0, -10000, 0);
    u.uBendDir.value.set(0, 0);
    return;
  }
  u.uBendPos.value.set(pos.x, pos.y, pos.z);
  const len = Math.hypot(dirX, dirZ);
  if (len > 1) u.uBendDir.value.set(dirX / len, dirZ / len);
  else if (Number.isFinite(len)) u.uBendDir.value.set(dirX, dirZ);
  else u.uBendDir.value.set(0, 0);
}
