// TEMPORARY Challenge_Area visuals (tasks 9.6–9.8) until the environment art tasks (18–19). Read-only: mirrors the
// ChallengeAreaSystem and the Talus pillars and never changes them.
// - Pieces (task 18.4: the shrine / spire / observatory prefabs, src/render/prefabs/keyLocations.ts): root walls
//   (dark bark, moss tops) and the root canopy slabs; Cinderspire's charcoal spires, orange crystal tiers and ramp
//   steps, the red-hot block and the summit floor; the Observatory's white stone hall, roof, parapets with gold lines,
//   steps, dome drum and telescope; merged per area (one mesh + one per glowing look); the oculus stays translucent.
// - Heat_Crystal walls: red-hot while hot, blue while cooled, flashing orange in their last 2 s (Req 13.8).
// - Risers: the exit stairs and vent ledges rise from below into place (staggered) once they stand.
// - Fall judgement floors marked `embers` or `starfall`: a faint glowing disc (or box) on the floor.
// - Doors: a bramble thicket, a root door, rubble and root gates, the ring corridor's starlight barriers, the star cage
//   and the balcony gate, shown while closed; each fades out over 0.4 s when it opens (the solid box is already gone).
// - Ceiling constellations (the Observatory's hall): faint white stars that glow in turn in the colour of their step's
//   Element, repeating the puzzle's order; all of them steady once it is solved.
// - Checkpoint runes: a 2 m disc on the floor, dim until lit, bright green for the area's latest checkpoint.
// - Root lifts: a disc and a faint column while the lift runs.
// - Glowing roots and lighting (Req 12.4): green point lights and small emissive root knots at the area's light
//   spots; while the Active_Character is inside, the scene fog and background fade to the area's green fog over 1 s
//   (the outdoor values come back the same way).
// - Talus's stone pillars: stone cylinders that sink in their last 0.5 s.
// Task 18.4 (draw-call budget): apart from the prefab bodies, glows and lights, each area's parts hide beyond 160 m of
// the area (distanceCull.ts), and its static stand-ins and root knots draw merged per material.

import * as THREE from 'three';
import type { AreaLighting, AreaLook, AreaShape, ChallengeAreaDef } from '../data/challengeAreas';
import { CHALLENGE_AREA_DEFS, CHECKPOINT_RADIUS } from '../data/challengeAreas';
import { TEMP_LIFT_PAD_RADIUS } from '../data/tempRoute';
import { ELEMENT_DEFS } from '../data/elements';
import type { AreaDoorView, AreaLift, CheckpointView, ConstellationView, HeatWallView, RiserView } from '../world/challengeArea';
import type { PillarView } from '../world/talusPillars';
import { cullChildren, mergeStaticMeshes, worldBoundsOf } from './distanceCull'; // task 18.4
import { prefabMesh } from './prefabs/kit'; // task 18.4
import { observatory as observatoryPrefab, shrine as shrinePrefab, spire as spirePrefab } from './prefabs/keyLocations'; // task 18.4
import { sharedMaterialVariant } from './toonMaterial'; // task 18.4

