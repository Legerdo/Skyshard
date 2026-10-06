/*
 * Enemy and Elite models (design.md "적·Elite·NPC 구성", Req 28.1, 40.4): each kind is a fixed model of the rig kit, its
 * preset, palette and parts. Thorns, shells, wings, rings and armour are merged into the body geometry, so one enemy
 * is 2 draw calls (body + outline); only an Element_Shield (./shellMaterial) or an Elite's aura adds one.
 *
 * - bramblekin: a small thorn ball (20 cones on a Fibonacci sphere) on four short legs (`quadruped`).
 * - thornspitter: a rooted 4-joint stalk (`stalk`) with a bud head of 5 petals, each on its own bone (they open to fire).
 * - mossbackBrute: a hunched giant with long arms and short legs (`humanoid`), a moss back shell and a shield plate on
 *   each forearm that together face forward in its guard (the frontal damage reduction, Req 28.11).
 * - cinderHound: a lean hound (`quadruped`) with a glowing ember mane along its neck and back and a tail.
 * - slagshell: a lava-shelled crab (`crab`, 6 legs, 2 claws) with glowing shell cracks (`aFx.x`) and a club tail.
 * - ashWisp: a floating flame ball (`floater`) with an ash mask and two pairs of slowly beating ash wings.
 * - windcutter: a blade-feathered raptor (`floater`, wings 3 joints × 2) with steel rims on its feather edges.
 * - aetherSentinel: an ancient machine core on a hovering base, stone arms, three rings on their own bones turning on
 *   different axes, and a single eye (the head) that turns toward its aim.
 * Elites (design "Elite"): the base model at 1.4× (ELITE_SIZE) plus a thorn crown (oldMossback), horns (emberjaw,
 * cinderAlpha) or crystal armour (galeclaw, sentinelPrime), an additive fresnel aura shell (ELITE_AURA) and the HUD bar's
 * name tag (Req 32.5); rootboundWarden is its own model — a humanoid torso rising from a root mound, glowing back roots —
 * and sentinelPrime's two drones are reduced Sentinels with only the eye and one ring (DRONE_RIG_SPEC).
 */
import * as THREE from 'three';
import { createRng, hashString } from '../core/rng';
import { ELITE_SIZE } from '../data/enemies';
import type { EliteId, EnemyId } from '../data/ids';
import { humanoidBase } from './humanoidParts';
import { cone, crystal, fibonacciDirections, hexPlate, v3add, v3lerp, v3norm, v3scale, v3sub } from './modelParts';
import { box, ellipsoid, lathe, ribbon, ring, sweep, taperedCapsule } from './rigGeometry';
import type { ExtraJointDef, LimbProportions, PaletteZone, PartDef, RigLayout, RigPreset, RigSpec, V3 } from './rigTypes';

type Palette = Readonly<Record<PaletteZone, number>>;
type Parts = (layout: RigLayout) => PartDef[];

interface EnemyLook {
  readonly preset: RigPreset;
  readonly height: number;
  readonly headRatio?: number;
  readonly shoulderScale?: number;
  readonly proportions?: LimbProportions;
  readonly extraJoints?: (height: number) => ExtraJointDef[];
  readonly palette: Palette;
  readonly parts: Parts;
  /** Glow of the Element accents at rest (`uGlow`). */
  readonly glow?: number;
}

const L = (side: 'left' | 'right'): 1 | -1 => (side === 'left' ? 1 : -1);
const SIDES = ['left', 'right'] as const;
const rng = (id: string) => createRng(hashString(`rig:${id}`));

// ── Bramblekin ──────────────────────────────────────────────────────────────

function bramblekinParts(layout: RigLayout): PartDef[] {
  const H = layout.height;
  const parts: PartDef[] = [];
  const spine = layout.pos('spine');
  const chest = layout.pos('chest');
  const c = v3add(v3lerp(spine, chest, 0.45), [0, 0.02 * H, 0]);
  const R = 0.35 * H;
  parts.push({ joint: 'spine', zone: 'primary', geometry: ellipsoid(c, [R, R * 0.95, R * 1.02], 16, 11) });
  parts.push({ joint: 'spine', zone: 'hair', geometry: ellipsoid(v3add(c, [0, R * 0.35, -R * 0.1]), [R * 0.8, R * 0.62, R * 0.85], 12, 8) });
  // 20 thorn cones on a Fibonacci sphere (the lower cap left bare over the legs).
  const r = rng('bramblekin');
  for (const d of fibonacciDirections(20, -0.45)) {
    const len = (0.16 + r.range(-0.03, 0.04)) * H;
    const base = v3add(c, v3scale(d, R * 0.92));
    parts.push({ joint: 'spine', zone: 'accent', geometry: cone(base, v3add(base, v3scale(d, len)), 0.04 * H, 5) });
  }
  // Head poking out of the ball's front, amber eyes, a leaf sprout.
  const head = layout.pos('head');
  const hc = v3add(head, [0, -0.05 * H, -0.06 * H]);
  parts.push({ joint: 'head', zone: 'skin', geometry: ellipsoid(hc, [0.12 * H, 0.1 * H, 0.11 * H], 12, 8) });
  for (const s of [1, -1]) {
    parts.push({ joint: 'head', zone: 'element', glow: 1, geometry: ellipsoid(v3add(hc, [s * 0.045 * H, 0.02 * H, 0.095 * H]), [0.026 * H, 0.032 * H, 0.012 * H], 8, 6) });
    parts.push({ joint: 'head', zone: 'hair', geometry: ribbon([v3add(hc, [s * 0.03 * H, 0.08 * H, 0]), v3add(hc, [s * 0.09 * H, 0.2 * H, -0.05 * H])], [0, 0, 1], 0.06 * H, 0.3, 0.008) });
  }
  parts.push({ joint: 'head', zone: 'secondary', geometry: box(v3add(hc, [0, -0.035 * H, 0.1 * H]), [0.06 * H, 0.012 * H, 0.012 * H]) });
  // Four short legs with round feet.
  for (const side of SIDES) {
    for (const end of ['Front', 'Back'] as const) {
      const n = `${side}${end}`;
      const up = layout.pos(`${n}UpperLeg`);
      const low = layout.pos(`${n}LowerLeg`);
      const foot = layout.pos(`${n}Foot`);
      parts.push({ joint: `${n}UpperLeg`, zone: 'secondary', geometry: taperedCapsule(up, low, 0.055 * H, 0.045 * H, 7, 2) });
      parts.push({ joint: `${n}LowerLeg`, zone: 'secondary', geometry: taperedCapsule(low, foot, 0.045 * H, 0.035 * H, 7, 2) });
      parts.push({ joint: `${n}Foot`, zone: 'secondary', geometry: ellipsoid(v3add(foot, [0, -0.01 * H, 0.03 * H]), [0.05 * H, 0.035 * H, 0.07 * H], 8, 5) });
    }
  }
  return parts;
}

// ── Thornspitter ────────────────────────────────────────────────────────────

