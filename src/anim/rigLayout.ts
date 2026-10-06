/*
 * Preset skeleton layouts (design.md "Rig kit"): joint names, hierarchy and rest positions for given proportions.
 * Rest is the +Z-facing T-pose and every joint's rest world rotation is identity, so a joint's local offset is simply
 * its world position minus its parent's; a procedural humanoid's raw skeleton therefore equals the normalized humanoid
 * skeleton (Req 43.4). Pure arithmetic: no three.js objects are made here.
 *
 * humanoid: root → hips → spine → chest → neck → head; chest → {left,right}Shoulder → UpperArm → LowerArm → Hand;
 *   hips → {left,right}UpperLeg → LowerLeg → Foot (VRM humanoid bone names). Left is +X.
 * quadruped: root → hips → spine → chest → neck → head; chest → {left,right}FrontUpperLeg → …LowerLeg → …Foot,
 *   hips → {left,right}BackUpperLeg → …; the body runs along Z.
 * crab: root → body → head; body → {left,right}Leg{0,1,2}Upper → Lower → Foot, body → {left,right}ClawUpper → Claw.
 * stalk: root → stalk0 … stalk3 → head → petal0 … petal4.
 * floater: root → body → head; body → {left,right}Wing0 → Wing1 → Wing2.
 * Every preset adds the sockets weaponR, weaponL, back and headTop, then the spec's spring chains (`${id}_${i}`).
 */
import type {
  ChainLayout, ExtraJointDef, JointDef, LimbProportions, RigDims, RigLayout, RigPreset, SpringDef, V3,
} from './rigTypes';
import type { SocketName } from '../data/visualManifest';

/** The 19 VRM humanoid bones of the procedural humanoid, parent before child. */
export const RIG_HUMANOID_BONES = [
  'hips', 'spine', 'chest', 'neck', 'head',
  'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand',
  'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot',
  'rightUpperLeg', 'rightLowerLeg', 'rightFoot',
] as const;
export type RigHumanoidBone = (typeof RIG_HUMANOID_BONES)[number];

export const RIG_SOCKETS: readonly SocketName[] = ['weaponR', 'weaponL', 'back', 'headTop'];

/** Joint name of chain `id`'s segment `i`. */
export const chainJoint = (id: string, i: number): string => `${id}_${i}`;

export interface LayoutParams {
  readonly preset: RigPreset;
  readonly height: number;
  readonly headRatio: number;
  readonly shoulderScale: number;
  readonly springs: readonly SpringDef[];
  readonly proportions?: LimbProportions;
  readonly extraJoints?: readonly ExtraJointDef[];
  /** Parent of the held-weapon socket (weaponR or weaponL, see `weaponSocket`). */
  readonly weaponParent?: string;
  readonly weaponSocket?: 'weaponR' | 'weaponL';
}

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mirror = (p: V3): V3 => [-p[0], p[1], p[2]];

