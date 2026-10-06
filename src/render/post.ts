/*
 * Post-processing (design.md "후처리"; Req 39.1, 38.1, 38.2): one EffectComposer with, in this order,
 * 1. RenderPass into the composer's half-float target,
 * 2. UnrealBloomPass at half the drawing-buffer resolution (full at the high preset) with a high threshold, so only
 *    glowing crystals, combat VFX and the sky's sun glow bloom, not ordinary toon surfaces (EffectComposer.setSize
 *    resizes every pass to full size, so the bloom is resized again right after),
 * 3. GradingPass: lift / gamma / gain, the Region blend's saturation, contrast and tint (GRADING_UNIFORMS), vignette,
 * 4. OutputPass: the one tone mapping (Neutral) and sRGB conversion,
 * 5. FXAA (medium / high only): after OutputPass because it expects sRGB input; its `resolution` follows the drawing
 *    buffer (window size × pixel ratio, render scale included).
 * With post-processing off the pipeline draws with `renderer.render` directly and the toon materials' grading
 * fallback takes over (RegionGrading.gradingPassActive false).
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js';
import { GRADING_UNIFORMS } from './grading';

/** Bloom: a high luminance threshold (linear, before tone mapping) so only emissive glows and VFX spread. */
export const BLOOM_SETTINGS = { strength: 0.55, radius: 0.4, threshold: 1.05 } as const;

/** GradingPass curve constants (ASC-CDL style lift / gamma / gain, linear) and the vignette strength. */
export const GRADING_CURVE = {
  lift: new THREE.Vector3(0.004, 0.003, 0.008),
  gamma: new THREE.Vector3(1, 1, 1),
  gain: new THREE.Vector3(1.02, 1.01, 1.0),
  vignette: 0.2,
};

const GRADING_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
	vUv = uv;
	gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

const GRADING_FRAGMENT = /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec3 uGradeTint;
uniform float uGradeSaturation;
uniform float uGradeContrast;
uniform vec3 uLift;
uniform vec3 uGamma;
uniform vec3 uGain;
uniform float uVignette;
varying vec2 vUv;
void main() {
	vec4 texel = texture2D( tDiffuse, vUv );
	vec3 c = max( texel.rgb, 0.0 );
	c = pow( max( c * uGain + uLift, 0.0 ), 1.0 / uGamma );
	float luma = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
	c = max( mix( vec3( luma ), c, uGradeSaturation ), 0.0 );
	// Contrast around linear mid grey.
	c = 0.18 * pow( max( c, vec3( 1e-5 ) ) / 0.18, vec3( uGradeContrast ) );
	c *= uGradeTint;
	vec2 d = vUv - 0.5;
	c *= 1.0 - uVignette * smoothstep( 0.3, 0.8, length( d ) * 1.25 );
	gl_FragColor = vec4( c, texel.a );
}
`;

/** The GradingPass material: the shared GRADING_UNIFORMS objects (not copies), so the Region blend reaches it. */
export function createGradingMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'GradingPass',
    uniforms: {
      tDiffuse: { value: null },
      ...GRADING_UNIFORMS,
      uLift: { value: GRADING_CURVE.lift },
      uGamma: { value: GRADING_CURVE.gamma },
      uGain: { value: GRADING_CURVE.gain },
      uVignette: { value: GRADING_CURVE.vignette },
    },
    vertexShader: GRADING_VERTEX,
    fragmentShader: GRADING_FRAGMENT,
    depthTest: false,
    depthWrite: false,
  });
}

export interface PostOptions {
  /** Bloom resolution relative to the drawing buffer (0.5 or 1). */
  bloomScale: number;
  fxaa: boolean;
}

/** Bloom target size for a drawing buffer of w × h px at `scale`. */
export function bloomSizeFor(width: number, height: number, scale: number): { width: number; height: number } {
  const s = Number.isFinite(scale) && scale > 0 ? Math.min(1, scale) : 0.5;
  return { width: Math.max(1, Math.round(width * s)), height: Math.max(1, Math.round(height * s)) };
}

export class PostProcessing {
  readonly composer: EffectComposer;
  readonly bloom: UnrealBloomPass;
  readonly grading: ShaderPass;
  readonly output: OutputPass;
  readonly fxaa: ShaderPass;
  private options: PostOptions;
  private cssWidth: number;
  private cssHeight: number;
  private readonly gradingMaterial: THREE.ShaderMaterial;

  constructor(private readonly renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, options: PostOptions) {
    this.options = { ...options };
    const size = renderer.getSize(new THREE.Vector2());
    this.cssWidth = Math.max(1, size.x);
    this.cssHeight = Math.max(1, size.y);
    const ratio = renderer.getPixelRatio();
    const target = new THREE.WebGLRenderTarget(Math.round(this.cssWidth * ratio), Math.round(this.cssHeight * ratio), { type: THREE.HalfFloatType });
    target.texture.name = 'composer.rt1';
    this.composer = new EffectComposer(renderer, target);
    this.composer.addPass(new RenderPass(scene, camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(this.cssWidth * ratio, this.cssHeight * ratio), BLOOM_SETTINGS.strength, BLOOM_SETTINGS.radius, BLOOM_SETTINGS.threshold);
    this.composer.addPass(this.bloom);
    this.gradingMaterial = createGradingMaterial();
    this.grading = new ShaderPass(this.gradingMaterial);
    this.composer.addPass(this.grading);
    this.output = new OutputPass();
    this.composer.addPass(this.output);
    this.fxaa = new ShaderPass(FXAAShader);
    this.fxaa.enabled = options.fxaa;
    this.composer.addPass(this.fxaa);
    this.resize();
  }

  get config(): Readonly<PostOptions> {
    return this.options;
  }

  /** Bloom scale / FXAA of a new preset: only those passes change. */
  configure(options: PostOptions): void {
    const bloomChanged = options.bloomScale !== this.options.bloomScale;
    this.options = { ...options };
    this.fxaa.enabled = options.fxaa;
    if (bloomChanged) this.resize();
  }

  /** Window (CSS px) size: the composer at size × pixel ratio, then bloom at its scale and FXAA's resolution. */
  setSize(cssWidth: number, cssHeight: number): void {
    this.cssWidth = Math.max(1, cssWidth);
    this.cssHeight = Math.max(1, cssHeight);
    this.resize();
  }

  /** The drawing-buffer size the passes run at (px). */
  get bufferSize(): { width: number; height: number } {
    const ratio = this.renderer.getPixelRatio();
    return { width: Math.round(this.cssWidth * ratio), height: Math.round(this.cssHeight * ratio) };
  }

  render(deltaSeconds?: number): void {
    this.composer.render(deltaSeconds);
  }

  dispose(): void {
    this.bloom.dispose();
    this.grading.dispose();
    this.output.dispose();
    this.fxaa.dispose();
    this.gradingMaterial.dispose();
    this.composer.dispose();
  }

  private resize(): void {
    const ratio = this.renderer.getPixelRatio();
    this.composer.setPixelRatio(ratio);
    this.composer.setSize(this.cssWidth, this.cssHeight);
    const { width, height } = this.bufferSize;
    const bloom = bloomSizeFor(width, height, this.options.bloomScale);
    this.bloom.setSize(bloom.width, bloom.height);
    this.bloom.resolution.set(bloom.width, bloom.height);
    (this.fxaa.material.uniforms.resolution.value as THREE.Vector2).set(1 / width, 1 / height);
  }
}
