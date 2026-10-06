// TEMPORARY Thistlewick and NPC visuals until the art tasks (tasks 13.1–13.3; Req 14.1, 14.2, 14.8, 14.9, 15.3): flat
// toon boxes, cones and cylinders over the village layout (src/data/village.ts) and the solid bodies of
// src/world/village.ts, capsule NPCs that mirror the NpcSystem, and the progress look recomputed from GameState every
// frame (VillageSystem.look), so a loaded save shows the same village at once:
// - the stone plaza with the Hearth fire, Elder Maren's two-storey house, the other houses, Pip's stall (a makeshift
//   crate stand at Skyshard 0–1, awning and shelves from 2), Old Bram's Echo Altar, the well, the watchtower, Hobb's
//   field, the camp_durga forge and anvil and the camp_oriel telescope;
// - street lanterns (out at 0, lit from 1), bunting (1), garlands on the doors and flower beds in bloom (2, wilted
//   before), star lanterns over the plaza (3), the dawn festival's tents after the ending while the Blight patches
//   round the village are gone;
// - Side_Quest world changes: the kite over the village (sq_tamsin), flowers in the field (sq_hobb), the forge glowing
//   with chimney smoke (sq_durga), and sq_tamsin's kite on the windmill blade tip while it still hangs there;
// - task 18.4: the houses are the Thistlewick house prefab (src/render/prefabs/keyLocations.ts); after building, every
//   static part (bevelled / displaced by the prefab kit on the way) and the small props (barrels, crates, cart, fence,
//   woodpile) merge into one mesh per 64 m chunk, each toggled group into one mesh, and the street lamps into one mesh;
// - NPCs (task 19.3 models, task 19.4 clips): each NPC's procedural rig from the VisualLibrary (the companions before
//   they join: their hero rigs) at the NpcSystem's position and facing, playing the clip of its animation state
//   (`selectNpcAnim`: idle, walk, work, lookAround…, `idle` while talking, the mouth moving through the face atlas),
//   breathing and turning its head toward the player within 8 m; a companion that joined is hidden, and (task 18.4)
//   every rig hides beyond NPC_CULL_DISTANCE of the camera.
// Read-only: the view never changes the simulation.

import * as THREE from 'three';
import { selectNpcAnim } from '../anim/animState';
import { heroClips, NPC_CLIPS } from '../anim/clips';
import type { Vec3 } from '../core/types';
import type { Speaker } from '../data/dialogue';
import { isCharacterId } from '../data/ids';
import { AnimatedView, humanoidProcedural } from '../visual/animatedView';
import type { EntityView } from '../visual/entityView';
import { defaultVisualLibrary, type VisualLibrary } from '../visual/visualLibrary';
import { KITE_POS } from '../data/sideQuests';
import {
  BLIGHT_PATCHES, DURGA_CAMP_PROPS, FESTIVAL_TENTS, FLOWER_BEDS, HEARTH_POS, HOBB_FIELD, ORIEL_CAMP_PROPS, PLAZA_RADIUS,
  STAR_LANTERNS, STREET_LANTERNS, VILLAGE_CENTER, VILLAGE_KITE, WATCHTOWER_POST_RADIUS, type VillageBuildingDef,
} from '../data/village';
import type { XZ } from '../data/worldLayout';
import type { VillageLook } from '../logic/village';
import type { KiteState } from '../world/sideQuests';
import type { NpcView } from '../world/npcSystem';
import type { PlacedBuilding } from '../world/village';
import { createToonMaterial } from './toonMaterial';
import { PartBuilder, prefabMaterial, prefabMesh } from './prefabs/kit'; // task 18.4
import { thistlewickHouse } from './prefabs/keyLocations'; // task 18.4
import { bakeMesh, ChunkBatcher } from './props/propBatcher'; // task 18.4
import { addVillageProps } from './props/villageProps'; // task 18.4
import { distanceCulled } from './distanceCull'; // task 18.4

/** What the view reads from the play session (PlaySim satisfies it through its systems). */
export interface VillageViewSource {
  readonly village: { readonly buildings: readonly PlacedBuilding[]; look(): VillageLook };
  readonly npcs: { views(): readonly NpcView[] };
  readonly sideQuests: { kiteState(): KiteState };
  heightAt(x: number, z: number): number;
  /** The Active_Character's feet (NPCs look at the player within 8 m); omitted: no look-at. */
  player?(): Readonly<Vec3> | null;
  /** Model library (default the page's VisualLibrary). */
  readonly library?: VisualLibrary;
}

