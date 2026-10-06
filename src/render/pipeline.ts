/*
 * The page's render pipeline (tasks 18.5 / 18.6; design.md "그림자", "후처리", "품질 프리셋", "성능 예산"): owns the
 * character shadow map, the interior lighting blend and the post-processing composer, and applies the graphics
 * settings live:
 * - every Settings change is diffed (qualityResourceDiff) and only the touched resources are rebuilt in the same call
 *   (well inside the 1 s budget, no restart): the shadow map (freed and reallocated at the new size, or the shadow
 *   pass switched with the shared materials recompiled), the composer (made or freed; bloom resolution and FXAA per
 *   preset). The pixel ratio itself is bindRenderSettings' (renderer.ts); its resize reaches the composer through
 *   onResize. Particle capacities follow the preset in the VFX system and the atmosphere (read each frame), the
 *   vegetation density and terrain LOD are the terrain task's. The Settings_System has already saved the change.
 * - `render(realDt, frame)`: resets `renderer.info` (autoReset off, so the shadow pass and every composer pass add up
 *   in the F3 panel and the harness), blends the interior lighting over the world scene's values, moves the shadow
 *   box to the Active_Character, updates the water's sky, then draws through the composer, or with
 *   `renderer.render` when post-processing is off.
 */
import type * as THREE from 'three';
import type { Vec3 } from '../core/types';
import type { Settings } from '../settings/settings';
import { applyInterior, InteriorBlend, type InteriorLook } from './interiorLighting';
import { PostProcessing } from './post';
import { postConfigFor, qualityResourceDiff, type QualityResource, type QualityState } from './qualityApplier';
import type { RendererHandle } from './renderer';
import { CharacterShadow } from './shadows';
import { refreshSharedMaterials } from './toonMaterial';
import { updateWaterSky } from './water';
import type { WorldScene } from './worldScene';

/** The Settings fields the pipeline follows (SettingsStore satisfies it). */
export interface PipelineSettingsSource {
  get(): Readonly<QualityState>;
  subscribe(listener: (next: Readonly<Settings>) => void): () => void;
}

export interface RenderPipelineOptions {
  handle: Pick<RendererHandle, 'renderer' | 'onResize' | 'onContextRestored'>;
  scene: THREE.Scene;
  camera: THREE.Camera;
  world: WorldScene;
  settings: PipelineSettingsSource;
}

/** What the session hands the pipeline each frame. */
export interface PipelineFrame {
  /** Active_Character feet (the shadow box centre). */
  readonly focus: Readonly<Vec3>;
  /** The InteriorVolume look at the character, or null outdoors. */
  readonly interior: InteriorLook | null;
}

export class RenderPipeline {
  readonly shadow: CharacterShadow;
  private post: PostProcessing | null = null;
  private readonly interior = new InteriorBlend();
  private state: QualityState | null = null;
  /** The resources rebuilt by the last settings application (tests, debugging). */
  lastApplied: ReadonlySet<QualityResource> = new Set();
  private readonly unsubscribe: (() => void)[] = [];

  constructor(private readonly o: RenderPipelineOptions) {
    const { renderer } = o.handle;
    renderer.info.autoReset = false;
    this.shadow = new CharacterShadow(renderer, o.world.sun);
    this.apply(o.settings.get());
    this.unsubscribe.push(
      o.settings.subscribe((next) => this.apply(next)),
      o.handle.onResize((w, h) => this.post?.setSize(w, h)),
      o.handle.onContextRestored(() => {
        // three.js made a new `info` and fresh GL state: keep the summed counters and rebuild the render targets.
        o.handle.renderer.info.autoReset = false;
        this.shadow.resetMap();
        if (this.post !== null) {
          const config = this.post.config;
          this.post.dispose();
          this.post = new PostProcessing(o.handle.renderer, o.scene, o.camera, config);
        }
      }),
    );
  }

  /** Whether frames go through the composer. */
  get postProcessing(): boolean {
    return this.post !== null;
  }

  /** The interior weight of the last frame (0 outdoors … 1 inside). */
  get interiorWeight(): number {
    return this.interior.eased;
  }

  /** Applies a Settings value: only the resources its diff names are rebuilt. */
  apply(next: Readonly<QualityState>): ReadonlySet<QualityResource> {
    const snapshot: QualityState = {
      qualityPreset: next.qualityPreset, renderScale: next.renderScale, shadows: next.shadows, vegetation: next.vegetation, postProcessing: next.postProcessing,
    };
    const diff = qualityResourceDiff(this.state, snapshot);
    this.state = snapshot;
    const { renderer } = this.o.handle;
    if (diff.has('shadowToggle') || diff.has('shadowMap')) this.shadow.setQuality(snapshot.shadows);
    if (diff.has('sharedMaterials')) refreshSharedMaterials();
    const post = postConfigFor(snapshot);
    if (diff.has('composer')) {
      this.post?.dispose();
      this.post = post.enabled ? new PostProcessing(renderer, this.o.scene, this.o.camera, { bloomScale: post.bloomScale, fxaa: post.fxaa }) : null;
    } else if (this.post !== null && (diff.has('bloomSize') || diff.has('fxaa'))) {
      this.post.configure({ bloomScale: post.bloomScale, fxaa: post.fxaa });
    }
    this.o.world.grading.gradingPassActive = this.post !== null;
    this.lastApplied = diff;
    return diff;
  }

  /** One frame (after the session and the world scene updated). `frame` null: no session (only the world). */
  render(realDt: number, frame: PipelineFrame | null): void {
    const { renderer } = this.o.handle;
    renderer.info.reset();
    const world = this.o.world;
    const t = this.interior.update(realDt, frame?.interior ?? null);
    const fog = world.scene.fog;
    if (fog !== null && 'near' in fog) {
      applyInterior({ fog, background: world.fogColor, haze: world.sky.uniforms.uHaze.value, hemi: world.hemi, renderer }, this.interior.look, t);
    }
    const tod = world.timeOfDay.current;
    if (frame !== null) this.shadow.follow(frame.focus, tod.sunDir);
    updateWaterSky(tod);
    if (this.post !== null) this.post.render(realDt);
    else renderer.render(this.o.scene, this.o.camera);
  }

  dispose(): void {
    for (const off of this.unsubscribe.splice(0)) off();
    this.post?.dispose();
    this.post = null;
    this.shadow.dispose();
  }
}
