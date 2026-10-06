/*
 * Clip authoring helpers (design.md "포즈 클립과 샘플링"): clips are written as a few key poses; `poseClip` turns them
 * into per-joint tracks (a joint a key leaves out holds its previous value, or its first given one before that).
 *
 * Humanoid pose vocabulary (bind pose = +Z-facing T-pose, left = +X; Euler degrees, XYZ):
 * - arm(side, { down, fwd, across, bend, twist }): upper arm lowered `down`° from the T-pose (90 hangs), swung `fwd`°
 *   forward (negative back), `across`° horizontally toward the front; forearm bent `bend`° at the elbow.
 * - leg(side, { lift, spread, knee, toe }): thigh raised `lift`° forward, `spread`° out, knee bent `knee`°, toes down.
 * - torso: [pitch (+ bends forward), yaw (+ turns to its left), roll (+ leans to its right)] per spine joint.
 */
import type { ClipEvent, Ease, EulerDeg, Keyframe, PoseClip } from '../clip';

export type Pose = Readonly<Partial<Record<string, EulerDeg>>>;

export interface KeyPose {
  readonly t: number;
  readonly pose: Pose;
  readonly ease?: Ease;
}

export interface PoseClipSpec {
  readonly name: string;
  readonly duration: number;
  readonly loop?: boolean;
  readonly keys: readonly KeyPose[];
  readonly events?: readonly ClipEvent[];
  /** rootMotion.forward (m per cycle). */
  readonly forward?: number;
}

/** Builds a PoseClip from key poses (every joint gets a key at every key time). */
export function poseClip(spec: PoseClipSpec): PoseClip {
  const keys = [...spec.keys].sort((a, b) => a.t - b.t);
  const joints: string[] = [];
  for (const k of keys) for (const j of Object.keys(k.pose)) if (!joints.includes(j)) joints.push(j);
  const tracks: Record<string, Keyframe[]> = {};
  for (const joint of joints) {
    const first = keys.find((k) => k.pose[joint] !== undefined)!.pose[joint]!;
    let held: EulerDeg = first;
    tracks[joint] = keys.map((k) => {
      held = k.pose[joint] ?? held;
      return { t: k.t, rot: held, ease: k.ease };
    });
  }
  return {
    name: spec.name,
    duration: spec.duration,
    loop: spec.loop ?? false,
    tracks,
    rootMotion: spec.forward === undefined ? undefined : { forward: spec.forward },
    events: spec.events ?? [],
  };
}

/** Merges poses left to right (later joints win). */
export const pose = (...parts: readonly Pose[]): Pose => Object.assign({}, ...parts) as Pose;

/** Mirrors a pose left ↔ right (yaw and roll flip sign). */
export function mirror(p: Pose): Pose {
  const out: Record<string, EulerDeg> = {};
  for (const [joint, rot] of Object.entries(p)) {
    if (rot === undefined) continue;
    const name = joint.startsWith('left') ? `right${joint.slice(4)}` : joint.startsWith('right') ? `left${joint.slice(5)}` : joint;
    out[name] = [rot[0], -rot[1], -rot[2]];
  }
  return out;
}

export type Side = 'left' | 'right';

export interface ArmPose {
  readonly down?: number;
  readonly fwd?: number;
  readonly across?: number;
  readonly bend?: number;
  readonly twist?: number;
  readonly wrist?: number;
}

export function arm(side: Side, a: ArmPose): Pose {
  const s = side === 'left' ? 1 : -1;
  return {
    [`${side}UpperArm`]: [-(a.fwd ?? 0), -s * (a.across ?? 0), -s * (a.down ?? 0)],
    [`${side}LowerArm`]: [a.twist ?? 0, -s * (a.bend ?? 0), 0],
    [`${side}Hand`]: [a.wrist ?? 0, 0, 0],
  };
}

export interface LegPose {
  readonly lift?: number;
  readonly spread?: number;
  readonly knee?: number;
  readonly toe?: number;
  readonly turn?: number;
}

