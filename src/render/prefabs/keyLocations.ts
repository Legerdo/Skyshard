/*
 * Key-location structure prefabs (design.md "식생·바위·소품", "구조물과 실내 공간"; Req 39.3, 8.3–8.5): eight procedural
 * structures built with the prefab kit (kit.ts: chamfered boxes, bevelled / displaced cylinders, displaced blobs,
 * combined), painted from the Region palettes and drawn with the shared toon material:
 * - `thistlewickHouse`: timber-framed plaster house on a stone plinth, tiled gable roof, door, windows, chimney
 *   (Elder Maren's two-storey version adds the floor band and upper windows);
 * - `windmillStand`: the Breezewatch climb tower's plinth, core and the plank deck of the Vista_Point top (inside the
 *   landmark's tower shell and sails, landmarks.ts);
 * - `elderboughBase`: roots arching out of the ground, moss stones, shrine stones and mushroom clusters round the
 *   old tree's foot;
 * - `shrine` / `spire` / `observatory`: the Hollowroot Shrine, Cinderspire and Starfall Observatory static pieces;
 * - `brokenBridge`: planks, stringers, end posts and sagging rope rails over the chasm;
 * - `sanctum`: the Astral Sanctum's star-stone floors, steps, walls, rim, pedestals and Waystone with gold trims.
 * Structures that stand on a collider (house, windmill deck, bridge, Challenge_Area and Sanctum pieces) fill exactly
 * the collider's shape (bevels cut inward; trims stay within a few centimetres), so what is seen is what is walked on.
 *
 * Every function returns merged BufferGeometry (non-indexed: position, normal, color); nothing here is added to a
 * scene. Deterministic (hash noise only).
 */
import * as THREE from 'three';
import type { AreaLook, AreaShape, ChallengeAreaDef } from '../../data/challengeAreas';
import { REGION_PALETTES } from '../../data/palettes';
import type { SanctumDef, SanctumLook } from '../../data/sanctum';
import type { VillageBuildingDef } from '../../data/village';
import { hash3, PartBuilder, trs, type ColorSpec } from './kit';

const PV = REGION_PALETTES.verdant.swatches;
const PE = REGION_PALETTES.ember.swatches;
const PA = REGION_PALETTES.azure.swatches;
const PS = REGION_PALETTES.sanctum.swatches;

