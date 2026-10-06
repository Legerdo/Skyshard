import * as THREE from 'three';
import { renderQualityFor } from '../data/renderQuality';

/*
 * WebGL2 renderer setup: color/tone/shadow defaults, DPR-capped pixel ratio × render scale,
 * parent-driven resize, and context loss/restore notifications (Req 1.5, 1.6, 1.8).
 */

/** Context attributes shared by the WebGL2 probe and the renderer (Req 1.6). */
const CONTEXT_ATTRIBUTES: WebGLContextAttributes = {
  antialias: false, // FXAA pass handles AA (design: 후처리)
  powerPreference: 'high-performance',
  stencil: false,
  alpha: false,
  preserveDrawingBuffer: false,
};

const DEFAULT_MAX_PIXEL_RATIO = 1.5;
/** Render-scale slider range (design: 품질 프리셋, 50–100%). */
const MIN_RENDER_SCALE = 0.5;
const MAX_RENDER_SCALE = 1;

export interface RendererOptions {
  /** Multiplied into the pixel ratio; clamped to 0.5–1. Default 1. */
  renderScale?: number;
  /** Device pixel ratio cap from the quality preset. Default 1.5. */
  maxPixelRatio?: number;
}

export interface RendererHandle {
  renderer: THREE.WebGLRenderer;
  canvas: HTMLCanvasElement;
  setRenderScale(scale: number): void;
  readonly renderScale: number;
  /** Task 18.1: the quality preset's device-pixel-ratio cap (low / medium 1, high 1.5). */
  setPixelRatioCap(cap: number): void;
  readonly pixelRatioCap: number;
  /** The pixel ratio in use: min(devicePixelRatio, cap) × render scale. */
  readonly pixelRatio: number;
  /** Fires after the CSS size or pixel ratio changes. Initial size: `renderer.getSize()`. */
  onResize(cb: (w: number, h: number) => void): () => void;
  onContextLost(cb: () => void): () => void;
  /** Fires after three.js has re-initialized its GL state; recreate render targets here. */
  onContextRestored(cb: () => void): () => void;
  readonly contextLost: boolean;
  dispose(): void;
}

/** True if a WebGL2 context can be created. Without `canvas`, a throwaway probe is used and released. */
export function isWebGL2Supported(canvas?: HTMLCanvasElement): boolean {
  if (typeof WebGL2RenderingContext === 'undefined') return false;
  let gl: WebGL2RenderingContext | null;
  try {
    gl = (canvas ?? document.createElement('canvas')).getContext('webgl2', CONTEXT_ATTRIBUTES);
  } catch {
    return false;
  }
  if (gl === null) return false;
  // A caller-supplied canvas keeps its context for the renderer; the probe's is freed now.
  if (canvas === undefined) gl.getExtension('WEBGL_lose_context')?.loseContext();
  return true;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function subscribe<T>(listeners: Set<T>, cb: T): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Calls every listener; one throwing listener does not block the rest. */
function notify<A extends unknown[]>(listeners: Set<(...args: A) => void>, ...args: A): void {
  for (const cb of [...listeners]) {
    try {
      cb(...args);
    } catch (err) {
      console.error('[renderer] listener failed', err);
    }
  }
}

function finiteOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback;
}

/**
 * Task 18.1 (design "렌더러와 재질"): the pixel ratio `min(devicePixelRatio, DPR cap) × render scale`, the render scale
 * clamped to 50–100 %. Bad inputs fall back to DPR 1, cap 1.5 and scale 1.
 */
export function pixelRatioFor(devicePixelRatio: number, cap: number, renderScale: number): number {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const max = Number.isFinite(cap) && cap > 0 ? cap : DEFAULT_MAX_PIXEL_RATIO;
  const scale = clamp(finiteOr(renderScale, 1), MIN_RENDER_SCALE, MAX_RENDER_SCALE);
  return Math.min(dpr, max) * scale;
}