function thornspitterParts(layout: RigLayout): PartDef[] {
  const H = layout.height;
  const parts: PartDef[] = [];
  const r = rng('thornspitter');
  // Roots spreading over the ground from the base bulb.
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.3;
    const out: V3 = [Math.sin(a), 0, Math.cos(a)];
    const reach = (0.3 + r.range(0, 0.08)) * H;
    parts.push({ joint: 'root', zone: 'secondary', geometry: sweep([[0, 0.05 * H, 0], v3add(v3scale(out, reach * 0.5), [0, 0.06 * H, 0]), v3add(v3scale(out, reach), [0, 0.005 * H, 0])], { r0: 0.04 * H, r1: 0.008 * H, radial: 5, samples: 5 }) });
  }
  const s0 = layout.pos('stalk0');
  parts.push({ joint: 'stalk0', zone: 'secondary', geometry: ellipsoid(v3add(s0, [0, 0.04 * H, 0]), [0.1 * H, 0.07 * H, 0.1 * H], 10, 7) });
  const chain = ['stalk0', 'stalk1', 'stalk2', 'stalk3', 'head'];
  const radii = [0.05, 0.043, 0.037, 0.034, 0.04];
  for (let i = 0; i < 4; i++) {
    const a = layout.pos(chain[i]!);
    const b = layout.pos(chain[i + 1]!);
    parts.push({ joint: chain[i]!, zone: 'primary', geometry: taperedCapsule(a, b, radii[i]! * H, radii[i + 1]! * H, 7, 2) });
    // Thorns along the stalk, and a leaf on the middle joints.
    for (let k = 0; k < 3; k++) {
      const t = (k + 0.5) / 3;
      const p = v3lerp(a, b, t);
      const ang = (i * 3 + k) * 2.1;
      const d: V3 = [Math.sin(ang), 0.35, Math.cos(ang)];
      const base = v3add(p, v3scale(v3norm([d[0], 0, d[2]]), radii[i]! * H * 0.9));
      parts.push({ joint: chain[i]!, zone: 'accent', color: 0x6e4a2a, geometry: cone(base, v3add(base, v3scale(v3norm(d), 0.07 * H)), 0.014 * H, 4) });
    }
    if (i === 1 || i === 2) {
      const side = i === 1 ? 1 : -1;
      const p = v3lerp(a, b, 0.6);
      parts.push({ joint: chain[i]!, zone: 'hair', geometry: ribbon([p, v3add(p, [side * 0.16 * H, 0.08 * H, 0.03 * H]), v3add(p, [side * 0.3 * H, 0.05 * H, 0.06 * H])], [0, 0.3, 1], 0.1 * H, 0.2, 0.01) });
    }
  }
  // Bud head: calyx, glowing throat (where the spike comes from), five petals on their own bones.
  const head = layout.pos('head');
  parts.push({ joint: 'head', zone: 'primary', geometry: ellipsoid(v3add(head, [0, 0.05 * H, 0]), [0.1 * H, 0.08 * H, 0.1 * H], 12, 8) });
  parts.push({ joint: 'head', zone: 'element', glow: 0.9, geometry: ellipsoid(v3add(head, [0, 0.12 * H, 0]), [0.05 * H, 0.03 * H, 0.05 * H], 10, 6) });
  for (let i = 0; i < 5; i++) {
    const j = `petal${i}`;
    const base = layout.pos(j);
    const a = Math.atan2(base[0], base[2]);
    const out: V3 = [Math.sin(a), 0, Math.cos(a)];
    const mid = v3add(base, v3add(v3scale(out, 0.06 * H), [0, 0.12 * H, 0]));
    const tip = v3add(base, v3add(v3scale(out, -0.06 * H), [0, 0.24 * H, 0]));
    parts.push({ joint: j, zone: 'accent', geometry: sweep([base, mid, tip], { r0: 0.07 * H, r1: 0.01 * H, radial: 6, samples: 6, flatten: 0.35 }) });
    parts.push({ joint: j, zone: 'skin', geometry: cone(v3lerp(mid, tip, 0.6), v3add(tip, v3scale(out, 0.02 * H)), 0.012 * H, 4) });
  }
  return parts;
}

// ── Mossback Brute ──────────────────────────────────────────────────────────

function mossbackParts(layout: RigLayout): PartDef[] {
  const H = layout.height;
  const base = humanoidBase(layout, {
    limb: 1.6, torsoWidth: 1.4, torsoDepth: 0.95, hipWidth: 1.25, torsoZone: 'skin', sleeveZone: 'skin', forearmZone: 'skin',
    handZone: 'skin', legZone: 'secondary', bootZone: 'secondary', jaw: 0.05,
  });
  const parts = base.parts.filter((p) => p.face !== true);
  const chest = layout.pos('chest');
  // Moss back shell with stones and tufts.
  const shell = v3add(chest, [0, 0.03 * H, -0.1 * H]);
  parts.push({ joint: 'chest', zone: 'hair', geometry: ellipsoid(shell, [0.19 * H, 0.15 * H, 0.12 * H], 14, 9) });
  const r = rng('mossbackBrute');
  for (const d of fibonacciDirections(9, 0.1)) {
    if (d[2] > 0.4) continue;
    const p = v3add(shell, [d[0] * 0.17 * H, d[1] * 0.13 * H, d[2] * 0.11 * H - 0.02 * H]);
    parts.push({ joint: 'chest', zone: r.next() < 0.5 ? 'secondary' : 'hair', color: r.next() < 0.5 ? 0x7a9a4a : undefined, geometry: ellipsoid(p, [0.035 * H, 0.025 * H, 0.03 * H], 7, 5) });
  }
  // Shield plates on both forearms (bark over stone): in the guard they meet in front of the chest.
  for (const side of SIDES) {
    const low = layout.pos(`${side}LowerArm`);
    const hand = layout.pos(`${side}Hand`);
    const mid = v3lerp(low, hand, 0.5);
    const len = Math.abs(hand[0] - low[0]);
    parts.push({ joint: `${side}LowerArm`, zone: 'accent', geometry: box(v3add(mid, [0, 0, 0.05 * H]), [len * 1.05, 0.12 * H, 0.03 * H]) });
    parts.push({ joint: `${side}LowerArm`, zone: 'secondary', geometry: box(v3add(mid, [0, 0, 0.068 * H]), [len * 0.8, 0.07 * H, 0.012 * H]) });
  }
  // Brow, glowing eyes, tusks.
  const c = base.head.center;
  const hr = base.head.radius;
  parts.push({ joint: 'head', zone: 'secondary', geometry: ellipsoid(v3add(c, [0, hr * 0.35, hr * 0.62]), [hr * 0.95, hr * 0.25, hr * 0.4], 10, 6) });
  for (const s of [1, -1]) {
    parts.push({ joint: 'head', zone: 'element', glow: 1, geometry: ellipsoid(v3add(c, [s * hr * 0.35, hr * 0.12, hr * 0.9]), [hr * 0.14, hr * 0.09, hr * 0.06], 8, 5) });
    parts.push({ joint: 'head', zone: 'accent', color: 0xe6dcc0, geometry: cone(v3add(c, [s * hr * 0.35, -hr * 0.55, hr * 0.7]), v3add(c, [s * hr * 0.5, -hr * 0.05, hr * 1.0]), hr * 0.1, 5) });
  }
  return parts;
}

// ── Cinder Hound ────────────────────────────────────────────────────────────

function houndJoints(H: number): ExtraJointDef[] {
  const Lb = 1.15 * H;
  return [
    { name: 'tail0', parent: 'hips', pos: [0, 0.66 * H, -0.42 * Lb] },
    { name: 'tail1', parent: 'tail0', pos: [0, 0.6 * H, -0.62 * Lb] },
  ];
}

