/*
 * Rig materials (design.md "Rigid skinning 병합" 재질 instance, Req 39.1): the shared toon material extended with the
 * face atlas and Element glow, and the rig outline that collapses the face plane.
 *
 * - Body: `sharedMaterialVariant(kind)` (the toon rim, grading and fog cap) plus `faceMap`·`faceCell`·`uGlow`·
 *   `uGlowColor`·`uFlash`·`uFlashColor` uniforms. Vertices with `aFx.y = 1` (the face plane) take the atlas cell
 *   `faceCell` = (mouth column, eye row) over their skin colour; `aFx.x` is the Element accent glow, emitted as
 *   `uGlowColor · aFx.x · uGlow`. Blinking, talking, glow and hit flash change uniforms only. Every rig material
 *   shares one program (RIG_PROGRAM_KEY).
 * - Outline: the inverted-hull outline material with vertex colours; face-plane vertices collapse to the origin, so
 *   the outline never draws a rim around the face. One shared instance (RIG_OUTLINE_PROGRAM_KEY).
 */
import * as THREE from 'three';
import { createOutlineMaterial, sharedMaterialVariant } from '../render/toonMaterial';

export const RIG_PROGRAM_KEY = 'skyshard-toon-rig-v1';
export const RIG_OUTLINE_PROGRAM_KEY = 'skyshard-outline-rig-v1';
/** Face atlas: 768 px square, 3 × 3 cells of 256 px, 8 px margins (design "얼굴"). */
export const FACE_ATLAS_SIZE = 768;
export const FACE_CELL_SIZE = 256;
export const FACE_CELL_MARGIN = 8;
/** Emission of a fully lit glow line at uGlow 1. */
const GLOW_GAIN = 1.8;

export interface RigUniforms {
  faceMap: { value: THREE.Texture };
  /** (mouth column, eye row). */
  faceCell: { value: THREE.Vector2 };
  uGlow: { value: number };
  uGlowColor: { value: THREE.Color };
  uFlash: { value: number };
  uFlashColor: { value: THREE.Color };
  /** Death dissolve 0 (whole) → 1 (gone): fragments whose noise threshold is below it are discarded. */
  uDissolve: { value: number };
  /** Colour of the glowing dissolve edge. */
  uDissolveColor: { value: THREE.Color };
  /** 0: noise dissolve (enemies); 1: rising from the feet to the head (Caelith, design "사망"). */
  uDissolveRise: { value: number };
  /** Rig height (m): normalises the rest-pose height for the rising dissolve. */
  uRigHeight: { value: number };
}

/** Width of the glowing band at the dissolve edge (threshold units). */
const DISSOLVE_EDGE = 0.08;

let blankFace: THREE.DataTexture | null = null;

/** 1 × 1 transparent texture for rigs without a face atlas (Node, faceless enemies). */
export function blankFaceTexture(): THREE.DataTexture {
  if (blankFace === null) {
    blankFace = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, THREE.RGBAFormat);
    blankFace.needsUpdate = true;
  }
  return blankFace;
}

function replaceOnce(source: string, search: string, replacement: string, what: string): string {
  const at = source.indexOf(search);
  if (at < 0) throw new Error(`rigMaterial: ${what} not found in the shader (three.js chunk layout changed?)`);
  return source.slice(0, at) + replacement + source.slice(at + search.length);
}

/** The toon vertex shader with the aFx / uv varyings (exported for tests). */
export function patchRigVertex(vertex: string): string {
  let out = replaceOnce(vertex, '#include <common>', `#include <common>
attribute vec2 aFx;
varying vec2 vRigFx;
varying vec2 vRigUv;
varying vec3 vRigPos;`, 'common chunk');
  out = replaceOnce(out, '#include <begin_vertex>', `#include <begin_vertex>
vRigFx = aFx;
vRigUv = uv;
vRigPos = position;`, 'begin_vertex chunk');
  return out;
}