/** `hex` brightened by `k` (sRGB channels, clamped). */
export function tint(hex: number, k: number): number {
  const ch = (s: number): number => Math.max(0, Math.min(255, Math.round(((hex >> s) & 255) * k)));
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

/** Bevel faces (normals off the three axes) catch the light: the edge highlight of every structure. */
function edged(base: number, edge = tint(base, 1.14)): ColorSpec {
  return (_c, n) => (Math.max(Math.abs(n.x), Math.abs(n.y), Math.abs(n.z)) < 0.97 ? edge : base);
}

// ── Thistlewick house ──────────────────────────────────────────────────────

export interface HouseSpec {
  readonly id: string;
  readonly kind: VillageBuildingDef['kind'];
  readonly half: { readonly x: number; readonly z: number };
  readonly height: number;
}

/** Roof pitch and eave overhang of the village houses. */
const ROOF_PITCH = (36 * Math.PI) / 180;
const EAVE = 0.45;

/**
 * A Thistlewick house in its own frame: base centre at the origin, front (door) toward +z, walls exactly the
 * collider's w × height × d box; the roof rises above it.
 */
export function thistlewickHouse(spec: HouseSpec): THREE.BufferGeometry {
  const b = new PartBuilder();
  const W = spec.half.x * 2;
  const D = spec.half.z * 2;
  const H = spec.height;
  const maren = spec.kind === 'marenHouse';
  const vary = hash3(W, D, spec.id.length);
  const plaster = maren ? 0xdcc9a2 : tint(0xeadfc4, 0.95 + vary * 0.08);
  const timber = maren ? 0x6a4a30 : 0x7a5434;
  const stone = PV.stone;
  const roof = maren ? 0x8a3f32 : tint(PV.roof, 0.92 + vary * 0.12);
  const plinthH = 0.45;
  // Plinth, walls, corner posts, sill and top beams.
  b.boxAt(0, -0.1, 0, W + 0.1, plinthH + 0.1, D + 0.1, edged(stone), 0, 0.05);
  b.boxAt(0, plinthH, 0, W - 0.04, H - plinthH, D - 0.04, plaster, 0, 0.03);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) b.boxAt(sx * (W / 2 - 0.1), plinthH, sz * (D / 2 - 0.1), 0.24, H - plinthH, 0.24, edged(timber), 0, 0.03);
  }
  const beams = maren ? [plinthH + 0.08, H / 2, H - 0.12] : [plinthH + 0.08, H - 0.12];
  for (const y of beams) {
    const band = maren && y === H / 2 ? 0.28 : 0.18;
    for (const sz of [-1, 1]) b.boxAt(0, y - band / 2, sz * (D / 2 - 0.06), W, band, 0.16, edged(timber), 0, 0.03);
    for (const sx of [-1, 1]) b.boxAt(sx * (W / 2 - 0.06), y - band / 2, 0, 0.16, band, D, edged(timber), 0, 0.03);
  }
  // Braces on the side walls.
  const storey = maren ? H / 2 : H;
  for (const sx of [-1, 1]) {
    const run = D / 2 - 0.4;
    const rise = storey - plinthH - 0.5;
    const len = Math.hypot(run, rise);
    const ang = Math.atan2(run, rise);
    for (const sz of [-1, 1]) {
      b.box(0.12, len, 0.12, trs(sx * (W / 2 - 0.02), plinthH + 0.2 + rise / 2, sz * (0.2 + run / 2), -sz * ang, 0, 0), timber, 0.02);
    }
  }
  // Door with its frame and step.
  b.boxAt(0, plinthH - 0.1, D / 2 - 0.01, 1.34, 2.35, 0.1, edged(timber), 0, 0.03);
  b.boxAt(0, plinthH - 0.05, D / 2 + 0.02, 1.06, 2.1, 0.08, 0x5a3a24, 0, 0.02);
  b.boxAt(0, -0.2, D / 2 + 0.34, 1.6, 0.36, 0.62, edged(stone), 0, 0.05);
  // Windows: frame, dark glass, sill.
  const window = (x: number, y: number, z: number, yaw: number): void => {
    const m = trs(x, y, z, 0, yaw, 0);
    b.box(0.95, 0.95, 0.1, m, edged(timber), 0.03);
    b.box(0.72, 0.72, 0.08, m.clone().multiply(trs(0, 0, 0.03)), 0x2c3f5a, 0.02);
    b.box(1.1, 0.1, 0.24, m.clone().multiply(trs(0, -0.52, 0.06)), edged(timber), 0.02);
  };
  const rows = maren ? [1.7, H / 2 + 1.5] : [1.7];
  for (const y of rows) {
    if (W >= 5) for (const sx of [-1, 1]) window(sx * W * 0.28, y, D / 2 - 0.02, 0);
    else if (y > 2) window(0, y, D / 2 - 0.02, 0);
    for (const sx of [-1, 1]) window(sx * (W / 2 - 0.02), y, 0, (sx * Math.PI) / 2);
  }
  if (maren) window(0, H / 2 + 1.5, D / 2 - 0.02, 0);
  // Gable roof along x: four stepped shingle rows per side, gable ends, ridge beam.
  const ridgeY = H + (D / 2) * Math.tan(ROOF_PITCH);
  const eaveZ = D / 2 + EAVE;
  const eaveY = H - EAVE * Math.tan(ROOF_PITCH);
  const slope = Math.hypot(eaveZ, ridgeY - eaveY);
  const shingle = (hex: number): ColorSpec => edged(hex, tint(hex, 0.8));
  for (const side of [-1, 1]) {
    for (let row = 0; row < 4; row++) {
      const t0 = row / 4;
      const len = slope / 4 + 0.12;
      const mid = t0 + 0.125;
      const z = side * eaveZ * (1 - mid);
      // Each row a little proud of the one below it, so the rows read as overlapping shingles.
      const y = eaveY + (ridgeY - eaveY) * mid + 0.09 + row * 0.03;
      b.box(W + EAVE * 1.2, 0.16, len, trs(0, y, z, side * ROOF_PITCH, 0, 0), shingle(tint(roof, 0.94 + row * 0.03)), 0.03);
    }
  }
  for (const sx of [-1, 1]) b.prism(D - 0.02, ridgeY - H, 0.18, trs(sx * (W / 2 - 0.05), H, 0, 0, Math.PI / 2, 0), edged(plaster));
  b.boxAt(0, ridgeY - 0.02, 0, W + EAVE * 1.3, 0.2, 0.26, edged(timber), 0, 0.03);
  // Chimney on the back slope.
  const cz = -D / 5;
  const cy = eaveY + (ridgeY - eaveY) * (1 - Math.abs(cz) / eaveZ) - 0.3;
  b.boxAt(W * 0.25, cy, cz, 0.62, ridgeY - cy + 0.9, 0.62, edged(stone), 0, 0.04);
  b.boxAt(W * 0.25, ridgeY + 0.9, cz, 0.78, 0.14, 0.78, edged(tint(stone, 0.85)), 0, 0.03);
  return b.build(`prefab:house:${spec.id}`);
}