/** Creates the game renderer on `canvas`. Throws if the WebGL2 context cannot be created. */
export function createRenderer(canvas: HTMLCanvasElement, opts: RendererOptions = {}): RendererHandle {
  // Task 18.1: the WebGL2 context the boot probe created on this canvas (same attributes: antialias off, the FXAA
  // pass anti-aliases), or a new one; getContext returns the existing context for the canvas.
  const context = canvas.getContext('webgl2', CONTEXT_ATTRIBUTES);
  if (context === null) throw new Error('WebGL2 context unavailable');
  const renderer = new THREE.WebGLRenderer({ canvas, context, ...CONTEXT_ATTRIBUTES });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Neutral: gentle highlight roll-off that keeps stylized hues and saturation nearly intact.
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  // r186 removed PCFSoftShadowMap (warns, falls back); PCFShadowMap is now the soft Vogel-disk filter.
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const cap = finiteOr(opts.maxPixelRatio, DEFAULT_MAX_PIXEL_RATIO);
  let maxPixelRatio = cap > 0 ? cap : DEFAULT_MAX_PIXEL_RATIO;
  let renderScale = clamp(finiteOr(opts.renderScale, 1), MIN_RENDER_SCALE, MAX_RENDER_SCALE);
  let width = 0;
  let height = 0;
  let pixelRatio = 0;
  let contextLost = false;
  let disposed = false;
  const resizeListeners = new Set<(w: number, h: number) => void>();
  const lostListeners = new Set<() => void>();
  const restoredListeners = new Set<() => void>();

  const applySize = (): void => {
    if (disposed) return;
    const parent = canvas.parentElement;
    const w = Math.max(1, parent?.clientWidth || window.innerWidth);
    const h = Math.max(1, parent?.clientHeight || window.innerHeight);
    const ratio = pixelRatioFor(window.devicePixelRatio, maxPixelRatio, renderScale);
    if (w === width && h === height && ratio === pixelRatio) return;
    if (ratio !== pixelRatio) renderer.setPixelRatio(ratio);
    width = w;
    height = h;
    pixelRatio = ratio;
    renderer.setSize(w, h, false);
    notify(resizeListeners, w, h);
  };

  // DPR changes (monitor switch, zoom) do not always resize the parent element.
  let dprQuery: MediaQueryList | null = null;
  const onDprChange = (): void => {
    watchDpr();
    applySize();
  };
  const watchDpr = (): void => {
    dprQuery?.removeEventListener('change', onDprChange);
    dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    dprQuery.addEventListener('change', onDprChange);
  };

  const onLost = (event: Event): void => {
    event.preventDefault(); // keeps the context restorable
    contextLost = true;
    notify(lostListeners);
  };
  const onRestored = (): void => {
    contextLost = false;
    notify(restoredListeners);
  };
  // Registered after three.js's own handlers, so its GL state is rebuilt before ours run.
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);

  const parent = canvas.parentElement;
  const observer = parent && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(applySize) : null;
  if (observer && parent) observer.observe(parent);
  else window.addEventListener('resize', applySize);
  watchDpr();
  applySize();

  return {
    renderer,
    canvas,
    setRenderScale(scale: number): void {
      if (!Number.isFinite(scale)) return;
      renderScale = clamp(scale, MIN_RENDER_SCALE, MAX_RENDER_SCALE);
      applySize();
    },
    get renderScale(): number {
      return renderScale;
    },
    setPixelRatioCap(next: number): void {
      if (!(Number.isFinite(next) && next > 0)) return;
      maxPixelRatio = next;
      applySize();
    },
    get pixelRatioCap(): number {
      return maxPixelRatio;
    },
    get pixelRatio(): number {
      return pixelRatio;
    },
    onResize: (cb) => subscribe(resizeListeners, cb),
    onContextLost: (cb) => subscribe(lostListeners, cb),
    onContextRestored: (cb) => subscribe(restoredListeners, cb),
    get contextLost(): boolean {
      return contextLost;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      observer?.disconnect();
      window.removeEventListener('resize', applySize);
      dprQuery?.removeEventListener('change', onDprChange);
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      resizeListeners.clear();
      lostListeners.clear();
      restoredListeners.clear();
      renderer.dispose();
    },
  };
}

/** The Settings fields the renderer follows (SettingsStore satisfies it). */
export interface RenderSettingsSource {
  get(): Readonly<{ qualityPreset: string; renderScale: number }>;
  subscribe(listener: (next: Readonly<{ qualityPreset: string; renderScale: number }>) => void): () => void;
}

/**
 * Task 18.1: applies the quality preset's DPR cap and the render-scale setting now and on every change (the change
 * reaches the canvas at once, well inside the 1 s budget, without a restart). Returns the unsubscribe function.
 */
export function bindRenderSettings(handle: Pick<RendererHandle, 'setPixelRatioCap' | 'setRenderScale'>, settings: RenderSettingsSource): () => void {
  const apply = (s: Readonly<{ qualityPreset: string; renderScale: number }>): void => {
    handle.setPixelRatioCap(renderQualityFor(s.qualityPreset).dprCap);
    handle.setRenderScale(s.renderScale);
  };
  apply(settings.get());
  return settings.subscribe(apply);
}