/** The (toon-patched) fragment shader with the face atlas, glow and flash (exported for tests). */
export function patchRigFragment(fragment: string): string {
  let out = replaceOnce(fragment, '#include <common>', `#include <common>
uniform sampler2D faceMap;
uniform vec2 faceCell;
uniform float uGlow;
uniform vec3 uGlowColor;
uniform float uFlash;
uniform vec3 uFlashColor;
uniform float uDissolve;
uniform vec3 uDissolveColor;
uniform float uDissolveRise;
uniform float uRigHeight;
varying vec2 vRigFx;
varying vec2 vRigUv;
varying vec3 vRigPos;
float rigHash( vec3 p ) {
	p = fract( p * vec3( 0.1031, 0.1030, 0.0973 ) );
	p += dot( p, p.yxz + 33.33 );
	return fract( ( p.x + p.y ) * p.z );
}
float rigNoise( vec3 p ) {
	vec3 i = floor( p );
	vec3 f = fract( p );
	f = f * f * ( 3.0 - 2.0 * f );
	float a = mix( mix( rigHash( i ), rigHash( i + vec3( 1.0, 0.0, 0.0 ) ), f.x ), mix( rigHash( i + vec3( 0.0, 1.0, 0.0 ) ), rigHash( i + vec3( 1.0, 1.0, 0.0 ) ), f.x ), f.y );
	float b = mix( mix( rigHash( i + vec3( 0.0, 0.0, 1.0 ) ), rigHash( i + vec3( 1.0, 0.0, 1.0 ) ), f.x ), mix( rigHash( i + vec3( 0.0, 1.0, 1.0 ) ), rigHash( i + vec3( 1.0 ) ), f.x ), f.y );
	return mix( a, b, f.z );
}`, 'common chunk');
  out = replaceOnce(out, '#include <color_fragment>', `#include <color_fragment>
float rigDissolveEdge = 0.0;
if ( uDissolve > 0.0 ) {
	// Threshold per fragment: noise over the rest-pose body, or its normalised height (rising dissolve) with a
	// little noise; the band just above the cut glows.
	float n = rigNoise( vRigPos * ( 6.0 / max( uRigHeight, 0.5 ) ) + 1.7 ) * 0.7 + rigNoise( vRigPos * ( 17.0 / max( uRigHeight, 0.5 ) ) ) * 0.3;
	float rise = clamp( vRigPos.y / max( uRigHeight, 0.01 ), 0.0, 1.0 );
	float threshold = mix( n, rise * 0.85 + n * 0.15, uDissolveRise ) * ( 1.0 - ${DISSOLVE_EDGE.toFixed(2)} ) + ${DISSOLVE_EDGE.toFixed(2)};
	if ( threshold < uDissolve ) discard;
	rigDissolveEdge = 1.0 - smoothstep( 0.0, ${DISSOLVE_EDGE.toFixed(2)}, threshold - uDissolve );
}
if ( vRigFx.y > 0.5 ) {
	// Atlas cell (column = mouth, row = eyes) inside its ${FACE_CELL_MARGIN} px margin; canvas rows run downward.
	vec2 cellUv = clamp( vRigUv, 0.0, 1.0 );
	float px = faceCell.x * ${FACE_CELL_SIZE.toFixed(1)} + ${FACE_CELL_MARGIN.toFixed(1)} + cellUv.x * ${(FACE_CELL_SIZE - 2 * FACE_CELL_MARGIN).toFixed(1)};
	float py = faceCell.y * ${FACE_CELL_SIZE.toFixed(1)} + ${FACE_CELL_MARGIN.toFixed(1)} + ( 1.0 - cellUv.y ) * ${(FACE_CELL_SIZE - 2 * FACE_CELL_MARGIN).toFixed(1)};
	vec4 faceTexel = texture2D( faceMap, vec2( px, ${FACE_ATLAS_SIZE.toFixed(1)} - py ) / ${FACE_ATLAS_SIZE.toFixed(1)} );
	diffuseColor.rgb = mix( diffuseColor.rgb, faceTexel.rgb, faceTexel.a );
}`, 'color_fragment chunk');
  out = replaceOnce(out, '#include <emissivemap_fragment>', `#include <emissivemap_fragment>
totalEmissiveRadiance += uGlowColor * ( vRigFx.x * uGlow * ${GLOW_GAIN.toFixed(2)} ) + uFlashColor * uFlash + uDissolveColor * ( rigDissolveEdge * 2.5 );`, 'emissivemap_fragment chunk');
  return out;
}

