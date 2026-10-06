/*
 * Humanoid body parts of the rig kit (design.md "Rig kit" 몸통·팔다리·손발·머리·머리카락): lathe torso sections,
 * tapered-capsule limbs, mitten hands, round-toed boots, the shaped head, its face plane, a hair cap and spline hair
 * clumps. Outfits (coats, capes, armour) are added on top by each character's spec (./heroes).
 */
import * as THREE from 'three';
import type { Rng } from '../core/rng';
import {
  boot, facePlane, headGeometry, headShape, lathe, mitten, sweep, taperedCapsule, type HeadShape,
} from './rigGeometry';
import type { PaletteZone, PartDef, RigLayout, V3 } from './rigTypes';

export interface HumanoidBaseOptions {
  /** Limb thickness multiplier (1 = average). */
  readonly limb?: number;
  /** Torso width / depth multipliers. */
  readonly torsoWidth?: number;
  readonly torsoDepth?: number;
  readonly hipWidth?: number;
  readonly torsoZone?: PaletteZone;
  readonly sleeveZone?: PaletteZone;
  readonly forearmZone?: PaletteZone;
  readonly handZone?: PaletteZone;
  readonly legZone?: PaletteZone;
  readonly bootZone?: PaletteZone;
  readonly bootColor?: number;
  /** Jaw narrowing of the head (0 round … 0.4 pointed). */
  readonly jaw?: number;
}

export interface HumanoidBase {
  readonly parts: PartDef[];
  readonly head: HeadShape;
}

/** Torso, neck, head, face, arms, hands, legs and boots of a humanoid layout. */
export function humanoidBase(layout: RigLayout, o: HumanoidBaseOptions = {}): HumanoidBase {
  const H = layout.height;
  const limb = o.limb ?? 1;
  const tw = o.torsoWidth ?? 1;
  const td = o.torsoDepth ?? 0.72;
  const hw = o.hipWidth ?? 1;
  const d = layout.dims;
  const parts: PartDef[] = [];
  const hipsY = layout.pos('hips')[1];
  const spineY = layout.pos('spine')[1];
  const chestY = layout.pos('chest')[1];
  const neckY = layout.pos('neck')[1];
  const legY = layout.pos('leftUpperLeg')[1];
  const shoulderR = Math.max(d.shoulderHalf * 0.82, 0.075 * H * tw);
  const torsoZone = o.torsoZone ?? 'primary';

  // Pelvis (hips) → abdomen (spine) → chest: three lathe sections, overlapping a little at each seam.
  parts.push({
    joint: 'hips', zone: o.legZone ?? 'secondary',
    geometry: lathe([[0.02 * H, legY - 0.035 * H], [0.07 * H * hw, legY - 0.01 * H], [0.085 * H * hw, hipsY], [0.074 * H * tw, spineY + 0.01 * H]], { segments: 14, scaleZ: td }),
  });
  parts.push({
    joint: 'spine', zone: torsoZone,
    geometry: lathe([[0.072 * H * tw, spineY - 0.015 * H], [0.07 * H * tw, spineY + 0.03 * H], [0.082 * H * tw, chestY + 0.005 * H]], { segments: 14, scaleZ: td }),
  });
  parts.push({
    joint: 'chest', zone: torsoZone,
    geometry: lathe([
      [0.08 * H * tw, chestY - 0.01 * H], [0.09 * H * tw, chestY + 0.04 * H], [shoulderR, neckY - 0.03 * H],
      [shoulderR * 0.72, neckY - 0.005 * H], [0.03 * H, neckY + 0.008 * H],
    ], { segments: 14, scaleZ: td * 1.05 }),
  });
  // Neck and head.
  const neck = layout.pos('neck');
  const headJoint = layout.pos('head');
  parts.push({ joint: 'neck', zone: 'skin', geometry: taperedCapsule(neck, [headJoint[0], headJoint[1] + 0.02 * H, headJoint[2]], 0.024 * H * limb, 0.022 * H * limb, 8, 2) });
  const head = headShape(d.headCenter, d.headRadius, o.jaw ?? 0.3, 0.12);
  parts.push({ joint: 'head', zone: 'skin', geometry: headGeometry(head, 16, 12) });
  parts.push({ joint: 'head', zone: 'skin', face: true, geometry: facePlane(head) });
  // Arms, hands.
  for (const [side, s] of [['left', 1], ['right', -1]] as const) {
    const upper = layout.pos(`${side}UpperArm`);
    const lower = layout.pos(`${side}LowerArm`);
    const hand = layout.pos(`${side}Hand`);
    parts.push({ joint: `${side}UpperArm`, zone: o.sleeveZone ?? torsoZone, geometry: taperedCapsule(upper, lower, 0.034 * H * limb, 0.028 * H * limb) });
    parts.push({ joint: `${side}LowerArm`, zone: o.forearmZone ?? o.sleeveZone ?? torsoZone, geometry: taperedCapsule(lower, hand, 0.027 * H * limb, 0.021 * H * limb) });
    for (const g of mitten(hand, s, 0.04 * H * Math.sqrt(limb))) parts.push({ joint: `${side}Hand`, zone: o.handZone ?? 'skin', geometry: g });
  }
  // Legs, boots.
  for (const side of ['left', 'right'] as const) {
    const upper = layout.pos(`${side}UpperLeg`);
    const lower = layout.pos(`${side}LowerLeg`);
    const foot = layout.pos(`${side}Foot`);
    parts.push({ joint: `${side}UpperLeg`, zone: o.legZone ?? 'secondary', geometry: taperedCapsule(upper, lower, 0.05 * H * limb * hw, 0.036 * H * limb) });
    parts.push({ joint: `${side}LowerLeg`, zone: o.legZone ?? 'secondary', geometry: taperedCapsule(lower, foot, 0.034 * H * limb, 0.025 * H * limb) });
    for (const g of boot(foot, 0.048 * H * Math.sqrt(limb))) {
      parts.push({ joint: `${side}Foot`, zone: o.bootZone ?? 'secondary', color: o.bootColor, geometry: g });
    }
  }
  return { parts, head };
}

