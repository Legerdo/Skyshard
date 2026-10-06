/*
 * The seven Thistlewick NPC models (design.md "적·Elite·NPC 구성" NPC, Req 14.9): the same `humanoid` kit as the heroes
 * with other proportions, outfits and palettes, and every one with a face atlas so the mouth moves in dialogue.
 * - Elder Maren (촌장): long robe and shawl, grey bun, a tall elder's staff with a green stone.
 * - Pip (상인): apron, cap and a big pack on the back.
 * - Old Bram: bald crown, long white beard, a short cane, stooped.
 * - Tamsin (아이): ≈ 1.2 m, big head (1:4.6), dress and two pigtails.
 * - Hobb (농부): wide straw hat, overalls, a hoe.
 * - Durga (광부): broad, leather apron, bandana, bare forearms, a forge hammer.
 * - Oriel (천문학자): long navy coat under a star-patterned cape, round spectacles, a notebook.
 * Held tools are merged into the body on the hand joint (still 2 draw calls). Tool shafts run along the hand's grip
 * axis (+Z at rest, palm down), so with the forearm raised forward a staff stands upright.
 */
import { createRng, hashString } from '../core/rng';
import type { NpcId } from '../data/ids';
import { chainLock, hairCap, hairClumps, humanoidBase, type HairStyle } from './humanoidParts';
import { crystal, rod, v3add } from './modelParts';
import { box, ellipsoid, flipped, lathe, ring, sweep, taperedCapsule } from './rigGeometry';
import type { FaceSpec, PaletteZone, PartDef, RigLayout, RigSpec, V3 } from './rigTypes';

type Palette = Readonly<Record<PaletteZone, number>>;

interface NpcLook {
  readonly height: number;
  readonly headRatio: number;
  readonly shoulderScale: number;
  readonly palette: Palette;
  readonly face: FaceSpec;
  readonly parts: (layout: RigLayout) => PartDef[];
}

const rngFor = (id: string) => createRng(hashString(`rig:${id}`));

/** Palm centre of a hand (where a held tool's grip is). */
function palm(layout: RigLayout, side: 'left' | 'right', limb = 1): V3 {
  const H = layout.height;
  const w = layout.pos(`${side}Hand`);
  const size = 0.04 * H * Math.sqrt(limb);
  return [w[0] + (side === 'left' ? 1 : -1) * size * 0.95, w[1] - size * 0.1, w[2]];
}

/** Long skirt / robe hanging from the hips to `hemY`, flaring to `hemR` (× H). */
function robe(layout: RigLayout, hemY: number, hemR: number, zone: PaletteZone, lining: PaletteZone, phiGap = 0): PartDef[] {
  const H = layout.height;
  const hipsY = layout.pos('hips')[1];
  const spineY = layout.pos('spine')[1];
  const profile: [number, number][] = [[hemR * H, hemY * H], [(hemR * 0.82) * H, (hemY + (hipsY / H - hemY) * 0.5) * H], [0.09 * H, hipsY - 0.02 * H], [0.078 * H, spineY + 0.01 * H]];
  const opts = { segments: 16, scaleZ: 0.82, phiStart: phiGap / 2, phiLength: Math.PI * 2 - phiGap };
  return [
    { joint: 'hips', zone, geometry: lathe(profile, opts) },
    { joint: 'hips', zone: lining, geometry: flipped(lathe(profile.map(([r, y]) => [r * 0.97, y] as [number, number]), opts)) },
  ];
}

function hair(layout: RigLayout, head: ReturnType<typeof humanoidBase>['head'], style: HairStyle, id: string, forehead = 0.5, nape = -0.3): PartDef[] {
  const rng = rngFor(id);
  const out: PartDef[] = [{ joint: 'head', zone: 'hair', geometry: hairCap(head, forehead, nape) }];
  for (const g of hairClumps(head, style, rng)) out.push({ joint: 'head', zone: 'hair', geometry: g });
  return out;
}