export function leg(side: Side, l: LegPose): Pose {
  const s = side === 'left' ? 1 : -1;
  return {
    [`${side}UpperLeg`]: [-(l.lift ?? 0), s * (l.turn ?? 0), s * (l.spread ?? 0)],
    [`${side}LowerLeg`]: [l.knee ?? 0, 0, 0],
    [`${side}Foot`]: [l.toe ?? 0, 0, 0],
  };
}

export interface TorsoPose {
  readonly hips?: EulerDeg;
  readonly spine?: EulerDeg;
  readonly chest?: EulerDeg;
  readonly neck?: EulerDeg;
  readonly head?: EulerDeg;
  /** Shoulder shrug (+ raises both). */
  readonly shrug?: number;
}

export function torso(t: TorsoPose): Pose {
  const out: Record<string, EulerDeg> = {};
  for (const j of ['hips', 'spine', 'chest', 'neck', 'head'] as const) {
    const v = t[j];
    out[j] = v ?? [0, 0, 0];
  }
  const shrug = t.shrug ?? 0;
  out.leftShoulder = [0, 0, shrug];
  out.rightShoulder = [0, 0, -shrug];
  return out;
}

export interface BodyPose extends TorsoPose {
  readonly la?: ArmPose;
  readonly ra?: ArmPose;
  readonly ll?: LegPose;
  readonly rl?: LegPose;
}

/** A whole humanoid pose (every humanoid joint keyed). */
export function body(b: BodyPose): Pose {
  return pose(torso(b), arm('left', b.la ?? {}), arm('right', b.ra ?? {}), leg('left', b.ll ?? {}), leg('right', b.rl ?? {}));
}

/** Upper-body pose only (arms and spine above the hips): legs are left to the layer below. */
export function upper(b: BodyPose): Pose {
  const rest: Record<string, EulerDeg> = { ...(torso(b) as Record<string, EulerDeg>) };
  delete rest.hips;
  return pose(rest, arm('left', b.la ?? {}), arm('right', b.ra ?? {}));
}

/** The relaxed stance every humanoid clip starts from. */
export const STAND: BodyPose = {
  la: { down: 76, bend: 14, fwd: 4 },
  ra: { down: 76, bend: 14, fwd: 4 },
  ll: { lift: 2, spread: 2, knee: 4, toe: -2 },
  rl: { lift: 2, spread: 2, knee: 4, toe: -2 },
  spine: [3, 0, 0],
  head: [-2, 0, 0],
};

/** `base` with overrides (arms / legs merged field by field). */
export function variant(base: BodyPose, over: BodyPose): BodyPose {
  return {
    ...base,
    ...over,
    la: { ...base.la, ...over.la },
    ra: { ...base.ra, ...over.ra },
    ll: { ...base.ll, ...over.ll },
    rl: { ...base.rl, ...over.rl },
  };
}

/** `STAND` with overrides. */
export const stand = (over: BodyPose = {}): BodyPose => variant(STAND, over);

/** A pose maker over a base stance: `from(READY)({ ra: { … } })`. */
export const from = (base: BodyPose) => (over: BodyPose = {}): Pose => body(variant(base, over));

/** Event helpers. */
export const hit = (t: number): ClipEvent => ({ t, kind: 'hit' });
export const vfx = (t: number, data: string): ClipEvent => ({ t, kind: 'vfx', data });
export const sfx = (t: number, data: string): ClipEvent => ({ t, kind: 'sfx', data });
export const step = (t: number): ClipEvent => ({ t, kind: 'footstep' });
export const anticipation = (t: number, data?: string): ClipEvent => ({ t, kind: 'anticipation', data });
/** Melee trail window (the VFX ribbon between `trail:on` and `trail:off`). */
export const trail = (on: number, off: number): ClipEvent[] => [vfx(on, 'trail:on'), vfx(off, 'trail:off')];