// ── Breezewatch windmill stand ─────────────────────────────────────────────

export interface WindmillShapes {
  /** The climb tower (TEMP_PIECES bw_tower). */
  readonly tower: { readonly base: { readonly x: number; readonly y: number; readonly z: number }; readonly radius: number; readonly height: number };
  /** The top deck box (bw_top). */
  readonly top: { readonly min: { readonly x: number; readonly y: number; readonly z: number }; readonly max: { readonly x: number; readonly y: number; readonly z: number } };
}

/** The windmill's plinth, stone core, cap ring and plank deck (world space). */
export function windmillStand(s: WindmillShapes): THREE.BufferGeometry {
  const b = new PartBuilder();
  const t = s.tower;
  const bands: ColorSpec = (c) => (Math.floor((c.y - t.base.y) / 6) % 2 === 0 ? PV.stone : tint(PV.stone, 0.88));
  b.cylinder(2.7, 2.45, 1.4, 16, trs(t.base.x, t.base.y - 0.4, t.base.z), edged(PV.rock), { bevel: 0.12 });
  b.cylinder(t.radius, t.radius, t.height, 10, trs(t.base.x, t.base.y, t.base.z), bands, { rings: 7 });
  const top = s.top;
  const cx = (top.min.x + top.max.x) / 2;
  const cz = (top.min.z + top.max.z) / 2;
  const w = top.max.x - top.min.x;
  const d = top.max.z - top.min.z;
  const thick = top.max.y - top.min.y;
  // Cap ring where the landmark shell ends, just below the deck.
  b.cylinder(2.35, 2.2, 0.45, 16, trs(t.base.x, top.min.y - 0.45, t.base.z), edged(PV.wood), { bevel: 0.06 });
  // Deck: planks along z over a beam frame, all inside the collider box.
  const plankT = 0.12;
  const planks = 7;
  for (let i = 0; i < planks; i++) {
    const x = top.min.x + ((i + 0.5) * w) / planks;
    const shade = 0.9 + 0.2 * hash3(i, top.max.y, 3);
    b.boxAt(x, top.max.y - plankT, cz, w / planks - 0.03, plankT, d - 0.02, edged(tint(PV.wood, shade)), 0, 0.025);
  }
  const frameH = thick - plankT;
  for (const sz of [-1, 1]) b.boxAt(cx, top.min.y, cz + sz * (d / 2 - 0.12), w, frameH, 0.24, edged(0x7a5434), 0, 0.03);
  for (const sx of [-1, 1]) b.boxAt(cx + sx * (w / 2 - 0.12), top.min.y, cz, 0.24, frameH, d - 0.48, edged(0x7a5434), 0, 0.03);
  for (const fx of [-0.18, 0.18]) b.boxAt(cx + fx * w, top.min.y, cz, 0.2, frameH, d - 0.48, 0x6a4a30, 0, 0.03);
  // Corner posts and a lantern on one of them.
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.boxAt(cx + sx * (w / 2 - 0.12), top.max.y, cz + sz * (d / 2 - 0.12), 0.14, 1.05, 0.14, edged(0x6a4a30), 0, 0.02);
  const lx = cx + (w / 2 - 0.12);
  const lz = cz - (d / 2 - 0.12);
  b.boxAt(lx, top.max.y + 1.05, lz, 0.28, 0.3, 0.28, 0xffe2a0, 0, 0.03);
  b.boxAt(lx, top.max.y + 1.35, lz, 0.36, 0.08, 0.36, edged(0x3a3634), 0, 0.02);
  return b.build('prefab:windmill');
}

