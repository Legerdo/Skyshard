/*
 * Weapon shape generators (design.md "캐릭터 사양" 무기 형상, "Rigid skinning 병합" 무기). A weapon is a plain Mesh
 * (plus its outline Mesh) parented to a socket bone, so it follows the bone without skinning: 2 more draw calls. The
 * default and the unique Weapons are variants of one generator with other blade length / ornament / glow-line values.
 *
 * Socket-space convention (every socket's rest world rotation is identity, T-pose): a held weapon's grip is at the
 * origin and its main axis runs along +Z (the fist's grip axis with the palm down); the shield hangs on the forearm
 * with its face toward +Y (the back of the forearm) and its long axis along X. Vertex colours use the rig palette
 * zones; the Element glow line has `aFx.x` = 1, so it lights with the rig's `uGlow`.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { attachOutline } from '../render/outline';
import { normalizePart } from './rigKit';
import { box, lathe, taperedCapsule } from './rigGeometry';
import type { PaletteZone, PartDef, V3, WeaponBuild } from './rigTypes';

export type WeaponShape = 'curvedSword' | 'recurveBow' | 'crescentGlaive' | 'towerShield' | 'crystalGreatsword';

export interface WeaponParams {
  readonly shape: WeaponShape;
  /** Blade / limb / shield length multiplier (1 = the default Weapon). */
  readonly length?: number;
  /** Ornament size multiplier (guard, emblem). */
  readonly ornament?: number;
  /** Glow-line strength 0–1. */
  readonly glowLine?: number;
}

const STEEL = 0xdfe4ec;

type Palette = Readonly<Record<PaletteZone, number>>;

/** Merges weapon parts (same attribute layout as a rig, skin index unused) into one geometry. */
function mergeWeapon(parts: PartDef[], palette: Palette): THREE.BufferGeometry {
  const geometries = parts.map((p) => normalizePart(p, palette, () => 0));
  for (const p of parts) p.geometry.dispose();
  const merged = mergeGeometriesSafe(geometries);
  for (const g of geometries) g.dispose();
  merged.deleteAttribute('skinIndex');
  merged.deleteAttribute('skinWeight');
  merged.computeBoundingSphere();
  return merged;
}

function mergeGeometriesSafe(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(geometries);
  if (merged === null) throw new Error('weapons: parts could not be merged');
  return merged;
}

/** Shape extruded `depth` m with a small bevel, centred on its thickness. */
function extrude(shape: THREE.Shape, depth: number, bevel: number, curveSegments = 10): THREE.BufferGeometry {
  const g = new THREE.ExtrudeGeometry(shape, {
    depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 1, curveSegments, steps: 1,
  });
  g.translate(0, 0, -depth / 2);
  return g;
}

function curvedSword(p: WeaponParams): { parts: PartDef[]; tip: V3 } {
  const L = 0.78 * (p.length ?? 1);
  const orn = p.ornament ?? 1;
  const parts: PartDef[] = [];
  // Grip along −Z (the fist holds it at the origin), pommel cap.
  parts.push({ joint: 'root', zone: 'secondary', geometry: taperedCapsule([0, 0, -0.13], [0, 0, 0.06], 0.017, 0.016, 6, 2) });
  parts.push({ joint: 'root', zone: 'accent', geometry: taperedCapsule([0, 0, -0.15], [0, 0, -0.13], 0.022, 0.022, 6, 1) });
  // Guard (tsuba): a flattened disc at the blade root.
  const guard = lathe([[0, -0.008], [0.045 * orn, -0.008], [0.05 * orn, 0], [0.045 * orn, 0.008], [0, 0.008]], { segments: 12, scaleZ: 0.7 });
  guard.rotateX(Math.PI / 2);
  guard.translate(0, 0, 0.07);
  parts.push({ joint: 'root', zone: 'accent', geometry: guard });
  // Single-edged curved blade: the spine (top, +y) and edge arcs in shape space (x = along the blade).
  const s = new THREE.Shape();
  const curve = 0.07 * (p.length ?? 1);
  s.moveTo(0, 0.013);
  s.quadraticCurveTo(L * 0.55, 0.018 + curve, L, curve * 1.2 + 0.004);
  s.quadraticCurveTo(L * 0.96, curve * 0.9 - 0.012, L * 0.86, curve * 0.62 - 0.018);
  s.quadraticCurveTo(L * 0.5, -0.03 + curve * 0.3, 0, -0.016);
  s.closePath();
  const blade = extrude(s, 0.006, 0.002, 12);
  blade.rotateY(-Math.PI / 2); // shape x → +Z, extrusion → X
  blade.translate(0, 0, 0.078);
  parts.push({ joint: 'root', zone: 'primary', color: STEEL, geometry: blade });
  // Ember glow line along the spine.
  const line = new THREE.Shape();
  line.moveTo(0.02, 0.009);
  line.quadraticCurveTo(L * 0.55, 0.012 + curve, L * 0.9, curve * 1.05);
  line.lineTo(L * 0.9, curve * 1.05 - 0.006);
  line.quadraticCurveTo(L * 0.55, 0.004 + curve, 0.02, 0.002);
  line.closePath();
  const glow = extrude(line, 0.009, 0, 10);
  glow.rotateY(-Math.PI / 2);
  glow.translate(0, 0, 0.078);
  parts.push({ joint: 'root', zone: 'element', glow: p.glowLine ?? 0.8, geometry: glow });
  return { parts, tip: [0, curve * 1.2, 0.078 + L] };
}