/** Joints and derived dims of one preset (without sockets and springs). */
function presetJoints(p: LayoutParams): { joints: JointDef[]; dims: RigDims; sockets: Record<SocketName, { parent: string; pos: V3 }> } {
  const H = p.height;
  const joints: JointDef[] = [{ name: 'root', parent: null, pos: [0, 0, 0] }];
  const j = (name: string, parent: string, pos: V3): V3 => {
    joints.push({ name, parent, pos });
    return pos;
  };
  switch (p.preset) {
    case 'humanoid': {
      const headH = H / p.headRatio;
      const sh = 0.1 * H * p.shoulderScale; // shoulder half-width (upper-arm joints)
      const hipX = 0.052 * H * Math.max(0.9, Math.min(1.25, p.shoulderScale));
      // Limb proportions: arm / leg length multipliers; a shorter leg lowers the hips and lengthens the torso.
      const arm = p.proportions?.arm ?? 1;
      const leg = p.proportions?.leg ?? 1;
      const hipsY = 0.53 * H * leg;
      const drop = 0.53 * H - hipsY;
      j('hips', 'root', [0, hipsY, 0]);
      j('spine', 'hips', [0, 0.6 * H - drop * 0.5, 0]);
      const chest = j('chest', 'spine', [0, 0.69 * H - drop * 0.2, 0]);
      const neckY = H - headH - 0.035 * H;
      j('neck', 'chest', [0, neckY, -0.005 * H]);
      const head = j('head', 'neck', [0, H - headH * 0.9, -0.004 * H]);
      const shoulderY = neckY - 0.022 * H;
      for (const [side, s] of [['left', 1], ['right', -1]] as const) {
        j(`${side}Shoulder`, 'chest', [s * 0.022 * H, shoulderY, -0.004 * H]);
        j(`${side}UpperArm`, `${side}Shoulder`, [s * sh, shoulderY, -0.004 * H]);
        j(`${side}LowerArm`, `${side}UpperArm`, [s * (sh + 0.165 * H * arm), shoulderY, -0.004 * H]);
        j(`${side}Hand`, `${side}LowerArm`, [s * (sh + 0.305 * H * arm), shoulderY, -0.004 * H]);
      }
      for (const [side, s] of [['left', 1], ['right', -1]] as const) {
        j(`${side}UpperLeg`, 'hips', [s * hipX, 0.5 * H * leg, 0]);
        j(`${side}LowerLeg`, `${side}UpperLeg`, [s * hipX * 0.92, 0.048 * H + 0.222 * H * leg, 0.004 * H]);
        j(`${side}Foot`, `${side}LowerLeg`, [s * hipX * 0.9, 0.048 * H, -0.006 * H]);
      }
      const headRadius = headH * 0.5;
      const headCenter: V3 = [0, H - headH * 0.5, 0.004 * H];
      return {
        joints,
        dims: { headHeight: headH, headRadius, headCenter, shoulderHalf: sh, hipHalf: hipX, limb: H / 1.72 },
        sockets: {
          weaponR: { parent: 'rightHand', pos: add(joints.find((x) => x.name === 'rightHand')!.pos, [-0.03 * H, -0.008 * H, 0]) },
          weaponL: { parent: 'leftHand', pos: add(joints.find((x) => x.name === 'leftHand')!.pos, [0.03 * H, -0.008 * H, 0]) },
          back: { parent: 'chest', pos: add(chest, [0, 0.02 * H, -0.1 * H * Math.max(1, p.shoulderScale * 0.9)]) },
          headTop: { parent: 'head', pos: [0, H + 0.01 * H, head[2]] },
        },
      };
    }
    case 'quadruped': {
      const L = 1.15 * H; // body length
      const hips = j('hips', 'root', [0, 0.62 * H, -0.32 * L]);
      j('spine', 'hips', [0, 0.64 * H, -0.02 * L]);
      const chest = j('chest', 'spine', [0, 0.66 * H, 0.26 * L]);
      j('neck', 'chest', [0, 0.76 * H, 0.4 * L]);
      const head = j('head', 'neck', [0, 0.86 * H, 0.52 * L]);
      const half = 0.14 * H * p.shoulderScale;
      for (const [side, s] of [['left', 1], ['right', -1]] as const) {
        for (const [end, base] of [['Front', chest], ['Back', hips]] as const) {
          const name = `${side}${end}`;
          j(`${name}UpperLeg`, end === 'Front' ? 'chest' : 'hips', [s * half, base[1] - 0.04 * H, base[2]]);
          j(`${name}LowerLeg`, `${name}UpperLeg`, [s * half, 0.32 * H, base[2] + (end === 'Front' ? -0.02 : 0.03) * L]);
          j(`${name}Foot`, `${name}LowerLeg`, [s * half, 0.05 * H, base[2]]);
        }
      }
      return {
        joints,
        dims: { headHeight: 0.3 * H, headRadius: 0.15 * H, headCenter: add(head, [0, 0, 0.06 * L]), shoulderHalf: half, hipHalf: half, limb: H },
        sockets: {
          weaponR: { parent: 'head', pos: add(head, [0, -0.05 * H, 0.14 * L]) },
          weaponL: { parent: 'head', pos: add(head, [0, -0.05 * H, 0.14 * L]) },
          back: { parent: 'spine', pos: add(joints[2]!.pos, [0, 0.14 * H, 0]) },
          headTop: { parent: 'head', pos: add(head, [0, 0.16 * H, 0]) },
        },
      };
    }
    case 'crab': {
      const W = 0.9 * H * p.shoulderScale; // shell half-width
      const body = j('body', 'root', [0, 0.5 * H, 0]);
      const head = j('head', 'body', [0, 0.58 * H, 0.42 * W]);
      for (const [side, s] of [['left', 1], ['right', -1]] as const) {
        for (let i = 0; i < 3; i++) {
          const z = (0.25 - i * 0.3) * W;
          const name = `${side}Leg${i}`;
          j(`${name}Upper`, 'body', [s * 0.6 * W, 0.46 * H, z]);
          j(`${name}Lower`, `${name}Upper`, [s * 1.05 * W, 0.55 * H, z * 1.2]);
          j(`${name}Foot`, `${name}Lower`, [s * 1.35 * W, 0.04 * H, z * 1.35]);
        }
        j(`${side}ClawUpper`, 'body', [s * 0.5 * W, 0.52 * H, 0.55 * W]);
        j(`${side}Claw`, `${side}ClawUpper`, [s * 0.75 * W, 0.5 * H, 1.05 * W]);
      }
      return {
        joints,
        dims: { headHeight: 0.2 * H, headRadius: 0.1 * H, headCenter: head, shoulderHalf: W, hipHalf: W, limb: H },
        sockets: {
          weaponR: { parent: 'rightClaw', pos: add(joints.find((x) => x.name === 'rightClaw')!.pos, [0, 0, 0.1 * W]) },
          weaponL: { parent: 'leftClaw', pos: add(joints.find((x) => x.name === 'leftClaw')!.pos, [0, 0, 0.1 * W]) },
          back: { parent: 'body', pos: add(body, [0, 0.3 * H, -0.1 * W]) },
          headTop: { parent: 'head', pos: add(head, [0, 0.22 * H, 0]) },
        },
      };
    }
    case 'stalk': {
      let parent = 'root';
      for (let i = 0; i < 4; i++) {
        j(`stalk${i}`, parent, [0, (0.02 + i * 0.19) * H, 0]);
        parent = `stalk${i}`;
      }
      const head = j('head', parent, [0, 0.8 * H, 0]);
      const r = 0.12 * H * p.shoulderScale;
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        j(`petal${i}`, 'head', [Math.sin(a) * r * 0.6, 0.86 * H, Math.cos(a) * r * 0.6]);
      }
      return {
        joints,
        dims: { headHeight: 0.24 * H, headRadius: r, headCenter: add(head, [0, 0.08 * H, 0]), shoulderHalf: r, hipHalf: 0.08 * H, limb: H },
        sockets: {
          weaponR: { parent: 'head', pos: add(head, [0, 0.08 * H, r]) },
          weaponL: { parent: 'head', pos: add(head, [0, 0.08 * H, r]) },
          back: { parent: 'stalk2', pos: [0, 0.4 * H, -0.08 * H] },
          headTop: { parent: 'head', pos: add(head, [0, 0.24 * H, 0]) },
        },
      };
    }
    case 'floater': {
      const body = j('body', 'root', [0, 0.55 * H, 0]);
      const head = j('head', 'body', [0, 0.62 * H, 0.18 * H]);
      const span = 0.25 * H * p.shoulderScale;
      for (const [side, s] of [['left', 1], ['right', -1]] as const) {
        j(`${side}Wing0`, 'body', [s * 0.12 * H, 0.6 * H, -0.02 * H]);
        j(`${side}Wing1`, `${side}Wing0`, [s * (0.12 * H + span), 0.62 * H, -0.05 * H]);
        j(`${side}Wing2`, `${side}Wing1`, [s * (0.12 * H + 2 * span), 0.6 * H, -0.1 * H]);
      }
      return {
        joints,
        dims: { headHeight: 0.2 * H, headRadius: 0.1 * H, headCenter: head, shoulderHalf: span, hipHalf: 0.1 * H, limb: H },
        sockets: {
          weaponR: { parent: 'head', pos: add(head, [0, 0, 0.1 * H]) },
          weaponL: { parent: 'head', pos: add(head, [0, 0, 0.1 * H]) },
          back: { parent: 'body', pos: add(body, [0, 0.1 * H, -0.15 * H]) },
          headTop: { parent: 'head', pos: add(head, [0, 0.15 * H, 0]) },
        },
      };
    }
  }
}