// ── Elderbough base ────────────────────────────────────────────────────────

/**
 * Round the old tree's foot (trunk centre `trunk`, landmarks.ts): root arches, moss stones, shrine stones and mushroom
 * clusters on the west and north sides, off the glide landing (south-east) and the Hollowroot path (east). World space.
 */
export function elderboughBase(trunk: { readonly x: number; readonly z: number }, heightAt: (x: number, z: number) => number): THREE.BufferGeometry {
  const b = new PartBuilder();
  const ground = (x: number, z: number): number => {
    const h = heightAt(x, z);
    return Number.isFinite(h) ? h : 0;
  };
  const at = (bearing: number, r: number): { x: number; z: number } => ({ x: trunk.x + Math.cos(bearing) * r, z: trunk.z + Math.sin(bearing) * r });
  // Angles (rad, from +x toward +z): west ≈ π, north ≈ −π/2.
  const arches: [number, number, number][] = [[Math.PI * 0.92, 9.5, 2.2], [Math.PI * 1.18, 10.5, 1.8], [Math.PI * 1.42, 9, 2.5]];
  for (const [a, r, hgt] of arches) {
    // A root rising out of the ground and diving back in: five bent segments along a half arc.
    const p0 = at(a - 0.16, r);
    const p1 = at(a + 0.16, r + 1.2);
    const seg = 6;
    let prev: THREE.Vector3 | null = null;
    for (let k = 0; k <= seg; k++) {
      const u = k / seg;
      const x = p0.x + (p1.x - p0.x) * u;
      const z = p0.z + (p1.z - p0.z) * u;
      const y = ground(x, z) - 0.3 + Math.sin(u * Math.PI) * hgt;
      const cur = new THREE.Vector3(x, y, z);
      if (prev !== null) {
        const dir = cur.clone().sub(prev);
        const len = dir.length();
        const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
        const m = new THREE.Matrix4().compose(prev, q, new THREE.Vector3(1, 1, 1));
        const rr = 0.45 - 0.12 * Math.abs(u - 0.5);
        b.cylinder(rr, rr * 0.92, len + 0.12, 7, m, edged(PV.bark, 0x6f8a44), { noise: 0.05, seed: k + a });
      }
      prev = cur;
    }
  }
  const stones: [number, number, number][] = [[Math.PI * 0.85, 12, 0.8], [Math.PI * 1.02, 13.5, 0.6], [Math.PI * 1.3, 12.5, 0.9], [Math.PI * 1.55, 11.5, 0.7], [Math.PI * 1.1, 8, 0.5], [Math.PI * 1.62, 13, 0.55]];
  const moss: ColorSpec = (_c, n) => (n.y > 0.45 ? 0x6f9a44 : PV.rock);
  stones.forEach(([a, r, s], i) => {
    const p = at(a, r);
    b.blob(s, trs(p.x, ground(p.x, p.z) + s * 0.35, p.z, 0, i, 0, 1.2, 0.7, 1), moss, 0.2, i * 1.7);
  });
  // Shrine stones: short carved pillars with caps on the north side.
  for (let k = 0; k < 5; k++) {
    const p = at(Math.PI * 1.25 + k * 0.12, 15 + (k % 2));
    const y = ground(p.x, p.z);
    b.cylinder(0.32, 0.26, 0.9, 6, trs(p.x, y - 0.1, p.z, 0, k, 0), edged(PV.stone), { bevel: 0.05 });
    b.boxAt(p.x, y + 0.8, p.z, 0.5, 0.14, 0.5, edged(tint(PV.stone, 0.9)), k * 0.4, 0.04);
  }
  // Mushroom clusters.
  const clusters: [number, number][] = [[Math.PI * 0.97, 8.2], [Math.PI * 1.36, 8.4], [Math.PI * 1.5, 10.8]];
  clusters.forEach(([a, r], ci) => {
    for (let k = 0; k < 4; k++) {
      const p = at(a + (k - 1.5) * 0.05, r + (k % 2) * 0.6);
      const y = ground(p.x, p.z);
      const h = 0.25 + 0.2 * hash3(ci, k, 1);
      b.cylinder(0.05, 0.04, h, 5, trs(p.x, y - 0.02, p.z), 0xf0e6cc);
      b.blob(0.14 + 0.06 * hash3(k, ci, 2), trs(p.x, y + h, p.z, 0, 0, 0, 1, 0.45, 1), k % 2 === 0 ? 0xf2e2b0 : 0xe8c8a0, 0.1, ci + k, 0);
    }
  });
  return b.build('prefab:elderboughBase');
}

