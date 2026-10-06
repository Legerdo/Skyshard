/*
 * Time of day in the renderer (design.md "하늘·조명·시간대"; Req 8.10, 4.7, 6.7).
 * - TimeOfDayState: the current look as linear-space values; `set(id, seconds)` cuts to a preset (0 s: a load, the
 *   sunrise after the ending) or blends every value to it over `seconds` (colours lerp in linear space, the sun
 *   direction slerps). `update(dt)` advances the blend.
 * - SkyDirector (one per play session): picks the preset from GameState (Skyshards, altar, ending) and the Caelith
 *   arena, and decides cut or 4 s blend: a change blends inside cin_skyshard_1–3 / cin_altar (and right after
 *   'skyshard:acquired' / 'altar:activated', which start them) and while the arena switches its sky; anything else
 *   (loading a save, a new session, the ending's sunrise) cuts.
 * The world scene applies the state to its one DirectionalLight, one HemisphereLight, the fog and the sky dome.
 */
import * as THREE from 'three';
import type { GameEventBus } from '../core/gameEvents';
import {
  sunDirection, TIME_OF_DAY_BLEND_CINEMATICS, TIME_OF_DAY_BLEND_SECONDS, TIME_OF_DAY_PRESETS, timeOfDayFor,
  type TimeOfDayId, type TimeOfDayPreset, type TimeOfDayProgress,
} from '../data/timeOfDay';

/** A preset as blendable linear values. */
export interface TimeOfDayValues {
  readonly sunDir: THREE.Vector3;
  readonly sunColor: THREE.Color;
  sunIntensity: number;
  /** 0 sun, 1 moon. */
  moon: number;
  readonly skyTop: THREE.Color;
  readonly skyHorizon: THREE.Color;
  readonly fogColor: THREE.Color;
  fogNear: number;
  fogFar: number;
  readonly hemiSky: THREE.Color;
  readonly hemiGround: THREE.Color;
  hemiIntensity: number;
  clouds: number;
  stars: number;
  rimStrength: number;
}

function emptyValues(): TimeOfDayValues {
  return {
    sunDir: new THREE.Vector3(0, 1, 0), sunColor: new THREE.Color(), sunIntensity: 0, moon: 0,
    skyTop: new THREE.Color(), skyHorizon: new THREE.Color(), fogColor: new THREE.Color(), fogNear: 0, fogFar: 1,
    hemiSky: new THREE.Color(), hemiGround: new THREE.Color(), hemiIntensity: 0, clouds: 0, stars: 0, rimStrength: 0,
  };
}

/** Writes `preset` into `out` (sRGB hex → linear). */
export function presetValues(preset: TimeOfDayPreset, out: TimeOfDayValues = emptyValues()): TimeOfDayValues {
  const d = sunDirection(preset);
  out.sunDir.set(d.x, d.y, d.z).normalize();
  out.sunColor.set(preset.sunColor);
  out.sunIntensity = preset.sunIntensity;
  out.moon = preset.moon ? 1 : 0;
  out.skyTop.set(preset.skyTop);
  out.skyHorizon.set(preset.skyHorizon);
  out.fogColor.set(preset.fogColor);
  out.fogNear = preset.fogNear;
  out.fogFar = preset.fogFar;
  out.hemiSky.set(preset.hemiSky);
  out.hemiGround.set(preset.hemiGround);
  out.hemiIntensity = preset.hemiIntensity;
  out.clouds = preset.clouds;
  out.stars = preset.stars;
  out.rimStrength = preset.rimStrength;
  return out;
}