function houndParts(layout: RigLayout): PartDef[] {
  const H = layout.height;
  const parts: PartDef[] = [];
  const hips = layout.pos('hips');
  const spine = layout.pos('spine');
  const chest = layout.pos('chest');
  const neck = layout.pos('neck');
  const head = layout.pos('head');
  parts.push({ joint: 'chest', zone: 'primary', geometry: ellipsoid(v3add(chest, [0, 0.01 * H, 0]), [0.15 * H, 0.17 * H, 0.22 * H], 12, 8) });
  parts.push({ joint: 'spine', zone: 'primary', geometry: ellipsoid(v3add(spine, [0, 0.01 * H, 0]), [0.12 * H, 0.12 * H, 0.26 * H], 12, 8) });
  parts.push({ joint: 'hips', zone: 'primary', geometry: ellipsoid(v3add(hips, [0, 0.01 * H, 0.02 * H]), [0.13 * H, 0.14 * H, 0.17 * H], 12, 8) });
  // Ribs of ash along the flank (secondary stripes).
  for (let k = 0; k < 3; k++) {
    const z = spine[2] + (k - 1) * 0.1 * H;
    parts.push({ joint: 'spine', zone: 'secondary', geometry: ring([0, spine[1], z], 0.118 * H, 0.012 * H, 4, 12, 0, 1, 1.02) });
  }
  parts.push({ joint: 'neck', zone: 'primary', geometry: taperedCapsule(v3add(chest, [0, 0.05 * H, 0.08 * H]), head, 0.09 * H, 0.065 * H, 8, 2) });
  // Head: skull, long snout, jaw, pointed ears, ember eyes.
  parts.push({ joint: 'head', zone: 'primary', geometry: ellipsoid(head, [0.085 * H, 0.08 * H, 0.1 * H], 10, 7) });
  parts.push({ joint: 'head', zone: 'secondary', geometry: taperedCapsule(v3add(head, [0, -0.01 * H, 0.05 * H]), v3add(head, [0, -0.035 * H, 0.23 * H]), 0.055 * H, 0.035 * H, 8, 2) });
  parts.push({ joint: 'head', zone: 'accent', geometry: box(v3add(head, [0, -0.06 * H, 0.15 * H]), [0.05 * H, 0.012 * H, 0.14 * H]) });
  for (const s of [1, -1]) {
    parts.push({ joint: 'head', zone: 'primary', geometry: cone(v3add(head, [s * 0.05 * H, 0.05 * H, -0.02 * H]), v3add(head, [s * 0.08 * H, 0.17 * H, -0.08 * H]), 0.03 * H, 4) });
    parts.push({ joint: 'head', zone: 'element', glow: 1, geometry: ellipsoid(v3add(head, [s * 0.045 * H, 0.02 * H, 0.08 * H]), [0.018 * H, 0.012 * H, 0.012 * H], 6, 4) });
  }
  // Glowing ember mane along the neck and back (the VFX-free part of the design's ember mane).
  const mane: [string, V3, number][] = [
    ['head', v3add(head, [0, 0.07 * H, -0.06 * H]), 0.14],
    ['neck', v3lerp(chest, head, 0.55), 0.18],
    ['neck', v3lerp(chest, head, 0.25), 0.2],
    ['chest', v3add(chest, [0, 0.14 * H, 0]), 0.18],
    ['chest', v3add(chest, [0, 0.13 * H, -0.12 * H]), 0.15],
    ['spine', v3add(spine, [0, 0.1 * H, 0.1 * H]), 0.12],
    ['spine', v3add(spine, [0, 0.1 * H, -0.08 * H]), 0.1],
  ];
  for (const [joint, at, len] of mane) {
    parts.push({ joint, zone: 'element', glow: 1, geometry: cone(at, v3add(at, [0, len * H, -len * H * 0.8]), 0.035 * H, 5) });
  }
  for (const side of SIDES) {
    for (const end of ['Front', 'Back'] as const) {
      const n = `${side}${end}`;
      const up = layout.pos(`${n}UpperLeg`);
      const low = layout.pos(`${n}LowerLeg`);
      const foot = layout.pos(`${n}Foot`);
      parts.push({ joint: `${n}UpperLeg`, zone: 'primary', geometry: taperedCapsule(up, low, 0.06 * H, 0.04 * H, 7, 2) });
      parts.push({ joint: `${n}LowerLeg`, zone: 'secondary', geometry: taperedCapsule(low, foot, 0.035 * H, 0.028 * H, 7, 2) });
      parts.push({ joint: `${n}Foot`, zone: 'secondary', geometry: ellipsoid(v3add(foot, [0, -0.012 * H, 0.03 * H]), [0.04 * H, 0.03 * H, 0.06 * H], 7, 5) });
    }
  }
  const t0 = layout.pos('tail0');
  const t1 = layout.pos('tail1');
  parts.push({ joint: 'tail0', zone: 'primary', geometry: taperedCapsule(t0, t1, 0.04 * H, 0.03 * H, 6, 2) });
  const tip = v3add(t1, v3scale(v3norm(v3sub(t1, t0)), 0.18 * H));
  parts.push({ joint: 'tail1', zone: 'element', glow: 1, geometry: cone(t1, tip, 0.04 * H, 5) });
  return parts;
}

// ── Slagshell ───────────────────────────────────────────────────────────────

function slagshellJoints(H: number): ExtraJointDef[] {
  const W = 0.9 * H * 0.7;
  return [
    { name: 'tail0', parent: 'body', pos: [0, 0.5 * H, -0.6 * W] },
    { name: 'tail1', parent: 'tail0', pos: [0, 0.46 * H, -0.95 * W] },
  ];
}

function slagshellParts(layout: RigLayout): PartDef[] {
  const H = layout.height;
  const W = layout.dims.shoulderHalf;
  const parts: PartDef[] = [];
  const body = layout.pos('body');
  const dome = v3add(body, [0, 0.06 * H, -0.05 * W]);
  const radii: V3 = [0.72 * W, 0.26 * H, 0.72 * W];
  parts.push({ joint: 'body', zone: 'primary', geometry: ellipsoid(dome, radii, 18, 10) });
  parts.push({ joint: 'body', zone: 'secondary', geometry: ellipsoid(v3add(body, [0, -0.08 * H, 0]), [0.64 * W, 0.08 * H, 0.64 * W], 14, 6) });
  // Lava cracks over the dome (aFx.x glow) and basalt nodules.
  const r = rng('slagshell');
  for (let k = 0; k < 7; k++) {
    const a0 = r.range(0, Math.PI * 2);
    const pts: V3[] = [];
    for (let i = 0; i < 4; i++) {
      const el = 0.25 + i * 0.28 + r.range(-0.05, 0.05);
      const az = a0 + i * r.range(-0.35, 0.35);
      const d: V3 = [Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)];
      pts.push(v3add(dome, [d[0] * radii[0] * 1.01, d[1] * radii[1] * 1.01, d[2] * radii[2] * 1.01]));
    }
    const across = v3norm([Math.cos(a0), 0, -Math.sin(a0)]);
    parts.push({ joint: 'body', zone: 'element', glow: 1, geometry: ribbon(pts, across, 0.035 * W, 0.4, 0.02 * H) });
  }
  for (const d of fibonacciDirections(8, 0.35)) {
    parts.push({ joint: 'body', zone: 'accent', geometry: crystal(v3add(dome, [d[0] * radii[0], d[1] * radii[1] * 0.98, d[2] * radii[2]]), d, 0.12 * H, 0.1 * H) });
  }
  // Head with eye stalks.
  const head = layout.pos('head');
  parts.push({ joint: 'head', zone: 'secondary', geometry: ellipsoid(head, [0.16 * W, 0.08 * H, 0.1 * W], 10, 6) });
  for (const s of [1, -1]) {
    const stalkTop = v3add(head, [s * 0.1 * W, 0.16 * H, 0.04 * W]);
    parts.push({ joint: 'head', zone: 'skin', geometry: taperedCapsule(v3add(head, [s * 0.08 * W, 0.03 * H, 0]), stalkTop, 0.02 * H, 0.015 * H, 5, 1) });
    parts.push({ joint: 'head', zone: 'element', glow: 1, geometry: ellipsoid(stalkTop, [0.035 * H, 0.035 * H, 0.035 * H], 7, 5) });
  }
  for (const side of SIDES) {
    for (let i = 0; i < 3; i++) {
      const n = `${side}Leg${i}`;
      const up = layout.pos(`${n}Upper`);
      const low = layout.pos(`${n}Lower`);
      const foot = layout.pos(`${n}Foot`);
      parts.push({ joint: `${n}Upper`, zone: 'skin', geometry: taperedCapsule(up, low, 0.045 * H, 0.035 * H, 6, 2) });
      parts.push({ joint: `${n}Lower`, zone: 'skin', geometry: taperedCapsule(low, v3add(foot, [0, 0.06 * H, 0]), 0.033 * H, 0.022 * H, 6, 2) });
      parts.push({ joint: `${n}Foot`, zone: 'accent', geometry: cone(v3add(foot, [0, 0.08 * H, 0]), foot, 0.022 * H, 4) });
    }
    const cu = layout.pos(`${side}ClawUpper`);
    const cl = layout.pos(`${side}Claw`);
    parts.push({ joint: `${side}ClawUpper`, zone: 'primary', geometry: taperedCapsule(cu, cl, 0.06 * H, 0.05 * H, 7, 2) });
    const palm = v3add(cl, [0, 0, 0.08 * W]);
    parts.push({ joint: `${side}Claw`, zone: 'primary', geometry: ellipsoid(palm, [0.09 * H, 0.08 * H, 0.14 * W], 9, 6) });
    parts.push({ joint: `${side}Claw`, zone: 'accent', geometry: cone(v3add(palm, [0, 0.03 * H, 0.08 * W]), v3add(palm, [0, 0.04 * H, 0.34 * W]), 0.04 * H, 5) });
    parts.push({ joint: `${side}Claw`, zone: 'accent', geometry: cone(v3add(palm, [0, -0.03 * H, 0.06 * W]), v3add(palm, [0, -0.02 * H, 0.26 * W]), 0.03 * H, 5) });
    parts.push({ joint: `${side}Claw`, zone: 'element', glow: 0.8, geometry: box(v3add(palm, [0, 0, 0.1 * W]), [0.01 * H, 0.1 * H, 0.1 * W]) });
  }
  const t0 = layout.pos('tail0');
  const t1 = layout.pos('tail1');
  parts.push({ joint: 'tail0', zone: 'primary', geometry: taperedCapsule(t0, t1, 0.09 * H, 0.07 * H, 8, 2) });
  parts.push({ joint: 'tail1', zone: 'secondary', geometry: ellipsoid(v3add(t1, [0, 0, -0.1 * W]), [0.13 * H, 0.1 * H, 0.16 * W], 10, 6) });
  parts.push({ joint: 'tail1', zone: 'element', glow: 1, geometry: ring(v3add(t1, [0, 0, -0.1 * W]), 0.12 * H, 0.012 * H, 4, 12, Math.PI / 2) });
  return parts;
}