// ── Challenge_Area pieces (shrine, spire, observatory) ─────────────────────

interface LookStyle {
  readonly color: number;
  /** Top band painted differently, `depth` m of the piece's height (inside the shape). */
  readonly cap?: { readonly color: number; readonly depth: number };
  /** Glowing looks draw in their own emissive mesh. */
  readonly glow?: { readonly emissive: number; readonly intensity: number };
}

/** Styles of the opaque static looks; the rest (doors, cages, barriers, the oculus) keep their own views. */
export const AREA_LOOK_STYLES: Partial<Readonly<Record<AreaLook, LookStyle>>> = {
  rootWall: { color: 0x4a3526, cap: { color: 0x5f8a3c, depth: 0.35 } },
  canopy: { color: 0x2c3f28, cap: { color: 0x4f7a34, depth: 0.25 }, glow: { emissive: 0x0d2a14, intensity: 0.4 } },
  spireRock: { color: PE.rockDark, cap: { color: 0x4a3a34, depth: 0.3 } },
  spireCrystal: { color: 0xd9743a, glow: { emissive: 0xff8a3d, intensity: 0.35 } },
  hotCrystal: { color: 0x8a2a18, glow: { emissive: 0xff4a1a, intensity: 0.6 } },
  crystalStep: { color: 0xb8653a, cap: { color: 0xe08a4a, depth: 0.08 } },
  summitFloor: { color: 0x3a3230, cap: { color: 0x5a4238, depth: 0.1 } },
  obsStone: { color: PA.stone, cap: { color: 0xd4d2e4, depth: 0.25 } },
  obsFloor: { color: 0xd6d8e6, cap: { color: 0xe6e8f4, depth: 0.06 } },
  obsStep: { color: 0xdcdcea, cap: { color: 0xeeeef8, depth: 0.05 } },
  obsParapet: { color: 0xc9cbe0, cap: { color: 0xe9c46a, depth: 0.08 } },
  obsDrum: { color: 0xe2e2ee, cap: { color: PA.accent, depth: 0.2 } },
  telescope: { color: 0x8a8fa8, cap: { color: 0xc9a94e, depth: 0.15 } },
};

/** A shape's solid in the kit: chamfered box or bevelled cylinder, exactly the collider, with an optional top band. */
export function shapePiece(b: PartBuilder, shape: AreaShape, color: number, cap?: { readonly color: number; readonly depth: number }): void {
  if (shape.kind === 'obb') {
    const { center: c, half: h } = shape;
    const bevel = Math.min(0.08, h.x * 0.3, h.y * 0.3, h.z * 0.3);
    const capD = cap !== undefined ? Math.min(cap.depth, h.y) : 0;
    const body = h.y * 2 - capD;
    if (body > 0.01) b.box(h.x * 2, body, h.z * 2, trs(c.x, c.y - h.y + body / 2, c.z, 0, shape.yaw, 0), edged(color), bevel);
    if (cap !== undefined && capD > 0.01) b.box(h.x * 2, capD, h.z * 2, trs(c.x, c.y + h.y - capD / 2, c.z, 0, shape.yaw, 0), edged(cap.color), Math.min(bevel, capD * 0.3));
  } else {
    const { base: p, radius: r, height } = shape;
    const sides = r > 12 ? 48 : r > 4 ? 28 : r > 1.5 ? 16 : 10;
    const bevel = Math.min(0.08, r * 0.2, height * 0.2);
    const capD = cap !== undefined ? Math.min(cap.depth, height) : 0;
    const body = height - capD;
    if (body > 0.01) b.cylinder(r, r, body, sides, trs(p.x, p.y, p.z), edged(color), { bevel });
    if (cap !== undefined && capD > 0.01) b.cylinder(r, r, capD, sides, trs(p.x, p.y + body, p.z), edged(cap.color), { bevel: Math.min(bevel, capD * 0.3) });
  }
}