/** One NPC's rig and its clip player. */
interface NpcVisual {
  readonly view: EntityView;
  readonly anim: AnimatedView;
  readonly last: THREE.Vector3;
  hasLast: boolean;
  talking: boolean;
}

/** NPC chains sway in a light breeze (m/s, world). */
const NPC_BREEZE = { x: 0.5, y: 0, z: 0.3 };
/** Head height above the feet the player is looked at (m). */
const LOOK_HEIGHT = 1.5;
/**
 * Task 18.4 (draw-call budget): an NPC rig (2–4 draw calls) hides beyond this distance (m) of the camera from where it
 * started (its home; NPCs keep to the village or their camp), a few pixels tall by then.
 */
export const NPC_CULL_DISTANCE = 220;

/** Toggled groups of the progress look, exposed for tests. */
export interface VillageLookParts {
  readonly lanternLamps: readonly THREE.Mesh[];
  readonly bunting: THREE.Group;
  readonly garlands: THREE.Group;
  readonly bedsWilted: THREE.Group;
  readonly bedsBloom: THREE.Group;
  readonly stallMakeshift: THREE.Group;
  readonly stallRestored: THREE.Group;
  readonly starLanterns: THREE.Group;
  readonly festival: THREE.Group;
  readonly blight: THREE.Group;
  readonly villageKite: THREE.Group;
  readonly windmillKite: THREE.Group;
  readonly fieldFlowers: THREE.Group;
  readonly forgeGlow: THREE.Mesh;
  readonly smoke: THREE.Group;
}

export class TempVillageView {
  readonly object = new THREE.Group();
  readonly parts: VillageLookParts;
  private readonly source: VillageViewSource;
  private readonly disposables: { dispose(): void }[] = [];
  private readonly materials = new Map<number, THREE.MeshToonMaterial>();
  private readonly npcMeshes = new Map<Speaker, NpcVisual>();
  private readonly library: VisualLibrary;
  private lastTime: number | null = null;
  private readonly lampOn: THREE.MeshToonMaterial;
  private readonly lampOff: THREE.MeshToonMaterial;
  private readonly forgeOn: THREE.MeshToonMaterial;
  private readonly forgeOff: THREE.MeshToonMaterial;
  private readonly box: THREE.BoxGeometry;
  private readonly cylinder: THREE.CylinderGeometry;
  private readonly cone4: THREE.ConeGeometry;
  private readonly cone: THREE.ConeGeometry;
  private readonly sphere: THREE.SphereGeometry;
  private readonly smokeMaterial: THREE.MeshBasicMaterial;

