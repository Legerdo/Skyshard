/*
 * Animator (design.md "레이어와 블렌드"): one per rig, composing three layers joint by joint. An upper layer overwrites
 * only the joints its current clip has tracks for; the rest keep the layers below.
 *
 * - base (locomotion): a clip or a blend — 1D over speed (idle · walk · run · sprint, sharing one normalised phase so the
 *   footfalls never drift while blending) or 2D (climbIdle and the four climb directions by the climb input).
 * - action: attacks, Skill, Burst and hurt; a clip with leg tracks covers the legs too, `hurt` leaves them to the base.
 * - override: full-body clips (jump, fall, land, dodge, climb, mantle, glide, swim, downed…).
 * - crossfade: entering / leaving a layer and changing its clip blend over `blendTime(from, to)` (0.1–0.25 s,
 *   ./blendTimes). A transition during a blend snapshots the layer's current output as its start, so nothing pops.
 * - time: free clips advance by scaled `dt` × rate (rootMotion speed matching); driven clips take the time the request
 *   gives (attack clips from the sim's attack clock, render-interpolated). Events fire once as the time passes them.
 * The Animator writes local quaternions of the joints its clips drive and nothing else (springs, sockets stay).
 */
import type * as THREE from 'three';
import { blendTime } from './blendTimes';
import { bindClip, clipTime, eventsBetween, playbackRate, sampleClip, type BoundClip, type ClipEvent, type PoseClip } from './clip';

export interface BlendPoint1D {
  readonly clip: string;
  /** Blend parameter (speed m/s) at which this clip has full weight. */
  readonly at: number;
}

export type BlendDef =
  | { readonly kind: '1d'; readonly points: readonly BlendPoint1D[] }
  | { readonly kind: '2d'; readonly center: string; readonly up: string; readonly down: string; readonly left: string; readonly right: string };

/** What one layer should play: a clip (free, or driven by `time`) or a named blend. */
export type LayerRequest =
  | { readonly clip: string; readonly time?: number; readonly speed?: number }
  | { readonly blend: string; readonly x: number; readonly y?: number; readonly speed?: number };

export interface AnimRequest {
  readonly base: LayerRequest;
  readonly action: LayerRequest | null;
  readonly override: LayerRequest | null;
}

export type LayerName = 'base' | 'action' | 'override';
export const LAYERS: readonly LayerName[] = ['base', 'action', 'override'];

export interface AnimatorEvent {
  readonly layer: LayerName;
  readonly clip: string;
  readonly event: ClipEvent;
}

export interface AnimatorOptions {
  /** Rig name for load errors. */
  readonly name: string;
  readonly blends?: Readonly<Record<string, BlendDef>>;
  /** Crossfade time override (default ./blendTimes). */
  readonly blendTime?: (from: string | null, to: string | null) => number;
}