const LOOK: Readonly<Record<AreaLook, { color: number; emissive: number; intensity: number; opacity: number }>> = {
  rootWall: { color: 0x3b2c21, emissive: 0x000000, intensity: 0, opacity: 1 },
  canopy: { color: 0x243124, emissive: 0x0d2a14, intensity: 0.4, opacity: 1 },
  bramble: { color: 0x4d5a2a, emissive: 0xff7a45, intensity: 0.25, opacity: 0.92 },
  rootDoor: { color: 0x5a3f2a, emissive: 0x9dff8a, intensity: 0.15, opacity: 1 },
  rubble: { color: 0x8a8272, emissive: 0xd9a441, intensity: 0.2, opacity: 1 },
  rootGate: { color: 0x4a3526, emissive: 0x9dff8a, intensity: 0.2, opacity: 1 },
  // Cinderspire: charcoal rock, orange glowing crystal (Req 12.4); the hot block glows the common non-climbable red.
  spireRock: { color: 0x2f2a28, emissive: 0x3a1408, intensity: 0.25, opacity: 1 },
  spireCrystal: { color: 0xd9743a, emissive: 0xff8a3d, intensity: 0.35, opacity: 1 },
  hotCrystal: { color: 0x8a2a18, emissive: 0xff4a1a, intensity: 0.6, opacity: 1 },
  crystalStep: { color: 0xb8653a, emissive: 0xff8a3d, intensity: 0.2, opacity: 1 },
  summitFloor: { color: 0x3a3230, emissive: 0xff6a2a, intensity: 0.15, opacity: 1 },
  crystalCage: { color: 0xffb070, emissive: 0xff8a3d, intensity: 0.6, opacity: 0.7 },
  ventLedge: { color: 0x3a302c, emissive: 0xff8a3d, intensity: 0.3, opacity: 1 },
  exitStair: { color: 0xf0a060, emissive: 0xff9a4a, intensity: 0.5, opacity: 0.95 },
  // Starfall Observatory: white stone, cold blue light, violet starlight (Req 12.4).
  obsStone: { color: 0xe8e6f0, emissive: 0x1a2240, intensity: 0.2, opacity: 1 },
  obsFloor: { color: 0xd6d8e6, emissive: 0x28306a, intensity: 0.15, opacity: 1 },
  obsStep: { color: 0xdcdcea, emissive: 0x3a4a9a, intensity: 0.15, opacity: 1 },
  obsParapet: { color: 0xc9cbe0, emissive: 0x1a2240, intensity: 0.2, opacity: 1 },
  obsDrum: { color: 0xe2e2ee, emissive: 0x2a2f60, intensity: 0.2, opacity: 1 },
  obsOculus: { color: 0x7f8fe0, emissive: 0xb9a8ff, intensity: 0.6, opacity: 0.85 },
  telescope: { color: 0x8a8fa8, emissive: 0x9fb8ff, intensity: 0.25, opacity: 1 },
  starBarrier: { color: 0xb9a8ff, emissive: 0xc3b4ff, intensity: 0.9, opacity: 0.45 },
  starCage: { color: 0xd8ccff, emissive: 0xc3b4ff, intensity: 0.7, opacity: 0.6 },
  balconyGate: { color: 0xcfd2e6, emissive: 0x9fb8ff, intensity: 0.3, opacity: 1 },
};
/** Heat_Crystal wall colours: hot (the non-climbable glow), cooled (blue), and the orange of its last-2 s flash. */
const HEAT_HOT = 0xff4a1a;
const HEAT_COOL = 0x9fd8ff;
const HEAT_WARN = 0xff9a2a;
/** A riser rises from this far below its place over RISER_RISE_SECONDS (after its delay). */
const RISER_DROP = 6;
const RISER_RISE_SECONDS = 0.8;
const EMBER_COLOR = 0xff6a2a;
/** The Observatory courtyard's pool of fallen starlight. */
const STARFALL_COLOR = 0xb9a8ff;
/** A ceiling constellation out of its turn: faint white stars. */
const STAR_IDLE_COLOR = 0x9aa0c8;
const RUNE_COLOR = 0x9dff8a;
const LIFT_COLOR = 0xd9a441;
const PILLAR_COLOR = 0xa89a7c;
/** Fog blend time (s, design "구조물과 실내 공간": 1 s). */
const FOG_BLEND_SECONDS = 1;
/** Door fade after opening (s). */
const DOOR_FADE_SECONDS = 0.4;
/** A pillar sinks during its last this many seconds. */
const PILLAR_SINK_SECONDS = 0.5;
/** Glowing-root point light at full interior blend (physically based units, as the scene's other lights). */
const LIGHT_INTENSITY = 40;

/** What the view reads each frame. */
export interface ChallengeAreaViewSource {
  readonly lifts: readonly AreaLift[];
  readonly current: ChallengeAreaDef | null;
  doorViews(): AreaDoorView[];
  checkpointViews(): CheckpointView[];
  heatWallViews(): HeatWallView[];
  riserViews(): RiserView[];
  constellationViews(): ConstellationView[];
  liftRuns(def: AreaLift['def']): boolean;
}

interface DoorHandle {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.MeshLambertMaterial;
  readonly baseOpacity: number;
  fade: number;
}

interface RiserHandle {
  readonly mesh: THREE.Mesh;
  readonly home: number;
  readonly delay: number;
  /** Seconds since it started rising; null while down. */
  since: number | null;
}

