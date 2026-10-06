import { describe, expect, it } from 'vitest';
import { REQUIRED_HUMANOID_BONES, HUMANOID_BONE_NAMES, type HumanoidBoneName } from '../../../src/data/visualManifest';
import {
  boneTable, detectHumanoidBones, formatBoneTable, normalizeBoneName, sanitizeNodeName, synonymOf, type BoneNodeInfo,
} from '../../../src/visual/boneMap';

// Task 19.8: humanoid bone detection (design.md "bone 대응 우선순위", "이름 정규화", "동의어와 계층 검증"). Pure: flat
// node lists, no three.js.

/** Nodes from [name, parent name | null] pairs (all bones unless `plain` lists the non-bone names). */
function tree(defs: readonly (readonly [string, string | null])[], plain: readonly string[] = []): BoneNodeInfo[] {
  const index = new Map(defs.map(([name], i) => [name, i]));
  return defs.map(([name, parent]) => ({ name, parent: parent === null ? -1 : index.get(parent)!, isBone: !plain.includes(name) }));
}

/** Humanoid bone → node name of a detection result. */
function named(nodes: readonly BoneNodeInfo[], map: ReadonlyMap<HumanoidBoneName, number>): Record<string, string> {
  return Object.fromEntries([...map].map(([bone, i]) => [bone, nodes[i]!.name]));
}

/** A Mixamo skeleton (`mixamorig:` names; `strip` removes the ':' like three.js loaders do). */
function mixamo(strip = false): BoneNodeInfo[] {
  const n = (s: string): string => (strip ? `mixamorig${s}` : `mixamorig:${s}`);
  const defs: [string, string | null][] = [
    [n('Hips'), null], [n('Spine'), n('Hips')], [n('Spine1'), n('Spine')], [n('Spine2'), n('Spine1')],
    [n('Neck'), n('Spine2')], [n('Head'), n('Neck')], [n('HeadTop_End'), n('Head')], [n('LeftEye'), n('Head')], [n('RightEye'), n('Head')],
  ];
  for (const side of ['Left', 'Right']) {
    defs.push(
      [n(`${side}Shoulder`), n('Spine2')], [n(`${side}Arm`), n(`${side}Shoulder`)], [n(`${side}ForeArm`), n(`${side}Arm`)],
      [n(`${side}Hand`), n(`${side}ForeArm`)], [n(`${side}HandIndex1`), n(`${side}Hand`)], [n(`${side}HandThumb1`), n(`${side}Hand`)],
      [n(`${side}UpLeg`), n('Hips')], [n(`${side}Leg`), n(`${side}UpLeg`)], [n(`${side}Foot`), n(`${side}Leg`)],
      [n(`${side}ToeBase`), n(`${side}Foot`)], [n(`${side}Toe_End`), n(`${side}ToeBase`)],
    );
  }
  return tree(defs);
}

/** A VRoid (VRM 0.x) skeleton: J_Bip_C_ / J_Bip_L_ / J_Bip_R_ names, secondary hair and adjust bones. */
function vroid(): BoneNodeInfo[] {
  const defs: [string, string | null][] = [
    ['Root', null], ['J_Bip_C_Hips', 'Root'], ['J_Bip_C_Spine', 'J_Bip_C_Hips'], ['J_Bip_C_Chest', 'J_Bip_C_Spine'],
    ['J_Bip_C_UpperChest', 'J_Bip_C_Chest'], ['J_Bip_C_Neck', 'J_Bip_C_UpperChest'], ['J_Bip_C_Head', 'J_Bip_C_Neck'],
    ['J_Adj_L_FaceEye', 'J_Bip_C_Head'], ['J_Sec_Hair1_01', 'J_Bip_C_Head'],
  ];
  for (const s of ['L', 'R']) {
    defs.push(
      [`J_Bip_${s}_Shoulder`, 'J_Bip_C_UpperChest'], [`J_Bip_${s}_UpperArm`, `J_Bip_${s}_Shoulder`],
      [`J_Bip_${s}_LowerArm`, `J_Bip_${s}_UpperArm`], [`J_Bip_${s}_Hand`, `J_Bip_${s}_LowerArm`], [`J_Bip_${s}_Index1`, `J_Bip_${s}_Hand`],
      [`J_Bip_${s}_UpperLeg`, 'J_Bip_C_Hips'], [`J_Bip_${s}_LowerLeg`, `J_Bip_${s}_UpperLeg`], [`J_Bip_${s}_Foot`, `J_Bip_${s}_LowerLeg`],
      [`J_Bip_${s}_ToeBase`, `J_Bip_${s}_Foot`], [`J_Sec_${s}_Bust1`, 'J_Bip_C_Chest'],
    );
  }
  return tree(defs);
}