export interface HairStyle {
  /** Clumps on the scalp (20–40 with the fringe). */
  readonly count: number;
  /** Clump length (m). */
  readonly length: number;
  /** Direction the clumps flow toward (rig space; normalised). */
  readonly flow: V3;
  /** How much the clump leaves along the scalp normal (0 flat … 1 spiky). */
  readonly outward: number;
  /** Fringe clumps hanging over the forehead. */
  readonly fringe: number;
  readonly fringeLength?: number;
  /** Share of flat ribbon clumps (0–1). */
  readonly ribbons?: number;
  /** Clump root radius scale (1 = default). */
  readonly thickness?: number;
  /** Lowest elevation (rad) at the back of the head the clumps start from. */
  readonly nape?: number;
  /** Optional per-clump flow override (e.g. toward a ponytail tie). */
  readonly flowTo?: V3;
}

/** Hair cap: the upper head shell, lifted over the forehead so the face stays clear. */
export function hairCap(head: HeadShape, forehead = 0.5, nape = -0.25): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, 16, 9, 0, Math.PI * 2, 0, Math.PI / 2 - nape);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const dir = new THREE.Vector3();
  const p = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    dir.fromBufferAttribute(pos, i).normalize();
    const az = Math.atan2(dir.x, dir.z);
    let el = Math.asin(Math.max(-1, Math.min(1, dir.y)));
    // Front (az ≈ 0) keeps above the forehead line, the sides and back go down to the nape.
    const front = Math.max(0, Math.cos(az));
    const minEl = nape + (forehead - nape) * Math.pow(front, 1.6);
    if (el < minEl) el = minEl;
    dir.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
    head.point(dir, 0.012, p);
    pos.setXYZ(i, p.x, p.y, p.z);
  }
  g.computeVertexNormals();
  return g;
}