function marenParts(layout: RigLayout): PartDef[] {
  const H = layout.height;
  const base = humanoidBase(layout, { limb: 0.92, torsoWidth: 0.96, torsoZone: 'primary', sleeveZone: 'primary', legZone: 'primary', bootColor: 0x4a3a2a, jaw: 0.34 });
  const parts = base.parts;
  parts.push(...robe(layout, 0.04, 0.15, 'primary', 'secondary'));
  const chest = layout.pos('chest');
  const neck = layout.pos('neck');
  // Cream shawl over the shoulders, gold sash.
  parts.push({ joint: 'chest', zone: 'secondary', geometry: lathe([[0.1 * H, chest[1] + 0.02 * H], [0.11 * H, neck[1] - 0.04 * H], [0.05 * H, neck[1] + 0.005 * H]], { segments: 14, scaleZ: 0.82 }) });
  parts.push({ joint: 'spine', zone: 'accent', geometry: ring([0, layout.pos('spine')[1] + 0.01 * H, 0], 0.08 * H, 0.009 * H, 5, 16, 0, 1, 0.8) });
  // Grey hair in a bun.
  const c = base.head.center;
  const r = base.head.radius;
  parts.push(...hair(layout, base.head, { count: 20, length: 0.1, flow: [0, -0.2, -1], flowTo: v3add(c, [0, r * 0.3, -r * 1.1]), outward: 0.15, fringe: 3, fringeLength: 0.05, ribbons: 0.3, nape: -0.35 }, 'maren', 0.55, -0.35));
  parts.push({ joint: 'head', zone: 'hair', geometry: ellipsoid(v3add(c, [0, r * 0.35, -r * 1.05]), [r * 0.42, r * 0.38, r * 0.36], 10, 7) });
  // Elder's staff (upright with the forearm forward) with a glowing green stone.
  const p = palm(layout, 'right', 0.92);
  parts.push({ joint: 'rightHand', zone: 'accent', color: 0x6a4a2a, geometry: rod(v3add(p, [0, 0, -0.92]), v3add(p, [0, 0, 0.62]), 0.018) });
  parts.push({ joint: 'rightHand', zone: 'element', glow: 0.9, geometry: crystal(v3add(p, [0, 0, 0.7]), [0, 0, 1], 0.14, 0.07) });
  parts.push({ joint: 'rightHand', zone: 'accent', geometry: ring(v3add(p, [0, 0, 0.62]), 0.03, 0.008, 4, 10, Math.PI / 2) });
  return parts;
}

function pipParts(layout: RigLayout): PartDef[] {
  const H = layout.height;
  const base = humanoidBase(layout, { limb: 0.95, torsoWidth: 1.02, torsoZone: 'primary', sleeveZone: 'primary', legZone: 'secondary', bootColor: 0x3a2a1a, jaw: 0.28 });
  const parts = base.parts;
  const hipsY = layout.pos('hips')[1];
  const chest = layout.pos('chest');
  // Apron: a front panel from the chest to the knees.
  const apron = lathe([[0.1 * H, 0.3 * H], [0.092 * H, hipsY], [0.086 * H, chest[1] + 0.03 * H]], { segments: 10, scaleZ: 0.85, phiStart: -0.9, phiLength: 1.8 });
  parts.push({ joint: 'hips', zone: 'accent', geometry: apron });
  parts.push({ joint: 'hips', zone: 'accent', geometry: flipped(apron) });
  // Big pack on the back: body, bedroll, straps.
  const pack = v3add(chest, [0, -0.01 * H, -0.14 * H]);
  parts.push({ joint: 'chest', zone: 'secondary', geometry: ellipsoid(pack, [0.1 * H, 0.13 * H, 0.08 * H], 12, 8) });
  parts.push({ joint: 'chest', zone: 'hair', color: 0x9a6a3a, geometry: taperedCapsule(v3add(pack, [-0.11 * H, 0.13 * H, 0]), v3add(pack, [0.11 * H, 0.13 * H, 0]), 0.035 * H, 0.035 * H, 8, 2) });
  parts.push({ joint: 'chest', zone: 'accent', color: 0x5a3a20, geometry: box(v3add(pack, [0, 0.02 * H, -0.08 * H]), [0.12 * H, 0.08 * H, 0.03 * H]) });
  for (const s of [1, -1]) parts.push({ joint: 'chest', zone: 'secondary', geometry: box(v3add(chest, [s * 0.05 * H, 0.02 * H, 0.05 * H]), [0.018 * H, 0.14 * H, 0.012 * H]) });
  // Cap and short hair.
  const c = base.head.center;
  const r = base.head.radius;
  parts.push(...hair(layout, base.head, { count: 18, length: 0.08, flow: [0, -0.5, -1], outward: 0.3, fringe: 3, fringeLength: 0.05, ribbons: 0.3 }, 'pip', 0.55, -0.3));
  parts.push({ joint: 'head', zone: 'primary', color: 0x8a5a2a, geometry: ellipsoid(v3add(c, [0, r * 0.55, -r * 0.05]), [r * 1.02, r * 0.5, r * 1.02], 12, 6) });
  parts.push({ joint: 'head', zone: 'primary', color: 0x8a5a2a, geometry: ellipsoid(v3add(c, [0, r * 0.55, r * 0.8]), [r * 0.7, r * 0.08, r * 0.45], 10, 4) });
  return parts;
}

