/*
 * The four Player_Character models (design.md "캐릭터 사양", Req 22.5): RigSpecs and weapons. All four share the
 * collision capsule (r 0.4 m, h 1.75 m, ADJ-06); build differences are visual only and every model stands with its
 * soles on the capsule bottom (the rig origin), so Talus stands 0.3 m above the capsule top and Wren 0.3 m below it.
 *
 * Told apart at 30 m (1080p, vertical fov 60°: 45–64 px tall) by height (1.45–2.05 m), width (Talus's shoulders are
 * ≥ 1.5× everyone else's), silhouette accent and main colour:
 * - Kairen 1.72 m, 1:6 — short swept-back hair, a long crimson scarf (6-joint spring chain), short coat;
 *   crimson · charcoal · gold; curved sword. Ember glow: coat hem and scarf tip.
 * - Isla 1.80 m, 1:6.5 — a high long ponytail (7 joints) and a short hooded cape over a fitted travel suit;
 *   teal · white · navy; recurve longbow with a string. Tide glow: the cape's edge.
 * - Wren 1.45 m, 1:5 — a bob, a feather cape spreading wide from the shoulders, goggles on the forehead, short tunic;
 *   mint · cream · amber; crescent glaive. Gale glow: the feather tips.
 * - Talus 2.05 m, 1:6.5, broad — short hair, big pauldrons, stone gauntlets; ochre · stone grey · moss; tower shield
 *   with the Terra hex crystal. Terra glow: the gauntlet cracks.
 */
import * as THREE from 'three';
import { createRng, hashString, type Rng } from '../core/rng';
import type { CharacterId } from '../data/ids';
import { ELEMENT_DEFS } from '../data/elements';
import { CHARACTERS } from '../data/characters';
import { chainLock, hairCap, hairClumps, humanoidBase, type HairStyle } from './humanoidParts';
import { box, ellipsoid, flipped, lathe, ribbon, ring, sweep, taperedCapsule } from './rigGeometry';
import { chainJoint } from './rigLayout';
import type { PaletteZone, PartDef, RigLayout, RigSpec, SpringDef, V3 } from './rigTypes';
import type { WeaponParams } from './weapons';

export interface HeroLook {
  readonly height: number;
  readonly headRatio: number;
  readonly shoulderScale: number;
  readonly palette: Readonly<Record<PaletteZone, number>>;
  readonly weapon: WeaponParams;
  readonly weaponSocket: 'weaponR' | 'weaponL';
  readonly weaponParent: string;
}

const element = (id: CharacterId): number => ELEMENT_DEFS[CHARACTERS[id].element].color;

/** Heights, proportions, palettes and weapons of the four heroes. */
export const HERO_LOOKS: Readonly<Record<CharacterId, HeroLook>> = {
  kairen: {
    height: 1.72, headRatio: 6, shoulderScale: 1,
    palette: { primary: 0xb3202e, secondary: 0x2d2a31, accent: 0xe0b347, skin: 0xf2c9a8, hair: 0x3c2227, element: element('kairen') },
    weapon: { shape: 'curvedSword' }, weaponSocket: 'weaponR', weaponParent: 'rightHand',
  },
  isla: {
    height: 1.8, headRatio: 6.5, shoulderScale: 0.95,
    palette: { primary: 0x1e8e8c, secondary: 0xf0efe8, accent: 0x1f2d5c, skin: 0xf3d3bb, hair: 0x1d2946, element: element('isla') },
    weapon: { shape: 'recurveBow' }, weaponSocket: 'weaponL', weaponParent: 'leftHand',
  },
  wren: {
    height: 1.45, headRatio: 5, shoulderScale: 1,
    palette: { primary: 0x8fdcb6, secondary: 0xf2e6c4, accent: 0xe39a2d, skin: 0xf6d6b6, hair: 0xb8702e, element: element('wren') },
    weapon: { shape: 'crescentGlaive' }, weaponSocket: 'weaponR', weaponParent: 'rightHand',
  },
  talus: {
    // shoulderScale 1.3 at 2.05 m: the upper-arm joints sit ≥ 1.5× as far apart as any other hero's.
    height: 2.05, headRatio: 6.5, shoulderScale: 1.3,
    palette: { primary: 0xc58a2c, secondary: 0x7f7f79, accent: 0x5c7b3b, skin: 0xb8876a, hair: 0x39322d, element: element('talus') },
    weapon: { shape: 'towerShield' }, weaponSocket: 'weaponL', weaponParent: 'leftLowerArm',
  },
};