export class TempChallengeAreaView {
  readonly object = new THREE.Group();
  private readonly source: ChallengeAreaViewSource;
  private readonly pillarSource: { views(): PillarView[] };
  private readonly scene: THREE.Scene | null;
  private readonly disposables: { dispose(): void }[] = [];
  private readonly doors = new Map<string, DoorHandle>();
  private readonly heatWalls = new Map<string, THREE.MeshLambertMaterial>();
  private readonly risers = new Map<string, RiserHandle>();
  private readonly runes = new Map<string, THREE.MeshBasicMaterial>();
  private readonly constellations = new Map<string, THREE.MeshBasicMaterial>();
  private readonly liftGroups: { group: THREE.Group; lift: AreaLift }[] = [];
  private readonly pillarGroup = new THREE.Group();
  private readonly pillarMeshes: THREE.Mesh[] = [];
  private readonly pillarGeometry: THREE.CylinderGeometry;
  private readonly pillarMaterial: THREE.MeshLambertMaterial;
  private readonly lights = new Map<string, { light: THREE.PointLight; spots: AreaLighting['lights'] }>();
  /** 0 outdoors … 1 inside the area, eased over FOG_BLEND_SECONDS. */
  private interior = 0;
  private outdoor: { color: THREE.Color; near: number; far: number; background: THREE.Color | null } | null = null;
  private interiorLook: AreaLighting | null = null;
  /** The area whose look the blend fades toward (the last one entered). */
  private interiorArea: string | null = null;
  private readonly fogScratch = new THREE.Color();

  constructor(source: ChallengeAreaViewSource, pillars: { views(): PillarView[] }, scene: THREE.Scene | null = null, defs = CHALLENGE_AREA_DEFS) {
    this.source = source;
    this.pillarSource = pillars;
    this.scene = scene;
    this.object.name = 'tempChallengeAreas';
    const materials = new Map<AreaLook, THREE.MeshLambertMaterial>();
    const lookMaterial = (look: AreaLook): THREE.MeshLambertMaterial => {
      let m = materials.get(look);
      if (m === undefined) {
        const l = LOOK[look];
        m = this.track(new THREE.MeshLambertMaterial({
          color: l.color, emissive: l.emissive, emissiveIntensity: l.intensity, flatShading: true,
          transparent: l.opacity < 1, opacity: l.opacity,
        }));
        materials.set(look, m);
      }
      return m;
    };
    // Task 18.4: the prefab bodies and glows stay drawn at any distance; the rest is culled per area (cullDetails).
    const structures: { id: string; body: THREE.Mesh }[] = [];
    const kept = new Set<THREE.Object3D>();
    for (const def of defs) {
      // Task 18.4: the Hollowroot Shrine / Cinderspire / Starfall Observatory prefab over the static pieces (each piece
      // exactly its collider), one merged mesh plus one per glowing look; unstyled looks stay flat-shaded stand-ins.
      const prefab = def.id === 'hollowroot' ? shrinePrefab(def) : def.id === 'cinderspire' ? spirePrefab(def) : observatoryPrefab(def);
      const body = prefabMesh(this.track(prefab.body), `area:${def.id}:prefab`);
      this.object.add(body);
      structures.push({ id: def.id, body });
      for (const glow of prefab.glows) {
        const material = this.track(sharedMaterialVariant('crystal', { emissive: glow.emissive, emissiveIntensity: glow.intensity }));
        const mesh = prefabMesh(this.track(glow.geometry), `area:${def.id}:${glow.look}`, true, material);
        this.object.add(mesh);
        kept.add(mesh);
      }
      const skipped = new Set(prefab.skipped);
      for (const piece of def.pieces) {
        if (skipped.has(piece.id)) this.object.add(this.shapeMesh(piece.shape, lookMaterial(piece.look), `area:${piece.id}`));
      }
      this.addLights(def);
      this.addEmberFloors(def);
    }
    for (const view of source.heatWallViews()) {
      const material = this.track(new THREE.MeshLambertMaterial({ color: HEAT_HOT, emissive: HEAT_HOT, emissiveIntensity: 0.6, flatShading: true }));
      this.object.add(this.shapeMesh(view.def.shape, material, `heatWall:${view.def.id}`));
      this.heatWalls.set(view.def.id, material);
    }
    for (const view of source.riserViews()) {
      const mesh = this.shapeMesh(view.def.shape, lookMaterial(view.def.look), `riser:${view.def.id}`);
      mesh.visible = view.up;
      this.object.add(mesh);
      // A riser standing already (a load after the Skyshard) shows in place from the start.
      this.risers.set(view.def.id, { mesh, home: mesh.position.y, delay: view.def.delay, since: view.up ? Number.POSITIVE_INFINITY : null });
    }
    for (const view of source.doorViews()) {
      const l = LOOK[view.def.look];
      const material = this.track(new THREE.MeshLambertMaterial({
        color: l.color, emissive: l.emissive, emissiveIntensity: l.intensity, flatShading: true, transparent: true, opacity: l.opacity,
      }));
      const mesh = this.shapeMesh(view.def.shape, material, `door:${view.def.id}`);
      this.object.add(mesh);
      this.doors.set(view.def.id, { mesh, material, baseOpacity: l.opacity, fade: view.open ? 0 : 1 });
    }
    for (const view of source.checkpointViews()) this.addRune(view);
    for (const view of source.constellationViews()) this.addConstellation(view);
    for (const lift of source.lifts) this.addLift(lift);
    this.cullDetails(structures, kept);
    this.pillarGeometry = this.track(new THREE.CylinderGeometry(1, 1, 1, 10));
    this.pillarMaterial = this.track(new THREE.MeshLambertMaterial({ color: PILLAR_COLOR, flatShading: true }));
    this.pillarGroup.name = 'talusPillars';
    this.object.add(this.pillarGroup);
  }

