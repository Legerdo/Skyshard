/*
 * Humanoid bone detection for external models (design.md "시각 모델 교체 구조": bone 대응 우선순위, 이름 정규화,
 * three.js 이름 정리, 동의어와 계층 검증, 대응표 출력; Req 43.4, 43.7). Pure: it works on a flat node list (name,
 * parent index, bone flag) so it runs without three.js.
 *
 * - Priority: the manifest `boneMap` (manual) > the VRM humanoid definition > automatic detection.
 * - Names: lower case, namespace prefixes dropped (`mixamorig:`, `Armature|`, `Character1_`), VRoid `J_Bip_C_` dropped
 *   and `J_Bip_L_` / `J_Bip_R_` kept as the side only, 3ds Max `Bip01`, Rigify `DEF-` / `ORG-` dropped, and every side
 *   spelling (`Left…`, `L_…`, `…_L`, `….L`, `…L` after three.js strips the dot, DAZ `l…`) unified. three.js loaders
 *   strip `:` and `.` from node names (`mixamorig:Hips` → `mixamorigHips`, `UpperArm.L` → `UpperArmL`); the stripped
 *   forms follow the same rules.
 * - Synonyms: upperarm / arm, lowerarm / forearm, upperleg / upleg / thigh, lowerleg / leg / shin / calf, the spine
 *   chain (spine, spine1, spine2, spine_01…, chest, upperChest: ordered by depth into spine → chest → upperChest),
 *   neck, head, hand, foot, toes, shoulder / clavicle, eye, jaw.
 * - Hierarchy: a detected bone whose nearest mapped humanoid parent is not one of its ancestors is dropped (with the
 *   reason in the table), so a stray "Hand" elsewhere in the tree never takes the arm.
 */
import {
  HUMANOID_BONE_NAMES, REQUIRED_HUMANOID_BONES, type HumanoidBoneName,
} from '../data/visualManifest';

/** One node of the model's scene graph (parents before children is not required). */
export interface BoneNodeInfo {
  readonly name: string;
  /** Index of the parent node in the list, −1 for a root. */
  readonly parent: number;
  /** A THREE.Bone (skin joint); detection prefers bones over plain nodes of the same name. */
  readonly isBone: boolean;
}

export type BoneSource = 'manual' | 'vrm' | 'auto';

/**
 * Parent of each humanoid bone in the VRM humanoid hierarchy. Optional bones (chest, upperChest, neck, shoulders,
 * toes, eyes, jaw) may be absent: a bone's effective parent is then the nearest present ancestor in this table.
 */
export const HUMANOID_PARENT: Readonly<Record<HumanoidBoneName, HumanoidBoneName | null>> = {
  hips: null, spine: 'hips', chest: 'spine', upperChest: 'chest', neck: 'upperChest', head: 'neck',
  leftEye: 'head', rightEye: 'head', jaw: 'head',
  leftShoulder: 'upperChest', leftUpperArm: 'leftShoulder', leftLowerArm: 'leftUpperArm', leftHand: 'leftLowerArm',
  rightShoulder: 'upperChest', rightUpperArm: 'rightShoulder', rightLowerArm: 'rightUpperArm', rightHand: 'rightLowerArm',
  leftUpperLeg: 'hips', leftLowerLeg: 'leftUpperLeg', leftFoot: 'leftLowerLeg', leftToes: 'leftFoot',
  rightUpperLeg: 'hips', rightLowerLeg: 'rightUpperLeg', rightFoot: 'rightLowerLeg', rightToes: 'rightFoot',
};

export interface NormalizedBoneName {
  readonly side: 'left' | 'right' | null;
  /** Lower-case letters and digits only, side and prefixes removed ('' for bones that never match). */
  readonly core: string;
}

const sideOf = (c: string): 'left' | 'right' => (c.toLowerCase() === 'l' ? 'left' : 'right');