// ── Ash Wisp ────────────────────────────────────────────────────────────────

function ashWispJoints(H: number): ExtraJointDef[] {
  const out: ExtraJointDef[] = [];
  for (const side of SIDES) {
    const s = L(side);
    out.push({ name: `${side}WingB0`, parent: 'body', pos: [s * 0.1 * H, 0.45 * H, -0.06 * H] });
    out.push({ name: `${side}WingB1`, parent: `${side}WingB0`, pos: [s * 0.3 * H, 0.36 * H, -0.1 * H] });
  }
  return out;
}

function ashWispParts(layout: RigLayout): PartDef[] {
  const H = layout.height;
  const parts: PartDef[] = [];
  const body = layout.pos('body');
  parts.push({ joint: 'body', zone: 'element', glow: 1, geometry: ellipsoid(body, [0.25 * H, 0.27 * H, 0.25 * H], 14, 10) });
  parts.push({ joint: 'body', zone: 'skin', glow: 0.6, geometry: ellipsoid(v3add(body, [0, -0.02 * H, 0]), [0.28 * H, 0.2 * H, 0.28 * H], 12, 7) });
  // Flame tongues on top and a trailing wisp below.
  const r = rng('ashWisp');
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    const base = v3add(body, [Math.sin(a) * 0.14 * H, 0.16 * H, Math.cos(a) * 0.14 * H]);
    parts.push({ joint: 'body', zone: 'element', glow: 1, geometry: cone(base, v3add(base, [Math.sin(a) * 0.05 * H, (0.22 + r.range(0, 0.12)) * H, Math.cos(a) * 0.05 * H - 0.05 * H]), 0.06 * H, 5) });
  }
  parts.push({ joint: 'body', zone: 'element', glow: 1, geometry: cone(v3add(body, [0, -0.15 * H, -0.05 * H]), v3add(body, [0, -0.5 * H, -0.2 * H]), 0.1 * H, 6) });
  // Ash crust flakes orbiting the core.
  for (const d of fibonacciDirections(10)) {
    parts.push({ joint: 'body', zone: 'secondary', geometry: crystal(v3add(body, v3scale(d, 0.3 * H)), d, 0.08 * H, 0.05 * H) });
  }
  // Ash mask with glowing eye slits.
  const head = layout.pos('head');
  const mask = v3add(head, [0, 0, 0.06 * H]);
  parts.push({ joint: 'head', zone: 'primary', geometry: ellipsoid(mask, [0.15 * H, 0.14 * H, 0.05 * H], 10, 7) });
  for (const s of [1, -1]) {
    parts.push({ joint: 'head', zone: 'element', glow: 1, geometry: box(v3add(mask, [s * 0.055 * H, 0.02 * H, 0.045 * H]), [0.05 * H, 0.016 * H, 0.012 * H]) });
    parts.push({ joint: 'head', zone: 'accent', geometry: cone(v3add(mask, [s * 0.1 * H, 0.08 * H, -0.02 * H]), v3add(mask, [s * 0.16 * H, 0.2 * H, -0.08 * H]), 0.025 * H, 4) });
  }
  // Two pairs of ash wings (upper on the floater wing chain, lower on the extra joints).
  for (const side of SIDES) {
    const w0 = layout.pos(`${side}Wing0`);
    const w1 = layout.pos(`${side}Wing1`);
    const w2 = layout.pos(`${side}Wing2`);
    const tip = v3add(w2, [L(side) * 0.15 * H, -0.08 * H, -0.08 * H]);
    parts.push({ joint: `${side}Wing0`, zone: 'primary', geometry: ribbon([w0, w1], [0, 0.25, 1], 0.28 * H, 0.9, 0.012 * H) });
    parts.push({ joint: `${side}Wing1`, zone: 'primary', geometry: ribbon([w1, w2], [0, 0.25, 1], 0.24 * H, 0.75, 0.012 * H) });
    parts.push({ joint: `${side}Wing2`, zone: 'accent', geometry: ribbon([w2, tip], [0, 0.25, 1], 0.16 * H, 0.2, 0.012 * H) });
    parts.push({ joint: `${side}Wing2`, zone: 'element', glow: 0.8, geometry: ribbon([v3lerp(w2, tip, 0.5), tip], [0, 0.25, 1], 0.05 * H, 0.2, 0.016 * H) });
    const b0 = layout.pos(`${side}WingB0`);
    const b1 = layout.pos(`${side}WingB1`);
    const btip = v3add(b1, [L(side) * 0.16 * H, -0.1 * H, -0.06 * H]);
    parts.push({ joint: `${side}WingB0`, zone: 'secondary', geometry: ribbon([b0, b1], [0, 0.4, 1], 0.2 * H, 0.8, 0.012 * H) });
    parts.push({ joint: `${side}WingB1`, zone: 'secondary', geometry: ribbon([b1, btip], [0, 0.4, 1], 0.16 * H, 0.2, 0.012 * H) });
  }
  return parts;
}

// ── Windcutter ──────────────────────────────────────────────────────────────