const smooth = (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const EPS = 1e-6;

/** Quaternion slerp between flat arrays (shortest arc). */
function slerpInto(out: Float32Array, o: number, a: Float32Array, ao: number, b: Float32Array, bo: number, t: number): void {
  let ax = a[ao]!, ay = a[ao + 1]!, az = a[ao + 2]!, aw = a[ao + 3]!;
  let bx = b[bo]!, by = b[bo + 1]!, bz = b[bo + 2]!, bw = b[bo + 3]!;
  if (t <= 0) {
    out[o] = ax; out[o + 1] = ay; out[o + 2] = az; out[o + 3] = aw;
    return;
  }
  if (t >= 1) {
    out[o] = bx; out[o + 1] = by; out[o + 2] = bz; out[o + 3] = bw;
    return;
  }
  let cos = ax * bx + ay * by + az * bz + aw * bw;
  if (cos < 0) {
    bx = -bx; by = -by; bz = -bz; bw = -bw;
    cos = -cos;
  }
  let k0: number;
  let k1: number;
  if (cos > 0.9995) {
    k0 = 1 - t;
    k1 = t;
  } else {
    const angle = Math.acos(cos);
    const sin = Math.sin(angle);
    k0 = Math.sin((1 - t) * angle) / sin;
    k1 = Math.sin(t * angle) / sin;
  }
  ax = ax * k0 + bx * k1; ay = ay * k0 + by * k1; az = az * k0 + bz * k1; aw = aw * k0 + bw * k1;
  const len = Math.hypot(ax, ay, az, aw) || 1;
  out[o] = ax / len; out[o + 1] = ay / len; out[o + 2] = az / len; out[o + 3] = aw / len;
}

interface Fade {
  readonly from: Float32Array;
  readonly fromMask: Uint8Array;
  elapsed: number;
  readonly duration: number;
}

class Layer {
  key: string | null = null;
  /** Clip / blend name shown to blendTime (the key without its kind prefix). */
  label: string | null = null;
  time = 0;
  /** Blend phase 0..1 (blends only). */
  phase = 0;
  lastEventTime = 0;
  fresh = true;
  fade: Fade | null = null;
  readonly out: Float32Array;
  readonly outMask: Uint8Array;
  readonly cur: Float32Array;
  readonly curMask: Uint8Array;
  /** Clip of the last frame (event source), null for none. */
  source: string | null = null;

  constructor(joints: number) {
    this.out = new Float32Array(joints * 4);
    this.outMask = new Uint8Array(joints);
    this.cur = new Float32Array(joints * 4);
    this.curMask = new Uint8Array(joints);
  }
}

/** One rig's layered clip player. */
export class Animator {
  /** Joint names the clips drive, index-aligned with `bones`. */
  readonly jointNames: readonly string[];
  private readonly bones: THREE.Object3D[];
  private readonly clips = new Map<string, BoundClip>();
  private readonly blends: Readonly<Record<string, BlendDef>>;
  private readonly layers: Record<LayerName, Layer>;
  private readonly result: Float32Array;
  private readonly resultMask: Uint8Array;
  private readonly scratch: Float32Array;
  private readonly scratchMask: Uint8Array;
  private readonly blendTimeOf: (from: string | null, to: string | null) => number;
  private readonly events: AnimatorEvent[] = [];
  private readonly eventScratch: ClipEvent[] = [];
  /** After the first update: transitions blend from then on. */
  private started = false;

  constructor(joints: ReadonlyMap<string, THREE.Object3D>, clips: readonly PoseClip[], readonly options: AnimatorOptions) {
    const names: string[] = [];
    const seen = new Set<string>();
    for (const clip of clips) {
      for (const joint of Object.keys(clip.tracks)) {
        if (seen.has(joint)) continue;
        if (!joints.has(joint)) throw new Error(`clip ${clip.name}: joint '${joint}' is not a joint of rig ${options.name}`);
        seen.add(joint);
        names.push(joint);
      }
    }
    this.jointNames = names;
    this.bones = names.map((n) => joints.get(n)!);
    const index = new Map(names.map((n, i) => [n, i]));
    for (const clip of clips) {
      if (this.clips.has(clip.name)) throw new Error(`rig ${options.name}: clip '${clip.name}' given twice`);
      this.clips.set(clip.name, bindClip(clip, index, options.name));
    }
    this.blends = options.blends ?? {};
    for (const [id, def] of Object.entries(this.blends)) {
      const members = def.kind === '1d' ? def.points.map((p) => p.clip) : [def.center, def.up, def.down, def.left, def.right];
      for (const m of members) if (!this.clips.has(m)) throw new Error(`rig ${options.name}: blend '${id}' needs clip '${m}'`);
    }
    const n = names.length;
    this.layers = { base: new Layer(n), action: new Layer(n), override: new Layer(n) };
    this.result = new Float32Array(n * 4);
    this.resultMask = new Uint8Array(n);
    this.scratch = new Float32Array(n * 4);
    this.scratchMask = new Uint8Array(n);
    this.blendTimeOf = options.blendTime ?? blendTime;
  }

  has(clip: string): boolean {
    return this.clips.has(clip);
  }

  clip(name: string): PoseClip | undefined {
    return this.clips.get(name)?.loaded.clip;
  }

  /** Current clip or blend of a layer (null: inactive). */
  current(layer: LayerName): string | null {
    return this.layers[layer].label;
  }

  /** Whether a layer is crossfading now. */
  fading(layer: LayerName): boolean {
    return this.layers[layer].fade !== null;
  }

  /** Current clip time of a layer (blends: phase × the dominant clip's duration). */
  time(layer: LayerName): number {
    return this.layers[layer].time;
  }

  /** Rest pose on every driven joint, all layers cleared (a new model, a respawn). */
  reset(): void {
    this.started = false;
    for (const name of LAYERS) {
      const l = this.layers[name];
      l.key = null;
      l.label = null;
      l.fade = null;
      l.outMask.fill(0);
      l.source = null;
    }
    for (const bone of this.bones) bone.quaternion.identity();
  }

  /**
   * Advances every layer by `dt` (scaled) s toward `req`, writes the composed pose to the bones and returns the clip
   * events passed this frame (valid until the next update).
   */
  update(dt: number, req: AnimRequest): readonly AnimatorEvent[] {
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    this.events.length = 0;
    const n = this.jointNames.length;
    // Below the base: the rest pose.
    for (let j = 0; j < n; j++) {
      this.result[j * 4] = 0;
      this.result[j * 4 + 1] = 0;
      this.result[j * 4 + 2] = 0;
      this.result[j * 4 + 3] = 1;
    }
    this.resultMask.fill(0);
    this.evaluate('base', req.base, step);
    this.evaluate('action', req.action, step);
    this.evaluate('override', req.override, step);
    this.started = true;
    for (let j = 0; j < n; j++) {
      const bone = this.bones[j]!;
      if (this.resultMask[j] === 1) bone.quaternion.fromArray(this.result, j * 4);
      else bone.quaternion.identity();
    }
    return this.events;
  }

  private keyOf(req: LayerRequest | null): { key: string | null; label: string | null } {
    if (req === null) return { key: null, label: null };
    if ('clip' in req) {
      if (!this.clips.has(req.clip)) throw new Error(`rig ${this.options.name}: no clip '${req.clip}'`);
      return { key: `c:${req.clip}`, label: req.clip };
    }
    if (this.blends[req.blend] === undefined) throw new Error(`rig ${this.options.name}: no blend '${req.blend}'`);
    return { key: `b:${req.blend}`, label: req.blend };
  }

  private evaluate(name: LayerName, req: LayerRequest | null, dt: number): void {
    const layer = this.layers[name];
    const { key, label } = this.keyOf(req);
    // A driven clip whose time jumps back (the same attack started again) restarts like a new clip.
    const rewound = key !== null && key === layer.key && req !== null && 'clip' in req && req.time !== undefined && req.time < layer.time - 1e-3;
    if (key !== layer.key || rewound) {
      // Transition: the layer's last output is the start pose (a blend mid-way included). The very first pose of
      // the rig and the base layer's first clip snap (nothing to blend from).
      const duration = this.blendTimeOf(rewound ? null : layer.label, label);
      const wasActive = layer.key !== null || layer.fade !== null;
      layer.fade = !this.started || (name === 'base' && !wasActive) || (!wasActive && key === null)
        ? null
        : { from: layer.out.slice(), fromMask: layer.outMask.slice(), elapsed: 0, duration: Math.max(EPS, duration) };
      layer.key = key;
      layer.label = label;
      layer.time = 0;
      layer.phase = name === 'base' ? layer.phase : 0;
      layer.fresh = true;
    }
    const n = this.jointNames.length;
    layer.curMask.fill(0);
    if (req !== null) this.sample(name, layer, req, dt);
    const below = this.result;
    const belowMask = this.resultMask;
    layer.outMask.fill(0);
    if (layer.fade !== null) {
      const f = layer.fade;
      f.elapsed += dt;
      const k = smooth(f.elapsed / f.duration);
      for (let j = 0; j < n; j++) {
        const inFrom = f.fromMask[j] === 1;
        const inCur = layer.curMask[j] === 1;
        if (!inFrom && !inCur) continue;
        const a = inFrom ? f.from : below;
        const b = inCur ? layer.cur : below;
        slerpInto(layer.out, j * 4, a, j * 4, b, j * 4, k);
        layer.outMask[j] = 1;
      }
      if (f.elapsed >= f.duration - EPS) layer.fade = null;
    } else {
      layer.out.set(layer.cur);
      layer.outMask.set(layer.curMask);
    }
    for (let j = 0; j < n; j++) {
      if (layer.outMask[j] !== 1) continue;
      below[j * 4] = layer.out[j * 4]!;
      below[j * 4 + 1] = layer.out[j * 4 + 1]!;
      below[j * 4 + 2] = layer.out[j * 4 + 2]!;
      below[j * 4 + 3] = layer.out[j * 4 + 3]!;
      belowMask[j] = 1;
    }
  }

  private sample(name: LayerName, layer: Layer, req: LayerRequest, dt: number): void {
    if ('clip' in req) {
      const bound = this.clips.get(req.clip)!;
      const clip = bound.loaded.clip;
      const prev = layer.time;
      if (req.time !== undefined) layer.time = Math.max(0, req.time);
      else layer.time += dt * (req.speed === undefined ? 1 : playbackRate(clip, req.speed));
      sampleClip(bound, layer.time, layer.cur, layer.curMask);
      this.emit(name, clip, layer.fresh ? 0 : prev, layer.time, layer.fresh);
      layer.fresh = false;
      layer.source = clip.name;
      return;
    }
    const def = this.blends[req.blend]!;
    const weights = this.weights(def, req);
    // Shared phase: advances at the weighted cycle rate of the members (speed-matched).
    const speed = req.speed ?? req.x;
    let rate = 0;
    for (const [clipName, w] of weights) {
      const clip = this.clips.get(clipName)!.loaded.clip;
      const cycle = clip.rootMotion !== undefined && clip.rootMotion.forward > 0 ? Math.max(0, speed) / clip.rootMotion.forward : 1 / clip.duration;
      rate += w * cycle;
    }
    const prevPhase = layer.phase;
    layer.phase += dt * rate;
    let dominant = weights[0]![0];
    let best = -1;
    let acc = 0;
    const n = this.jointNames.length;
    this.scratchMask.fill(0);
    for (const [clipName, w] of weights) {
      if (w <= 0) continue;
      const bound = this.clips.get(clipName)!;
      const clip = bound.loaded.clip;
      if (w > best) {
        best = w;
        dominant = clipName;
      }
      this.scratchMask.fill(0);
      sampleClip(bound, layer.phase * clip.duration, this.scratch, this.scratchMask);
      // Running normalised sum (nlerp): the first member seeds, the others slerp in by their share.
      const share = w / (acc + w);
      for (let j = 0; j < n; j++) {
        if (this.scratchMask[j] !== 1) {
          this.scratch[j * 4] = 0;
          this.scratch[j * 4 + 1] = 0;
          this.scratch[j * 4 + 2] = 0;
          this.scratch[j * 4 + 3] = 1;
        }
        if (acc === 0) {
          layer.cur[j * 4] = this.scratch[j * 4]!;
          layer.cur[j * 4 + 1] = this.scratch[j * 4 + 1]!;
          layer.cur[j * 4 + 2] = this.scratch[j * 4 + 2]!;
          layer.cur[j * 4 + 3] = this.scratch[j * 4 + 3]!;
        } else {
          slerpInto(layer.cur, j * 4, layer.cur, j * 4, this.scratch, j * 4, share);
        }
        if (this.scratchMask[j] === 1) layer.curMask[j] = 1;
      }
      acc += w;
    }
    const clip = this.clips.get(dominant)!.loaded.clip;
    layer.time = layer.phase * clip.duration;
    // Footsteps and other events only from the dominant member (design "events").
    if (layer.source === dominant && !layer.fresh) this.emit(name, clip, prevPhase * clip.duration, layer.time, false);
    layer.source = dominant;
    layer.fresh = false;
  }

  /** Member weights of a blend (summing to 1). */
  private weights(def: BlendDef, req: Extract<LayerRequest, { blend: string }>): [string, number][] {
    if (def.kind === '1d') {
      const pts = def.points;
      const x = Number.isFinite(req.x) ? req.x : 0;
      if (x <= pts[0]!.at) return [[pts[0]!.clip, 1]];
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i]!;
        const b = pts[i + 1]!;
        if (x <= b.at) {
          const w = (x - a.at) / Math.max(EPS, b.at - a.at);
          return [[a.clip, 1 - w], [b.clip, w]];
        }
      }
      return [[pts[pts.length - 1]!.clip, 1]];
    }
    const x = Math.max(-1, Math.min(1, Number.isFinite(req.x) ? req.x : 0));
    const y = Math.max(-1, Math.min(1, Number.isFinite(req.y ?? 0) ? req.y ?? 0 : 0));
    let wx = Math.abs(x);
    let wy = Math.abs(y);
    const sum = wx + wy;
    if (sum > 1) {
      wx /= sum;
      wy /= sum;
    }
    const out: [string, number][] = [[def.center, Math.max(0, 1 - wx - wy)]];
    if (wx > 0) out.push([x > 0 ? def.right : def.left, wx]);
    if (wy > 0) out.push([y > 0 ? def.up : def.down, wy]);
    return out;
  }

  private emit(layer: LayerName, clip: PoseClip, from: number, to: number, inclusive: boolean): void {
    if (clip.events.length === 0 || to < from) return;
    const scratch = this.eventScratch;
    scratch.length = 0;
    if (clip.loop) eventsBetween(clip, from, to, inclusive, scratch);
    else eventsBetween(clip, clipTime(clip, from), clipTime(clip, to), inclusive, scratch);
    for (const event of scratch) {
      if (event.kind === 'footstep' && layer !== 'base') continue;
      this.events.push({ layer, clip: clip.name, event });
    }
  }
}
