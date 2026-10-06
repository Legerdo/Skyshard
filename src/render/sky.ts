/*
 * Sky dome (design.md "하늘·조명·시간대"): a 2,000 m sphere drawn from the inside (BackSide, no depth writes) that
 * follows the render camera, with one ShaderMaterial computing in a single pass the zenith → horizon gradient, the
 * sun (or moon) disc and glow, a slowly drifting stylized cloud band, twinkling hash stars and the horizon haze in the
 * final fog colour, so distant fogged terrain meets the sky without a seam. Values come from the time-of-day preset
 * (src/render/timeOfDay.ts) and the fog colour from the Region grading blend. Always drawn first (renderOrder).
 */
import * as THREE from 'three';

export const SKY_RADIUS = 2000;

export interface SkyUniforms {
  [name: string]: THREE.IUniform;
  uTop: THREE.IUniform<THREE.Color>;
  uHorizon: THREE.IUniform<THREE.Color>;
  uHaze: THREE.IUniform<THREE.Color>;
  uSunDir: THREE.IUniform<THREE.Vector3>;
  uSunColor: THREE.IUniform<THREE.Color>;
  /** 0 sun, 1 moon (blends during transitions). */
  uMoon: THREE.IUniform<number>;
  uClouds: THREE.IUniform<number>;
  uStars: THREE.IUniform<number>;
  /** Seconds, for the cloud drift and the star twinkle. */
  uTime: THREE.IUniform<number>;
}

const VERTEX = /* glsl */ `
varying vec3 vSkyDir;
void main() {
	vSkyDir = normalize( position );
	vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
	gl_Position = projectionMatrix * mvPosition;
}
`;

