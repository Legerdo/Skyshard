/*
 * Caelith, the fallen star's guardian (design.md "Caelith 구성", Req 40.4): a ≈ 6 m humanoid star knight of the rig kit.
 * - Body: the lathe torso under hexagonal crystal plates (extruded hexagon Shapes) on chest, back, shoulders, forearms,
 *   thighs and shins; glowing crack strips between the plates (`aFx.x`, so `uGlow` 0 in Phases 1–2 leaves dark gold
 *   lines and the Final Phase's 1 lights them); an armoured skirt; a visored helm under a star crown.
 * - Crystal greatsword on `weaponR` (rightHand), a weapon Mesh + outline (./weapons `crystalGreatsword`).
 * - Starlight cape: six ribbon strips hanging from the chest, each on its own 5-joint spring chain, merged into one
 *   separate SkinnedMesh on the same Skeleton with the drifting-star cape material (caelithCapeGeometry).
 * - The halo (8 shards on a 1.8 m ring round the head, an InstancedMesh) and the Starshell (./shellMaterial) are added by
 *   the Caelith view, which updates them per frame. Draw calls: body 2 + cape 1 + halo 1 + sword 2 + Starshell 1 = 7.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { humanoidBase } from './humanoidParts';
import { cone, crystal, hexPlate, v3add, v3lerp } from './modelParts';
import { normalizePart } from './rigKit';
import { box, ellipsoid, flipped, lathe, ribbon, ring } from './rigGeometry';
import { chainJoint } from './rigLayout';
import type { PaletteZone, PartDef, RigLayout, RigSpec, SpringDef, V3 } from './rigTypes';
import type { WeaponParams } from './weapons';

export const CAELITH_HEIGHT = 6;
/** Halo shards and their ring radius round the head (m). */
export const CAELITH_HALO = { count: 8, radius: 1.8 } as const;
/** Cape ribbons, each a 5-joint spring chain. */
export const CAELITH_CAPE = { strips: 6, segments: 5, segLength: 0.5, width: 0.27 } as const;
export const CAELITH_SWORD: WeaponParams = { shape: 'crystalGreatsword', length: 1, glowLine: 1 };
/** Dark gold of the crack lines while `uGlow` is 0. */
const CRACK_COLOR = 0x8a6a2a;

const PALETTE: Readonly<Record<PaletteZone, number>> = {
  primary: 0x26345e, secondary: 0xcfd6ff, accent: 0xe9c46a, skin: 0x33427a, hair: 0x141a3a, element: 0xfff0a0,
};

/** Joint names of cape strip `i`. */
export const capeChainId = (i: number): string => `cape${i}`;

function capeSprings(): SpringDef[] {
  const out: SpringDef[] = [];
  for (let i = 0; i < CAELITH_CAPE.strips; i++) {
    const x = (i - (CAELITH_CAPE.strips - 1) / 2) * 0.24;
    out.push({
      id: capeChainId(i), parent: 'chest', segments: CAELITH_CAPE.segments, segLength: CAELITH_CAPE.segLength,
      offset: [x, 0.6, -0.5 - Math.abs(x) * 0.1], dir: [x * 0.12, -1, -0.12], stiffness: 0.05, drag: 2, gravity: 1,
    });
  }
  return out;
}