  constructor(source: VillageViewSource) {
    this.source = source;
    this.library = source.library ?? defaultVisualLibrary();
    this.object.name = 'tempVillage';
    this.box = this.track(new THREE.BoxGeometry(1, 1, 1));
    this.cylinder = this.track(new THREE.CylinderGeometry(1, 1, 1, 16));
    this.cone4 = this.track(new THREE.ConeGeometry(1, 1, 4));
    this.cone = this.track(new THREE.ConeGeometry(1, 1, 12));
    this.sphere = this.track(new THREE.SphereGeometry(1, 10, 8));
    this.lampOn = this.track(createToonMaterial({ color: 0xffe2a0, vertexColors: false, emissive: 0xffc860, emissiveIntensity: 0.9 }));
    this.lampOff = this.track(createToonMaterial({ color: 0x4a4a52, vertexColors: false }));
    this.forgeOn = this.track(createToonMaterial({ color: 0xff8a3a, vertexColors: false, emissive: 0xff6a1a, emissiveIntensity: 1 }));
    this.forgeOff = this.track(createToonMaterial({ color: 0x3a3634, vertexColors: false }));
    this.smokeMaterial = this.track(new THREE.MeshBasicMaterial({ color: 0xb8b8c0, transparent: true, opacity: 0.45, depthWrite: false }));

    this.addPlaza();
    const garlands = this.group('garlands');
    const stallMakeshift = this.group('stallMakeshift');
    const stallRestored = this.group('stallRestored');
    for (const b of source.village.buildings) this.addBuilding(b, garlands, stallMakeshift, stallRestored);
    this.addField();
    const lamps = STREET_LANTERNS.map((p) => this.addLantern(p));
    const bunting = this.addBunting();
    const { wilted, bloom } = this.addFlowerBeds();
    const starLanterns = this.addStarLanterns();
    const festival = this.addFestival();
    const blight = this.addBlight();
    const villageKite = this.addVillageKite();
    const windmillKite = this.kiteMesh('windmillKite', 0.6);
    windmillKite.position.set(KITE_POS.x, KITE_POS.y + 1.1, KITE_POS.z);
    windmillKite.rotation.z = 0.5;
    const fieldFlowers = this.addFieldFlowers();
    const { glow, smoke } = this.addCamps();
    // Task 18.4: every static part merged per 64 m chunk with the small props (≈ 1 draw call per chunk), each toggled
    // group into one mesh, and the street lamps into one mesh whose material turns on and off.
    const kite = villageKite.children[0] ?? villageKite;
    const toggled = [garlands, wilted, bloom, stallMakeshift, stallRestored, bunting, festival, blight, fieldFlowers, kite, windmillKite];
    // Small props only receive shadows (design "그림자": casters are characters and large structures).
    const small = new Set<THREE.Object3D>([garlands, wilted, bloom, bunting, blight, fieldFlowers, kite, windmillKite]);
    this.object.updateMatrixWorld(true);
    const lanternLamps = [this.mergeLamps(lamps)];
    for (const g of toggled) this.mergeGroup(g, !small.has(g));
    this.bakeStatic(new Set<THREE.Object3D>([...toggled, villageKite, starLanterns, smoke]));
    for (const npc of source.npcs.views()) this.addNpc(npc.id, npc.pos);
    this.parts = {
      lanternLamps, bunting, garlands, bedsWilted: wilted, bedsBloom: bloom, stallMakeshift, stallRestored, starLanterns, festival,
      blight, villageKite, windmillKite, fieldFlowers, forgeGlow: glow, smoke,
    };
    this.update(0);
  }

  /** The NPC's drawn group (tests), or undefined. */
  npcObject(id: Speaker): THREE.Group | undefined {
    return this.npcMeshes.get(id)?.view.object;
  }

  /** The NPC's model view and clip player (tests), or undefined. */
  npcVisual(id: Speaker): { readonly view: EntityView; readonly anim: AnimatedView } | undefined {
    return this.npcMeshes.get(id);
  }

  /**
   * Mirrors the village look and the NPCs; `time` (s, real) drives the ambient motion, `dt` (default the change of
   * `time`) the NPC clips.
   */
  update(time: number, dt?: number): void {
    const step = dt ?? (this.lastTime === null ? 0 : Math.max(0, Math.min(0.25, time - this.lastTime)));
    this.lastTime = time;
    const look = this.source.village.look();
    const p = this.parts;
    for (const lamp of p.lanternLamps) lamp.material = look.streetLanternsLit ? this.lampOn : this.lampOff;
    p.bunting.visible = look.bunting;
    p.garlands.visible = look.garlands;
    p.bedsBloom.visible = look.flowerBedsBloom;
    p.bedsWilted.visible = !look.flowerBedsBloom;
    p.stallRestored.visible = look.stall === 'restored';
    p.stallMakeshift.visible = look.stall === 'makeshift';
    p.starLanterns.visible = look.starLanterns;
    p.festival.visible = look.festival;
    p.blight.visible = look.blightTraces;
    p.villageKite.visible = look.kite;
    p.fieldFlowers.visible = look.fieldFlowers;
    p.forgeGlow.material = look.forgeLit ? this.forgeOn : this.forgeOff;
    p.smoke.visible = look.forgeLit;
    p.windmillKite.visible = this.source.sideQuests.kiteState() === 'hanging';
    if (look.starLanterns) {
      p.starLanterns.children.forEach((c, i) => {
        c.position.y = STAR_LANTERNS.height + 0.25 * Math.sin(time * 1.3 + i);
        c.rotation.y = time * 0.7 + i;
      });
    }
    if (look.kite) {
      const kite = p.villageKite.children[0];
      if (kite !== undefined) {
        kite.position.x = 2.5 * Math.sin(time * 0.4);
        kite.rotation.z = 0.3 * Math.sin(time * 0.9);
      }
    }
    if (look.forgeLit) {
      p.smoke.children.forEach((c, i) => {
        const t = (time * 0.35 + i / p.smoke.children.length) % 1;
        c.position.y = 6 + t * 7;
        c.scale.setScalar(0.5 + t * 1.2);
      });
    }
    p.windmillKite.rotation.z = 0.5 + 0.08 * Math.sin(time * 2.2);
    const player = this.source.player?.() ?? null;
    for (const npc of this.source.npcs.views()) this.poseNpc(npc, step, player);
  }

