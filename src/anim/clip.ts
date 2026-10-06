/*
 * Pose clips (design.md "포즈 클립과 샘플링"): every motion is TS data (`PoseClip`, src/anim/clips/) with bind-relative
 * local joint rotations only; the sim always decides where the character is.
 *
 * - load: each track's key times become a Float32Array and its Euler degrees (XYZ order) a flat quaternion array, once
 *   per clip (cached). Binding to a rig resolves joint names to indices; a joint the rig lacks is a load error.
 * - sampling: the key segment holding the time is found (starting from the previous frame's segment while time runs
 *   forward) and its progress u is eased by the arrival key's `ease` — `linear` u, `inOut` (default) 3u² − 2u³,
 *   `out` 1 − (1 − u)² — before the slerp. A `loop` clip wraps from its last key to its first; others hold the last.
 * - `rootMotion.forward`: metres one cycle covers; the playback rate is `speed × duration / forward` so feet do not
 *   slide (the Animator never moves the root).
 * - events: fire once in the frame whose time passes them (loop wraps included).
 */
import * as THREE from 'three';

export type Ease = 'linear' | 'inOut' | 'out';
/** Rotation relative to the bind pose, Euler degrees in XYZ order. */
export type EulerDeg = readonly [number, number, number];

export interface Keyframe {
  readonly t: number;
  readonly rot: EulerDeg;
  readonly ease?: Ease;
}

export type ClipEventKind = 'hit' | 'footstep' | 'vfx' | 'sfx' | 'anticipation';

export interface ClipEvent {
  readonly t: number;
  readonly kind: ClipEventKind;
  readonly data?: string;
}

/** Joint name: a preset joint (humanoid: HumanoidBoneName | 'root'), a socket, a spring or an extra joint. */
export type JointName = string;

export interface PoseClip {
  readonly name: string;
  readonly duration: number;
  readonly loop: boolean;
  /** A joint without a track is left to the layers below. */
  readonly tracks: Readonly<Partial<Record<JointName, readonly Keyframe[]>>>;
  /** Distance (m) one cycle covers, for speed matching. */
  readonly rootMotion?: { readonly forward: number };
  readonly events: readonly ClipEvent[];
}

const EASE_CODE: Readonly<Record<Ease, number>> = { linear: 0, inOut: 1, out: 2 };

/** The eased progress of a segment (`code` of the arrival key). */
export function easeProgress(code: number, u: number): number {
  const x = u <= 0 ? 0 : u >= 1 ? 1 : u;
  if (code === 0) return x;
  if (code === 2) return 1 - (1 - x) * (1 - x);
  return x * x * (3 - 2 * x);
}

/** Ease by name (tests, authoring tools). */
export const ease = (name: Ease, u: number): number => easeProgress(EASE_CODE[name], u);

export interface LoadedTrack {
  readonly joint: JointName;
  readonly times: Float32Array;
  /** Quaternion per key (x, y, z, w). */
  readonly quats: Float32Array;
  /** Ease code of each key (the arrival key's applies to a segment). */
  readonly eases: Uint8Array;
}

export interface LoadedClip {
  readonly clip: PoseClip;
  readonly tracks: readonly LoadedTrack[];
}

const loaded = new WeakMap<PoseClip, LoadedClip>();
const _euler = new THREE.Euler();
const _q = new THREE.Quaternion();
const DEG = Math.PI / 180;

/** Euler degrees (XYZ) → quaternion. */
export function eulerToQuaternion(rot: EulerDeg, out = new THREE.Quaternion()): THREE.Quaternion {
  return out.setFromEuler(_euler.set(rot[0] * DEG, rot[1] * DEG, rot[2] * DEG, 'XYZ'));
}

/** Converts a clip once (cached): Float32 key times, quaternion keys; validates times and duration. */
export function loadClip(clip: PoseClip): LoadedClip {
  const cached = loaded.get(clip);
  if (cached !== undefined) return cached;
  if (!(clip.duration > 0)) throw new Error(`clip ${clip.name}: duration must be > 0`);
  const tracks: LoadedTrack[] = [];
  for (const [joint, keys] of Object.entries(clip.tracks)) {
    if (keys === undefined || keys.length === 0) continue;
    const times = new Float32Array(keys.length);
    const quats = new Float32Array(keys.length * 4);
    const eases = new Uint8Array(keys.length);
    let last = -Infinity;
    keys.forEach((k, i) => {
      if (!(k.t >= 0) || k.t > clip.duration + 1e-6 || k.t <= last) {
        throw new Error(`clip ${clip.name}: track ${joint} key ${i} time ${k.t} out of order or outside [0, ${clip.duration}]`);
      }
      last = k.t;
      times[i] = k.t;
      eulerToQuaternion(k.rot, _q).toArray(quats, i * 4);
      eases[i] = EASE_CODE[k.ease ?? 'inOut'];
    });
    tracks.push({ joint, times, quats, eases });
  }
  for (const e of clip.events) {
    if (!(e.t >= 0) || e.t > clip.duration + 1e-6) throw new Error(`clip ${clip.name}: event ${e.kind} at ${e.t} outside the clip`);
  }
  const result = { clip, tracks };
  loaded.set(clip, result);
  return result;
}

/** A clip bound to a rig: each track's joint index (into the rig's joint list). */
export interface BoundClip {
  readonly loaded: LoadedClip;
  readonly joints: Int32Array;
  /** Per-track segment cursor (the previous frame's segment). */
  readonly cursors: Int32Array;
}