/** Builds the rest layout of a preset for given proportions, with its sockets and spring chains. */
export function buildLayout(p: LayoutParams): RigLayout {
  if (!(p.height > 0) || !(p.headRatio > 0) || !(p.shoulderScale > 0)) {
    throw new RangeError(`rigLayout: height, headRatio and shoulderScale must be > 0 (got ${p.height}, ${p.headRatio}, ${p.shoulderScale})`);
  }
  const { joints, dims, sockets } = presetJoints(p);
  const byName = new Map<string, JointDef>(joints.map((x) => [x.name, x]));
  const push = (def: JointDef): void => {
    if (byName.has(def.name)) throw new Error(`rigLayout: duplicate joint '${def.name}'`);
    if (def.parent !== null && !byName.has(def.parent)) throw new Error(`rigLayout: '${def.name}' has unknown parent '${def.parent}'`);
    joints.push(def);
    byName.set(def.name, def);
  };
  for (const extra of p.extraJoints ?? []) {
    const parent = byName.get(extra.parent);
    if (parent === undefined) throw new Error(`rigLayout: extra joint '${extra.name}' has unknown parent '${extra.parent}'`);
    push({ name: extra.name, parent: extra.parent, pos: extra.pos ?? add(parent.pos, extra.offset ?? [0, 0, 0]) });
  }
  const held = p.weaponSocket ?? 'weaponR';
  for (const name of RIG_SOCKETS) {
    const s = sockets[name];
    if (name === held && p.weaponParent !== undefined && p.weaponParent !== s.parent) {
      const parent = byName.get(p.weaponParent);
      if (parent === undefined) throw new Error(`rigLayout: weaponParent '${p.weaponParent}' is not a joint of ${p.preset}`);
      // On a forearm (Talus's shield): halfway along it, on the outer side.
      const child = joints.find((x) => x.parent === p.weaponParent);
      const mid: V3 = child === undefined ? parent.pos : [(parent.pos[0] + child.pos[0]) / 2, (parent.pos[1] + child.pos[1]) / 2, (parent.pos[2] + child.pos[2]) / 2];
      push({ name, parent: p.weaponParent, pos: mid });
    } else {
      push({ name, parent: s.parent, pos: s.pos });
    }
  }
  const chains = new Map<string, ChainLayout>();
  for (const def of p.springs) {
    if (!(def.segments >= 4 && def.segments <= 8) || !Number.isInteger(def.segments)) {
      throw new RangeError(`rigLayout: spring '${def.id}' needs 4–8 segments (got ${def.segments})`);
    }
    if (!(def.segLength > 0)) throw new RangeError(`rigLayout: spring '${def.id}' segLength must be > 0`);
    const parent = byName.get(def.parent);
    if (parent === undefined) throw new Error(`rigLayout: spring '${def.id}' has unknown parent '${def.parent}'`);
    const raw = def.dir ?? [0, -1, 0];
    const len = Math.hypot(raw[0], raw[1], raw[2]) || 1;
    const dir: V3 = [raw[0] / len, raw[1] / len, raw[2] / len];
    const start = add(parent.pos, def.offset ?? [0, 0, 0]);
    const points: V3[] = [];
    const names: string[] = [];
    for (let i = 0; i <= def.segments; i++) {
      const d = i * def.segLength;
      points.push([start[0] + dir[0] * d, start[1] + dir[1] * d, start[2] + dir[2] * d]);
    }
    for (let i = 0; i < def.segments; i++) {
      const name = chainJoint(def.id, i);
      push({ name, parent: i === 0 ? def.parent : chainJoint(def.id, i - 1), pos: points[i]! });
      names.push(name);
    }
    chains.set(def.id, { def, joints: names, points, dir });
  }
  return {
    preset: p.preset,
    height: p.height,
    joints,
    chains,
    dims,
    has: (name) => byName.has(name),
    pos: (name) => {
      const joint = byName.get(name);
      if (joint === undefined) throw new Error(`rigLayout: unknown joint '${name}'`);
      return joint.pos;
    },
  };
}

export { mirror as mirrorX };