const rngFor = (id: string): Rng => createRng(hashString(`rig:${id}`));
const p3 = (v: V3, dx = 0, dy = 0, dz = 0): V3 => [v[0] + dx, v[1] + dy, v[2] + dz];
/** Rest points of a chain in a layout. */
const chainPoints = (layout: RigLayout, id: string): readonly V3[] => layout.chains.get(id)!.points;

// ── Kairen ─────────────────────────────────────────────────────────────────

const KAIREN_SPRINGS: SpringDef[] = [
  { id: 'scarf', parent: 'neck', segments: 6, segLength: 0.1, offset: [0.03, 0.01, -0.07], dir: [0.12, -0.42, -1], stiffness: 0.035, drag: 3 },
];

function kairenParts(layout: RigLayout): PartDef[] {
  const H = layout.height;
  const rng = rngFor('kairen');
  // Charcoal shirt under the open crimson coat (the opening reads at a distance), coat sleeves to the wrist.
  const base = humanoidBase(layout, {
    limb: 1, torsoWidth: 1, torsoZone: 'secondary', sleeveZone: 'primary', forearmZone: 'primary', legZone: 'secondary',
    bootColor: 0x1d1b20, jaw: 0.32,
  });
  const parts = base.parts;
  const chestY = layout.pos('chest')[1];
  const spineY = layout.pos('spine')[1];
  const hipsY = layout.pos('hips')[1];
  const hemY = 0.4 * H;
  // Short coat: body on the chest, skirt on the hips with a front opening; charcoal lining; gold belt; ember hem.
  const gap = 0.55;
  parts.push({
    joint: 'chest', zone: 'primary',
    geometry: lathe([[0.084 * H, spineY + 0.02 * H], [0.094 * H, chestY + 0.04 * H], [0.088 * H, chestY + 0.08 * H]], { segments: 14, scaleZ: 0.78, phiStart: gap / 2, phiLength: Math.PI * 2 - gap }),
  });
  const skirtProfile: [number, number][] = [[0.106 * H, hemY], [0.094 * H, hipsY - 0.03 * H], [0.08 * H, spineY + 0.015 * H]];
  const skirt = lathe(skirtProfile, { segments: 16, scaleZ: 0.8, phiStart: gap / 2, phiLength: Math.PI * 2 - gap });
  parts.push({ joint: 'hips', zone: 'primary', geometry: skirt });
  parts.push({ joint: 'hips', zone: 'secondary', geometry: flipped(lathe(skirtProfile.map(([r, y]) => [r * 0.97, y] as [number, number]), { segments: 16, scaleZ: 0.8, phiStart: gap / 2, phiLength: Math.PI * 2 - gap })) });
  parts.push({ joint: 'hips', zone: 'element', glow: 1, geometry: lathe([[0.108 * H, hemY - 0.004 * H], [0.107 * H, hemY + 0.012 * H]], { segments: 16, scaleZ: 0.8, phiStart: gap / 2, phiLength: Math.PI * 2 - gap }) });
  parts.push({ joint: 'spine', zone: 'accent', geometry: ring([0, spineY + 0.005 * H, 0], 0.076 * H, 0.008 * H, 5, 16, 0, 1, 0.76) });
  // Gold cuff trims.
  for (const side of ['left', 'right'] as const) {
    const lower = layout.pos(`${side}LowerArm`);
    parts.push({ joint: `${side}LowerArm`, zone: 'accent', geometry: taperedCapsule(lower, p3(lower, (side === 'left' ? 1 : -1) * 0.02 * H), 0.031 * H, 0.031 * H, 8, 1) });
  }
  // Scarf: a wrap round the neck and the long tail on its spring chain, ember-lit at the tip.
  const neck = layout.pos('neck');
  parts.push({ joint: 'neck', zone: 'primary', color: 0xd4303c, geometry: ring(p3(neck, 0, 0.004 * H, 0), 0.034 * H, 0.016 * H, 6, 14, 0.15, 1, 0.9) });
  const tail = chainPoints(layout, 'scarf');
  const body = tail.slice(0, tail.length - 1);
  // The tail's flat side is turned ≈ 40° from horizontal (⊥ the chain) so it reads from the side and from behind at 30 m.
  const scarfSide: [number, number, number] = [0.74, 0.65, -0.19];
  parts.push({ joint: 'neck', chain: 'scarf', zone: 'primary', color: 0xd4303c, geometry: ribbon(body, scarfSide, 0.12, 0.85) });
  parts.push({ joint: 'neck', chain: 'scarf', zone: 'element', glow: 1, geometry: ribbon(tail.slice(tail.length - 2), scarfSide, 0.1, 0.4, 0.016) });
  // Hair: short, swept back and up, a few fringe clumps.
  parts.push({ joint: 'head', zone: 'hair', geometry: hairCap(base.head, 0.5, -0.3) });
  const style: HairStyle = { count: 24, length: 0.15, flow: [0, 0.35, -1], outward: 0.55, fringe: 5, fringeLength: 0.09, ribbons: 0.3, nape: -0.35 };
  for (const g of hairClumps(base.head, style, rng)) parts.push({ joint: 'head', zone: 'hair', geometry: g });
  return parts;
}