function caelithParts(layout: RigLayout): PartDef[] {
  const H = layout.height;
  const base = humanoidBase(layout, {
    limb: 1.25, torsoWidth: 1.15, torsoDepth: 0.78, hipWidth: 1.1, torsoZone: 'primary', sleeveZone: 'primary',
    forearmZone: 'primary', handZone: 'skin', legZone: 'primary', bootZone: 'skin', jaw: 0.15,
  });
  const parts = base.parts.filter((p) => p.face !== true);
  const plate = (joint: string, c: V3, n: V3, size: number, stretch: readonly [number, number] = [1, 1]): void => {
    parts.push({ joint, zone: 'secondary', geometry: hexPlate(c, n, size, 0.06, stretch) });
  };
  const crack = (joint: string, c: V3, s: V3): void => {
    parts.push({ joint, zone: 'element', glow: 1, color: CRACK_COLOR, geometry: box(c, s) });
  };
  const chest = layout.pos('chest');
  const spine = layout.pos('spine');
  const hipsY = layout.pos('hips')[1];
  const cy = chest[1];
  // Chest, flank, abdomen and back plates with the cracks between them.
  plate('chest', [0, cy + 0.22, 0.5], [0, 0.15, 1], 0.32, [1.1, 1]);
  for (const s of [1, -1]) {
    plate('chest', [s * 0.4, cy + 0.02, 0.4], [s * 0.6, 0, 1], 0.24);
    plate('chest', [s * 0.26, cy + 0.2, -0.46], [s * 0.2, 0.1, -1], 0.3);
    crack('chest', [s * 0.25, cy + 0.08, 0.5], [0.03, 0.46, 0.03]);
    crack('chest', [s * 0.02, cy + 0.2, -0.5], [0.03, 0.5, 0.03]);
  }
  plate('spine', [0, spine[1] + 0.05, 0.44], [0, 0, 1], 0.24, [1.2, 0.9]);
  crack('spine', [0, spine[1] + 0.27, 0.46], [0.5, 0.03, 0.03]);
  crack('chest', [0, cy - 0.16, 0.5], [0.55, 0.03, 0.03]);
  // Armoured skirt (open at the front) with a gold belt.
  const skirtProfile: [number, number][] = [[0.13 * H, 0.4 * H], [0.11 * H, hipsY - 0.02 * H], [0.085 * H, spine[1] + 0.01 * H]];
  const skirtOpts = { segments: 16, scaleZ: 0.8, phiStart: 0.3, phiLength: Math.PI * 2 - 0.6 };
  parts.push({ joint: 'hips', zone: 'primary', geometry: lathe(skirtProfile, skirtOpts) });
  parts.push({ joint: 'hips', zone: 'hair', geometry: flipped(lathe(skirtProfile.map(([r, y]) => [r * 0.97, y] as [number, number]), skirtOpts)) });
  parts.push({ joint: 'spine', zone: 'accent', geometry: ring([0, spine[1] - 0.05, 0], 0.085 * H * 1.15, 0.035, 5, 18, 0, 1, 0.8) });
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2 + 0.5;
    crack('hips', [Math.sin(a) * 0.12 * H, 0.46 * H, Math.cos(a) * 0.1 * H], [0.03, 0.4, 0.03]);
  }
  // Pauldrons, forearm and leg plates.
  for (const [side, s] of [['left', 1], ['right', -1]] as const) {
    const up = layout.pos(`${side}UpperArm`);
    const low = layout.pos(`${side}LowerArm`);
    const hand = layout.pos(`${side}Hand`);
    plate(`${side}UpperArm`, v3add(up, [s * 0.1, 0.24, 0]), [s * 0.5, 1, 0], 0.32);
    plate(`${side}UpperArm`, v3add(up, [s * 0.32, 0.12, 0.05]), [s * 1, 0.6, 0.2], 0.2);
    parts.push({ joint: `${side}UpperArm`, zone: 'secondary', geometry: crystal(v3add(up, [s * 0.05, 0.42, -0.05]), [s * 0.4, 1, -0.2], 0.5, 0.18) });
    crack(`${side}UpperArm`, v3add(up, [s * 0.22, 0.2, 0]), [0.03, 0.03, 0.4]);
    plate(`${side}LowerArm`, v3add(v3lerp(low, hand, 0.45), [0, 0.12, 0]), [0, 1, 0.2], 0.2, [1.8, 1]);
    crack(`${side}LowerArm`, v3add(v3lerp(low, hand, 0.45), [0, 0.13, 0.14]), [0.5, 0.03, 0.03]);
    const ul = layout.pos(`${side}UpperLeg`);
    const ll = layout.pos(`${side}LowerLeg`);
    const ft = layout.pos(`${side}Foot`);
    plate(`${side}UpperLeg`, v3add(v3lerp(ul, ll, 0.5), [0, 0, 0.2]), [0, 0, 1], 0.2, [1, 1.7]);
    plate(`${side}LowerLeg`, v3add(v3lerp(ll, ft, 0.45), [0, 0, 0.16]), [0, 0.1, 1], 0.17, [1, 1.9]);
    crack(`${side}LowerLeg`, v3add(ll, [0, -0.04, 0.2]), [0.3, 0.03, 0.03]);
  }
  // Visored helm and the star crown.
  const c = base.head.center;
  const r = base.head.radius;
  parts.push({ joint: 'head', zone: 'hair', geometry: ellipsoid(v3add(c, [0, -r * 0.05, r * 0.72]), [r * 0.78, r * 0.36, r * 0.38], 12, 7) });
  for (const s of [1, -1]) {
    parts.push({ joint: 'head', zone: 'secondary', color: 0xeaf6ff, geometry: box(v3add(c, [s * r * 0.3, 0, r * 1.02]), [r * 0.3, r * 0.06, r * 0.05]) });
    parts.push({ joint: 'head', zone: 'primary', geometry: cone(v3add(c, [s * r * 0.85, r * 0.1, -r * 0.1]), v3add(c, [s * r * 1.35, r * 0.5, -r * 0.5]), r * 0.18, 5) });
  }
  const crownY = c[1] + r * 0.82;
  parts.push({ joint: 'head', zone: 'accent', geometry: ring([c[0], crownY, c[2]], r * 0.86, r * 0.09, 5, 18) });
  for (let k = 0; k < 7; k++) {
    const a = (k / 7) * Math.PI * 2;
    const at: V3 = [c[0] + Math.sin(a) * r * 0.86, crownY, c[2] + Math.cos(a) * r * 0.86];
    const h = (k === 0 ? 0.62 : k % 2 === 0 ? 0.42 : 0.3) * r * 1.6;
    parts.push({ joint: 'head', zone: 'accent', geometry: cone(at, v3add(at, [Math.sin(a) * r * 0.2, h, Math.cos(a) * r * 0.2]), r * 0.12, 4) });
  }
  parts.push({ joint: 'head', zone: 'element', glow: 0.6, geometry: crystal([c[0], crownY + r * 0.95, c[2] + r * 0.72], [0, 1, 0.1], r * 0.7, r * 0.34) });
  return parts;
}

