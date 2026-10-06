/*
 * Blob shadows (design.md "그림자"; Req 39.9): a soft dark disc under the Active_Character, the NPCs and the enemies
 * whenever the shadow map is off (the low preset's default) or the actor stands outside the 80 m shadow box, so
 * ground contact always reads. One InstancedMesh of ground-aligned quads (one draw call) with a radial falloff;
 * the disc lies on the ground under the feet and fades and widens with the height above it.
 */
import * as THREE from 'three';
import type { Vec3 } from '../core/types';
import { CHARACTER_SHADOW, insideShadowBox, type CharacterShadowState } from './shadows';

/** Above this height over the ground (m) an actor casts no blob. */
export const BLOB_MAX_HEIGHT = 6;
const BLOB_OPACITY = 0.5;
const BLOB_CAPACITY = 64;

export interface BlobActor {
  readonly pos: Readonly<Vec3>;
  /** Body radius (m). */
  readonly radius: number;
}

export interface BlobPlacement {
  readonly visible: boolean;
  readonly y: number;
  readonly opacity: number;
  /** Disc diameter (m). */
  readonly size: number;
}

/**
 * Where and how strongly the blob of `actor` shows: only without a real shadow (shadows off or outside the box),
 * on the ground `groundY`, fading out by BLOB_MAX_HEIGHT above it.
 */
export function blobPlacement(actor: BlobActor, groundY: number, state: Readonly<CharacterShadowState> = CHARACTER_SHADOW): BlobPlacement {
  const height = actor.pos.y - groundY;
  const real = insideShadowBox(actor.pos, state);
  if (real || !(height > -0.5) || height > BLOB_MAX_HEIGHT || !Number.isFinite(groundY)) return { visible: false, y: groundY, opacity: 0, size: 0 };
  const h = Math.max(0, height);
  const fade = 1 - h / BLOB_MAX_HEIGHT;
  return { visible: true, y: groundY + 0.04, opacity: BLOB_OPACITY * fade, size: actor.radius * 2.6 * (1 + h * 0.08) };
}

const VERTEX = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
attribute float aOpacity;
varying vec2 vUv;
varying float vOpacity;
void main() {
	vUv = uv;
	vOpacity = aOpacity;
	vec4 mvPosition = viewMatrix * modelMatrix * instanceMatrix * vec4( position, 1.0 );
	gl_Position = projectionMatrix * mvPosition;
	#include <fog_vertex>
}
`;

const FRAGMENT = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
varying vec2 vUv;
varying float vOpacity;
void main() {
	float r = length( vUv - 0.5 ) * 2.0;
	float a = ( 1.0 - smoothstep( 0.25, 1.0, r ) ) * vOpacity;
	if ( a < 0.003 ) discard;
	gl_FragColor = vec4( vec3( 0.05, 0.04, 0.08 ), a );
	#include <fog_fragment>
}
`;

export class BlobShadows {
  readonly mesh: THREE.InstancedMesh;
  private readonly opacity: THREE.InstancedBufferAttribute;
  private readonly material: THREE.ShaderMaterial;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3();

  constructor() {
    const g = new THREE.PlaneGeometry(1, 1);
    this.opacity = new THREE.InstancedBufferAttribute(new Float32Array(BLOB_CAPACITY), 1);
    g.setAttribute('aOpacity', this.opacity);
    this.material = new THREE.ShaderMaterial({
      name: 'blobShadow',
      uniforms: THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false,
      fog: true,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    });
    this.mesh = new THREE.InstancedMesh(g, this.material, BLOB_CAPACITY);
    this.mesh.name = 'blobShadows';
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.renderOrder = 1;
    this.mesh.count = 0;
  }

  /** Places the blobs for this frame; `groundAt(x, z, feetY)` is the ground under the feet. */
  update(actors: Iterable<BlobActor>, groundAt: (x: number, z: number, feetY: number) => number): number {
    let n = 0;
    for (const a of actors) {
      if (n >= BLOB_CAPACITY) break;
      const place = blobPlacement(a, groundAt(a.pos.x, a.pos.z, a.pos.y));
      if (!place.visible) continue;
      this.m.compose(this.p.set(a.pos.x, place.y, a.pos.z), this.q, this.s.set(place.size, place.size, 1));
      this.mesh.setMatrixAt(n, this.m);
      this.opacity.setX(n, place.opacity);
      n++;
    }
    this.mesh.count = n;
    this.mesh.visible = n > 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.opacity.needsUpdate = true;
    return n;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.mesh.dispose();
  }
}