function windcutterJoints(H: number): ExtraJointDef[] {
  return [
    { name: 'tail', parent: 'body', pos: [0, 0.54 * H, -0.2 * H] },
    { name: 'talons', parent: 'body', pos: [0, 0.44 * H, 0.03 * H] },
  ];
}

function windcutterParts(layout: RigLayout): PartDef[] {
  const H = layout.height;
  const parts: PartDef[] = [];
  const body = layout.pos('body');
  const head = layout.pos('head');
  parts.push({ joint: 'body', zone: 'primary', geometry: ellipsoid(v3add(body, [0, 0, -0.02 * H]), [0.1 * H, 0.1 * H, 0.2 * H], 12, 8) });
  parts.push({ joint: 'body', zone: 'skin', color: 0xe6eef2, geometry: ellipsoid(v3add(body, [0, -0.02 * H, 0.08 * H]), [0.08 * H, 0.08 * H, 0.1 * H], 10, 7) });
  parts.push({ joint: 'head', zone: 'primary', geometry: ellipsoid(head, [0.06 * H, 0.06 * H, 0.07 * H], 10, 7) });
  parts.push({ joint: 'head', zone: 'skin', geometry: cone(v3add(head, [0, -0.005 * H, 0.05 * H]), v3add(head, [0, -0.04 * H, 0.17 * H]), 0.026 * H, 5) });
  for (const s of [1, -1]) {
    parts.push({ joint: 'head', zone: 'element', glow: 1, geometry: ellipsoid(v3add(head, [s * 0.035 * H, 0.015 * H, 0.04 * H]), [0.012 * H, 0.01 * H, 0.01 * H], 6, 4) });
  }
  // Blade crest (steel).
  for (let k = 0; k < 3; k++) {
    const base = v3add(head, [0, 0.04 * H, -0.02 * H - k * 0.02 * H]);
    parts.push({ joint: 'head', zone: 'accent', geometry: cone(base, v3add(base, [0, (0.08 - k * 0.015) * H, -0.14 * H]), 0.015 * H, 4) });
  }
  // Wings: blade-feather panels per segment, steel rims along the trailing edges.
  for (const side of SIDES) {
    const s = L(side);
    const w0 = layout.pos(`${side}Wing0`);
    const w1 = layout.pos(`${side}Wing1`);
    const w2 = layout.pos(`${side}Wing2`);
    const back: V3 = [0, 0, -0.1 * H];
    parts.push({ joint: `${side}Wing0`, zone: 'primary', geometry: ribbon([v3add(w0, back), v3add(w1, back)], [0, 0, 1], 0.2 * H, 0.9, 0.012 * H) });
    parts.push({ joint: `${side}Wing0`, zone: 'accent', glow: 0.25, geometry: ribbon([v3add(w0, [0, 0, -0.2 * H]), v3add(w1, [0, 0, -0.19 * H])], [0, 0, 1], 0.02 * H, 1, 0.016 * H) });
    parts.push({ joint: `${side}Wing1`, zone: 'secondary', geometry: ribbon([v3add(w1, back), v3add(w2, [0, 0, -0.08 * H])], [0, 0, 1], 0.17 * H, 0.8, 0.012 * H) });
    parts.push({ joint: `${side}Wing1`, zone: 'accent', glow: 0.25, geometry: ribbon([v3add(w1, [0, 0, -0.19 * H]), v3add(w2, [0, 0, -0.16 * H])], [0, 0, 1], 0.02 * H, 1, 0.016 * H) });
    for (let k = 0; k < 4; k++) {
      const root = v3add(w2, [0, 0, -k * 0.035 * H]);
      const tip = v3add(root, [s * (0.3 - k * 0.04) * H, -0.01 * H, -(0.08 + k * 0.06) * H]);
      parts.push({ joint: `${side}Wing2`, zone: k === 0 ? 'accent' : 'secondary', geometry: ribbon([root, v3lerp(root, tip, 0.6), tip], [0, 0, 1], 0.05 * H, 0.2, 0.01 * H) });
    }
  }
  const tail = layout.pos('tail');
  for (let k = -1; k <= 1; k++) {
    const tip = v3add(tail, [k * 0.08 * H, 0.01 * H, -0.28 * H]);
    parts.push({ joint: 'tail', zone: k === 0 ? 'accent' : 'secondary', geometry: ribbon([tail, tip], [1, 0, 0], 0.06 * H, 0.3, 0.01 * H) });
  }
  const talons = layout.pos('talons');
  for (const s of [1, -1]) {
    const foot = v3add(talons, [s * 0.04 * H, -0.08 * H, 0.02 * H]);
    parts.push({ joint: 'talons', zone: 'skin', geometry: taperedCapsule(v3add(talons, [s * 0.04 * H, 0, 0]), foot, 0.015 * H, 0.012 * H, 5, 1) });
    parts.push({ joint: 'talons', zone: 'accent', geometry: cone(foot, v3add(foot, [0, -0.02 * H, 0.05 * H]), 0.012 * H, 4) });
  }
  return parts;
}

// ── Aether Sentinel ─────────────────────────────────────────────────────────

/** The three ring bones of a Sentinel (one per ring, each turning on its own axis). */
export const SENTINEL_RINGS = ['ring0', 'ring1', 'ring2'] as const;

function sentinelJoints(H: number): ExtraJointDef[] {
  return SENTINEL_RINGS.map((name) => ({ name, parent: 'body', pos: [0, 0.55 * H, 0] as V3 }));
}