// ── Isla ───────────────────────────────────────────────────────────────────

function islaSprings(): SpringDef[] {
  return [
    { id: 'ponytail', parent: 'head', segments: 7, segLength: 0.075, offset: [0, 0.2, -0.13], dir: [0, -0.55, -0.85], stiffness: 0.02, drag: 2.2 },
    { id: 'cape', parent: 'chest', segments: 4, segLength: 0.075, offset: [0, 0.2, -0.12], dir: [0, -1, -0.3], stiffness: 0.08, drag: 2 },
  ];
}

function islaParts(layout: RigLayout): PartDef[] {
  const H = layout.height;
  const rng = rngFor('isla');
  const base = humanoidBase(layout, {
    limb: 0.9, torsoWidth: 0.92, torsoDepth: 0.7, hipWidth: 0.95, torsoZone: 'primary', sleeveZone: 'secondary',
    forearmZone: 'primary', legZone: 'accent', bootZone: 'accent', bootColor: 0x152040, jaw: 0.34,
  });
  const parts = base.parts;
  const spineY = layout.pos('spine')[1];
  // White trims on the fitted suit (belt, collar), navy bracer.
  parts.push({ joint: 'spine', zone: 'secondary', geometry: ring([0, spineY + 0.01 * H, 0], 0.066 * H, 0.006 * H, 5, 16, 0, 1, 0.7) });
  const neck = layout.pos('neck');
  parts.push({ joint: 'neck', zone: 'secondary', geometry: ring(p3(neck, 0, -0.004 * H, 0), 0.03 * H, 0.008 * H, 5, 14, 0, 1, 0.9) });
  // Short hooded cape on its chain: white shell over the back and shoulders, navy lining, tide-lit edge; hood roll.
  const cape = chainPoints(layout, 'cape');
  const top = cape[0]![1];
  const bottom = cape[cape.length - 1]![1];
  const capeProfile: [number, number][] = [[0.13 * H, bottom], [0.118 * H, (top + bottom) / 2], [0.07 * H, top + 0.005 * H]];
  const phiStart = Math.PI * 0.42;
  const phiLength = Math.PI * 1.16;
  const capeGeo = lathe(capeProfile, { segments: 12, scaleZ: 0.82, phiStart, phiLength, center: [0, -0.01 * H] });
  parts.push({ joint: 'chest', chain: 'cape', zone: 'secondary', geometry: capeGeo });
  parts.push({ joint: 'chest', chain: 'cape', zone: 'accent', geometry: flipped(lathe(capeProfile.map(([r, y]) => [r * 0.97, y] as [number, number]), { segments: 12, scaleZ: 0.82, phiStart, phiLength, center: [0, -0.01 * H] })) });
  parts.push({ joint: 'chest', chain: 'cape', zone: 'element', glow: 1, geometry: lathe([[0.1315 * H, bottom - 0.004 * H], [0.131 * H, bottom + 0.014 * H]], { segments: 12, scaleZ: 0.82, phiStart, phiLength, center: [0, -0.01 * H] }) });
  parts.push({ joint: 'chest', zone: 'secondary', geometry: ellipsoid(p3(neck, 0, -0.005 * H, -0.05 * H), [0.06 * H, 0.03 * H, 0.03 * H], 10, 6) });
  // Hair swept back to a high tie, fringe, two long side locks, and the ponytail on its chain.
  const tieBase = layout.pos('head');
  const tie: V3 = p3(tieBase, 0, 0.2, -0.13);
  parts.push({ joint: 'head', zone: 'hair', geometry: hairCap(base.head, 0.52, -0.25) });
  const style: HairStyle = { count: 22, length: 0.13, flow: [0, 0.2, -1], flowTo: tie, outward: 0.2, fringe: 4, fringeLength: 0.1, ribbons: 0.4, nape: -0.3 };
  for (const g of hairClumps(base.head, style, rng)) parts.push({ joint: 'head', zone: 'hair', geometry: g });
  const c = base.head.center;
  const r = base.head.radius;
  for (const s of [1, -1]) {
    parts.push({ joint: 'head', zone: 'hair', geometry: sweep([[c[0] + s * r * 0.82, c[1] + r * 0.3, c[2] + r * 0.42], [c[0] + s * r * 0.95, c[1] - r * 0.4, c[2] + r * 0.35], [c[0] + s * r * 0.9, c[1] - r * 1.25, c[2] + r * 0.25]], { r0: r * 0.2, r1: r * 0.03, radial: 4, samples: 6, flatten: 0.45 }) });
  }
  parts.push({ joint: 'head', zone: 'accent', geometry: ring(tie, 0.022, 0.009, 5, 10, Math.PI / 2 - 0.55) });
  for (const g of chainLock(chainPoints(layout, 'ponytail'), 0.05, rng, 3)) parts.push({ joint: 'head', chain: 'ponytail', zone: 'hair', geometry: g });
  return parts;
}