function bramParts(layout: RigLayout): PartDef[] {
  const base = humanoidBase(layout, { limb: 0.9, torsoWidth: 0.98, torsoZone: 'primary', sleeveZone: 'secondary', legZone: 'secondary', bootColor: 0x3a2e24, jaw: 0.3 });
  const parts = base.parts;
  parts.push(...robe(layout, 0.22, 0.12, 'primary', 'secondary', 0.5));
  const c = base.head.center;
  const r = base.head.radius;
  // Bald crown: side and back hair only; a long beard and moustache.
  const rng = rngFor('bram');
  for (const g of hairClumps(base.head, { count: 14, length: 0.07, flow: [0, -1, -0.3], outward: 0.25, fringe: 0, ribbons: 0.3, nape: -0.4 }, rng)) {
    parts.push({ joint: 'head', zone: 'hair', geometry: g });
  }
  parts.push({ joint: 'head', zone: 'skin', geometry: ellipsoid(v3add(c, [0, r * 0.25, 0]), [r * 1.01, r * 0.85, r * 1.03], 14, 9) });
  for (let k = 0; k < 7; k++) {
    const x = (k - 3) * r * 0.16;
    const root: V3 = v3add(c, [x, -r * 0.55, r * 0.72 - Math.abs(x) * 0.4]);
    const len = r * (1.6 - Math.abs(k - 3) * 0.18);
    parts.push({ joint: 'head', zone: 'hair', geometry: sweep([root, v3add(root, [x * 0.2, -len * 0.5, r * 0.18]), v3add(root, [x * 0.1, -len, r * 0.05])], { r0: r * 0.16, r1: r * 0.03, radial: 5, samples: 5, flatten: 0.7 }) });
  }
  for (const s of [1, -1]) {
    const root: V3 = v3add(c, [s * r * 0.05, -r * 0.3, r * 0.95]);
    parts.push({ joint: 'head', zone: 'hair', geometry: sweep([root, v3add(root, [s * r * 0.3, -r * 0.05, 0]), v3add(root, [s * r * 0.55, -r * 0.3, -r * 0.1])], { r0: r * 0.09, r1: r * 0.02, radial: 4, samples: 4 }) });
  }
  // Short cane, the grip at the palm.
  const p = palm(layout, 'right', 0.9);
  parts.push({ joint: 'rightHand', zone: 'accent', color: 0x5a3a24, geometry: rod(v3add(p, [0, 0, -0.95]), v3add(p, [0, 0, 0.06]), 0.016) });
  parts.push({ joint: 'rightHand', zone: 'accent', color: 0x5a3a24, geometry: taperedCapsule(v3add(p, [0, 0, 0.06]), v3add(p, [-0.08, 0, 0.1]), 0.02, 0.018, 6, 1) });
  return parts;
}