/** The recurve's centre line (limbs along ±Z, belly toward +X, tips curling back toward −X). */
function bowCurve(L: number): THREE.CatmullRomCurve3 {
  const pts: V3[] = [
    [-0.1, 0, -L], [-0.14, 0, -L * 0.9], [-0.1, 0, -L * 0.62], [0.01, 0, -L * 0.25], [0.03, 0, 0],
    [0.01, 0, L * 0.25], [-0.1, 0, L * 0.62], [-0.14, 0, L * 0.9], [-0.1, 0, L],
  ];
  return new THREE.CatmullRomCurve3(pts.map((q) => new THREE.Vector3(...q)), false, 'centripetal');
}

function recurveBow(p: WeaponParams): { parts: PartDef[]; tip: V3; stringEnds: [V3, V3] } {
  const L = 0.72 * (p.length ?? 1);
  const parts: PartDef[] = [];
  const curve = bowCurve(L);
  parts.push({ joint: 'root', zone: 'accent', geometry: new THREE.TubeGeometry(curve, 28, 0.014, 5, false) });
  // Grip wrap and the Tide glow line along the belly of each limb.
  parts.push({ joint: 'root', zone: 'secondary', geometry: taperedCapsule([0.03, 0, -0.07], [0.03, 0, 0.07], 0.021, 0.021, 6, 2) });
  const limbLine = (s: 1 | -1): THREE.CatmullRomCurve3 => new THREE.CatmullRomCurve3([
    new THREE.Vector3(0.035, 0, s * 0.1), new THREE.Vector3(0.018, 0, s * L * 0.28), new THREE.Vector3(-0.08, 0, s * L * 0.6),
  ]);
  const glowTop = limbLine(1);
  const glowBottom = limbLine(-1);
  for (const c of [glowTop, glowBottom]) {
    parts.push({ joint: 'root', zone: 'element', glow: p.glowLine ?? 0.8, geometry: new THREE.TubeGeometry(c, 10, 0.006, 4, false) });
  }
  // Nocks: small balls at the tips.
  for (const z of [-L, L]) parts.push({ joint: 'root', zone: 'primary', geometry: taperedCapsule([-0.1, 0, z], [-0.1, 0, z], 0.012, 0.012, 5, 2) });
  return { parts, tip: [-0.1, 0, L], stringEnds: [[-0.1, 0, -L], [-0.1, 0, L]] };
}

function crescentGlaive(p: WeaponParams): { parts: PartDef[]; tip: V3 } {
  const k = p.length ?? 1;
  const parts: PartDef[] = [];
  const top = 0.95 * k;
  // Long shaft held at the origin, ferrule and collar.
  parts.push({ joint: 'root', zone: 'secondary', geometry: taperedCapsule([0, 0, -0.55 * k], [0, 0, top], 0.017, 0.016, 6, 2) });
  parts.push({ joint: 'root', zone: 'accent', geometry: taperedCapsule([0, 0, -0.6 * k], [0, 0, -0.52 * k], 0.022, 0.02, 6, 1) });
  parts.push({ joint: 'root', zone: 'accent', geometry: taperedCapsule([0, 0, top - 0.04], [0, 0, top + 0.02], 0.026, 0.024, 6, 1) });
  // Crescent blade from two arcs (outer r 0.3, inner r 0.23 shifted forward), horns pointing forward-up.
  const R = 0.3 * (p.ornament ?? 1);
  const s = new THREE.Shape();
  s.absarc(0, 0, R, -Math.PI * 0.62, Math.PI * 0.62, false);
  s.absarc(R * 0.32, 0, R * 0.78, Math.PI * 0.55, -Math.PI * 0.55, true);
  s.closePath();
  const blade = extrude(s, 0.008, 0.002, 14);
  // Shape x → +Z (forward from the shaft end), shape y → +Y, extrusion → X; the crescent's back sits on the shaft.
  blade.rotateY(-Math.PI / 2);
  blade.translate(0, 0, top + R * 0.62);
  parts.push({ joint: 'root', zone: 'primary', color: STEEL, geometry: blade });
  // Gale glow line on the inner edge.
  const g = new THREE.Shape();
  g.absarc(R * 0.32, 0, R * 0.8, -Math.PI * 0.5, Math.PI * 0.5, false);
  g.absarc(R * 0.32, 0, R * 0.74, Math.PI * 0.5, -Math.PI * 0.5, true);
  g.closePath();
  const glow = extrude(g, 0.011, 0, 12);
  glow.rotateY(-Math.PI / 2);
  glow.translate(0, 0, top + R * 0.62);
  parts.push({ joint: 'root', zone: 'element', glow: p.glowLine ?? 0.8, geometry: glow });
  return { parts, tip: [0, 0, top + R * 1.62] };
}