// ── Wren ───────────────────────────────────────────────────────────────────

function wrenSprings(): SpringDef[] {
  return [{ id: 'cape', parent: 'chest', segments: 5, segLength: 0.06, offset: [0, 0.155, -0.095], dir: [0, -1, -0.45], stiffness: 0.07, drag: 2.6 }];
}

function wrenParts(layout: RigLayout): PartDef[] {
  const H = layout.height;
  const rng = rngFor('wren');
  const base = humanoidBase(layout, {
    limb: 1.02, torsoWidth: 1.02, torsoZone: 'primary', sleeveZone: 'secondary', forearmZone: 'secondary',
    legZone: 'secondary', bootZone: 'accent', bootColor: 0x8a5a2b, jaw: 0.22,
  });
  const parts = base.parts;
  const spineY = layout.pos('spine')[1];
  const hipsY = layout.pos('hips')[1];
  // Short mint tunic flaring over the hips, amber belt.
  parts.push({ joint: 'hips', zone: 'primary', geometry: lathe([[0.108 * H, 0.4 * H], [0.092 * H, hipsY - 0.02 * H], [0.078 * H, spineY + 0.02 * H]], { segments: 16, scaleZ: 0.8 }) });
  parts.push({ joint: 'spine', zone: 'accent', geometry: ring([0, spineY + 0.005 * H, 0], 0.078 * H, 0.009 * H, 5, 16, 0, 1, 0.78) });
  // Feather cape: a cream shell spreading wide from the shoulders, mint feathers round the hem with gale-lit tips.
  const cape = chainPoints(layout, 'cape');
  const top = cape[0]![1];
  const bottom = cape[cape.length - 1]![1];
  const profile: [number, number][] = [[0.2 * H, bottom], [0.16 * H, (top + bottom) / 2], [0.09 * H, top + 0.01 * H]];
  const phiStart = Math.PI * 0.36;
  const phiLength = Math.PI * 1.28;
  parts.push({ joint: 'chest', chain: 'cape', zone: 'secondary', geometry: lathe(profile, { segments: 14, scaleZ: 0.72, phiStart, phiLength }) });
  parts.push({ joint: 'chest', chain: 'cape', zone: 'accent', geometry: flipped(lathe(profile.map(([r, y]) => [r * 0.97, y] as [number, number]), { segments: 14, scaleZ: 0.72, phiStart, phiLength })) });
  const feathers = 13;
  for (let i = 0; i < feathers; i++) {
    const a = phiStart + ((i + 0.5) / feathers) * phiLength;
    const r = 0.2 * H * 1.02;
    const x = Math.sin(a) * r;
    const z = Math.cos(a) * r * 0.72;
    const out: V3 = [Math.sin(a) * 0.3, 0, Math.cos(a) * 0.3 * 0.72];
    const len = 0.13 + rng.range(-0.02, 0.02);
    const root: V3 = [x, bottom + 0.05, z];
    const mid: V3 = [x + out[0] * 0.2, bottom - len * 0.45, z + out[2] * 0.2];
    const tip: V3 = [x + out[0] * 0.4, bottom - len, z + out[2] * 0.4];
    const side: V3 = [Math.cos(a), 0, -Math.sin(a)];
    parts.push({ joint: 'chest', chain: 'cape', zone: 'primary', geometry: ribbon([root, mid], side, 0.07, 0.8, 0.01) });
    parts.push({ joint: 'chest', chain: 'cape', zone: 'element', glow: 1, geometry: ribbon([mid, tip], side, 0.056, 0.15, 0.012) });
  }
  // Goggles on the forehead: two amber frames with pale lenses on a strap.
  const c = base.head.center;
  const r = base.head.radius;
  const browY = c[1] + r * 0.55;
  parts.push({ joint: 'head', zone: 'accent', geometry: ring([c[0], browY, c[2] - r * 0.02], r * 1.02, r * 0.07, 5, 18, 0, 1, 1.05) });
  for (const s of [1, -1]) {
    const lens: V3 = [c[0] + s * r * 0.36, browY + r * 0.06, c[2] + r * 0.93];
    const frame = new THREE.TorusGeometry(r * 0.22, r * 0.07, 6, 14);
    frame.rotateX(-0.45);
    frame.translate(...lens);
    parts.push({ joint: 'head', zone: 'accent', geometry: frame });
    parts.push({ joint: 'head', zone: 'accent', color: 0xa8ecff, glow: 0.2, geometry: ellipsoid(p3(lens, 0, 0, -r * 0.02), [r * 0.2, r * 0.2, r * 0.06], 10, 6) });
  }
  // Bob: clumps falling to the jaw, full fringe.
  parts.push({ joint: 'head', zone: 'hair', geometry: hairCap(base.head, 0.5, -0.4) });
  const style: HairStyle = { count: 28, length: 0.13, flow: [0, -1, -0.15], outward: 0.35, fringe: 6, fringeLength: 0.075, ribbons: 0.35, thickness: 1.1, nape: -0.35 };
  for (const g of hairClumps(base.head, style, rng)) parts.push({ joint: 'head', zone: 'hair', geometry: g });
  return parts;
}