/** Name normalisation (see the file comment). */
export function normalizeBoneName(raw: string): NormalizedBoneName {
  let s = raw.trim();
  // Namespaces: 'Armature|Hips', 'mixamorig:Hips', 'rig/Hips' → the last segment.
  const cut = Math.max(s.lastIndexOf(':'), s.lastIndexOf('|'), s.lastIndexOf('/'));
  if (cut >= 0) s = s.slice(cut + 1);
  s = s.replace(/^mixamorig\d*_?/i, '').replace(/^character\d*_/i, '').replace(/^armature_/i, '');
  // VRoid: J_Bip_C_Hips → Hips, J_Bip_L_UpperArm → L_UpperArm; secondary / adjust bones never match.
  if (/^J_(Sec|Adj|Opt)_/i.test(s)) return { side: null, core: '' };
  s = s.replace(/^J_Bip_C_/i, '').replace(/^J_Bip_([LR])_/i, '$1_');
  s = s.replace(/^(bip0*1|biped)[_\s.-]?/i, '').replace(/^(def|org|mch)[-_.]/i, '');
  let side: 'left' | 'right' | null = null;
  const word = /left|right/i.exec(s);
  if (word !== null) {
    side = word[0].toLowerCase() === 'left' ? 'left' : 'right';
    s = s.slice(0, word.index) + s.slice(word.index + word[0].length);
  } else {
    let m: RegExpExecArray | null;
    if ((m = /^([LR])[_.\-\s]/i.exec(s)) !== null) {
      side = sideOf(m[1]!);
      s = s.slice(m[0].length);
    } else if ((m = /[_.\-\s]([LR])$/i.exec(s)) !== null) {
      side = sideOf(m[1]!);
      s = s.slice(0, s.length - m[0].length);
    } else if ((m = /[_.\-\s]([LR])[_.\-\s]/i.exec(s)) !== null) {
      side = sideOf(m[1]!);
      s = s.slice(0, m.index) + '_' + s.slice(m.index + m[0].length);
    } else if ((m = /[a-z0-9]([LR])$/.exec(s)) !== null) {
      // 'UpperArmL' (three.js stripped the dot of 'UpperArm.L'): an upper-case side letter after the name.
      side = sideOf(m[1]!);
      s = s.slice(0, s.length - 1);
    } else if ((m = /^([lr])(?=[A-Z])/.exec(s)) !== null) {
      // DAZ style: 'lShldr', 'rThigh'.
      side = sideOf(m[1]!);
      s = s.slice(1);
    }
  }
  return { side, core: s.toLowerCase().replace(/[^a-z0-9]/g, '') };
}

type SidedBase = 'Shoulder' | 'UpperArm' | 'LowerArm' | 'Hand' | 'UpperLeg' | 'LowerLeg' | 'Foot' | 'Toes' | 'Eye';

/** Core name → sided humanoid base (left / right prepended). */
const SIDED_SYNONYMS: Readonly<Record<string, SidedBase>> = {
  shoulder: 'Shoulder', clavicle: 'Shoulder', collar: 'Shoulder', collarbone: 'Shoulder', shldr: 'Shoulder',
  upperarm: 'UpperArm', arm: 'UpperArm', uparm: 'UpperArm', shldrbend: 'UpperArm',
  lowerarm: 'LowerArm', forearm: 'LowerArm', lowarm: 'LowerArm', forearmbend: 'LowerArm', elbow: 'LowerArm',
  hand: 'Hand', wrist: 'Hand',
  upperleg: 'UpperLeg', upleg: 'UpperLeg', thigh: 'UpperLeg', thighbend: 'UpperLeg', femur: 'UpperLeg',
  lowerleg: 'LowerLeg', leg: 'LowerLeg', shin: 'LowerLeg', shinbend: 'LowerLeg', calf: 'LowerLeg', knee: 'LowerLeg', lowleg: 'LowerLeg',
  foot: 'Foot', ankle: 'Foot',
  toes: 'Toes', toe: 'Toes', toebase: 'Toes', ball: 'Toes',
  eye: 'Eye',
};

/** Core name → unsided humanoid bone. */
const CENTER_SYNONYMS: Readonly<Record<string, HumanoidBoneName>> = {
  hips: 'hips', hip: 'hips', pelvis: 'hips',
  neck: 'neck', neck1: 'neck', neck01: 'neck',
  head: 'head',
  jaw: 'jaw',
};

/** Spine-chain cores: ordered by depth into spine → chest → upperChest (explicit chest / upperChest win). */
const SPINE_CHAIN = /^(spine\d*|torso|abdomen|abdomenlower|abdomenupper|chestlower|chestupper|waist)$/;

/** The humanoid bone an automatic match would give a node (spine-chain nodes: 'spine*', resolved by depth). */
export function synonymOf(name: string): HumanoidBoneName | 'spine*' | null {
  const { side, core } = normalizeBoneName(name);
  if (core.length === 0) return null;
  if (side === null) {
    if (core === 'chest') return 'chest';
    if (core === 'upperchest') return 'upperChest';
    if (SPINE_CHAIN.test(core)) return 'spine*';
    return CENTER_SYNONYMS[core] ?? null;
  }
  const base = SIDED_SYNONYMS[core];
  return base === undefined ? null : (`${side}${base}` as HumanoidBoneName);
}