  dispose(): void {
    for (const v of this.npcMeshes.values()) {
      v.anim.dispose();
      v.view.dispose();
    }
    this.npcMeshes.clear();
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    for (const m of this.materials.values()) m.dispose();
    this.materials.clear();
    this.object.clear();
  }

  // ── Builders ──────────────────────────────────────────────────────────────

  private track<T extends { dispose(): void }>(resource: T): T {
    this.disposables.push(resource);
    return resource;
  }

  private material(color: number): THREE.MeshToonMaterial {
    let m = this.materials.get(color);
    if (m === undefined) {
      m = createToonMaterial({ color, vertexColors: false });
      this.materials.set(color, m);
    }
    return m;
  }

  private group(name: string, parent: THREE.Object3D = this.object): THREE.Group {
    const g = new THREE.Group();
    g.name = `village:${name}`;
    parent.add(g);
    return g;
  }

  // ── Task 18.4: merging ────────────────────────────────────────────────────

  /** Flat-coloured stand-in parts and prefabs merge; lamps, glows, smoke and NPC rigs keep their own meshes. */
  private bakeable(o: THREE.Object3D): o is THREE.Mesh {
    if (!(o instanceof THREE.Mesh) || Array.isArray(o.material)) return false;
    const m = o.material as THREE.Material;
    if (m === prefabMaterial()) return true;
    for (const flat of this.materials.values()) if (flat === m) return true;
    return false;
  }

  /** The group's parts as one mesh inside it (the group's visibility toggles it as before). */
  private mergeGroup(group: THREE.Object3D, castShadow = true): void {
    const b = new PartBuilder();
    const done: THREE.Mesh[] = [];
    group.traverse((o) => {
      if (this.bakeable(o) && bakeMesh(o, group, b)) done.push(o);
    });
    for (const m of done) m.removeFromParent();
    if (!b.empty) group.add(prefabMesh(this.track(b.build(`${group.name}:merged`)), `${group.name}:merged`, castShadow));
  }

  /** The street lamps as one mesh (lampOn / lampOff), placed in the view's frame. */
  private mergeLamps(lamps: readonly THREE.Mesh[]): THREE.Mesh {
    const b = new PartBuilder();
    for (const lamp of lamps) {
      bakeMesh(lamp, this.object, b);
      lamp.removeFromParent();
    }
    const mesh = new THREE.Mesh(this.track(b.build('village:lamps')), this.lampOff);
    mesh.name = 'village:lamps';
    this.object.add(mesh);
    return mesh;
  }

  /** Every other bakeable part plus the small props, merged per chunk. */
  private bakeStatic(skip: ReadonlySet<THREE.Object3D>): void {
    const batcher = new ChunkBatcher();
    const done: THREE.Mesh[] = [];
    const visit = (o: THREE.Object3D): void => {
      if (skip.has(o)) return;
      if (this.bakeable(o) && batcher.addMesh(o, this.object)) done.push(o);
      for (const c of o.children) visit(c);
    };
    visit(this.object);
    for (const m of done) m.removeFromParent();
    addVillageProps(batcher, (x, z) => this.source.heightAt(x, z));
    for (const mesh of batcher.build('village:static')) {
      this.track(mesh.geometry);
      this.object.add(mesh);
    }
    // Groups left empty by the merge go too.
    const empty: THREE.Object3D[] = [];
    this.object.traverse((o) => {
      if (o !== this.object && o instanceof THREE.Group && o.children.length === 0 && !skip.has(o)) empty.push(o);
    });
    for (const g of empty) g.removeFromParent();
  }