const FRAGMENT = /* glsl */ `
uniform vec3 uTop;
uniform vec3 uHorizon;
uniform vec3 uHaze;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uMoon;
uniform float uClouds;
uniform float uStars;
uniform float uTime;
varying vec3 vSkyDir;

float skyHash( vec3 p ) {
	p = fract( p * 0.3183099 + 0.1 );
	p *= 17.0;
	return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) );
}
float skyHash2( vec2 p ) {
	return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 );
}
float skyNoise( vec2 p ) {
	vec2 i = floor( p );
	vec2 f = fract( p );
	vec2 u = f * f * ( 3.0 - 2.0 * f );
	return mix( mix( skyHash2( i ), skyHash2( i + vec2( 1.0, 0.0 ) ), u.x ),
		mix( skyHash2( i + vec2( 0.0, 1.0 ) ), skyHash2( i + vec2( 1.0, 1.0 ) ), u.x ), u.y );
}
float skyFbm( vec2 p ) {
	float v = 0.0;
	float a = 0.5;
	for ( int i = 0; i < 4; i ++ ) {
		v += a * skyNoise( p );
		p = p * 2.03 + vec2( 17.0, 3.0 );
		a *= 0.5;
	}
	return v;
}

void main() {
	vec3 dir = normalize( vSkyDir );
	float h = dir.y;

	// Gradient: horizon colour low, zenith colour high.
	float up = pow( clamp( h, 0.0, 1.0 ), 0.55 );
	vec3 col = mix( uHorizon, uTop, up );

	// Stars: one candidate per 3D cell on the view sphere, a few percent of cells lit, each twinkling at its own rate.
	if ( uStars > 0.001 && h > -0.05 ) {
		vec3 p = dir * 95.0;
		vec3 cell = floor( p );
		float pick = skyHash( cell );
		if ( pick > 0.965 ) {
			vec3 centre = cell + 0.5 + ( vec3( skyHash( cell + 11.0 ), skyHash( cell + 23.0 ), skyHash( cell + 37.0 ) ) - 0.5 ) * 0.6;
			float d = length( p - centre );
			float size = mix( 0.06, 0.2, pow( skyHash( cell + 51.0 ), 3.0 ) );
			float twinkle = 0.6 + 0.4 * sin( uTime * ( 1.5 + 3.0 * skyHash( cell + 71.0 ) ) + pick * 60.0 );
			float star = smoothstep( size, 0.0, d ) * twinkle;
			float fade = smoothstep( -0.05, 0.25, h );
			vec3 tint = mix( vec3( 0.75, 0.82, 1.0 ), vec3( 1.0, 0.92, 0.75 ), skyHash( cell + 91.0 ) );
			col += tint * star * uStars * fade * 2.2;
		}
	}

	// Sun / moon disc and glow.
	float sunCos = dot( dir, normalize( uSunDir ) );
	float discEdge = mix( 0.99965, 0.99975, uMoon );
	float disc = smoothstep( discEdge - 0.00012, discEdge, sunCos );
	float glow = pow( max( sunCos, 0.0 ), mix( 90.0, 220.0, uMoon ) ) * mix( 0.9, 0.5, uMoon )
		+ pow( max( sunCos, 0.0 ), 8.0 ) * mix( 0.22, 0.08, uMoon );
	vec3 discColor = mix( uSunColor * 3.0, mix( vec3( 1.0, 0.98, 0.92 ), uSunColor, 0.35 ) * 2.2, uMoon );
	col += uSunColor * glow;

	// Cloud band: drifting fbm in a band above the horizon, lit toward the sun.
	if ( uClouds > 0.001 ) {
		float band = smoothstep( 0.02, 0.1, h ) * ( 1.0 - smoothstep( 0.28, 0.5, h ) );
		float az = atan( dir.z, dir.x );
		vec2 q = vec2( az * 5.0 + uTime * 0.006, h * 14.0 );
		float n = skyFbm( q ) + 0.35 * skyFbm( q * 2.7 + vec2( uTime * 0.01, 0.0 ) );
		float cover = smoothstep( 1.02 - uClouds * 0.55, 1.12 - uClouds * 0.5, n ) * band;
		float lit = 0.55 + 0.45 * max( sunCos, 0.0 );
		vec3 cloudCol = mix( mix( uHorizon, uTop, 0.35 ) * 0.9, mix( vec3( 1.0 ), uSunColor, 0.45 ), lit );
		col = mix( col, cloudCol, cover * 0.85 );
		disc *= 1.0 - cover;
	}
	col = mix( col, discColor, disc * step( -0.02, h ) );

	// Horizon haze in the final fog colour; below the horizon it is all haze.
	float haze = 1.0 - smoothstep( -0.03, 0.2, h );
	col = mix( col, uHaze, haze );

	gl_FragColor = vec4( col, 1.0 );
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}
`;

export interface SkyDome {
  readonly mesh: THREE.Mesh;
  readonly uniforms: SkyUniforms;
  dispose(): void;
}

/** The sky dome. It re-centres on whichever camera renders it, just before it is drawn. */
export function createSkyDome(): SkyDome {
  const uniforms: SkyUniforms = {
    uTop: { value: new THREE.Color(0x3d9bf2) },
    uHorizon: { value: new THREE.Color(0xc4e6ff) },
    uHaze: { value: new THREE.Color(0xd8edff) },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color(0xffffff) },
    uMoon: { value: 0 },
    uClouds: { value: 0.5 },
    uStars: { value: 0 },
    uTime: { value: 0 },
  };
  const material = new THREE.ShaderMaterial({
    name: 'skyDome',
    uniforms,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });
  const geometry = new THREE.SphereGeometry(SKY_RADIUS, 48, 24);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'skyDome';
  mesh.frustumCulled = false; // it surrounds the camera
  mesh.renderOrder = -1000; // before every opaque object
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.matrixAutoUpdate = false;
  mesh.onBeforeRender = (_renderer, _scene, camera) => {
    camera.getWorldPosition(mesh.position);
    mesh.updateMatrix();
    mesh.matrixWorld.copy(mesh.matrix);
  };
  return {
    mesh,
    uniforms,
    dispose(): void {
      geometry.dispose();
      material.dispose();
    },
  };
}