/** Spline-swept hair clumps and ribbons over the scalp, seeded (deterministic). */
export function hairClumps(head: HeadShape, style: HairStyle, rng: Rng): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  const r = head.radius;
  const flow = new THREE.Vector3(...style.flow).normalize();
  const dir = new THREE.Vector3();
  const root = new THREE.Vector3();
  const f = new THREE.Vector3();
  const nape = style.nape ?? -0.2;
  const thick = (style.thickness ?? 1) * r * 0.26;
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < style.count; i++) {
    const t = (i + 0.5) / style.count;
    const sinEl = Math.sin(nape) + (1 - Math.sin(nape)) * t;
    let el = Math.asin(Math.min(1, sinEl)) + rng.range(-0.05, 0.05);
    const az = i * golden + rng.range(-0.2, 0.2);
    // Keep the face open: front roots only above the forehead line.
    if (Math.cos(az) > 0.3 && el < 0.55) el = 0.55 + rng.range(0, 0.15);
    dir.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
    head.point(dir, -0.004, root);
    const len = style.length * rng.range(0.8, 1.15);
    if (style.flowTo !== undefined) f.set(style.flowTo[0] - root.x, style.flowTo[1] - root.y, style.flowTo[2] - root.z).normalize();
    else f.copy(flow);
    const n = dir;
    const mid = root.clone().addScaledVector(n, len * (0.25 + style.outward * 0.3)).addScaledVector(f, len * 0.35);
    const tip = root.clone().addScaledVector(n, len * style.outward * 0.7).addScaledVector(f, len);
    tip.x += rng.range(-0.15, 0.15) * len;
    const ribbon = rng.next() < (style.ribbons ?? 0.3);
    out.push(sweep([[root.x, root.y, root.z], [mid.x, mid.y, mid.z], [tip.x, tip.y, tip.z]], {
      r0: thick * rng.range(0.85, 1.15), r1: thick * 0.08, radial: ribbon ? 4 : 5, samples: 5, flatten: ribbon ? 0.4 : 1,
    }));
  }
  // Fringe: clumps from the hairline hanging down over the forehead.
  const fringeLen = style.fringeLength ?? style.length * 0.7;
  for (let i = 0; i < style.fringe; i++) {
    const az = ((i + 0.5) / style.fringe - 0.5) * 1.5 + rng.range(-0.06, 0.06);
    const el = 0.62 + rng.range(-0.04, 0.06);
    dir.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
    head.point(dir, 0, root);
    const len = fringeLen * rng.range(0.8, 1.1);
    const mid = root.clone().addScaledVector(dir, len * 0.3);
    mid.y -= len * 0.2;
    const tip = root.clone().addScaledVector(dir, len * 0.25);
    tip.y -= len;
    tip.x += Math.sin(az) * len * 0.2;
    out.push(sweep([[root.x, root.y, root.z], [mid.x, mid.y, mid.z], [tip.x, tip.y, tip.z]], {
      r0: thick * 0.9, r1: thick * 0.06, radial: 4, samples: 5, flatten: 0.45,
    }));
  }
  return out;
}

/** Hair clumps along a spring chain (ponytail, long hair): a main tapered lock plus thinner strands around it. */
export function chainLock(points: readonly V3[], radius: number, rng: Rng, strands = 3): THREE.BufferGeometry[] {
  const out = [sweep(points, { r0: radius, r1: radius * 0.18, radial: 6, samples: points.length * 2, flatten: 0.85 })];
  for (let i = 0; i < strands; i++) {
    const jitter = points.map((p, k) => {
      const f = k / Math.max(1, points.length - 1);
      return [p[0] + rng.range(-1, 1) * radius * 0.6 * f, p[1], p[2] + rng.range(-1, 1) * radius * 0.5 * f] as const;
    });
    out.push(sweep(jitter, { r0: radius * 0.55, r1: radius * 0.08, radial: 4, samples: points.length * 2, flatten: 0.6 }));
  }
  return out;
}