function copyValues(from: TimeOfDayValues, out: TimeOfDayValues): void {
  out.sunDir.copy(from.sunDir);
  out.sunColor.copy(from.sunColor);
  out.sunIntensity = from.sunIntensity;
  out.moon = from.moon;
  out.skyTop.copy(from.skyTop);
  out.skyHorizon.copy(from.skyHorizon);
  out.fogColor.copy(from.fogColor);
  out.fogNear = from.fogNear;
  out.fogFar = from.fogFar;
  out.hemiSky.copy(from.hemiSky);
  out.hemiGround.copy(from.hemiGround);
  out.hemiIntensity = from.hemiIntensity;
  out.clouds = from.clouds;
  out.stars = from.stars;
  out.rimStrength = from.rimStrength;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Spherical interpolation of unit vectors `a` → `b` into `out`. */
export function slerpUnit(a: THREE.Vector3, b: THREE.Vector3, t: number, out: THREE.Vector3): THREE.Vector3 {
  const dot = Math.min(1, Math.max(-1, a.dot(b)));
  const theta = Math.acos(dot);
  if (theta < 1e-5) return out.copy(a).lerp(b, t).normalize();
  if (Math.PI - theta < 1e-4) {
    // Opposite directions: go over the zenith.
    const mid = new THREE.Vector3(0, 1, 0);
    return t < 0.5 ? slerpUnit(a, mid, t * 2, out) : slerpUnit(mid, b, (t - 0.5) * 2, out);
  }
  const s = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / s;
  const wb = Math.sin(t * theta) / s;
  return out.set(a.x * wa + b.x * wb, a.y * wa + b.y * wb, a.z * wa + b.z * wb).normalize();
}

/** Blends `a` → `b` by `t` into `out` (colours linear lerp, the sun direction slerp). */
export function blendValues(a: TimeOfDayValues, b: TimeOfDayValues, t: number, out: TimeOfDayValues): TimeOfDayValues {
  slerpUnit(a.sunDir, b.sunDir, t, out.sunDir);
  out.sunColor.copy(a.sunColor).lerp(b.sunColor, t);
  out.sunIntensity = lerp(a.sunIntensity, b.sunIntensity, t);
  out.moon = lerp(a.moon, b.moon, t);
  out.skyTop.copy(a.skyTop).lerp(b.skyTop, t);
  out.skyHorizon.copy(a.skyHorizon).lerp(b.skyHorizon, t);
  out.fogColor.copy(a.fogColor).lerp(b.fogColor, t);
  out.fogNear = lerp(a.fogNear, b.fogNear, t);
  out.fogFar = lerp(a.fogFar, b.fogFar, t);
  out.hemiSky.copy(a.hemiSky).lerp(b.hemiSky, t);
  out.hemiGround.copy(a.hemiGround).lerp(b.hemiGround, t);
  out.hemiIntensity = lerp(a.hemiIntensity, b.hemiIntensity, t);
  out.clouds = lerp(a.clouds, b.clouds, t);
  out.stars = lerp(a.stars, b.stars, t);
  out.rimStrength = lerp(a.rimStrength, b.rimStrength, t);
  return out;
}

/** The current look and its blend toward a target preset. */
export class TimeOfDayState {
  /** The values to draw this frame. */
  readonly current: TimeOfDayValues;
  private readonly from = emptyValues();
  private readonly to = emptyValues();
  private targetId: TimeOfDayId;
  private elapsed = 0;
  private duration = 0;

  constructor(initial: TimeOfDayId = 'morning') {
    this.targetId = initial;
    this.current = presetValues(TIME_OF_DAY_PRESETS[initial]);
    copyValues(this.current, this.to);
  }

  /** The preset shown (or being blended to). */
  get target(): TimeOfDayId {
    return this.targetId;
  }

  /** Blend progress 0–1 (1 when settled). */
  get progress(): number {
    return this.duration > 0 ? Math.min(1, this.elapsed / this.duration) : 1;
  }

  get blending(): boolean {
    return this.progress < 1;
  }

  /** Goes to preset `id`: at once when `seconds` ≤ 0, else blended from the current look over `seconds`. */
  set(id: TimeOfDayId, seconds = 0): void {
    const blend = Number.isFinite(seconds) && seconds > 0;
    if (id === this.targetId && (blend || !this.blending)) return;
    this.targetId = id;
    presetValues(TIME_OF_DAY_PRESETS[id], this.to);
    if (!blend) {
      copyValues(this.to, this.current);
      this.elapsed = 0;
      this.duration = 0;
      return;
    }
    copyValues(this.current, this.from);
    this.elapsed = 0;
    this.duration = seconds;
  }

  /** Advances the blend by `dt` real seconds. */
  update(dt: number): void {
    if (this.duration <= 0) return;
    this.elapsed += Number.isFinite(dt) && dt > 0 ? dt : 0;
    const t = Math.min(1, this.elapsed / this.duration);
    const eased = t * t * (3 - 2 * t);
    blendValues(this.from, this.to, eased, this.current);
    if (t >= 1) {
      copyValues(this.to, this.current);
      this.duration = 0;
      this.elapsed = 0;
    }
  }
}

/** What the world scene reads from the session each frame. */
export interface SkyRequest {
  readonly preset: TimeOfDayId;
  /** 0 = cut, else blend seconds. */
  readonly blendSeconds: number;
}

/** The arena's sky while Caelith's fight runs (from its snapshot), else null. */
export function bossSkyOf(snapshot: { readonly state: string; readonly skyPreset: 'dusk' | 'starNight' }): 'dusk' | 'starNight' | null {
  return snapshot.state === 'dormant' || snapshot.state === 'dead' ? null : snapshot.skyPreset;
}

/** After a trigger event, how long a progress change still counts as inside its cinematic (s). */
const TRIGGER_WINDOW_SECONDS = 1;
const BLEND_CINEMATICS = new Set(TIME_OF_DAY_BLEND_CINEMATICS);

/** Session side: which preset to show and whether the change blends (see the header). */
export class SkyDirector {
  private window = 0;
  private last: TimeOfDayId | null = null;
  private lastBoss: 'dusk' | 'starNight' | null = null;
  private readonly unsubscribe: (() => void)[];
  private request: SkyRequest = { preset: 'morning', blendSeconds: 0 };

  constructor(bus: Pick<GameEventBus, 'on'>) {
    const open = (): void => {
      this.window = TRIGGER_WINDOW_SECONDS;
    };
    this.unsubscribe = [
      bus.on('skyshard:acquired', open),
      bus.on('altar:activated', open),
      bus.on('cinematic:started', (p) => {
        if (BLEND_CINEMATICS.has(p.cinematicId)) open();
      }),
    ];
  }

  /**
   * The request for this frame. `cinematic` is the playing cinematic id; `bossSky` the arena's sky (bossSkyOf) or null.
   * The first call after construction always cuts (a load shows its look at once).
   */
  update(realDt: number, progress: TimeOfDayProgress, bossSky: 'dusk' | 'starNight' | null, cinematic: string | null): SkyRequest {
    const preset = timeOfDayFor(progress, bossSky);
    const inCinematic = cinematic !== null && BLEND_CINEMATICS.has(cinematic);
    const bossSwitch = bossSky !== null || this.lastBoss !== null;
    const blend = this.last !== null && preset !== this.last && !progress.gameCompleted && (inCinematic || this.window > 0 || bossSwitch);
    if (this.last === null || preset !== this.last) {
      this.request = { preset, blendSeconds: blend ? TIME_OF_DAY_BLEND_SECONDS : 0 };
    }
    this.last = preset;
    this.lastBoss = bossSky;
    this.window = Math.max(0, this.window - (Number.isFinite(realDt) && realDt > 0 ? realDt : 0));
    return this.request;
  }

  dispose(): void {
    for (const off of this.unsubscribe.splice(0)) off();
  }
}