export interface RigMaterialOptions {
  readonly kind?: 'character' | 'enemy';
  readonly faceMap?: THREE.Texture | null;
  readonly glowColor?: THREE.ColorRepresentation;
  readonly glow?: number;
  /** Rig height (m) for the rising dissolve; default 1.8. */
  readonly height?: number;
}

/** The rig uniforms of a rig material (undefined for other materials). */
export function rigUniformsOf(material: THREE.Material): RigUniforms | undefined {
  return (material.userData as { rig?: RigUniforms }).rig;
}

/** A rig's own toon material instance with face / glow / flash uniforms (one program for every rig). */
export function createRigMaterial(opts: RigMaterialOptions = {}): THREE.MeshToonMaterial {
  const material = sharedMaterialVariant(opts.kind ?? 'character');
  material.name = `toon:rig:${opts.kind ?? 'character'}`;
  const uniforms: RigUniforms = {
    faceMap: { value: opts.faceMap ?? blankFaceTexture() },
    faceCell: { value: new THREE.Vector2(0, 0) },
    uGlow: { value: opts.glow ?? 0.3 },
    uGlowColor: { value: new THREE.Color(opts.glowColor ?? 0xffffff) },
    uFlash: { value: 0 },
    uFlashColor: { value: new THREE.Color(0xffffff) },
    uDissolve: { value: 0 },
    uDissolveColor: { value: new THREE.Color(0xcfe8ff) },
    uDissolveRise: { value: 0 },
    uRigHeight: { value: opts.height ?? 1.8 },
  };
  Object.defineProperty(material.userData, 'rig', { value: uniforms, enumerable: false, writable: true, configurable: true });
  const toonCompile = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    toonCompile.call(material, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = patchRigVertex(shader.vertexShader);
    shader.fragmentShader = patchRigFragment(shader.fragmentShader);
  };
  material.customProgramCacheKey = () => RIG_PROGRAM_KEY;
  return material;
}

/** Outline vertex patch: face-plane vertices (aFx.y = 1) collapse to one point (exported for tests). */
export function patchRigOutlineVertex(vertex: string): string {
  const out = replaceOnce(vertex, '#include <common>', '#include <common>\nattribute vec2 aFx;', 'common chunk');
  return replaceOnce(out, '#include <project_vertex>', `if ( aFx.y > 0.5 ) transformed = vec3( 0.0 );
#include <project_vertex>`, 'project_vertex chunk');
}

let rigOutline: THREE.MeshBasicMaterial | null = null;

/** The shared outline of every rig body (vertex colour × 35 %, face plane collapsed). */
export function rigOutlineMaterial(): THREE.MeshBasicMaterial {
  if (rigOutline !== null) return rigOutline;
  const material = createOutlineMaterial(undefined, { vertexColors: true });
  material.name = 'outline:rig';
  const outlineCompile = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    outlineCompile.call(material, shader, renderer);
    shader.vertexShader = patchRigOutlineVertex(shader.vertexShader);
  };
  material.customProgramCacheKey = () => RIG_OUTLINE_PROGRAM_KEY;
  rigOutline = material;
  return material;
}

// ── Elite aura and Caelith's star cape ──────────────────────────────────────

export const RIG_AURA_PROGRAM_KEY = 'skyshard-rig-aura-v1';
export const RIG_CAPE_PROGRAM_KEY = 'skyshard-rig-cape-v1';

/** Aura shell vertex shader: the rig geometry skinned, pushed `uWidth` m along the skinned normal (face collapsed). */
export const AURA_VERTEX = /* glsl */ `
#include <common>
#include <skinning_pars_vertex>
attribute vec2 aFx;
uniform float uWidth;
varying vec3 vAuraNormal;
varying vec3 vAuraView;
void main() {
	#include <beginnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <begin_vertex>
	#include <skinning_vertex>
	vec3 auraN = normalize( objectNormal );
	transformed += auraN * uWidth;
	if ( aFx.y > 0.5 ) transformed = vec3( 0.0 );
	vec4 mvPosition = modelViewMatrix * vec4( transformed, 1.0 );
	vAuraNormal = normalize( normalMatrix * auraN );
	vAuraView = normalize( -mvPosition.xyz );
	gl_Position = projectionMatrix * mvPosition;
}`;