describe('bone name normalisation', () => {
  it('strips prefixes and unifies side spellings (VRM, Mixamo, three.js-stripped, Blender, UE, DAZ)', () => {
    const cases: [string, 'left' | 'right' | null, string][] = [
      ['J_Bip_C_Hips', null, 'hips'],
      ['J_Bip_L_UpperArm', 'left', 'upperarm'],
      ['J_Bip_R_LowerLeg', 'right', 'lowerleg'],
      ['leftUpperArm', 'left', 'upperarm'],
      ['mixamorig:LeftForeArm', 'left', 'forearm'],
      ['mixamorigLeftForeArm', 'left', 'forearm'],
      ['mixamorig1:RightUpLeg', 'right', 'upleg'],
      ['Armature|Hips', null, 'hips'],
      ['UpperArm.L', 'left', 'upperarm'],
      ['UpperArmL', 'left', 'upperarm'],
      ['Shin.R', 'right', 'shin'],
      ['ShinR', 'right', 'shin'],
      ['hand_r', 'right', 'hand'],
      ['L_Thigh', 'left', 'thigh'],
      ['DEF-upper_arm.L', 'left', 'upperarm'],
      ['lShldr', 'left', 'shldr'],
      ['Bip01 L Calf', 'left', 'calf'],
      ['J_Sec_Hair1_01', null, ''],
    ];
    for (const [raw, side, core] of cases) expect(normalizeBoneName(raw), raw).toEqual({ side, core });
  });

  it('maps synonyms to humanoid bones (spine chain resolved later by depth)', () => {
    const cases: [string, HumanoidBoneName | 'spine*' | null][] = [
      ['mixamorig:LeftArm', 'leftUpperArm'], ['mixamorigRightForeArm', 'rightLowerArm'], ['mixamorig:LeftUpLeg', 'leftUpperLeg'],
      ['mixamorig:LeftLeg', 'leftLowerLeg'], ['mixamorig:LeftToeBase', 'leftToes'], ['thigh_l', 'leftUpperLeg'], ['calf_r', 'rightLowerLeg'],
      ['Shin.L', 'leftLowerLeg'], ['forearm_R', 'rightLowerArm'], ['clavicle_l', 'leftShoulder'], ['Pelvis', 'hips'], ['neck_01', 'neck'],
      ['Head', 'head'], ['Chest', 'chest'], ['UpperChest', 'upperChest'], ['Spine2', 'spine*'], ['spine_03', 'spine*'],
      ['mixamorig:HeadTop_End', null], ['mixamorig:LeftHandIndex1', null], ['J_Sec_L_Bust1', null], ['Root', null],
    ];
    for (const [raw, bone] of cases) expect(synonymOf(raw), raw).toBe(bone);
  });

  it('sanitises like PropertyBinding.sanitizeNodeName', () => {
    expect(sanitizeNodeName('mixamorig:Hips')).toBe('mixamorigHips');
    expect(sanitizeNodeName('UpperArm.L')).toBe('UpperArmL');
    expect(sanitizeNodeName('Bip01 L Hand')).toBe('Bip01_L_Hand');
  });
});