export interface AreaPrefab {
  /** Every opaque, non-glowing piece in one geometry. */
  readonly body: THREE.BufferGeometry;
  /** One geometry per glowing look. */
  readonly glows: readonly { readonly look: AreaLook; readonly geometry: THREE.BufferGeometry; readonly emissive: number; readonly intensity: number }[];
  /** Piece ids left to the caller (looks without a style: transparent or animated). */
  readonly skipped: readonly string[];
}

function areaPrefab(def: ChallengeAreaDef, name: string): AreaPrefab {
  const body = new PartBuilder();
  const glow = new Map<AreaLook, PartBuilder>();
  const skipped: string[] = [];
  for (const piece of def.pieces) {
    const style = AREA_LOOK_STYLES[piece.look];
    if (style === undefined) {
      skipped.push(piece.id);
      continue;
    }
    let target = body;
    if (style.glow !== undefined) {
      target = glow.get(piece.look) ?? new PartBuilder();
      glow.set(piece.look, target);
    }
    shapePiece(target, piece.shape, style.color, style.cap);
  }
  return {
    body: body.build(`prefab:${name}`),
    glows: [...glow].map(([look, builder]) => {
      const g = AREA_LOOK_STYLES[look]?.glow ?? { emissive: 0, intensity: 0 };
      return { look, geometry: builder.build(`prefab:${name}:${look}`), emissive: g.emissive, intensity: g.intensity };
    }),
    skipped,
  };
}

/** Hollowroot Shrine: root walls with moss tops and the root canopy slabs. */
export const shrine = (def: ChallengeAreaDef): AreaPrefab => areaPrefab(def, 'shrine');
/** Cinderspire: charcoal spires, orange crystal tiers, steps and the summit floor. */
export const spire = (def: ChallengeAreaDef): AreaPrefab => areaPrefab(def, 'spire');
/** Starfall Observatory: white stone hall, floors, steps, parapets with gold lines, the dome drum and the telescope. */
export const observatory = (def: ChallengeAreaDef): AreaPrefab => areaPrefab(def, 'observatory');

// ── Broken Bridge ──────────────────────────────────────────────────────────

/** The plank collider (TEMP_PIECES bridge_plank): an oriented box along its local z. */
export interface BridgeShape {
  readonly center: { readonly x: number; readonly y: number; readonly z: number };
  readonly half: { readonly x: number; readonly y: number; readonly z: number };
  readonly yaw: number;
}