function towerShield(p: WeaponParams): { parts: PartDef[]; tip: V3 } {
  const k = p.length ?? 1;
  const orn = p.ornament ?? 1;
  const parts: PartDef[] = [];
  // Tall shield outline in (x = along the forearm, y = width), extruded toward +Y (its face) after rotation.
  const s = new THREE.Shape();
  const hx = 0.58 * k;
  const hy = 0.3 * k;
  s.moveTo(-hx, 0);
  s.lineTo(-hx * 0.72, hy);
  s.lineTo(hx * 0.8, hy);
  s.lineTo(hx, hy * 0.35);
  s.lineTo(hx, -hy * 0.35);
  s.lineTo(hx * 0.8, -hy);
  s.lineTo(-hx * 0.72, -hy);
  s.closePath();
  const face = extrude(s, 0.05, 0.012, 1);
  face.rotateX(-Math.PI / 2); // extrusion z → +Y, shape y → −Z
  face.translate(0, 0.1, 0);
  parts.push({ joint: 'root', zone: 'secondary', geometry: face });
  // Ochre rim trim just proud of the face.
  const rim = extrude(s, 0.012, 0, 1);
  rim.rotateX(-Math.PI / 2);
  rim.scale(1.04, 1, 1.06);
  rim.translate(0, 0.1 - 0.02, 0);
  parts.push({ joint: 'root', zone: 'primary', geometry: rim });
  // Hexagonal crystal emblem (the Terra icon) glowing in the Element colour, with a moss setting.
  const hex = new THREE.Shape();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
    const x = Math.cos(a) * 0.13 * orn;
    const y = Math.sin(a) * 0.13 * orn;
    if (i === 0) hex.moveTo(x, y);
    else hex.lineTo(x, y);
  }
  hex.closePath();
  const setting = extrude(hex, 0.02, 0.008, 1);
  setting.rotateX(-Math.PI / 2);
  setting.scale(1.35, 1, 1.35);
  setting.translate(0.05 * k, 0.14, 0);
  parts.push({ joint: 'root', zone: 'accent', geometry: setting });
  const crystal = extrude(hex, 0.035, 0.012, 1);
  crystal.rotateX(-Math.PI / 2);
  crystal.translate(0.05 * k, 0.16, 0);
  parts.push({ joint: 'root', zone: 'element', glow: p.glowLine ?? 1, geometry: crystal });
  // Arm strap block under the shield.
  parts.push({ joint: 'root', zone: 'accent', geometry: box([0, 0.06, 0], [0.12, 0.04, 0.16]) });
  return { parts, tip: [hx, 0.1, 0] };
}

/** Caelith's crystal greatsword (design "Caelith 구성"): long grip, star guard, a faceted crystal blade, a glow core. */
function crystalGreatsword(p: WeaponParams): { parts: PartDef[]; tip: V3 } {
  const L = 3.1 * (p.length ?? 1);
  const orn = p.ornament ?? 1;
  const parts: PartDef[] = [];
  parts.push({ joint: 'root', zone: 'primary', geometry: taperedCapsule([0, 0, -0.42], [0, 0, 0.1], 0.055, 0.05, 7, 2) });
  parts.push({ joint: 'root', zone: 'accent', geometry: taperedCapsule([0, 0, -0.5], [0, 0, -0.42], 0.09, 0.08, 7, 1) });
  // Star guard: four gold points round the blade root.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    parts.push({ joint: 'root', zone: 'accent', geometry: taperedCapsule([0, 0, 0.14], [Math.cos(a) * 0.34 * orn, Math.sin(a) * 0.34 * orn, 0.12], 0.05, 0.012, 5, 1) });
  }
  // Crystal blade: a long tapering hexagonal section, pale crystal with a glowing core.
  const s = new THREE.Shape();
  s.moveTo(0, 0.16);
  s.lineTo(L * 0.82, 0.12);
  s.lineTo(L, 0);
  s.lineTo(L * 0.82, -0.12);
  s.lineTo(0, -0.16);
  s.closePath();
  const blade = extrude(s, 0.07, 0.03, 1);
  blade.rotateY(-Math.PI / 2);
  blade.translate(0, 0, 0.16);
  parts.push({ joint: 'root', zone: 'secondary', geometry: blade });
  const core = new THREE.Shape();
  core.moveTo(0.05, 0.035);
  core.lineTo(L * 0.8, 0.02);
  core.lineTo(L * 0.92, 0);
  core.lineTo(L * 0.8, -0.02);
  core.lineTo(0.05, -0.035);
  core.closePath();
  const glow = extrude(core, 0.11, 0, 1);
  glow.rotateY(-Math.PI / 2);
  glow.translate(0, 0, 0.16);
  parts.push({ joint: 'root', zone: 'element', glow: p.glowLine ?? 1, geometry: glow });
  return { parts, tip: [0, 0, 0.16 + L] };
}