describe('detectHumanoidBones', () => {
  it('detects a VRoid skeleton from its J_Bip names (secondary bones ignored)', () => {
    const nodes = vroid();
    const result = detectHumanoidBones(nodes);
    expect(result.missing).toEqual([]);
    expect(named(nodes, result.map)).toEqual({
      hips: 'J_Bip_C_Hips', spine: 'J_Bip_C_Spine', chest: 'J_Bip_C_Chest', upperChest: 'J_Bip_C_UpperChest', neck: 'J_Bip_C_Neck', head: 'J_Bip_C_Head',
      leftShoulder: 'J_Bip_L_Shoulder', leftUpperArm: 'J_Bip_L_UpperArm', leftLowerArm: 'J_Bip_L_LowerArm', leftHand: 'J_Bip_L_Hand',
      rightShoulder: 'J_Bip_R_Shoulder', rightUpperArm: 'J_Bip_R_UpperArm', rightLowerArm: 'J_Bip_R_LowerArm', rightHand: 'J_Bip_R_Hand',
      leftUpperLeg: 'J_Bip_L_UpperLeg', leftLowerLeg: 'J_Bip_L_LowerLeg', leftFoot: 'J_Bip_L_Foot', leftToes: 'J_Bip_L_ToeBase',
      rightUpperLeg: 'J_Bip_R_UpperLeg', rightLowerLeg: 'J_Bip_R_LowerLeg', rightFoot: 'J_Bip_R_Foot', rightToes: 'J_Bip_R_ToeBase',
    });
    expect([...result.sources.values()].every((s) => s === 'auto')).toBe(true);
  });

  it('detects Mixamo skeletons with and without the mixamorig: colon (Spine / Spine1 / Spine2 by depth)', () => {
    for (const strip of [false, true]) {
      const nodes = mixamo(strip);
      const result = detectHumanoidBones(nodes);
      const p = strip ? 'mixamorig' : 'mixamorig:';
      expect(result.missing).toEqual([]);
      expect(named(nodes, result.map)).toEqual({
        hips: `${p}Hips`, spine: `${p}Spine`, chest: `${p}Spine1`, upperChest: `${p}Spine2`, neck: `${p}Neck`, head: `${p}Head`,
        leftEye: `${p}LeftEye`, rightEye: `${p}RightEye`,
        leftShoulder: `${p}LeftShoulder`, leftUpperArm: `${p}LeftArm`, leftLowerArm: `${p}LeftForeArm`, leftHand: `${p}LeftHand`,
        rightShoulder: `${p}RightShoulder`, rightUpperArm: `${p}RightArm`, rightLowerArm: `${p}RightForeArm`, rightHand: `${p}RightHand`,
        leftUpperLeg: `${p}LeftUpLeg`, leftLowerLeg: `${p}LeftLeg`, leftFoot: `${p}LeftFoot`, leftToes: `${p}LeftToeBase`,
        rightUpperLeg: `${p}RightUpLeg`, rightLowerLeg: `${p}RightLeg`, rightFoot: `${p}RightFoot`, rightToes: `${p}RightToeBase`,
      });
    }
  });

  it('detects synonym-named rigs (UE pelvis / spine_0x / thigh / calf / ball, Blender .L names stripped to L)', () => {
    const ue = tree([
      ['Armature', null], ['root', 'Armature'], ['pelvis', 'root'], ['spine_01', 'pelvis'], ['spine_02', 'spine_01'], ['spine_03', 'spine_02'],
      ['neck_01', 'spine_03'], ['head', 'neck_01'],
      ['clavicle_l', 'spine_03'], ['upperarm_l', 'clavicle_l'], ['lowerarm_l', 'upperarm_l'], ['hand_l', 'lowerarm_l'],
      ['clavicle_r', 'spine_03'], ['upperarm_r', 'clavicle_r'], ['lowerarm_r', 'upperarm_r'], ['hand_r', 'lowerarm_r'],
      ['thigh_l', 'pelvis'], ['calf_l', 'thigh_l'], ['foot_l', 'calf_l'], ['ball_l', 'foot_l'],
      ['thigh_r', 'pelvis'], ['calf_r', 'thigh_r'], ['foot_r', 'calf_r'], ['ball_r', 'foot_r'],
    ], ['Armature']);
    const r1 = detectHumanoidBones(ue);
    expect(r1.missing).toEqual([]);
    expect(named(ue, r1.map)).toMatchObject({
      hips: 'pelvis', spine: 'spine_01', chest: 'spine_02', upperChest: 'spine_03', neck: 'neck_01', head: 'head',
      leftShoulder: 'clavicle_l', leftUpperArm: 'upperarm_l', leftLowerArm: 'lowerarm_l', leftHand: 'hand_l',
      leftUpperLeg: 'thigh_l', leftLowerLeg: 'calf_l', leftFoot: 'foot_l', leftToes: 'ball_l', rightLowerLeg: 'calf_r',
    });
    // Blender names after three.js dropped the dots; 'Leg' + 'Shin' both read "lower leg": the shallower one is the thigh.
    const blender = tree([
      ['Hips', null], ['Spine', 'Hips'], ['Chest', 'Spine'], ['Neck', 'Chest'], ['Head', 'Neck'],
      ['UpperArmL', 'Chest'], ['ForearmL', 'UpperArmL'], ['HandL', 'ForearmL'],
      ['UpperArmR', 'Chest'], ['ForearmR', 'UpperArmR'], ['HandR', 'ForearmR'],
      ['LegL', 'Hips'], ['ShinL', 'LegL'], ['FootL', 'ShinL'], ['ThighR', 'Hips'], ['ShinR', 'ThighR'], ['FootR', 'ShinR'],
    ]);
    const r2 = detectHumanoidBones(blender);
    expect(r2.missing).toEqual([]);
    expect(named(blender, r2.map)).toMatchObject({
      chest: 'Chest', leftUpperArm: 'UpperArmL', leftLowerArm: 'ForearmL', leftHand: 'HandL',
      leftUpperLeg: 'LegL', leftLowerLeg: 'ShinL', leftFoot: 'FootL', rightUpperLeg: 'ThighR', rightLowerLeg: 'ShinR',
    });
  });

  it('prefers the manual boneMap, then the VRM humanoid definition, then automatic detection', () => {
    const nodes = mixamo(true);
    const index = (name: string): number => nodes.findIndex((n) => n.name === name);
    // VRM definition: a different head (HeadTop_End) and a different left hand (the index finger).
    const vrm = new Map<HumanoidBoneName, number>([['head', index('mixamorigHeadTop_End')], ['leftHand', index('mixamorigLeftHandIndex1')]]);
    // Manual: the left hand back to the hand (written with the colon: matched after sanitising), the right foot a toe.
    const manual = { leftHand: 'mixamorig:LeftHand', rightFoot: 'mixamorigRightToeBase', leftFoot: 'NoSuchNode' };
    const result = detectHumanoidBones(nodes, { manual, vrm });
    const got = named(nodes, result.map);
    expect(got.leftHand).toBe('mixamorigLeftHand');
    expect(result.sources.get('leftHand')).toBe('manual');
    expect(got.rightFoot).toBe('mixamorigRightToeBase');
    expect(result.sources.get('rightFoot')).toBe('manual');
    expect(got.head).toBe('mixamorigHeadTop_End');
    expect(result.sources.get('head')).toBe('vrm');
    // A manual name not in the file is reported and the bone falls back to detection.
    expect(result.problems).toEqual(["boneMap.leftFoot: no node named 'NoSuchNode'"]);
    expect(got.leftFoot).toBe('mixamorigLeftFoot');
    expect(result.sources.get('leftFoot')).toBe('auto');
    expect(result.sources.get('hips')).toBe('auto');
    // The taken toe is not detected again as the right toes.
    expect(got.rightToes).toBeUndefined();
  });

  it('drops a match outside the humanoid hierarchy and reports the required bones still missing', () => {
    // A stray shallow 'LeftHand' (a prop) and the real one: the real one is below the forearm.
    const nodes = tree([...mixamo(true).map((n, i, all) => [n.name, n.parent < 0 ? null : all[n.parent]!.name] as const), ['PropRoot', null], ['LeftHand', 'PropRoot']]);
    expect(named(nodes, detectHumanoidBones(nodes).map).leftHand).toBe('mixamorigLeftHand');
    // Without the real hand the stray one is rejected: leftHand is missing, with the reason.
    const noHand = nodes.filter((n) => n.name !== 'mixamorigLeftHandIndex1' && n.name !== 'mixamorigLeftHandThumb1' && n.name !== 'mixamorigLeftHand');
    const rebuilt = tree(noHand.map((n) => [n.name, n.parent < 0 ? null : nodes[n.parent]!.name] as const));
    const result = detectHumanoidBones(rebuilt);
    expect(result.missing).toEqual(['leftHand']);
    expect(result.dropped).toEqual([expect.objectContaining({ bone: 'leftHand', reason: expect.stringContaining('leftLowerArm') })]);
  });

  it('lists every missing required bone (the 15 VRM ones) and tabulates the result', () => {
    expect(REQUIRED_HUMANOID_BONES).toEqual([
      'hips', 'spine', 'head', 'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightUpperArm', 'rightLowerArm', 'rightHand',
      'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot',
    ]);
    const all = mixamo(true);
    const without = new Set(['mixamorigLeftFoot', 'mixamorigLeftToeBase', 'mixamorigLeftToe_End']);
    const nodes = tree(all.filter((n) => !without.has(n.name)).map((n) => [n.name, n.parent < 0 ? null : all[n.parent]!.name] as const));
    const result = detectHumanoidBones(nodes);
    expect(result.missing).toEqual(['leftFoot']);
    const rows = boneTable(nodes, result);
    expect(rows.map((r) => r.bone)).toEqual([...HUMANOID_BONE_NAMES]);
    expect(rows.find((r) => r.bone === 'leftFoot')).toMatchObject({ node: null, required: true, status: 'missing' });
    expect(rows.find((r) => r.bone === 'leftToes')).toMatchObject({ node: null, required: false, status: 'optional' });
    expect(rows.find((r) => r.bone === 'hips')).toMatchObject({ node: 'mixamorigHips', source: 'auto', status: 'ok' });
    const text = formatBoneTable(rows);
    expect(text).toContain('hips ← mixamorigHips [auto]');
    expect(text).toContain('leftFoot ← (none)');
    // Nothing humanoid at all: all 15 missing, never a throw.
    expect(detectHumanoidBones(tree([['Cube', null]], ['Cube'])).missing).toEqual([...REQUIRED_HUMANOID_BONES]);
  });
});