  /**
   * Mirrors doors, runes, lifts and pillars; `time` (s) pulses the glow, `dt` (s) eases the doors and the fog, `focus`
   * (the Active_Character's feet) places the area light.
   */
  update(time: number, dt: number, focus: Readonly<{ x: number; y: number; z: number }> | null = null): void {
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    for (const view of this.source.doorViews()) {
      const h = this.doors.get(view.def.id);
      if (h === undefined) continue;
      h.fade = view.open ? Math.max(0, h.fade - step / DOOR_FADE_SECONDS) : 1;
      h.mesh.visible = h.fade > 0;
      h.material.opacity = h.baseOpacity * h.fade;
    }
    for (const view of this.source.checkpointViews()) {
      const m = this.runes.get(view.def.id);
      if (m === undefined) continue;
      m.opacity = view.latest ? 0.75 + 0.15 * Math.sin(time * 3) : view.lit ? 0.35 : 0.08;
    }
    for (const view of this.source.heatWallViews()) {
      const m = this.heatWalls.get(view.def.id);
      if (m === undefined) continue;
      // The last 2 s of cooling flash orange at 4 Hz (design H1), else blue while cooled and red-hot while hot.
      const flash = view.warning && Math.sin(time * Math.PI * 8) > 0;
      const hex = !view.cooled ? HEAT_HOT : flash ? HEAT_WARN : HEAT_COOL;
      m.color.setHex(hex);
      m.emissive.setHex(view.cooled && !flash ? 0x3a78a8 : hex);
      m.emissiveIntensity = !view.cooled ? 0.6 : flash ? 0.9 : 0.3;
    }
    for (const view of this.source.riserViews()) {
      const h = this.risers.get(view.def.id);
      if (h === undefined) continue;
      if (!view.up) {
        h.since = null;
        h.mesh.visible = false;
        continue;
      }
      h.since = (h.since ?? 0) + step;
      const t = Math.min(1, Math.max(0, (h.since - h.delay) / RISER_RISE_SECONDS));
      const ease = t * t * (3 - 2 * t);
      h.mesh.visible = t > 0;
      h.mesh.position.y = h.home - RISER_DROP * (1 - ease);
    }
    for (const { group, lift } of this.liftGroups) group.visible = this.source.liftRuns(lift.def);
    for (const view of this.source.constellationViews()) {
      const m = this.constellations.get(view.def.id);
      if (m === undefined) continue;
      // Its turn in the order: its step's Element colour, bright; out of turn: faint white; solved: all steady.
      m.color.setHex(view.lit && view.element !== null ? ELEMENT_DEFS[view.element].color : STAR_IDLE_COLOR);
      m.opacity = view.lit ? (view.solved ? 0.8 : 0.95) : 0.3 + 0.05 * Math.sin(time * 2);
    }
    this.syncPillars();
    this.blendFog(step);
    this.placeLights(focus);
  }