// ── Talus ──────────────────────────────────────────────────────────────────

function talusParts(layout: RigLayout): PartDef[] {
  const H = layout.height;
  const rng = rngFor('talus');
  const base = humanoidBase(layout, {
    limb: 1.3, torsoWidth: 1.28, torsoDepth: 0.8, hipWidth: 1.12, torsoZone: 'primary', sleeveZone: 'primary',
    forearmZone: 'secondary', handZone: 'secondary', legZone: 'accent', bootZone: 'secondary', bootColor: 0x5e5e59, jaw: 0.18,
  });
  const parts = base.parts;
  const spineY = layout.pos('spine')[1];
  // Stone belt, big pauldrons with moss, stone gauntlets with terra-lit cracks.
  parts.push({ joint: 'spine', zone: 'secondary', geometry: ring([0, spineY + 0.005 * H, 0], 0.094 * H, 0.012 * H, 5, 16, 0, 1, 0.8) });
  for (const [side, s] of [['left', 1], ['right', -1]] as const) {
    const upper = layout.pos(`${side}UpperArm`);
    parts.push({ joint: `${side}UpperArm`, zone: 'secondary', geometry: ellipsoid(p3(upper, s * 0.02 * H, 0.018 * H, 0), [0.075 * H, 0.05 * H, 0.068 * H], 12, 7) });
    parts.push({ joint: `${side}UpperArm`, zone: 'accent', geometry: ellipsoid(p3(upper, s * 0.02 * H, 0.058 * H, 0), [0.05 * H, 0.014 * H, 0.045 * H], 10, 5) });
    const lower = layout.pos(`${side}LowerArm`);
    const hand = layout.pos(`${side}Hand`);
    parts.push({ joint: `${side}LowerArm`, zone: 'secondary', geometry: taperedCapsule(p3(lower, s * 0.03 * H), p3(hand, -s * 0.01 * H), 0.04 * H, 0.037 * H, 9, 2) });
    const mid = (lower[0] + hand[0]) / 2;
    for (let k = 0; k < 3; k++) {
      const x = mid + s * (k - 1) * 0.03 * H + rng.range(-0.004, 0.004);
      parts.push({ joint: `${side}LowerArm`, zone: 'element', glow: 1, geometry: box([x, lower[1] + 0.036 * H, lower[2] + (k - 1) * 0.012 * H], [0.006 * H, 0.012 * H, 0.03 * H]) });
    }
  }
  // Short cropped hair.
  parts.push({ joint: 'head', zone: 'hair', geometry: hairCap(base.head, 0.58, -0.2) });
  const style: HairStyle = { count: 20, length: 0.06, flow: [0, 0.6, -0.8], outward: 0.6, fringe: 0, ribbons: 0.1, thickness: 0.9, nape: -0.25 };
  for (const g of hairClumps(base.head, style, rng)) parts.push({ joint: 'head', zone: 'hair', geometry: g });
  return parts;
}