/** Binds a clip to a rig's joint indices; a joint the rig does not have is a load error. */
export function bindClip(clip: PoseClip, jointIndex: ReadonlyMap<string, number>, rig: string): BoundClip {
  const l = loadClip(clip);
  const joints = new Int32Array(l.tracks.length);
  l.tracks.forEach((track, i) => {
    const index = jointIndex.get(track.joint);
    if (index === undefined) throw new Error(`clip ${clip.name}: joint '${track.joint}' is not a joint of rig ${rig}`);
    joints[i] = index;
  });
  return { loaded: l, joints, cursors: new Int32Array(l.tracks.length) };
}

/** Clip-local time: wrapped for loops, clamped otherwise. */
export function clipTime(clip: PoseClip, t: number): number {
  if (!Number.isFinite(t)) return 0;
  if (clip.loop) {
    const m = t % clip.duration;
    return m < 0 ? m + clip.duration : m;
  }
  return Math.min(clip.duration, Math.max(0, t));
}

/**
 * Samples one track at clip time `t` (already wrapped / clamped) into `out` (x, y, z, w at `offset`). `cursor` holds
 * the last segment index and is searched from while time runs forward.
 */
export function sampleTrack(
  track: LoadedTrack, t: number, clip: PoseClip, out: Float32Array, offset: number, cursors?: Int32Array, ci = 0,
): void {
  const { times, quats, eases } = track;
  const n = times.length;
  if (n === 1) {
    out.set(quats.subarray(0, 4), offset);
    return;
  }
  const first = times[0]!;
  const last = times[n - 1]!;
  if (t <= first || t >= last) {
    if (clip.loop && (first > 0 || last < clip.duration)) {
      // Wrap segment: last key → first key across the loop point.
      const span = clip.duration - last + first;
      const u = span > 0 ? (t >= last ? t - last : t + clip.duration - last) / span : 0;
      THREE.Quaternion.slerpFlat(out as unknown as number[], offset, quats as unknown as number[], (n - 1) * 4, quats as unknown as number[], 0, easeProgress(eases[0]!, u));
      return;
    }
    out.set(quats.subarray(t <= first ? 0 : (n - 1) * 4, t <= first ? 4 : n * 4), offset);
    return;
  }
  let i = cursors !== undefined ? cursors[ci]! : 0;
  if (i < 0 || i >= n - 1 || times[i]! > t) i = 0;
  while (i < n - 2 && times[i + 1]! <= t) i++;
  if (cursors !== undefined) cursors[ci] = i;
  const t0 = times[i]!;
  const t1 = times[i + 1]!;
  const u = (t - t0) / (t1 - t0);
  THREE.Quaternion.slerpFlat(out as unknown as number[], offset, quats as unknown as number[], i * 4, quats as unknown as number[], (i + 1) * 4, easeProgress(eases[i + 1]!, u));
}

/**
 * Samples a bound clip at time `t` into `pose` (4 floats per rig joint) and sets `mask[j] = 1` for its joints.
 * Wraps / clamps `t` first.
 */
export function sampleClip(bound: BoundClip, t: number, pose: Float32Array, mask: Uint8Array): void {
  const clip = bound.loaded.clip;
  const local = clipTime(clip, t);
  const tracks = bound.loaded.tracks;
  for (let i = 0; i < tracks.length; i++) {
    const j = bound.joints[i]!;
    sampleTrack(tracks[i]!, local, clip, pose, j * 4, bound.cursors, i);
    mask[j] = 1;
  }
}

/** Samples one joint of a clip at `t` (tests, tools): the quaternion, or null when the clip has no track for it. */
export function sampleJoint(clip: PoseClip, joint: JointName, t: number): THREE.Quaternion | null {
  const track = loadClip(clip).tracks.find((x) => x.joint === joint);
  if (track === undefined) return null;
  const out = new Float32Array(4);
  sampleTrack(track, clipTime(clip, t), clip, out, 0);
  return new THREE.Quaternion(out[0], out[1], out[2], out[3]);
}

/** Playback rate that matches the clip's `rootMotion.forward` to `speed` m/s (1 without root motion). */
export function playbackRate(clip: PoseClip, speed: number): number {
  const forward = clip.rootMotion?.forward;
  if (forward === undefined || !(forward > 0)) return 1;
  return Math.max(0, Number.isFinite(speed) ? speed : 0) * clip.duration / forward;
}

/**
 * Events the clip time passes going from `from` to `to` (raw, unwrapped times; `to` ≥ `from`): those with
 * from < t ≤ to, or from ≤ t when `inclusive` (the clip's first frame). Loop clips wrap (every cycle crossed counts
 * once per event, at most two cycles).
 */
export function eventsBetween(clip: PoseClip, from: number, to: number, inclusive: boolean, out: ClipEvent[]): void {
  if (!(to >= from) || clip.events.length === 0) return;
  if (!clip.loop) {
    for (const e of clip.events) if ((inclusive ? e.t >= from : e.t > from) && e.t <= to) out.push(e);
    return;
  }
  const d = clip.duration;
  const c0 = Math.floor(from / d);
  const c1 = Math.min(Math.floor(to / d), c0 + 2);
  for (let c = c0; c <= c1; c++) {
    for (const e of clip.events) {
      const at = c * d + e.t;
      if ((inclusive ? at >= from : at > from) && at <= to) out.push(e);
    }
  }
}