function tamsinParts(layout: RigLayout): PartDef[] {
  const H = layout.height;
  const base = humanoidBase(layout, { limb: 0.95, torsoWidth: 0.95, torsoZone: 'primary', sleeveZone: 'secondary', legZone: 'skin', bootZone: 'accent', bootColor: 0x7a3a3a, jaw: 0.2 });
  const parts = base.parts;
  parts.push(...robe(layout, 0.3, 0.13, 'primary', 'secondary'));
  parts.push({ joint: 'spine', zone: 'secondary', geometry: ring([0, layout.pos('spine')[1] + 0.02 * H, 0], 0.075 * H, 0.012 * H, 5, 16, 0, 1, 0.8) });
  const c = base.head.center;
  const r = base.head.radius;
  parts.push(...hair(layout, base.head, { count: 22, length: 0.09, flow: [0, -1, -0.2], outward: 0.25, fringe: 5, fringeLength: 0.06, ribbons: 0.35, thickness: 1.05 }, 'tamsin', 0.5, -0.35));
  // Two pigtails tied at the sides and a hairband.
  const rng = rngFor('tamsin-tails');
  for (const s of [1, -1]) {
    const tie: V3 = v3add(c, [s * r * 0.95, r * 0.1, -r * 0.35]);
    parts.push({ joint: 'head', zone: 'accent', geometry: ellipsoid(tie, [r * 0.12, r * 0.12, r * 0.12], 6, 4) });
    const pts: V3[] = [tie, v3add(tie, [s * r * 0.35, -r * 0.4, -r * 0.1]), v3add(tie, [s * r * 0.4, -r * 1.0, -r * 0.05]), v3add(tie, [s * r * 0.3, -r * 1.5, 0])];
    for (const g of chainLock(pts, r * 0.22, rng, 1)) parts.push({ joint: 'head', zone: 'hair', geometry: g });
  }
  parts.push({ joint: 'head', zone: 'accent', geometry: ring(v3add(c, [0, r * 0.45, -r * 0.05]), r * 1.0, r * 0.06, 4, 16, 0.3, 1, 1.02) });
  return parts;
}

function hobbParts(layout: RigLayout): PartDef[] {
  const H = layout.height;
  const base = humanoidBase(layout, { limb: 1.05, torsoWidth: 1.05, torsoZone: 'primary', sleeveZone: 'primary', legZone: 'secondary', bootColor: 0x3a2a1a, jaw: 0.24 });
  const parts = base.parts;
  const chest = layout.pos('chest');
  const hipsY = layout.pos('hips')[1];
  // Overall bib and straps.
  parts.push({ joint: 'chest', zone: 'secondary', geometry: box(v3add(chest, [0, -0.01 * H, 0.062 * H]), [0.1 * H, 0.1 * H, 0.012 * H]) });
  for (const s of [1, -1]) parts.push({ joint: 'chest', zone: 'secondary', geometry: box(v3add(chest, [s * 0.045 * H, 0.05 * H, 0]), [0.016 * H, 0.012 * H, 0.14 * H]) });
  parts.push({ joint: 'hips', zone: 'secondary', geometry: lathe([[0.09 * H, hipsY - 0.05 * H], [0.088 * H, hipsY + 0.04 * H]], { segments: 14, scaleZ: 0.78 }) });
  // Wide straw hat.
  const c = base.head.center;
  const r = base.head.radius;
  parts.push(...hair(layout, base.head, { count: 16, length: 0.07, flow: [0, -0.6, -1], outward: 0.3, fringe: 2, fringeLength: 0.04, ribbons: 0.3 }, 'hobb', 0.55, -0.3));
  parts.push({ joint: 'head', zone: 'accent', geometry: lathe([[r * 2.1, c[1] + r * 0.55], [r * 1.9, c[1] + r * 0.6], [r * 0.95, c[1] + r * 0.62], [r * 0.85, c[1] + r * 1.05], [r * 0.3, c[1] + r * 1.18]], { segments: 18 }) });
  parts.push({ joint: 'head', zone: 'primary', color: 0x9a3a2a, geometry: ring([c[0], c[1] + r * 0.72, c[2]], r * 0.9, r * 0.06, 4, 16) });
  // Hoe: shaft along the grip axis, the blade at its far end.
  const p = palm(layout, 'right', 1.05);
  parts.push({ joint: 'rightHand', zone: 'accent', color: 0x7a5a36, geometry: rod(v3add(p, [0, 0, -0.35]), v3add(p, [0, 0, 1.05]), 0.017) });
  parts.push({ joint: 'rightHand', zone: 'secondary', color: 0x8a8a88, geometry: box(v3add(p, [0, -0.08, 1.05]), [0.16, 0.16, 0.02]) });
  return parts;
}