/** three.js node name sanitisation (PropertyBinding.sanitizeNodeName): whitespace → '_', `[ ] . : /` removed. */
export const sanitizeNodeName = (name: string): string => name.replace(/\s/g, '_').replace(/[[\].:/]/g, '');

export interface DroppedBone {
  readonly bone: HumanoidBoneName;
  readonly node: number;
  readonly reason: string;
}

export interface BoneMapResult {
  /** Humanoid bone → node index. */
  readonly map: ReadonlyMap<HumanoidBoneName, number>;
  readonly sources: ReadonlyMap<HumanoidBoneName, BoneSource>;
  /** Required bones (REQUIRED_HUMANOID_BONES) without a node. */
  readonly missing: readonly HumanoidBoneName[];
  /** Automatic matches rejected by the hierarchy check. */
  readonly dropped: readonly DroppedBone[];
  /** Manual `boneMap` names not found in the model (the bone falls back to the VRM / automatic match). */
  readonly problems: readonly string[];
}

export interface DetectOptions {
  /** Manifest `boneMap`: humanoid bone → node name in the file. */
  readonly manual?: Readonly<Partial<Record<HumanoidBoneName, string>>>;
  /** VRM humanoid definition: humanoid bone → node index. */
  readonly vrm?: ReadonlyMap<HumanoidBoneName, number>;
}

function depthOf(nodes: readonly BoneNodeInfo[], i: number): number {
  let d = 0;
  for (let p = nodes[i]!.parent; p >= 0 && d <= nodes.length; p = nodes[p]!.parent) d++;
  return d;
}

/** Whether node `a` is a proper ancestor of node `b`. */
export function isAncestor(nodes: readonly BoneNodeInfo[], a: number, b: number): boolean {
  let guard = 0;
  for (let p = nodes[b]?.parent ?? -1; p >= 0 && guard <= nodes.length; p = nodes[p]!.parent, guard++) {
    if (p === a) return true;
  }
  return false;
}

/** The nearest mapped bone up the humanoid hierarchy from `bone` (exclusive), or null. */
export function mappedHumanoidParent(bone: HumanoidBoneName, has: (b: HumanoidBoneName) => boolean): HumanoidBoneName | null {
  for (let p = HUMANOID_PARENT[bone]; p !== null; p = HUMANOID_PARENT[p]) if (has(p)) return p;
  return null;
}

/** Finds the node a manual `boneMap` name refers to: exact name, then the three.js-sanitised form. */
export function findNodeByName(nodes: readonly BoneNodeInfo[], name: string): number {
  const exact = nodes.findIndex((n) => n.name === name);
  if (exact >= 0) return exact;
  const clean = sanitizeNodeName(name);
  return nodes.findIndex((n) => n.name === clean || sanitizeNodeName(n.name) === clean);
}

/** Automatic candidates per humanoid bone (bones preferred, then the shallowest). */
function autoCandidates(nodes: readonly BoneNodeInfo[]): Map<HumanoidBoneName, number[]> {
  const anyBone = nodes.some((n) => n.isBone);
  const out = new Map<HumanoidBoneName, number[]>();
  const spine: number[] = [];
  const depth = nodes.map((_, i) => depthOf(nodes, i));
  nodes.forEach((node, i) => {
    if (anyBone && !node.isBone) return;
    const match = synonymOf(node.name);
    if (match === null) return;
    if (match === 'spine*') {
      spine.push(i);
      return;
    }
    const list = out.get(match) ?? [];
    list.push(i);
    out.set(match, list);
  });
  for (const list of out.values()) list.sort((a, b) => depth[a]! - depth[b]!);
  // Spine chain by depth: the first free slots of spine → chest → upperChest.
  spine.sort((a, b) => depth[a]! - depth[b]!);
  const slots: HumanoidBoneName[] = ['spine', 'chest', 'upperChest'].filter((b) => !out.has(b as HumanoidBoneName)) as HumanoidBoneName[];
  const explicitChest = out.has('chest');
  let k = 0;
  for (const i of spine) {
    // With an explicit 'chest', spine-chain nodes below it cannot be the spine.
    if (k >= slots.length) break;
    const slot = slots[k]!;
    if (slot === 'spine' && explicitChest && out.get('chest')!.some((c) => isAncestor(nodes, c, i))) continue;
    out.set(slot, [i]);
    k++;
  }
  // Limb chains named with one synonym twice ('Leg.L' → 'Shin.L' both "lower leg"): shift the shallower one up.
  for (const side of ['left', 'right'] as const) {
    for (const [upper, lower] of [['UpperLeg', 'LowerLeg'], ['UpperArm', 'LowerArm']] as const) {
      const u = `${side}${upper}` as HumanoidBoneName;
      const l = `${side}${lower}` as HumanoidBoneName;
      const lows = out.get(l);
      if (out.has(u) || lows === undefined || lows.length < 2) continue;
      const [a, b] = lows;
      if (isAncestor(nodes, a!, b!)) {
        out.set(u, [a!]);
        out.set(l, [b!, ...lows.slice(2)]);
      }
    }
  }
  return out;
}