  dispose(): void {
    this.restoreFog();
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.object.clear();
  }

  private track<T extends { dispose(): void }>(resource: T): T {
    this.disposables.push(resource);
    return resource;
  }

  /**
   * Task 18.4 (draw-call budget): every child but the prefab bodies, glows and lights goes into its nearest area's
   * distance-culled group (shown within 160 m of that group's bounds). The static stand-ins sharing a material merge
   * into one mesh first.
   */
  private cullDetails(structures: readonly { id: string; body: THREE.Mesh }[], kept: ReadonlySet<THREE.Object3D>): void {
    if (structures.length === 0) return;
    const centers = structures.map((s) => {
      s.body.geometry.computeBoundingSphere();
      return { id: s.id, c: (s.body.geometry.boundingSphere as THREE.Sphere).center };
    });
    const perArea = new Map<string, THREE.Object3D[]>();
    const lifts = new Set<THREE.Object3D>(this.liftGroups.map((l) => l.group));
    const risers = new Set<THREE.Object3D>([...this.risers.values()].map((r) => r.mesh));
    const doors = new Set<THREE.Object3D>([...this.doors.values()].map((d) => d.mesh));
    const stills = new Map<string, Map<THREE.Material, THREE.Mesh[]>>();
    for (const child of [...this.object.children]) {
      if (kept.has(child) || structures.some((s) => s.body === child) || child instanceof THREE.Light) continue;
      const { center } = worldBoundsOf(child);
      let best = centers[0] as { id: string; c: THREE.Vector3 };
      for (const c of centers) if (c.c.distanceToSquared(center) < best.c.distanceToSquared(center)) best = c;
      // Plain static stand-ins (no own material, never moved or toggled) merge per area and material.
      if (child instanceof THREE.Mesh && !Array.isArray(child.material) && child.name.startsWith('area:') && !lifts.has(child) && !risers.has(child) && !doors.has(child)) {
        let byMaterial = stills.get(best.id);
        if (byMaterial === undefined) stills.set(best.id, (byMaterial = new Map()));
        const list = byMaterial.get(child.material) ?? [];
        list.push(child);
        byMaterial.set(child.material, list);
        continue;
      }
      let list = perArea.get(best.id);
      if (list === undefined) perArea.set(best.id, (list = []));
      list.push(child);
    }
    for (const [id, byMaterial] of stills) {
      let list = perArea.get(id);
      if (list === undefined) perArea.set(id, (list = []));
      for (const [material, meshes] of byMaterial) {
        const merged = mergeStaticMeshes(meshes, material, `area:${id}:standIns`);
        for (const m of meshes) m.removeFromParent();
        if (merged === null) {
          list.push(...meshes);
          continue;
        }
        this.track(merged.geometry);
        merged.castShadow = true;
        merged.receiveShadow = true;
        list.push(merged);
      }
    }
    for (const [id, list] of perArea) cullChildren(this.object, list, `areaDetail:${id}`);
  }