function sentinelParts(layout: RigLayout): PartDef[] {
  const H = layout.height;
  const parts: PartDef[] = [];
  const body = layout.pos('body');
  // Hovering base, core vase of ancient stone, brass bands, rune lines.
  parts.push({ joint: 'body', zone: 'secondary', geometry: lathe([[0.02 * H, 0.14 * H], [0.1 * H, 0.18 * H], [0.12 * H, 0.3 * H], [0.08 * H, 0.36 * H]], { segments: 10 }) });
  parts.push({ joint: 'body', zone: 'element', glow: 1, geometry: ellipsoid([0, 0.14 * H, 0], [0.06 * H, 0.015 * H, 0.06 * H], 10, 4) });
  parts.push({ joint: 'body', zone: 'primary', geometry: lathe([[0.08 * H, 0.33 * H], [0.15 * H, 0.43 * H], [0.17 * H, body[1]], [0.14 * H, 0.66 * H], [0.07 * H, 0.73 * H]], { segments: 10, scaleZ: 0.9 }) });
  for (const y of [0.43, 0.6]) parts.push({ joint: 'body', zone: 'accent', geometry: ring([0, y * H, 0], 0.16 * H, 0.012 * H, 4, 14, 0, 1, 0.9) });
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    parts.push({ joint: 'body', zone: 'element', glow: 0.7, geometry: box([Math.sin(a) * 0.168 * H, body[1], Math.cos(a) * 0.15 * H], [0.012 * H, 0.14 * H, 0.012 * H]) });
  }
  // Head: hood block, eye socket ring, glowing lens (the eye turns toward the aim).
  const head = layout.pos('head');
  parts.push({ joint: 'head', zone: 'primary', geometry: box(v3add(head, [0, 0.03 * H, -0.05 * H]), [0.14 * H, 0.1 * H, 0.12 * H]) });
  const socket = new THREE.TorusGeometry(0.045 * H, 0.012 * H, 5, 14);
  socket.translate(head[0], head[1], head[2] + 0.02 * H);
  parts.push({ joint: 'head', zone: 'accent', geometry: socket });
  parts.push({ joint: 'head', zone: 'element', glow: 1, geometry: ellipsoid(v3add(head, [0, 0, 0.015 * H]), [0.04 * H, 0.04 * H, 0.025 * H], 10, 7) });
  // Stone arms (the floater's wing chain): upper block, forearm, fist.
  for (const side of SIDES) {
    const w0 = layout.pos(`${side}Wing0`);
    const w1 = layout.pos(`${side}Wing1`);
    const w2 = layout.pos(`${side}Wing2`);
    parts.push({ joint: `${side}Wing0`, zone: 'primary', geometry: ellipsoid(w0, [0.07 * H, 0.06 * H, 0.06 * H], 8, 6) });
    parts.push({ joint: `${side}Wing0`, zone: 'secondary', geometry: taperedCapsule(w0, w1, 0.045 * H, 0.04 * H, 6, 2) });
    parts.push({ joint: `${side}Wing1`, zone: 'primary', geometry: taperedCapsule(w1, w2, 0.05 * H, 0.06 * H, 6, 2) });
    const band = new THREE.TorusGeometry(0.056 * H, 0.008 * H, 4, 10).rotateY(Math.PI / 2);
    const bandAt = v3lerp(w1, w2, 0.5);
    parts.push({ joint: `${side}Wing1`, zone: 'accent', geometry: band.translate(bandAt[0], bandAt[1], bandAt[2]) });
    parts.push({ joint: `${side}Wing2`, zone: 'secondary', geometry: box(v3add(w2, [L(side) * 0.05 * H, 0, 0]), [0.12 * H, 0.1 * H, 0.1 * H]) });
    parts.push({ joint: `${side}Wing2`, zone: 'element', glow: 0.8, geometry: box(v3add(w2, [L(side) * 0.05 * H, 0, 0.052 * H]), [0.08 * H, 0.012 * H, 0.004 * H]) });
  }
  // Three rings, each on its bone, on different axes (horizontal, facing forward, facing sideways).
  const rc = layout.pos('ring0');
  const rings: [string, number, (g: THREE.TorusGeometry) => void][] = [
    ['ring0', 0.27 * H, (g) => g.rotateX(Math.PI / 2)],
    ['ring1', 0.23 * H, () => undefined],
    ['ring2', 0.2 * H, (g) => g.rotateY(Math.PI / 2)],
  ];
  for (const [joint, radius, orient] of rings) {
    const g = new THREE.TorusGeometry(radius, 0.014 * H, 5, 28);
    orient(g);
    g.translate(rc[0], rc[1], rc[2]);
    parts.push({ joint, zone: 'accent', geometry: g });
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2;
      const local = new THREE.Vector3(Math.cos(a) * radius, Math.sin(a) * radius, 0);
      if (joint === 'ring0') local.set(Math.cos(a) * radius, 0, Math.sin(a) * radius);
      if (joint === 'ring2') local.set(0, Math.sin(a) * radius, Math.cos(a) * radius);
      parts.push({ joint, zone: 'element', glow: 1, geometry: ellipsoid([rc[0] + local.x, rc[1] + local.y, rc[2] + local.z], [0.02 * H, 0.02 * H, 0.02 * H], 6, 4) });
    }
  }
  return parts;
}

// ── Elites ──────────────────────────────────────────────────────────────────

function thornCrown(layout: RigLayout): PartDef[] {
  const H = layout.height;
  const head = layout.dims.headCenter;
  const r = layout.dims.headRadius;
  const parts: PartDef[] = [{ joint: 'head', zone: 'secondary', geometry: ring(v3add(head, [0, r * 0.7, 0]), r * 0.8, r * 0.1, 5, 14) }];
  for (let k = 0; k < 9; k++) {
    const a = (k / 9) * Math.PI * 2;
    const base: V3 = v3add(head, [Math.sin(a) * r * 0.8, r * 0.75, Math.cos(a) * r * 0.8]);
    parts.push({ joint: 'head', zone: 'accent', color: 0x3a2a18, geometry: cone(base, v3add(base, [Math.sin(a) * r * 0.25, (k % 2 === 0 ? 0.075 : 0.05) * H, Math.cos(a) * r * 0.25]), r * 0.12, 4) });
  }
  // Glowing moss and mushrooms on the back shell.
  const chest = layout.pos('chest');
  for (let k = 0; k < 5; k++) {
    const p = v3add(chest, [(k - 2) * 0.06 * H, 0.14 * H + (k % 2) * 0.03 * H, -0.14 * H]);
    parts.push({ joint: 'chest', zone: 'accent', color: 0xe8d8b0, geometry: taperedCapsule(p, v3add(p, [0, 0.035 * H, -0.01 * H]), 0.008 * H, 0.008 * H, 5, 1) });
    parts.push({ joint: 'chest', zone: 'element', glow: 0.7, geometry: ellipsoid(v3add(p, [0, 0.04 * H, -0.01 * H]), [0.03 * H, 0.014 * H, 0.03 * H], 8, 4) });
  }
  return parts;
}

function horns(layout: RigLayout, count: 2 | 4): PartDef[] {
  const H = layout.height;
  const head = layout.pos('head');
  const parts: PartDef[] = [];
  for (const s of [1, -1]) {
    for (let k = 0; k < count / 2; k++) {
      const root = v3add(head, [s * (0.045 + k * 0.03) * H, 0.05 * H, (0.02 - k * 0.05) * H]);
      const len = (k === 0 ? 0.22 : 0.15) * H;
      parts.push({ joint: 'head', zone: 'accent', color: 0x2a1c16, geometry: sweep([root, v3add(root, [s * 0.05 * H, len * 0.5, -len * 0.3]), v3add(root, [s * 0.04 * H, len * 0.75, -len])], { r0: 0.028 * H, r1: 0.004 * H, radial: 6, samples: 6 }) });
    }
  }
  // Molten jaw.
  parts.push({ joint: 'head', zone: 'element', glow: 1, geometry: box(v3add(head, [0, -0.055 * H, 0.16 * H]), [0.055 * H, 0.01 * H, 0.12 * H]) });
  return parts;
}

function crystalArmour(layout: RigLayout, joints: readonly [string, V3, V3, number][]): PartDef[] {
  const H = layout.height;
  return joints.map(([joint, at, dir, size]) => ({ joint, zone: 'element' as const, glow: 0.45, color: 0xc9f4ff, geometry: crystal(at, dir, size * H, size * H * 0.45) }));
}

function galeclawArmour(layout: RigLayout): PartDef[] {
  const body = layout.pos('body');
  const head = layout.pos('head');
  const H = layout.height;
  const spec: [string, V3, V3, number][] = [
    ['body', v3add(body, [0, 0.09 * H, -0.05 * H]), [0, 1, -0.4], 0.12],
    ['body', v3add(body, [0.05 * H, 0.08 * H, 0.04 * H]), [0.5, 1, 0.2], 0.08],
    ['body', v3add(body, [-0.05 * H, 0.08 * H, 0.04 * H]), [-0.5, 1, 0.2], 0.08],
    ['head', v3add(head, [0, 0.06 * H, -0.03 * H]), [0, 1, -0.8], 0.1],
  ];
  for (const side of SIDES) {
    const w0 = layout.pos(`${side}Wing0`);
    spec.push([`${side}Wing0`, v3add(w0, [L(side) * 0.08 * H, 0.03 * H, -0.05 * H]), [L(side) * 0.4, 1, -0.3], 0.1]);
    spec.push([`${side}Wing1`, v3add(layout.pos(`${side}Wing1`), [0, 0.02 * H, -0.08 * H]), [L(side) * 0.3, 1, -0.4], 0.08]);
  }
  return crystalArmour(layout, spec);
}