/**
 * Maps humanoid bones to nodes: manual `boneMap` first, then the VRM definition, then automatic detection checked
 * against the humanoid hierarchy. Never throws; `missing` lists required bones without a node.
 */
export function detectHumanoidBones(nodes: readonly BoneNodeInfo[], options: DetectOptions = {}): BoneMapResult {
  const map = new Map<HumanoidBoneName, number>();
  const sources = new Map<HumanoidBoneName, BoneSource>();
  const problems: string[] = [];
  const dropped: DroppedBone[] = [];
  const taken = new Set<number>();
  for (const bone of HUMANOID_BONE_NAMES) {
    const name = options.manual?.[bone];
    if (name === undefined) continue;
    const i = findNodeByName(nodes, name);
    if (i < 0) {
      problems.push(`boneMap.${bone}: no node named '${name}'`);
      continue;
    }
    map.set(bone, i);
    sources.set(bone, 'manual');
    taken.add(i);
  }
  if (options.vrm !== undefined) {
    for (const bone of HUMANOID_BONE_NAMES) {
      const i = options.vrm.get(bone);
      if (i === undefined || map.has(bone) || taken.has(i) || i < 0 || i >= nodes.length) continue;
      map.set(bone, i);
      sources.set(bone, 'vrm');
      taken.add(i);
    }
  }
  const auto = autoCandidates(nodes);
  for (const bone of HUMANOID_BONE_NAMES) {
    if (map.has(bone)) continue;
    const candidates = (auto.get(bone) ?? []).filter((i) => !taken.has(i));
    if (candidates.length === 0) continue;
    const parent = mappedHumanoidParent(bone, (b) => map.has(b));
    const fits = candidates.find((i) => parent === null || isAncestor(nodes, map.get(parent)!, i));
    if (fits === undefined) {
      dropped.push({ bone, node: candidates[0]!, reason: `not below ${parent} ('${nodes[map.get(parent!)!]!.name}')` });
      continue;
    }
    map.set(bone, fits);
    sources.set(bone, 'auto');
    taken.add(fits);
  }
  const missing = REQUIRED_HUMANOID_BONES.filter((b) => !map.has(b));
  return { map, sources, missing, dropped, problems };
}

export interface BoneTableRow {
  readonly bone: HumanoidBoneName;
  readonly node: string | null;
  readonly source: BoneSource | null;
  readonly required: boolean;
  /** 'ok', 'missing' (required, none) or 'optional' (not required, none). */
  readonly status: 'ok' | 'missing' | 'optional';
}

const REQUIRED_SET: ReadonlySet<string> = new Set(REQUIRED_HUMANOID_BONES);

/** The mapping table shown in the dev console and model-lab (one row per humanoid bone). */
export function boneTable(nodes: readonly BoneNodeInfo[], result: BoneMapResult): BoneTableRow[] {
  return HUMANOID_BONE_NAMES.map((bone) => {
    const i = result.map.get(bone);
    const required = REQUIRED_SET.has(bone);
    return {
      bone,
      node: i === undefined ? null : nodes[i]!.name,
      source: result.sources.get(bone) ?? null,
      required,
      status: i !== undefined ? 'ok' : required ? 'missing' : 'optional',
    };
  });
}

/** One-line text form of the table (console output). */
export function formatBoneTable(rows: readonly BoneTableRow[]): string {
  return rows
    .filter((r) => r.status !== 'optional')
    .map((r) => `${r.bone} ← ${r.node ?? '(none)'}${r.source === null ? '' : ` [${r.source}]`}`)
    .join(', ');
}