function durgaParts(layout: RigLayout): PartDef[] {
  const H = layout.height;
  const base = humanoidBase(layout, { limb: 1.18, torsoWidth: 1.12, torsoDepth: 0.78, hipWidth: 1.05, torsoZone: 'primary', sleeveZone: 'primary', forearmZone: 'skin', legZone: 'secondary', bootColor: 0x2a2220, jaw: 0.2 });
  const parts = base.parts;
  const hipsY = layout.pos('hips')[1];
  const chest = layout.pos('chest');
  const apron = lathe([[0.1 * H, 0.26 * H], [0.098 * H, hipsY], [0.094 * H, chest[1] + 0.05 * H]], { segments: 10, scaleZ: 0.85, phiStart: -1.0, phiLength: 2.0 });
  parts.push({ joint: 'hips', zone: 'accent', geometry: apron });
  parts.push({ joint: 'hips', zone: 'accent', geometry: flipped(apron) });
  parts.push({ joint: 'spine', zone: 'secondary', geometry: ring([0, layout.pos('spine')[1], 0], 0.085 * H, 0.012 * H, 5, 16, 0, 1, 0.8) });
  // Bandana over tied-back black hair, a braid.
  const c = base.head.center;
  const r = base.head.radius;
  parts.push(...hair(layout, base.head, { count: 16, length: 0.08, flow: [0, -0.3, -1], outward: 0.15, fringe: 2, fringeLength: 0.05, ribbons: 0.3 }, 'durga', 0.5, -0.3));
  parts.push({ joint: 'head', zone: 'primary', color: 0xb8402a, geometry: ellipsoid(v3add(c, [0, r * 0.42, -r * 0.05]), [r * 1.04, r * 0.62, r * 1.05], 12, 7) });
  for (const g of chainLock([v3add(c, [0, -r * 0.1, -r * 1.0]), v3add(c, [0, -r * 0.8, -r * 1.1]), v3add(c, [0, -r * 1.6, -r * 1.0])], r * 0.18, rngFor('durga-braid'), 1)) {
    parts.push({ joint: 'head', zone: 'hair', geometry: g });
  }
  // Forge hammer.
  const p = palm(layout, 'right', 1.18);
  parts.push({ joint: 'rightHand', zone: 'accent', color: 0x6a4a2a, geometry: rod(v3add(p, [0, 0, -0.08]), v3add(p, [0, 0, 0.42]), 0.017) });
  parts.push({ joint: 'rightHand', zone: 'secondary', color: 0x5a5a60, geometry: box(v3add(p, [0, 0, 0.45]), [0.07, 0.16, 0.08]) });
  return parts;
}

function orielParts(layout: RigLayout): PartDef[] {
  const H = layout.height;
  const base = humanoidBase(layout, { limb: 0.92, torsoWidth: 0.96, torsoZone: 'primary', sleeveZone: 'primary', legZone: 'primary', bootColor: 0x1e2230, jaw: 0.32 });
  const parts = base.parts;
  parts.push(...robe(layout, 0.12, 0.13, 'primary', 'secondary', 0.4));
  // Star-patterned cape over the back and shoulders: navy with pale gold stars (glowing faintly).
  const neck = layout.pos('neck');
  const profile: [number, number][] = [[0.15 * H, 0.3 * H], [0.13 * H, (0.3 * H + neck[1]) / 2], [0.08 * H, neck[1] - 0.01 * H]];
  const opts = { segments: 14, scaleZ: 0.85, phiStart: Math.PI * 0.45, phiLength: Math.PI * 1.1 };
  parts.push({ joint: 'chest', zone: 'accent', geometry: lathe(profile, opts) });
  parts.push({ joint: 'chest', zone: 'secondary', geometry: flipped(lathe(profile.map(([r, y]) => [r * 0.97, y] as [number, number]), opts)) });
  const rng = rngFor('oriel-stars');
  for (let k = 0; k < 14; k++) {
    const a = opts.phiStart + rng.range(0.1, 0.9) * opts.phiLength;
    const y = rng.range(0.34, 0.82) * H;
    const f = (y - 0.3 * H) / (neck[1] - 0.3 * H);
    const rr = (0.15 - 0.07 * f) * H * 1.02;
    parts.push({ joint: 'chest', zone: 'element', glow: 0.6, color: 0xfff0b0, geometry: crystal([Math.sin(a) * rr, y, Math.cos(a) * rr * 0.85], [Math.sin(a), 0, Math.cos(a)], 0.035, 0.03) });
  }
  // Hair, round spectacles, notebook in the left hand.
  const c = base.head.center;
  const r = base.head.radius;
  parts.push(...hair(layout, base.head, { count: 22, length: 0.11, flow: [0, -1, -0.4], outward: 0.25, fringe: 4, fringeLength: 0.07, ribbons: 0.35 }, 'oriel', 0.5, -0.35));
  for (const s of [1, -1]) {
    parts.push({ joint: 'head', zone: 'accent', color: 0xc9a54a, geometry: ring(v3add(c, [s * r * 0.34, r * 0.02, r * 1.06]), r * 0.2, r * 0.035, 4, 12, Math.PI / 2) });
  }
  parts.push({ joint: 'head', zone: 'accent', color: 0xc9a54a, geometry: box(v3add(c, [0, r * 0.04, r * 1.07]), [r * 0.28, r * 0.04, r * 0.04]) });
  const p = palm(layout, 'left', 0.92);
  parts.push({ joint: 'leftHand', zone: 'secondary', color: 0x6a3a2a, geometry: box(v3add(p, [0, 0.02, 0.06]), [0.1, 0.02, 0.14]) });
  return parts;
}