function sentinelPrimeArmour(layout: RigLayout): PartDef[] {
  const H = layout.height;
  const body = layout.pos('body');
  const head = layout.pos('head');
  const parts: PartDef[] = [];
  for (const [z, n] of [[0.17, 1], [-0.17, -1]] as const) {
    parts.push({ joint: 'body', zone: 'element', glow: 0.5, color: 0xc9f4ff, geometry: hexPlate(v3add(body, [0, 0.02 * H, z * H * 0.92]), [0, 0, n], 0.09 * H, 0.02 * H, [0.8, 1.2]) });
  }
  const spec: [string, V3, V3, number][] = [['head', v3add(head, [0, 0.1 * H, -0.05 * H]), [0, 1, -0.3], 0.1]];
  for (const side of SIDES) {
    const w0 = layout.pos(`${side}Wing0`);
    spec.push([`${side}Wing0`, v3add(w0, [L(side) * 0.03 * H, 0.07 * H, 0]), [L(side) * 0.3, 1, 0], 0.12]);
    spec.push([`${side}Wing0`, v3add(w0, [L(side) * 0.07 * H, 0.05 * H, -0.03 * H]), [L(side) * 0.8, 1, -0.2], 0.08]);
  }
  return [...parts, ...crystalArmour(layout, spec)];
}

// ── Rootbound Warden ────────────────────────────────────────────────────────

const LEG_JOINT = /UpperLeg|LowerLeg|Foot$/;

function wardenParts(layout: RigLayout): PartDef[] {
  const H = layout.height;
  const base = humanoidBase(layout, {
    limb: 1.5, torsoWidth: 1.3, torsoDepth: 0.9, hipWidth: 1.2, torsoZone: 'primary', sleeveZone: 'primary', forearmZone: 'secondary',
    handZone: 'secondary', legZone: 'secondary', jaw: 0.1,
  });
  const parts = base.parts.filter((p) => p.face !== true && !LEG_JOINT.test(p.joint));
  const r = rng('rootboundWarden');
  // The root mound the torso rises from (on `root`: it never moves), roots spreading over the ground.
  parts.push({ joint: 'root', zone: 'secondary', geometry: lathe([[0.36 * H, 0], [0.34 * H, 0.08 * H], [0.26 * H, 0.2 * H], [0.16 * H, 0.3 * H], [0.08 * H, 0.34 * H]], { segments: 16 }) });
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2 + r.range(-0.2, 0.2);
    const out: V3 = [Math.sin(a), 0, Math.cos(a)];
    const reach = (0.55 + r.range(0, 0.12)) * H;
    parts.push({ joint: 'root', zone: i % 2 === 0 ? 'secondary' : 'primary', geometry: sweep([v3add(v3scale(out, 0.2 * H), [0, 0.16 * H, 0]), v3add(v3scale(out, reach * 0.6), [0, 0.07 * H, 0]), v3add(v3scale(out, reach), [0, 0.005 * H, 0])], { r0: 0.06 * H, r1: 0.01 * H, radial: 6, samples: 6 }) });
  }
  // Roots braided up round the waist.
  const spine = layout.pos('spine');
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const low: V3 = [Math.sin(a) * 0.2 * H, 0.25 * H, Math.cos(a) * 0.2 * H];
    parts.push({ joint: 'hips', zone: 'secondary', geometry: sweep([low, [Math.sin(a + 0.4) * 0.13 * H, 0.33 * H, Math.cos(a + 0.4) * 0.12 * H], [Math.sin(a + 0.8) * 0.1 * H, spine[1], Math.cos(a + 0.8) * 0.08 * H]], { r0: 0.035 * H, r1: 0.012 * H, radial: 5, samples: 5 }) });
  }
  // Glowing weak-spot roots on the back (Ember from behind staggers it, Req 28.1 약점).
  const chest = layout.pos('chest');
  for (let k = 0; k < 5; k++) {
    const p = v3add(chest, [(k - 2) * 0.045 * H, -0.02 * H - (k % 2) * 0.05 * H, -0.085 * H]);
    parts.push({ joint: k < 3 ? 'chest' : 'spine', zone: 'element', glow: 1, geometry: ellipsoid(p, [0.03 * H, 0.04 * H, 0.025 * H], 8, 6) });
  }
  parts.push({ joint: 'chest', zone: 'element', glow: 0.8, geometry: sweep([v3add(chest, [-0.09 * H, 0.05 * H, -0.08 * H]), v3add(chest, [0, -0.02 * H, -0.095 * H]), v3add(chest, [0.09 * H, -0.08 * H, -0.08 * H])], { r0: 0.015 * H, r1: 0.008 * H, radial: 5, samples: 5 }) });
  // Bark mask, amber eyes, branch antlers, root fingers.
  const c = base.head.center;
  const hr = base.head.radius;
  parts.push({ joint: 'head', zone: 'secondary', geometry: ellipsoid(v3add(c, [0, 0, hr * 0.5]), [hr * 0.9, hr * 1.05, hr * 0.6], 10, 7) });
  for (const s of [1, -1]) {
    parts.push({ joint: 'head', zone: 'element', glow: 1, geometry: ellipsoid(v3add(c, [s * hr * 0.35, hr * 0.15, hr * 1.02]), [hr * 0.13, hr * 0.08, hr * 0.05], 8, 5) });
    parts.push({ joint: 'head', zone: 'primary', geometry: sweep([v3add(c, [s * hr * 0.6, hr * 0.6, 0]), v3add(c, [s * hr * 1.3, hr * 1.5, -hr * 0.2]), v3add(c, [s * hr * 1.5, hr * 2.4, -hr * 0.1])], { r0: hr * 0.13, r1: hr * 0.03, radial: 5, samples: 5 }) });
    const hand = layout.pos(s === 1 ? 'leftHand' : 'rightHand');
    for (let f = 0; f < 3; f++) {
      const base2 = v3add(hand, [s * 0.05 * H, -0.01 * H, (f - 1) * 0.025 * H]);
      parts.push({ joint: s === 1 ? 'leftHand' : 'rightHand', zone: 'secondary', geometry: cone(base2, v3add(base2, [s * 0.08 * H, -0.03 * H, (f - 1) * 0.02 * H]), 0.012 * H, 4) });
    }
  }
  // Moss on the shoulders.
  for (const side of SIDES) {
    const up = layout.pos(`${side}UpperArm`);
    parts.push({ joint: `${side}UpperArm`, zone: 'hair', geometry: ellipsoid(v3add(up, [L(side) * 0.02 * H, 0.03 * H, 0]), [0.06 * H, 0.03 * H, 0.055 * H], 9, 5) });
  }
  return parts;
}

// ── Specs ───────────────────────────────────────────────────────────────────