  private shapeMesh(shape: AreaShape, material: THREE.Material, name: string): THREE.Mesh {
    let mesh: THREE.Mesh;
    if (shape.kind === 'obb') {
      mesh = new THREE.Mesh(this.track(new THREE.BoxGeometry(shape.half.x * 2, shape.half.y * 2, shape.half.z * 2)), material);
      mesh.position.set(shape.center.x, shape.center.y, shape.center.z);
      mesh.rotation.y = shape.yaw;
    } else {
      mesh = new THREE.Mesh(this.track(new THREE.CylinderGeometry(shape.radius, shape.radius, shape.height, 40)), material);
      mesh.position.set(shape.base.x, shape.base.y + shape.height / 2, shape.base.z);
    }
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  /**
   * Glowing root knots at each light spot of the area, and one green point light that sits on the spot nearest the
   * Active_Character (a single light keeps the shader cost flat outside too; its intensity follows the fog blend).
   */
  private addLights(def: ChallengeAreaDef): void {
    const group = new THREE.Group();
    group.name = `areaLights:${def.id}`;
    const knot = this.track(new THREE.IcosahedronGeometry(0.35, 0));
    const glow = this.track(new THREE.MeshBasicMaterial({ color: def.lighting.glow }));
    const light = new THREE.PointLight(def.lighting.glow, 0, 26, 1.4);
    light.name = `areaLight:${def.id}`;
    // Task 18.4: the light stays outside the distance-culled knots (a light leaving the scene would recompile every
    // lit material).
    this.object.add(light);
    this.lights.set(def.id, { light, spots: def.lighting.lights });
    const knots: THREE.Mesh[] = [];
    def.lighting.lights.forEach((p, i) => {
      for (let k = 0; k < 3; k++) {
        const a = i * 1.7 + k * 2.1;
        const mesh = new THREE.Mesh(knot, glow);
        mesh.position.set(p.x + Math.cos(a) * 1.2, p.y + 0.4 * k, p.z + Math.sin(a) * 1.2);
        mesh.scale.setScalar(0.6 + 0.3 * k);
        knots.push(mesh);
      }
    });
    // Task 18.4: the static knots of an area as one mesh (one draw call instead of three per light spot).
    const merged = mergeStaticMeshes(knots, glow, `areaKnots:${def.id}`);
    if (merged !== null) {
      this.track(merged.geometry);
      group.add(merged);
    } else if (knots.length > 0) {
      group.add(...knots);
    }
    this.object.add(group);
  }

  /**
   * A faint glow on each marked fall judgement floor: embers (Cinderspire, between the spires) or fallen starlight (the
   * Observatory's courtyard below the dome stairs), a disc or the hazard's box.
   */
  private addEmberFloors(def: ChallengeAreaDef): void {
    for (const h of def.hazards) {
      if (h.look !== 'embers' && h.look !== 'starfall') continue;
      const material = this.track(new THREE.MeshBasicMaterial({
        color: h.look === 'embers' ? EMBER_COLOR : STARFALL_COLOR, transparent: true, opacity: h.look === 'embers' ? 0.18 : 0.28,
        depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      }));
      const geometry = h.box === undefined
        ? new THREE.CircleGeometry(h.radius, 40)
        : new THREE.PlaneGeometry(h.box.halfX * 2, h.box.halfZ * 2);
      const floor = new THREE.Mesh(this.track(geometry), material);
      floor.rotation.x = -Math.PI / 2;
      // About the floor under the band: the canyon floor (the ember band reaches ≈ 4 m above it), the courtyard's y 130.
      floor.position.set(h.center.x, h.look === 'embers' ? h.maxY - 3.9 : h.maxY - 1.35, h.center.z);
      floor.name = `${h.look}:${h.id}`;
      this.object.add(floor);
    }
  }

  /** A ceiling constellation: small star points under the ceiling, their colour set every frame. */
  private addConstellation(view: ConstellationView): void {
    const material = this.track(new THREE.MeshBasicMaterial({ color: STAR_IDLE_COLOR, transparent: true, opacity: 0.35, depthWrite: false }));
    const star = this.track(new THREE.OctahedronGeometry(0.14, 0));
    const group = new THREE.Group();
    group.name = `constellation:${view.def.id}`;
    const { center, stars } = view.def;
    group.position.set(center.x, center.y, center.z);
    for (const s of stars) {
      const mesh = new THREE.Mesh(star, material);
      mesh.position.set(s.x, 0, s.z);
      group.add(mesh);
    }
    this.object.add(group);
    this.constellations.set(view.def.id, material);
  }

  /** Each area's point light on its spot nearest `focus`, as bright as the interior blend. */
  private placeLights(focus: Readonly<{ x: number; y: number; z: number }> | null): void {
    for (const [id, { light, spots }] of this.lights) {
      light.intensity = this.interiorArea === id ? LIGHT_INTENSITY * this.interior : 0;
      if (focus === null || light.intensity <= 0) continue;
      let best = spots[0];
      let bestD = Infinity;
      for (const s of spots) {
        const d = (s.x - focus.x) ** 2 + (s.y - focus.y) ** 2 + (s.z - focus.z) ** 2;
        if (d < bestD) {
          bestD = d;
          best = s;
        }
      }
      if (best !== undefined) light.position.set(best.x, best.y, best.z);
    }
  }

  private addRune(view: CheckpointView): void {
    const material = this.track(new THREE.MeshBasicMaterial({
      color: RUNE_COLOR, transparent: true, opacity: 0.1, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    }));
    const ring = new THREE.Mesh(this.track(new THREE.RingGeometry(CHECKPOINT_RADIUS * 0.55, CHECKPOINT_RADIUS, 32)), material);
    ring.rotation.x = -Math.PI / 2;
    const { pos } = view.def.spot;
    ring.position.set(pos.x, pos.y + 0.05, pos.z);
    ring.name = `rune:${view.def.id}`;
    this.object.add(ring);
    this.runes.set(view.def.id, material);
  }

  private addLift(lift: AreaLift): void {
    const group = new THREE.Group();
    group.name = `lift:${lift.def.id}`;
    group.position.set(lift.pad.x, lift.pad.y, lift.pad.z);
    const disc = new THREE.Mesh(
      this.track(new THREE.CylinderGeometry(TEMP_LIFT_PAD_RADIUS, TEMP_LIFT_PAD_RADIUS, 0.12, 20)),
      this.track(new THREE.MeshLambertMaterial({ color: 0x5a3f2a, emissive: LIFT_COLOR, emissiveIntensity: 0.5 })),
    );
    disc.position.y = 0.06;
    const column = new THREE.Mesh(
      this.track(new THREE.CylinderGeometry(TEMP_LIFT_PAD_RADIUS * 0.8, TEMP_LIFT_PAD_RADIUS, 3, 16, 1, true)),
      this.track(new THREE.MeshBasicMaterial({
        color: LIFT_COLOR, transparent: true, opacity: 0.15, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      })),
    );
    column.position.y = 1.5;
    group.add(disc, column);
    this.object.add(group);
    this.liftGroups.push({ group, lift });
  }

  private syncPillars(): void {
    const views = this.pillarSource.views();
    while (this.pillarMeshes.length < views.length) {
      const mesh = new THREE.Mesh(this.pillarGeometry, this.pillarMaterial);
      mesh.castShadow = true;
      this.pillarMeshes.push(mesh);
      this.pillarGroup.add(mesh);
    }
    this.pillarMeshes.forEach((mesh, i) => {
      const v = views[i];
      mesh.visible = v !== undefined;
      if (v === undefined) return;
      const sink = Math.min(1, v.remaining / PILLAR_SINK_SECONDS);
      mesh.scale.set(v.radius, v.height, v.radius);
      mesh.position.set(v.pos.x, v.pos.y + v.height * (sink - 0.5), v.pos.z);
    });
  }

  /** Eases the scene fog toward the current area's look while inside, and back outside. */
  private blendFog(dt: number): void {
    const current = this.source.current;
    if (current !== null) {
      this.interiorLook = current.lighting;
      this.interiorArea = current.id;
    }
    const target = current === null ? 0 : 1;
    const delta = dt / FOG_BLEND_SECONDS;
    this.interior = target > this.interior ? Math.min(target, this.interior + delta) : Math.max(target, this.interior - delta);
    const scene = this.scene;
    if (scene === null || !(scene.fog instanceof THREE.Fog)) return;
    if (this.outdoor === null) {
      this.outdoor = {
        color: scene.fog.color.clone(), near: scene.fog.near, far: scene.fog.far,
        background: scene.background instanceof THREE.Color ? scene.background.clone() : null,
      };
    }
    const look = this.interiorLook;
    if (look === null) return;
    const t = this.interior * this.interior * (3 - 2 * this.interior);
    const out = this.outdoor;
    const inside = this.fogScratch.set(look.fogColor);
    scene.fog.color.copy(out.color).lerp(inside, t);
    scene.fog.near = out.near + (look.fogNear - out.near) * t;
    scene.fog.far = out.far + (look.fogFar - out.far) * t;
    if (out.background !== null && scene.background instanceof THREE.Color) scene.background.copy(out.background).lerp(inside, t);
  }

  private restoreFog(): void {
    const scene = this.scene;
    const out = this.outdoor;
    if (scene === null || out === null || !(scene.fog instanceof THREE.Fog)) return;
    scene.fog.color.copy(out.color);
    scene.fog.near = out.near;
    scene.fog.far = out.far;
    if (out.background !== null && scene.background instanceof THREE.Color) scene.background.copy(out.background);
  }
}