// ── Specs ──────────────────────────────────────────────────────────────────

const FACES = {
  kairen: { irisTop: 0x5a1a12, irisBottom: 0xff9a45, eyeShape: 'sharp' },
  isla: { irisTop: 0x0f2f4c, irisBottom: 0x5fd2e6, eyeShape: 'soft' },
  wren: { irisTop: 0x24561f, irisBottom: 0x9df0a2, eyeShape: 'round' },
  talus: { irisTop: 0x3a2710, irisBottom: 0xe0ac4a, eyeShape: 'soft', lineColor: 0x241a14 },
} as const satisfies Record<CharacterId, RigSpec['face']>;

const SPRINGS: Readonly<Record<CharacterId, () => SpringDef[]>> = {
  kairen: () => KAIREN_SPRINGS,
  isla: islaSprings,
  wren: wrenSprings,
  talus: () => [],
};

const PARTS: Readonly<Record<CharacterId, (layout: RigLayout) => PartDef[]>> = {
  kairen: kairenParts,
  isla: islaParts,
  wren: wrenParts,
  talus: talusParts,
};

/** The RigSpec of a Player_Character (parts built from the layout on demand). */
export function heroRigSpec(id: CharacterId): RigSpec {
  const look = HERO_LOOKS[id];
  return {
    id,
    preset: 'humanoid',
    height: look.height,
    headRatio: look.headRatio,
    shoulderScale: look.shoulderScale,
    parts: PARTS[id],
    palette: look.palette,
    weaponParent: look.weaponParent,
    weaponSocket: look.weaponSocket,
    springs: SPRINGS[id](),
    face: FACES[id],
    material: 'character',
    idleGlow: 0.3,
  };
}

/** Kairen's scarf joint names (for tests and the pose driver). */
export const KAIREN_SCARF_JOINTS = Array.from({ length: 6 }, (_, i) => chainJoint('scarf', i));