/** Back-socket placement of each shape (climb, glide, swim). */
const BACK: Readonly<Record<WeaponShape, { rot: THREE.Euler; offset: THREE.Vector3 }>> = {
  crystalGreatsword: { rot: new THREE.Euler(Math.PI / 2, 0, 0.3, 'ZYX'), offset: new THREE.Vector3(0.3, 0.2, -0.1) },
  curvedSword: { rot: new THREE.Euler(Math.PI / 2, 0, 0.6, 'ZYX'), offset: new THREE.Vector3(0.12, 0.1, -0.02) },
  recurveBow: { rot: new THREE.Euler(Math.PI / 2, Math.PI / 2, -0.5, 'ZYX'), offset: new THREE.Vector3(0, 0, -0.04) },
  crescentGlaive: { rot: new THREE.Euler(-Math.PI / 2, 0, 0.35, 'ZYX'), offset: new THREE.Vector3(0, -0.15, -0.02) },
  towerShield: { rot: new THREE.Euler(-Math.PI / 2, 0, Math.PI / 2, 'ZYX'), offset: new THREE.Vector3(0, -0.05, -0.02) },
};

/**
 * Builds a weapon drawn with `material` (the owning rig's toon instance: the glow line follows its `uGlow`) and the
 * rig's `palette`. The recurve bow adds its string (a Line child whose middle point follows the drawing hand).
 */
export function createWeapon(params: WeaponParams, palette: Palette, material: THREE.Material): WeaponBuild {
  const built = params.shape === 'curvedSword' ? curvedSword(params)
    : params.shape === 'recurveBow' ? recurveBow(params)
    : params.shape === 'crescentGlaive' ? crescentGlaive(params)
    : params.shape === 'crystalGreatsword' ? crystalGreatsword(params)
    : towerShield(params);
  const geometry = mergeWeapon(built.parts, palette);
  geometry.name = `weapon:${params.shape}`;
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = `weapon:${params.shape}`;
  mesh.castShadow = true;
  const outline = attachOutline(mesh, 'weapon');
  const base = new THREE.Vector3(0, 0, params.shape === 'towerShield' ? 0 : params.shape === 'crystalGreatsword' ? 0.2 : 0.08);
  const tip = new THREE.Vector3(...built.tip);
  let stringLine: THREE.Line | null = null;
  let restMid: THREE.Vector3 | null = null;
  if ('stringEnds' in built) {
    const [a, b] = built.stringEnds as [V3, V3];
    restMid = new THREE.Vector3((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
    const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...a), restMid.clone(), new THREE.Vector3(...b)]);
    stringLine = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xf2efe6 }));
    stringLine.name = 'bowString';
    stringLine.frustumCulled = false;
    mesh.add(stringLine);
  }
  const local = new THREE.Vector3();
  const back = BACK[params.shape];
  return {
    mesh,
    outline,
    anchors: { base, tip },
    backRotation: back.rot.clone(),
    backOffset: back.offset.clone(),
    update(drawPoint) {
      if (stringLine === null || restMid === null) return;
      const attr = stringLine.geometry.getAttribute('position') as THREE.BufferAttribute;
      if (drawPoint === null) local.copy(restMid);
      else {
        mesh.updateMatrixWorld(true);
        local.copy(drawPoint);
        mesh.worldToLocal(local);
      }
      attr.setXYZ(1, local.x, local.y, local.z);
      attr.needsUpdate = true;
    },
    dispose() {
      geometry.dispose();
      if (stringLine !== null) {
        stringLine.geometry.dispose();
        (stringLine.material as THREE.Material).dispose();
      }
      mesh.clear();
    },
  };
}