/** Caelith's RigSpec (own material instance; `uGlow` 0 until the Final Phase). */
export function caelithRigSpec(): RigSpec {
  return {
    id: 'caelith',
    preset: 'humanoid',
    height: CAELITH_HEIGHT,
    headRatio: 7.5,
    shoulderScale: 1.2,
    parts: caelithParts,
    palette: PALETTE,
    springs: capeSprings(),
    material: 'character',
    idleGlow: 0,
  };
}

/**
 * The starlight cape: six ribbons along their spring chains (skinned across each chain's joints), merged into one
 * geometry for the separate cape SkinnedMesh. `jointIndex` maps a joint name to its Skeleton bone index.
 */
export function caelithCapeGeometry(layout: RigLayout, jointIndex: (name: string) => number): THREE.BufferGeometry {
  const pieces: THREE.BufferGeometry[] = [];
  for (let i = 0; i < CAELITH_CAPE.strips; i++) {
    const id = capeChainId(i);
    const chain = layout.chains.get(id);
    if (chain === undefined) throw new Error(`caelithRig: missing cape chain ${id}`);
    const pts = chain.points;
    const edge = i === 0 || i === CAELITH_CAPE.strips - 1;
    const strip: PartDef = { joint: 'chest', chain: id, zone: 'hair', color: edge ? 0x222c5c : 0x141a3a, geometry: ribbon(pts, [1, 0, 0], CAELITH_CAPE.width, 0.85, 0.03) };
    pieces.push(normalizePart(strip, PALETTE, jointIndex, chain));
    // A pale gold hem at the tip of each strip.
    const hem: PartDef = { joint: 'chest', chain: id, zone: 'accent', geometry: ribbon(pts.slice(pts.length - 2), [1, 0, 0], CAELITH_CAPE.width * 0.86, 0.9, 0.034) };
    pieces.push(normalizePart(hem, PALETTE, jointIndex, chain));
  }
  const merged = mergeGeometries(pieces, false);
  for (const g of pieces) g.dispose();
  if (merged === null) throw new Error('caelithRig: cape could not be merged');
  merged.name = 'rig:caelith:cape';
  merged.computeBoundingSphere();
  return merged;
}

/** One halo shard (an elongated crystal, pointing outward along +Y). */
export function haloShardGeometry(): THREE.BufferGeometry {
  const g = new THREE.OctahedronGeometry(1, 0);
  g.scale(0.16, 0.5, 0.16);
  return g;
}

/** First joint of cape strip `i` (tests). */
export const capeRootJoint = (i: number): string => chainJoint(capeChainId(i), 0);
