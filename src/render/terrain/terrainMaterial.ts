/*
 * The terrain material (design.md "지형 렌더링"; Req 39.3): the shared `terrain` toon instance (toonMaterial.ts, rim
 * 0.45) with the strata shader added. Every terrain chunk draws with this one material; the material split is in the
 * vertex colours (terrainColors.ts).
 *
 * Strata: vertices carry `aStrata`, the steep-slope weight (34° → 56°). There the fragment shader paints horizontal
 * bands by world height (≈ 2.6 m each, a gentle x / z warp so they do not read as ruler lines), each band its own
 * brightness and warm / cool cast with a dark crease at its bottom edge, vertical joints offset band to band and a
 * fine grain (task 24.5 review: the plain cliff faces at Breezewatch and the Azure pass), so a cliff reads as a
 * layered rock face instead of stretched triangles. Flat ground (aStrata 0) and meshes without the attribute (it
 * reads 0) are unchanged.
 *
 * The patch is chained onto the toon `onBeforeCompile` and gets its own program key (the injected code differs from
 * the plain toon program). Idempotent: the shared instance is patched once.
 */
import * as THREE from 'three';
import { sharedMaterial } from '../toonMaterial';

export const TERRAIN_PROGRAM_KEY = 'skyshard-toon-terrain-v2';

/** Strata band height (m) and the strength of the band tones / crease. */
export const STRATA_UNIFORMS = {
  uStrataPeriod: { value: 2.6 },
  uStrataContrast: { value: 1.0 },
};

function replaceOnce(source: string, search: string, replacement: string, what: string): string {
  const at = source.indexOf(search);
  if (at < 0) throw new Error(`terrainMaterial: ${what} not found in the shader (three.js chunk layout changed?)`);
  return source.slice(0, at) + replacement + source.slice(at + search.length);
}

/** Vertex patch: the strata weight and the world position to the fragment shader (exported for tests). */
export function patchStrataVertex(vertex: string): string {
  let out = replaceOnce(vertex, '#include <common>', `#include <common>
attribute float aStrata;
varying float vStrata;
varying vec3 vStrataWorld;`, 'common chunk');
  out = replaceOnce(out, '#include <project_vertex>', `#include <project_vertex>
	vStrata = aStrata;
	vStrataWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;`, 'project_vertex chunk');
  return out;
}

/** Fragment patch: world-height bands on steep faces (exported for tests). */
export function patchStrataFragment(fragment: string): string {
  let out = replaceOnce(fragment, '#include <common>', `#include <common>
uniform float uStrataPeriod;
uniform float uStrataContrast;
varying float vStrata;
varying vec3 vStrataWorld;`, 'common chunk');
  out = replaceOnce(out, '#include <color_fragment>', `#include <color_fragment>
{
	// Strata (task 18.4): horizontal rock bands by world height on steep faces.
	float strataWeight = clamp( vStrata, 0.0, 1.0 ) * uStrataContrast;
	if ( strataWeight > 0.001 ) {
		vec3 sp = vStrataWorld;
		float warp = sin( sp.x * 0.061 + sp.z * 0.023 ) * 0.9 + sin( sp.z * 0.047 - sp.x * 0.031 ) * 0.7;
		float h = ( sp.y + warp ) / uStrataPeriod;
		float layer = floor( h );
		float f = h - layer;
		float seed = fract( sin( layer * 12.9898 + 78.233 ) * 43758.5453 );
		// Each band its own tone and a slight warm / cool cast, so a tall face reads as stacked rock courses.
		float tone = mix( 0.66, 1.18, seed );
		vec3 bandTint = mix( vec3( 1.04, 1.0, 0.94 ), vec3( 0.95, 0.98, 1.05 ), fract( seed * 7.13 ) );
		float crease = mix( 0.5, 1.0, smoothstep( 0.0, 0.12, f ) );
		float cap = mix( 1.12, 1.0, smoothstep( 0.8, 0.96, f ) );
		// Vertical joints: a few dark cracks per band, offset band to band (world x + z along the face).
		float along = ( sp.x * 0.83 + sp.z * 0.56 ) / ( uStrataPeriod * 1.7 ) + seed * 5.0;
		float joint = 1.0 - 0.32 * smoothstep( 0.0, 0.05, abs( fract( along ) - 0.5 ) * 2.0 - 0.9 );
		// Fine grain (two octaves of hashed value noise) keeps the band from reading as a flat plane up close.
		vec3 g = sp * 0.9;
		float grain = fract( sin( dot( floor( g ), vec3( 127.1, 311.7, 74.7 ) ) ) * 43758.5453 );
		float grain2 = fract( sin( dot( floor( g * 2.7 ), vec3( 269.5, 183.3, 246.1 ) ) ) * 43758.5453 );
		float speckle = 0.9 + 0.12 * grain + 0.08 * grain2;
		vec3 rock = bandTint * ( tone * crease * cap * joint * speckle );
		diffuseColor.rgb *= mix( vec3( 1.0 ), rock, clamp( strataWeight, 0.0, 1.0 ) );
	}
}`, 'color_fragment chunk');
  return out;
}

const PATCHED = Symbol('skyshard.strata');

/** The shared terrain material with the strata shader (patched on first use). */
export function terrainMaterial(): THREE.MeshToonMaterial {
  const material = sharedMaterial('terrain');
  const tagged = material as THREE.MeshToonMaterial & { [PATCHED]?: true };
  if (tagged[PATCHED] === true) return material;
  tagged[PATCHED] = true;
  const toonCompile = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    toonCompile.call(material, shader, renderer);
    Object.assign(shader.uniforms, STRATA_UNIFORMS);
    shader.vertexShader = patchStrataVertex(shader.vertexShader);
    shader.fragmentShader = patchStrataFragment(shader.fragmentShader);
  };
  material.customProgramCacheKey = () => TERRAIN_PROGRAM_KEY;
  material.needsUpdate = true;
  return material;
}