  /** A box of size (sx, sy, sz) standing on (x, y, z), turned by `yaw`. */
  private boxAt(parent: THREE.Object3D, color: number | THREE.Material, x: number, y: number, z: number, sx: number, sy: number, sz: number, yaw = 0): THREE.Mesh {
    const mesh = new THREE.Mesh(this.box, typeof color === 'number' ? this.material(color) : color);
    mesh.scale.set(sx, sy, sz);
    mesh.position.set(x, y + sy / 2, z);
    mesh.rotation.y = yaw;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }

  private cylinderAt(parent: THREE.Object3D, color: number | THREE.Material, x: number, y: number, z: number, radius: number, height: number): THREE.Mesh {
    const mesh = new THREE.Mesh(this.cylinder, typeof color === 'number' ? this.material(color) : color);
    mesh.scale.set(radius, height, radius);
    mesh.position.set(x, y + height / 2, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }

  private ground(p: XZ): number {
    const y = this.source.heightAt(p.x, p.z);
    return Number.isFinite(y) ? y : 0;
  }

  private addPlaza(): void {
    const plaza = this.group('plaza');
    const y = this.ground(VILLAGE_CENTER);
    const disc = this.cylinderAt(plaza, 0xa8a293, VILLAGE_CENTER.x, y - 0.1, VILLAGE_CENTER.z, PLAZA_RADIUS, 0.18);
    disc.castShadow = false;
    // The Hearth: a stone ring with a fire that always burns (Req 14.10).
    const hy = this.ground(HEARTH_POS);
    this.cylinderAt(plaza, 0x6f6a62, HEARTH_POS.x, hy, HEARTH_POS.z, 0.8, 0.45);
    const fire = new THREE.Mesh(this.cone, this.forgeOn);
    fire.scale.set(0.45, 0.9, 0.45);
    fire.position.set(HEARTH_POS.x, hy + 0.9, HEARTH_POS.z);
    plaza.add(fire);
  }

  private addBuilding(b: PlacedBuilding, garlands: THREE.Group, makeshift: THREE.Group, restored: THREE.Group): void {
    const { def, baseY } = b;
    const g = this.group(def.id);
    g.position.set(def.center.x, baseY, def.center.z);
    g.rotation.y = def.yaw; // local +z is the front (door, counter)
    const w = def.half.x * 2;
    const d = def.half.z * 2;
    switch (def.kind) {
      case 'marenHouse':
      case 'house':
        this.addHouse(g, def, w, d, garlands);
        break;
      case 'stall': {
        this.boxAt(g, 0x8a6a45, 0, 0, 0, w, def.height, d);
        // Makeshift: two crates beside the counter. Restored: shelves behind and a striped awning over it.
        const crates = this.group('crates', g);
        this.boxAt(crates, 0x9c7b4f, 0.1, 0, def.half.z + 0.5, 0.7, 0.6, 0.7, 0.3);
        this.boxAt(crates, 0x9c7b4f, -0.4, 0, -def.half.z - 0.5, 0.6, 0.5, 0.6, -0.2);
        makeshift.attach(crates);
        const stall = this.group('stallRestored', g);
        this.boxAt(stall, 0x7a5a3a, 0, 0, -1.3, w + 0.6, 2.1, 0.4);
        for (const x of [-1.1, 1.1]) this.boxAt(stall, 0x6a4a2e, x, 0, 0.5, 0.12, 2.6, 0.12);
        const awning = this.boxAt(stall, 0xd2584a, 0, 2.5, 0.2, w + 1.6, 0.08, d + 1.4);
        awning.rotation.x = 0.18;
        restored.attach(stall);
        break;
      }
      case 'echoAltar': {
        this.boxAt(g, 0x9a948a, 0, 0, 0, w, def.height, d);
        const rune = this.boxAt(g, this.lampOn, 0, def.height, 0, w * 0.6, 0.05, d * 0.6);
        rune.castShadow = false;
        break;
      }
      case 'step': {
        // Task 21.4: the plaza step, a worn stone ledge with a lighter top course.
        this.boxAt(g, 0x8f8a80, 0, 0, 0, w, def.height - 0.08, d);
        this.boxAt(g, 0xb3ad9f, 0, def.height - 0.08, 0, w + 0.1, 0.08, d + 0.1);
        break;
      }
      case 'well': {
        this.cylinderAt(g, 0x8d877c, 0, 0, 0, def.half.x, def.height);
        this.cylinderAt(g, 0x2c4a6a, 0, def.height - 0.05, 0, def.half.x * 0.78, 0.06);
        for (const x of [-def.half.x, def.half.x]) this.boxAt(g, 0x6a4a2e, x, 0, 0, 0.12, 2.3, 0.12);
        const roof = new THREE.Mesh(this.cone4, this.material(0x7a4a3a));
        roof.scale.set(def.half.x * 1.6, 0.8, def.half.x * 1.6);
        roof.position.y = 2.7;
        roof.rotation.y = Math.PI / 4;
        g.add(roof);
        break;
      }
      case 'watchtower': {
        for (const [x, z] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
          this.cylinderAt(g, 0x6a4a2e, x * def.half.x, 0, z * def.half.z, WATCHTOWER_POST_RADIUS, def.height);
        }
        this.boxAt(g, 0x8a6a45, 0, 8.6, 0, w, 0.3, d);
        const roof = new THREE.Mesh(this.cone4, this.material(0x7a4a3a));
        roof.scale.set(def.half.x * 1.7, 1.4, def.half.z * 1.7);
        roof.position.y = def.height + 0.7;
        roof.rotation.y = Math.PI / 4;
        g.add(roof);
        break;
      }
    }
  }

  private addHouse(g: THREE.Group, def: VillageBuildingDef, _w: number, _d: number, garlands: THREE.Group): void {
    // Task 18.4: the Thistlewick house prefab (timber frame, plaster walls filling the collider box, tiled gable roof).
    g.add(prefabMesh(this.track(thistlewickHouse(def)), `village:${def.id}:house`));
    // A garland over the door (Skyshard 2).
    const wreath = new THREE.Mesh(this.sphere, this.material(0x4f8f45));
    wreath.scale.set(0.5, 0.18, 0.12);
    wreath.position.set(0, 2.35, def.half.z + 0.1);
    g.add(wreath);
    garlands.attach(wreath);
  }

  private addField(): void {
    const field = this.group('field');
    const f = HOBB_FIELD;
    const y = this.ground(f.center);
    const soil = this.boxAt(field, 0x6b4a2e, f.center.x, y - 0.1, f.center.z, f.halfX * 2, 0.16, f.halfZ * 2);
    soil.castShadow = false;
    for (let i = 0; i < f.rows; i++) {
      const z = f.center.z - f.halfZ + ((i + 0.5) * 2 * f.halfZ) / f.rows;
      const row = this.boxAt(field, 0x5a3c24, f.center.x, y + 0.04, z, f.halfX * 2 - 1, 0.18, 0.5);
      row.castShadow = false;
    }
  }

  private addFieldFlowers(): THREE.Group {
    const flowers = this.group('fieldFlowers');
    const f = HOBB_FIELD;
    const y = this.ground(f.center);
    const colors = [0xf2d24b, 0xf28bb0, 0xffffff, 0xb58cf2];
    for (let i = 0; i < f.rows; i++) {
      const z = f.center.z - f.halfZ + ((i + 0.5) * 2 * f.halfZ) / f.rows;
      for (let k = 0; k < 10; k++) {
        const bloom = new THREE.Mesh(this.sphere, this.material(colors[(i + k) % colors.length] ?? 0xffffff));
        bloom.scale.setScalar(0.22);
        bloom.position.set(f.center.x - f.halfX + 1.5 + k * ((f.halfX * 2 - 3) / 9), y + 0.45, z);
        flowers.add(bloom);
      }
    }
    return flowers;
  }

  private addLantern(p: XZ): THREE.Mesh {
    const lantern = this.group('lantern');
    const y = this.ground(p);
    this.cylinderAt(lantern, 0x3a3634, p.x, y, p.z, 0.07, 2.6);
    return this.boxAt(lantern, this.lampOff, p.x, y + 2.6, p.z, 0.32, 0.4, 0.32);
  }

  private addBunting(): THREE.Group {
    const bunting = this.group('bunting');
    const colors = [0xe0584a, 0xf2c14b, 0x4a9de0, 0x5ec27a];
    // Strings between the plaza-rim lanterns (the first six), 3.2 m up.
    const rim = STREET_LANTERNS.slice(0, 6);
    rim.forEach((a, i) => {
      const b = rim[(i + 1) % rim.length];
      if (b === undefined) return;
      const ya = this.ground(a) + 3.2;
      const yb = this.ground(b) + 3.2;
      for (let k = 1; k < 8; k++) {
        const t = k / 8;
        const flag = new THREE.Mesh(this.cone4, this.material(colors[k % colors.length] ?? 0xffffff));
        flag.scale.set(0.2, 0.35, 0.03);
        flag.rotation.x = Math.PI;
        flag.position.set(a.x + (b.x - a.x) * t, ya + (yb - ya) * t - 0.35 * Math.sin(Math.PI * t), a.z + (b.z - a.z) * t);
        flag.rotation.y = Math.atan2(b.x - a.x, b.z - a.z) + Math.PI / 2;
        bunting.add(flag);
      }
    });
    return bunting;
  }

  private addFlowerBeds(): { wilted: THREE.Group; bloom: THREE.Group } {
    const wilted = this.group('bedsWilted');
    const bloom = this.group('bedsBloom');
    const colors = [0xf28bb0, 0xf2d24b, 0xb58cf2, 0xffffff];
    for (const p of FLOWER_BEDS) {
      const y = this.ground(p);
      this.boxAt(this.object, 0x5a3c24, p.x, y, p.z, 2.2, 0.25, 1.1);
      for (let k = 0; k < 5; k++) {
        const x = p.x - 0.8 + k * 0.4;
        const dry = new THREE.Mesh(this.cone, this.material(0x7a6a3a));
        dry.scale.set(0.08, 0.35, 0.08);
        dry.rotation.z = 0.5;
        dry.position.set(x, y + 0.35, p.z);
        wilted.add(dry);
        const flower = new THREE.Mesh(this.sphere, this.material(colors[k % colors.length] ?? 0xffffff));
        flower.scale.setScalar(0.16);
        flower.position.set(x, y + 0.5, p.z);
        bloom.add(flower);
      }
    }
    return { wilted, bloom };
  }

  private addStarLanterns(): THREE.Group {
    const group = this.group('starLanterns');
    const y = this.ground(VILLAGE_CENTER);
    group.position.set(VILLAGE_CENTER.x, y, VILLAGE_CENTER.z);
    const star = this.track(new THREE.OctahedronGeometry(0.35));
    for (let i = 0; i < STAR_LANTERNS.count; i++) {
      const a = (i / STAR_LANTERNS.count) * Math.PI * 2;
      const mesh = new THREE.Mesh(star, this.lampOn);
      mesh.position.set(Math.cos(a) * STAR_LANTERNS.radius, STAR_LANTERNS.height, Math.sin(a) * STAR_LANTERNS.radius);
      group.add(mesh);
    }
    return group;
  }

  private addFestival(): THREE.Group {
    const festival = this.group('festival');
    const colors = [0xe0584a, 0xf2c14b, 0x4a9de0];
    FESTIVAL_TENTS.forEach((p, i) => {
      const y = this.ground(p);
      const tent = new THREE.Mesh(this.cone, this.material(colors[i % colors.length] ?? 0xffffff));
      tent.scale.set(1.6, 2.4, 1.6);
      tent.position.set(p.x, y + 1.2, p.z);
      tent.castShadow = true;
      festival.add(tent);
    });
    return festival;
  }

  private addBlight(): THREE.Group {
    const blight = this.group('blight');
    const material = this.material(0x3a2440);
    for (const p of BLIGHT_PATCHES) {
      const patch = this.cylinderAt(blight, material, p.x, this.ground(p) - 0.02, p.z, 2.4, 0.08);
      patch.castShadow = false;
    }
    return blight;
  }

  /** A diamond kite of half-size `size` with its tail. */
  private kiteMesh(name: string, size: number, parent: THREE.Object3D = this.object): THREE.Group {
    const g = this.group(name, parent);
    const sail = new THREE.Mesh(this.cone4, this.material(0xe0584a));
    sail.scale.set(size, size * 1.6, 0.05);
    sail.rotation.x = Math.PI / 2;
    sail.rotation.y = Math.PI / 4;
    g.add(sail);
    const tail = new THREE.Mesh(this.box, this.material(0xf2c14b));
    tail.scale.set(0.05, size * 2, 0.05);
    tail.position.y = -size * 1.8;
    g.add(tail);
    return g;
  }

  private addVillageKite(): THREE.Group {
    const holder = this.group('villageKite');
    const a = VILLAGE_KITE.anchor;
    const y = this.ground(a);
    holder.position.set(a.x, y, a.z);
    const kite = this.kiteMesh('kite', 1.1, holder);
    kite.position.y = VILLAGE_KITE.height;
    const line = new THREE.Line(
      this.track(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, VILLAGE_KITE.height - 1, 0)])),
      this.track(new THREE.LineBasicMaterial({ color: 0xf5f1e6 })),
    );
    holder.add(line);
    return holder;
  }

  private addCamps(): { glow: THREE.Mesh; smoke: THREE.Group } {
    const camp = this.group('camps');
    const forge = DURGA_CAMP_PROPS.forge;
    const fy = this.ground(forge);
    this.boxAt(camp, 0x5a524c, forge.x, fy, forge.z, 2.4, 1.8, 2.0);
    this.cylinderAt(camp, 0x4a4440, forge.x + 0.6, fy + 1.8, forge.z - 0.4, 0.35, 4.2);
    const glow = this.boxAt(camp, this.forgeOff, forge.x, fy + 0.5, forge.z + 1.02, 1.0, 0.7, 0.05);
    glow.castShadow = false;
    const smoke = this.group('smoke', camp);
    smoke.position.set(forge.x + 0.6, fy, forge.z - 0.4);
    for (let i = 0; i < 5; i++) {
      const puff = new THREE.Mesh(this.sphere, this.smokeMaterial);
      puff.position.y = 6 + i;
      smoke.add(puff);
    }
    const anvil = DURGA_CAMP_PROPS.anvil;
    this.boxAt(camp, 0x2e2e34, anvil.x, this.ground(anvil), anvil.z, 0.8, 0.7, 0.4);
    const scope = ORIEL_CAMP_PROPS.telescope;
    const sy = this.ground(scope);
    for (const [dx, dz] of [[0.4, 0], [-0.2, 0.35], [-0.2, -0.35]] as const) this.boxAt(camp, 0x6a4a2e, scope.x + dx, sy, scope.z + dz, 0.06, 1.3, 0.06);
    const tube = this.cylinderAt(camp, 0xc9a94e, scope.x, sy + 1.2, scope.z, 0.12, 1.4);
    tube.rotation.z = 1.0;
    return { glow, smoke };
  }

  private addNpc(id: Speaker, home: Readonly<Vec3>): void {
    const view = this.library.createView(id);
    view.object.name = `npc:${id}`;
    // A companion before it joins stands with its weapon on its back.
    if (isCharacterId(id)) view.instance.stowWeapon(true);
    const anim = new AnimatedView(view, { clips: isCharacterId(id) ? heroClips(id) : NPC_CLIPS, procedural: humanoidProcedural });
    // Task 18.4: world coordinates stay (distanceCull.ts); the renderer hides the rig beyond NPC_CULL_DISTANCE.
    this.object.add(distanceCulled(view.object, home, NPC_CULL_DISTANCE));
    this.npcMeshes.set(id, { view, anim, last: new THREE.Vector3(), hasLast: false, talking: false });
  }

  private poseNpc(npc: NpcView, dt: number, player: Readonly<Vec3> | null): void {
    const v = this.npcMeshes.get(npc.id);
    if (v === undefined) return;
    v.view.object.visible = npc.present;
    if (!npc.present) {
      v.hasLast = false;
      return;
    }
    v.view.setPose(npc.pos, npc.yaw);
    const speed = v.hasLast && dt > 0 ? Math.hypot(npc.pos.x - v.last.x, npc.pos.z - v.last.z) / dt : 0;
    v.last.set(npc.pos.x, npc.pos.y, npc.pos.z);
    v.hasLast = true;
    if (npc.talking !== v.talking) {
      v.talking = npc.talking;
      v.view.instance.setExpression('talk', npc.talking ? 1 : 0);
    }
    v.view.object.updateMatrixWorld(true);
    const look = player === null ? null : { x: player.x, y: player.y + LOOK_HEIGHT, z: player.z };
    v.anim.update(dt, selectNpcAnim(npc.anim, npc.talking, Math.min(speed, 6)), {
      grounded: true, speed, yawRate: 0, lean: 'none', sprinting: false, landing: null, lookAt: look,
    });
    v.view.update(dt, NPC_BREEZE);
  }
}