/** Aura shell fragment shader: additive fresnel rim, a slow pulse. */
export const AURA_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uIntensity;
uniform float uTime;
varying vec3 vAuraNormal;
varying vec3 vAuraView;
void main() {
	float facing = max( dot( normalize( vAuraNormal ), normalize( vAuraView ) ), 0.0 );
	float rim = pow( 1.0 - facing, 2.2 );
	float a = rim * uIntensity * ( 0.8 + 0.2 * sin( uTime * 3.1 ) );
	gl_FragColor = vec4( uColor * a, a );
}`;

export interface AuraUniforms {
  uColor: { value: THREE.Color };
  uWidth: { value: number };
  uIntensity: { value: number };
  uTime: { value: number };
}

/**
 * The Elite aura (design "Elite": the same geometry pushed further along the normal, additive fresnel, 1 draw call).
 * Every aura shares one program; the instance carries its colour and width.
 */
export function createAuraMaterial(color: THREE.ColorRepresentation, width: number): THREE.ShaderMaterial {
  const uniforms: AuraUniforms = {
    uColor: { value: new THREE.Color(color) },
    uWidth: { value: width },
    uIntensity: { value: 0.9 },
    uTime: { value: 0 },
  };
  const material = new THREE.ShaderMaterial({
    name: 'rig:aura',
    uniforms: uniforms as unknown as Record<string, THREE.IUniform>,
    vertexShader: AURA_VERTEX,
    fragmentShader: AURA_FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.FrontSide,
  });
  material.customProgramCacheKey = () => RIG_AURA_PROGRAM_KEY;
  return material;
}

export interface CapeUniforms {
  uTime: { value: number };
  uStar: { value: number };
}

/** The cape fragment patch: screen-space star field drifting slowly over the cape colour (exported for tests). */
export function patchCapeFragment(fragment: string): string {
  let out = replaceOnce(fragment, '#include <common>', `#include <common>
uniform float uTime;
uniform float uStar;`, 'common chunk');
  out = replaceOnce(out, '#include <color_fragment>', `#include <color_fragment>
{
	vec2 sp = gl_FragCoord.xy / 16.0 + vec2( uTime * 0.35, uTime * 0.12 );
	vec2 cell = floor( sp );
	float h = fract( sin( dot( cell, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );
	vec2 f = fract( sp ) - 0.5 - ( vec2( h, fract( h * 7.13 ) ) - 0.5 ) * 0.5;
	float star = step( 0.8, h ) * smoothstep( 0.16, 0.0, length( f ) );
	float twinkle = 0.55 + 0.45 * sin( uTime * 3.0 + h * 40.0 );
	diffuseColor.rgb += vec3( 1.0, 0.93, 0.78 ) * star * twinkle * uStar;
}`, 'color_fragment chunk');
  return out;
}

/** Caelith's starlight cape: unlit vertex colour with the drifting star field (a SkinnedMesh on the rig's Skeleton). */
export function createCapeMaterial(): THREE.MeshBasicMaterial {
  const material = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, name: 'rig:cape' });
  const uniforms: CapeUniforms = { uTime: { value: 0 }, uStar: { value: 1 } };
  Object.defineProperty(material.userData, 'cape', { value: uniforms, enumerable: false, writable: true, configurable: true });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = patchCapeFragment(shader.fragmentShader);
  };
  material.customProgramCacheKey = () => RIG_CAPE_PROGRAM_KEY;
  return material;
}

/** The cape uniforms of a cape material (undefined for other materials). */
export function capeUniformsOf(material: THREE.Material): CapeUniforms | undefined {
  return (material.userData as { cape?: CapeUniforms }).cape;
}