const LOOKS: Readonly<Record<EnemyId, EnemyLook>> = {
  bramblekin: {
    preset: 'quadruped', height: 1.2, shoulderScale: 0.8, parts: bramblekinParts,
    palette: { primary: 0x4f7a2e, secondary: 0x3a2a1a, accent: 0x9a7a44, skin: 0x5f8f3a, hair: 0x3a5f22, element: 0xffc857 },
  },
  thornspitter: {
    preset: 'stalk', height: 1.8, shoulderScale: 1.2, parts: thornspitterParts,
    palette: { primary: 0x4f8a3a, secondary: 0x5a4028, accent: 0xc2456a, skin: 0xf0a0b8, hair: 0x3a6a2a, element: 0xffe08a },
  },
  mossbackBrute: {
    preset: 'humanoid', height: 2.6, headRatio: 7, shoulderScale: 1.5, proportions: { arm: 1.3, leg: 0.75 }, parts: mossbackParts,
    palette: { primary: 0x5f7f3f, secondary: 0x6a6050, accent: 0x4a3a2a, skin: 0x7a8a62, hair: 0x4a6a2a, element: 0xd4ff7a },
  },
  cinderHound: {
    preset: 'quadruped', height: 1.1, shoulderScale: 0.85, extraJoints: houndJoints, parts: houndParts,
    palette: { primary: 0x2e2624, secondary: 0x4a4040, accent: 0xd8c8b0, skin: 0x3a2a26, hair: 0x1a1210, element: 0xff7a45 },
  },
  slagshell: {
    preset: 'crab', height: 1.6, shoulderScale: 0.7, extraJoints: slagshellJoints, parts: slagshellParts,
    palette: { primary: 0x3a302c, secondary: 0x221a18, accent: 0x151012, skin: 0x5a3a2a, hair: 0x2a2020, element: 0xff6a2a },
  },
  ashWisp: {
    preset: 'floater', height: 1.0, extraJoints: ashWispJoints, parts: ashWispParts, glow: 0.8,
    palette: { primary: 0x5a5452, secondary: 0x3a3634, accent: 0x8a8480, skin: 0xffb060, hair: 0x3a3432, element: 0xff9a45 },
  },
  windcutter: {
    preset: 'floater', height: 1.7, shoulderScale: 1.2, extraJoints: windcutterJoints, parts: windcutterParts,
    palette: { primary: 0x7fa4bc, secondary: 0x3e5262, accent: 0xe8eef4, skin: 0xd8b060, hair: 0x2a3a48, element: 0x5ed3a5 },
  },
  aetherSentinel: {
    preset: 'floater', height: 3.0, shoulderScale: 0.8, extraJoints: sentinelJoints, parts: sentinelParts,
    palette: { primary: 0xb8b0a0, secondary: 0x6a6458, accent: 0xc8a050, skin: 0x8a8478, hair: 0x4a4640, element: 0x7fd8ff },
  },
};

/** Elite model: base kind and its extra parts / palette (rootboundWarden has no base). */
interface EliteLook {
  readonly base: EnemyId | null;
  readonly extra: Parts;
  readonly palette?: Partial<Palette>;
  /** Aura colour (additive fresnel shell). */
  readonly aura: number;
}

const ELITE_LOOKS: Readonly<Record<EliteId, EliteLook>> = {
  oldMossback: { base: 'mossbackBrute', extra: thornCrown, aura: 0x9dff8a, palette: { hair: 0x3f6a24, skin: 0x6f8058 } },
  emberjaw: { base: 'cinderHound', extra: (l) => horns(l, 2), aura: 0xff7a45, palette: { primary: 0x3a2420 } },
  galeclaw: { base: 'windcutter', extra: galeclawArmour, aura: 0x5ed3a5, palette: { primary: 0x6f9ab4, secondary: 0x33485a } },
  rootboundWarden: { base: null, extra: wardenParts, aura: 0xb6ff6a },
  cinderAlpha: { base: 'cinderHound', extra: (l) => horns(l, 4), aura: 0xff5a2a, palette: { primary: 0x241614, element: 0xff5a2a } },
  sentinelPrime: { base: 'aetherSentinel', extra: sentinelPrimeArmour, aura: 0x7fd8ff, palette: { primary: 0xc8c0b0, accent: 0xd8b060 } },
};

const WARDEN_LOOK: EnemyLook = {
  preset: 'humanoid', height: 4.2, headRatio: 6.5, shoulderScale: 1.5, proportions: { arm: 1.15, leg: 0.55 }, parts: () => [],
  palette: { primary: 0x5a4430, secondary: 0x3a2c20, accent: 0x6a8a3a, skin: 0x4a3a2a, hair: 0x5a7a34, element: 0xffa24a },
};

function specOf(id: string, look: EnemyLook, height: number, parts: Parts, palette: Palette): RigSpec {
  return {
    id,
    preset: look.preset,
    height,
    headRatio: look.headRatio ?? 6,
    shoulderScale: look.shoulderScale ?? 1,
    proportions: look.proportions,
    extraJoints: look.extraJoints?.(height),
    parts,
    palette,
    springs: [],
    material: 'enemy',
    idleGlow: look.glow ?? 0.6,
  };
}

/** The RigSpec of an enemy kind. */
export function enemyRigSpec(id: EnemyId): RigSpec {
  const look = LOOKS[id];
  return specOf(id, look, look.height, look.parts, look.palette);
}

/** The base kind of an Elite model (null for rootboundWarden's own model). */
export function eliteBase(id: EliteId): EnemyId | null {
  return ELITE_LOOKS[id].base;
}

/** Aura colour of an Elite. */
export function eliteAuraColor(id: EliteId): number {
  return ELITE_LOOKS[id].aura;
}

/** Aura shell width (m) for a model of `height`. */
export const eliteAuraWidth = (height: number): number => 0.025 * height;

/** The RigSpec of an Elite: its base model at 1.4× plus its extra parts (or rootboundWarden's own model). */
export function eliteRigSpec(id: EliteId): RigSpec {
  const e = ELITE_LOOKS[id];
  if (e.base === null) {
    return { ...specOf(id, WARDEN_LOOK, WARDEN_LOOK.height, e.extra, { ...WARDEN_LOOK.palette, ...e.palette }), material: 'character', idleGlow: 0.8 };
  }
  const look = LOOKS[e.base];
  const parts: Parts = (layout) => [...look.parts(layout), ...e.extra(layout)];
  // Own material instance (glow and aura are the Elite's own, design "재질 instance").
  return { ...specOf(id, look, look.height * ELITE_SIZE, parts, { ...look.palette, ...e.palette }), material: 'character', idleGlow: 0.8 };
}

/** Sentinel Prime's drones: a reduced Sentinel — the eye and one ring only (design "Elite"). */
export const DRONE_RIG_SPEC: RigSpec = {
  id: 'sentinelPrime_drone',
  preset: 'floater',
  height: 0.9,
  headRatio: 6,
  shoulderScale: 1,
  extraJoints: [{ name: 'ring0', parent: 'body', offset: [0, 0, 0] }],
  palette: { primary: 0xc9cbe0, secondary: 0x6a6458, accent: 0xd8b060, skin: 0x8a8478, hair: 0x4a4640, element: 0x7fd8ff },
  springs: [],
  material: 'enemy',
  idleGlow: 0.7,
  parts: (layout) => {
    const H = layout.height;
    const body = layout.pos('body');
    const head = layout.pos('head');
    const ringGeo = new THREE.TorusGeometry(0.36 * H, 0.03 * H, 5, 24);
    ringGeo.rotateX(Math.PI / 2 - 0.4);
    ringGeo.translate(body[0], body[1], body[2]);
    return [
      { joint: 'body', zone: 'primary', geometry: ellipsoid(body, [0.2 * H, 0.2 * H, 0.2 * H], 12, 8) },
      { joint: 'body', zone: 'secondary', geometry: cone(v3add(body, [0, -0.15 * H, 0]), v3add(body, [0, -0.4 * H, 0]), 0.08 * H, 6) },
      { joint: 'head', zone: 'accent', geometry: ring(v3add(head, [0, 0, 0.02 * H]), 0.09 * H, 0.02 * H, 5, 12, Math.PI / 2) },
      { joint: 'head', zone: 'element', glow: 1, geometry: ellipsoid(v3add(head, [0, 0, 0.03 * H]), [0.08 * H, 0.08 * H, 0.05 * H], 10, 7) },
      { joint: 'ring0', zone: 'accent', geometry: ringGeo },
    ];
  },
};

/** Model height (m) of an enemy or Elite model. */
export function enemyModelHeight(id: EnemyId | EliteId): number {
  if (id in LOOKS) return LOOKS[id as EnemyId].height;
  const e = ELITE_LOOKS[id as EliteId];
  return e.base === null ? WARDEN_LOOK.height : LOOKS[e.base].height * ELITE_SIZE;
}