/** Planks on two stringers filling the collider, end posts and sagging rope rails (world space). */
export function brokenBridge(s: BridgeShape): THREE.BufferGeometry {
  const b = new PartBuilder();
  const frame = trs(s.center.x, s.center.y, s.center.z, 0, s.yaw, 0);
  const place = (m: THREE.Matrix4): THREE.Matrix4 => frame.clone().multiply(m);
  const topY = s.half.y;
  const len = s.half.z * 2;
  const w = s.half.x * 2;
  const plankT = 0.12;
  const count = Math.max(4, Math.round(len / 0.7));
  const step = len / count;
  for (let i = 0; i < count; i++) {
    const z = -s.half.z + (i + 0.5) * step;
    const repaired = hash3(i, 5, 1) > 0.88;
    const shade = repaired ? 1.25 : 0.82 + 0.26 * hash3(i, 2, 7);
    b.box(w - 0.04, plankT, step - 0.05, place(trs(0, topY - plankT / 2, z, 0, (hash3(i, 1, 1) - 0.5) * 0.03, 0)), edged(tint(PV.wood, shade)), 0.025);
  }
  const under = s.half.y * 2 - plankT;
  for (const sx of [-1, 1]) b.box(0.3, under, len, place(trs(sx * (s.half.x - 0.35), -s.half.y + under / 2, 0)), edged(0x6a4a30), 0.04);
  // End posts and rope rails sagging between them.
  const postH = 1.3;
  for (const sz of [-1, 1]) {
    for (const sx of [-1, 1]) {
      b.box(0.24, postH, 0.24, place(trs(sx * (s.half.x - 0.1), topY + postH / 2, sz * (s.half.z - 0.15))), edged(0x5a3c26), 0.04);
      b.box(0.3, 0.1, 0.3, place(trs(sx * (s.half.x - 0.1), topY + postH + 0.05, sz * (s.half.z - 0.15))), edged(0x4a3222), 0.03);
    }
  }
  const segments = 8;
  const rope = 0xc9b48e;
  for (const sx of [-1, 1]) {
    const x = sx * (s.half.x - 0.1);
    for (let k = 0; k < segments; k++) {
      const z0 = -s.half.z + 0.15 + ((len - 0.3) * k) / segments;
      const z1 = -s.half.z + 0.15 + ((len - 0.3) * (k + 1)) / segments;
      const sag = (u: number): number => topY + 1.05 - 0.45 * Math.sin(Math.PI * u);
      const y0 = sag(k / segments);
      const y1 = sag((k + 1) / segments);
      const segLen = Math.hypot(z1 - z0, y1 - y0);
      const pitch = Math.atan2(y1 - y0, z1 - z0);
      b.box(0.06, 0.06, segLen + 0.04, place(trs(x, (y0 + y1) / 2, (z0 + z1) / 2, -pitch, 0, 0)), rope, 0.015);
    }
  }
  return b.build('prefab:bridge');
}

// ── Astral Sanctum ─────────────────────────────────────────────────────────

const SANCTUM_LOOK_COLORS: Partial<Readonly<Record<SanctumLook, number>>> = {
  floor: PS.stone,
  step: 0xb9bddd,
  hallWall: 0x59618f,
  rim: 0x8f97c8,
  pedestal: PS.rock,
  waystone: 0x7d86b8,
};

export interface SanctumPrefab {
  /** Star-stone body of every opaque piece. */
  readonly body: THREE.BufferGeometry;
  /** Gold trims (drawn with a gold emissive material). */
  readonly trim: THREE.BufferGeometry;
  /** Piece ids left to the caller (the ward). */
  readonly skipped: readonly string[];
}

/** The Sanctum's floors, steps, walls, rim, pedestals and Waystone, each exactly its collider, with gold trims. */
export function sanctum(def: SanctumDef): SanctumPrefab {
  const body = new PartBuilder();
  const trim = new PartBuilder();
  const skipped: string[] = [];
  const gold = PS.accent;
  for (const piece of def.pieces) {
    const color = SANCTUM_LOOK_COLORS[piece.look];
    if (color === undefined) {
      skipped.push(piece.id);
      continue;
    }
    const shape = piece.shape;
    switch (piece.look) {
      case 'hallWall':
      case 'rim': {
        // Gold cap line in the top of the wall (inside the shape).
        shapePiece(body, shape, color, undefined);
        if (shape.kind === 'obb') {
          const { center: c, half: h } = shape;
          trim.box(h.x * 2 + 0.04, 0.12, h.z * 2 + 0.04, trs(c.x, c.y + h.y - 0.06, c.z, 0, shape.yaw, 0), gold, 0.02);
        }
        break;
      }
      case 'floor':
      case 'pedestal': {
        shapePiece(body, shape, color, undefined);
        if (shape.kind === 'cylinder') {
          const r = shape.radius;
          const sides = r > 12 ? 64 : r > 4 ? 28 : 12;
          trim.cylinder(r + 0.03, r + 0.03, 0.08, sides, trs(shape.base.x, shape.base.y + shape.height - 0.1, shape.base.z), gold, { open: true });
        }
        break;
      }
      default:
        shapePiece(body, shape, color, { color: tint(color, 1.12), depth: 0.06 });
    }
  }
  return { body: body.build('prefab:sanctum'), trim: trim.build('prefab:sanctum:trim'), skipped };
}