const LOOKS: Readonly<Record<NpcId, NpcLook>> = {
  maren: {
    height: 1.66, headRatio: 6.2, shoulderScale: 0.95, parts: marenParts,
    palette: { primary: 0x5e7e48, secondary: 0xe8dcc0, accent: 0xc9a54a, skin: 0xeac4a4, hair: 0xcfcac2, element: 0x9dff8a },
    face: { irisTop: 0x2a3a22, irisBottom: 0x8fbf6a, eyeShape: 'soft', lineColor: 0x6a6058 },
  },
  pip: {
    height: 1.62, headRatio: 6, shoulderScale: 1, parts: pipParts,
    palette: { primary: 0xc9923e, secondary: 0x6a4a2a, accent: 0xefe2c4, skin: 0xf0c8a0, hair: 0x6a4428, element: 0xffe69a },
    face: { irisTop: 0x3a2410, irisBottom: 0xd89a4a, eyeShape: 'round' },
  },
  bram: {
    height: 1.7, headRatio: 6.4, shoulderScale: 0.95, parts: bramParts,
    palette: { primary: 0x7a6a56, secondary: 0x4a4038, accent: 0xa89a82, skin: 0xe0b894, hair: 0xe8e4dc, element: 0xffe69a },
    face: { irisTop: 0x2a2a3a, irisBottom: 0x8a9ab0, eyeShape: 'soft', lineColor: 0x9a9088 },
  },
  tamsin: {
    height: 1.2, headRatio: 4.6, shoulderScale: 0.9, parts: tamsinParts,
    palette: { primary: 0xe88aa2, secondary: 0xf6ecd8, accent: 0xffd166, skin: 0xf6d2b4, hair: 0xa0522d, element: 0xffe69a },
    face: { irisTop: 0x3a1a0e, irisBottom: 0xe8a060, eyeShape: 'round' },
  },
  hobb: {
    height: 1.76, headRatio: 6.3, shoulderScale: 1.1, parts: hobbParts,
    palette: { primary: 0xb8583a, secondary: 0x4a6a8a, accent: 0xe8c86a, skin: 0xd8a47c, hair: 0xb89060, element: 0xffe69a },
    face: { irisTop: 0x2a3a1a, irisBottom: 0x9ab05a, eyeShape: 'soft' },
  },
  durga: {
    height: 1.74, headRatio: 6.3, shoulderScale: 1.15, parts: durgaParts,
    palette: { primary: 0x4a4a52, secondary: 0x2e2a28, accent: 0x7a4a2a, skin: 0xb07a58, hair: 0x221c1c, element: 0xff9a45 },
    face: { irisTop: 0x241008, irisBottom: 0xb86a30, eyeShape: 'sharp', lineColor: 0x1a1210 },
  },
  oriel: {
    height: 1.72, headRatio: 6.5, shoulderScale: 0.95, parts: orielParts,
    palette: { primary: 0x2a3466, secondary: 0xd8d4f0, accent: 0x1a2048, skin: 0xefd0b8, hair: 0x2a2a44, element: 0xfff0b0 },
    face: { irisTop: 0x14163a, irisBottom: 0x7a8ae8, eyeShape: 'soft' },
  },
};

/** The RigSpec of an NPC (face atlas on, own material instance). */
export function npcRigSpec(id: NpcId): RigSpec {
  const look = LOOKS[id];
  return {
    id,
    preset: 'humanoid',
    height: look.height,
    headRatio: look.headRatio,
    shoulderScale: look.shoulderScale,
    parts: look.parts,
    palette: look.palette,
    springs: [],
    face: look.face,
    material: 'character',
    idleGlow: 0.3,
  };
}
