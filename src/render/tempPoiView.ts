// TEMPORARY POI visuals until the art tasks (tasks 12.7, 20.1; Req 10.5, 10.6, 10.8, 10.10): the Chests (a box and a
// hinged lid by tier, a lock plate while their camp stands, a lid that swings open with a burst for common / fine
// and the larger light pillar for glowing ones, a pop-in when a reward Chest appears), the Echo_Tablets (a slab with a
// glowing rune until read), lore stones, caches and herb bushes (gone once spent until they regrow), the Sky Ring
// Trial's start stone and eight rings (the next ring bright during a run), and the POI structures (the Breezewatch
// blade shelf, the isles' lower deck, the lake islet and its stepping stones) drawn from their colliders. The sounds
// are the Audio_System's on 'chest:opened' and the hidden-place notice. Task 18.4 (draw-call budget): the Chests,
// tablets, lore stones, caches and herbs hide beyond 160 m of the camera (distanceCull.ts); the trial and the
// structures stay.

import * as THREE from 'three';
import type { Vec3 } from '../core/types';
import { ECHO_TABLETS, POI_STRUCTURES, SKY_RING_DIRECTION, SKY_RING_TRIAL } from '../data/pois';
import type { DeepReadonly, GameState } from '../logic/save/gameState';
import type { ChestSystem, ChestView } from '../loot/chestSystem';
import { CHEST_SIZE } from '../loot/chestSystem';
import { CACHE_SIZE, structureCollider, TABLET_SIZE, type PoiSystem } from '../world/poiSystem';
import { distanceCulled } from './distanceCull'; // task 18.4
import { createToonMaterial } from './toonMaterial';

const LID_HEIGHT = 0.22;
const LID_OPEN_SECONDS = 0.6;
const APPEAR_SECONDS = 0.6;
const BURST_SECONDS = 1.2;
const PILLAR_SECONDS = 3;
const PILLAR_HEIGHT = 36;

export interface TempPoiViewOptions {
  chests: Pick<ChestSystem, 'views'>;
  pois: Pick<PoiSystem, 'densityViews' | 'lorePositions' | 'trial' | 'trialDone'>;
  state: DeepReadonly<GameState>;
  heightAt: (x: number, z: number) => number;
}

interface ChestMesh {
  readonly id: string;
  readonly root: THREE.Group;
  readonly lid: THREE.Group;
  readonly lock: THREE.Mesh;
  readonly glow: THREE.Mesh | null;
  readonly fx: THREE.Mesh;
  readonly glowing: boolean;
}

export class TempPoiView {
  readonly object = new THREE.Group();
  private readonly o: TempPoiViewOptions;
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly chests: ChestMesh[] = [];
  private readonly tablets: { id: string; rune: THREE.Mesh }[] = [];
  private readonly lore = new Map<string, THREE.Mesh>();
  private readonly density = new Map<string, THREE.Object3D>();
  private readonly rings: THREE.Mesh[] = [];
  private readonly ringIdle: THREE.MeshBasicMaterial;
  private readonly ringNext: THREE.MeshBasicMaterial;
  private readonly ringDone: THREE.MeshBasicMaterial;
  private readonly runeLit: THREE.MeshBasicMaterial;
  private readonly runeDim: THREE.MeshBasicMaterial;

  constructor(options: TempPoiViewOptions) {
    this.o = options;
    this.object.name = 'tempPois';
    const toon = (color: number, emissive?: number): THREE.MeshToonMaterial =>
      this.mat(createToonMaterial({ color, vertexColors: false, ...(emissive === undefined ? {} : { emissive, emissiveIntensity: 0.6 }) }));
    const basic = (color: number, extra: THREE.MeshBasicMaterialParameters = {}): THREE.MeshBasicMaterial =>
      this.mat(new THREE.MeshBasicMaterial({ color, ...extra }));
    const additive = (color: number): THREE.MeshBasicMaterial =>
      basic(color, { transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });

    // ── Chests ──
    const { width, depth, height } = CHEST_SIZE;
    const bodyGeo = this.geo(new THREE.BoxGeometry(width, height - LID_HEIGHT, depth));
    const lidGeo = this.geo(new THREE.BoxGeometry(width, LID_HEIGHT, depth));
    const lockGeo = this.geo(new THREE.BoxGeometry(0.2, 0.22, 0.05));
    const glowGeo = this.geo(new THREE.OctahedronGeometry(0.16, 0));
    const burstGeo = this.geo(new THREE.CylinderGeometry(0.5, 0.8, 4, 12, 1, true));
    const pillarGeo = this.geo(new THREE.CylinderGeometry(1.1, 1.6, PILLAR_HEIGHT, 16, 1, true));
    const tierMats = {
      common: { body: toon(0x9a6a3c), lid: toon(0xb07c46) },
      fine: { body: toon(0x6f7c93), lid: toon(0x9aa8c2) },
      glowing: { body: toon(0xd9a441, 0x6a4a10), lid: toon(0xf2cf6b, 0x7a5a18) },
    } as const;
    const lockMat = toon(0x2f3340);
    const glowMat = basic(0xffe9a8);
    const burstMat = additive(0xfff2c4);
    const pillarMat = additive(0xffd97a);
    for (const view of options.chests.views()) {
      const tier = view.def.tier;
      const root = new THREE.Group();
      root.position.set(view.pos.x, view.pos.y, view.pos.z);
      root.rotation.y = view.def.yaw;
      const body = new THREE.Mesh(bodyGeo, tierMats[tier].body);
      body.position.y = (height - LID_HEIGHT) / 2;
      const lid = new THREE.Group();
      lid.position.set(0, height - LID_HEIGHT, -depth / 2); // hinge on the back edge
      const lidMesh = new THREE.Mesh(lidGeo, tierMats[tier].lid);
      lidMesh.position.set(0, LID_HEIGHT / 2, depth / 2);
      lid.add(lidMesh);
      const lock = new THREE.Mesh(lockGeo, lockMat);
      lock.position.set(0, height - LID_HEIGHT - 0.05, depth / 2 + 0.03);
      const glowing = tier === 'glowing';
      const glow = glowing ? new THREE.Mesh(glowGeo, glowMat) : null;
      if (glow !== null) glow.position.y = height + 0.6;
      const fx = new THREE.Mesh(glowing ? pillarGeo : burstGeo, (glowing ? pillarMat : burstMat).clone());
      this.materials.push(fx.material as THREE.Material);
      fx.visible = false;
      fx.position.y = glowing ? PILLAR_HEIGHT / 2 : 2;
      root.add(body, lid, lock, fx, ...(glow === null ? [] : [glow]));
      this.object.add(distanceCulled(root, view.pos)); // task 18.4: small details hide beyond 160 m (draw-call budget)
      this.chests.push({ id: view.def.id, root, lid, lock, glow, fx, glowing });
    }

    // ── Echo_Tablets and lore stones ──
    const slabGeo = this.geo(new THREE.BoxGeometry(TABLET_SIZE.width, TABLET_SIZE.height, TABLET_SIZE.depth));
    const runeGeo = this.geo(new THREE.PlaneGeometry(TABLET_SIZE.width * 0.55, TABLET_SIZE.height * 0.45));
    const slabMat = toon(0x8e96a8);
    this.runeLit = basic(0x9fdcff);
    this.runeDim = basic(0x4a5570);
    for (const t of ECHO_TABLETS) {
      const y = this.ground(t.pos);
      const slab = new THREE.Mesh(slabGeo, slabMat);
      slab.position.set(t.pos.x, y + TABLET_SIZE.height / 2, t.pos.z);
      slab.rotation.y = t.yaw;
      const rune = new THREE.Mesh(runeGeo, this.runeLit);
      rune.position.set(0, 0.1, TABLET_SIZE.depth / 2 + 0.01);
      slab.add(rune);
      this.object.add(distanceCulled(slab, slab.position));
      this.tablets.push({ id: t.id, rune });
    }
    const steleGeo = this.geo(new THREE.CylinderGeometry(0.28, 0.4, 1.3, 5));
    const steleMat = toon(0xa39c8c);
    for (const l of options.pois.lorePositions()) {
      const stele = new THREE.Mesh(steleGeo, steleMat);
      stele.position.set(l.pos.x, l.pos.y + 0.65, l.pos.z);
      this.object.add(distanceCulled(stele, stele.position));
      this.lore.set(l.id, stele);
    }

    // ── Caches and herb bushes ──
    const jarGeo = this.geo(new THREE.CylinderGeometry(CACHE_SIZE.radius * 0.7, CACHE_SIZE.radius, CACHE_SIZE.height, 8));
    const jarMat = toon(0xc27a4a);
    const bushGeo = this.geo(new THREE.IcosahedronGeometry(0.45, 0));
    const bushMat = toon(0x5fa84a);
    const budGeo = this.geo(new THREE.SphereGeometry(0.08, 6, 4));
    const budMat = basic(0xf4d35e);
    for (const d of options.pois.densityViews()) {
      let obj: THREE.Object3D;
      if (d.def.kind === 'cache') {
        obj = new THREE.Mesh(jarGeo, jarMat);
        obj.position.set(d.pos.x, d.pos.y + CACHE_SIZE.height / 2, d.pos.z);
      } else {
        obj = new THREE.Group();
        const bush = new THREE.Mesh(bushGeo, bushMat);
        bush.scale.set(1, 0.7, 1);
        obj.add(bush);
        for (let i = 0; i < 4; i++) {
          const bud = new THREE.Mesh(budGeo, budMat);
          const a = (i / 4) * Math.PI * 2 + 0.4;
          bud.position.set(Math.sin(a) * 0.32, 0.18, Math.cos(a) * 0.32);
          obj.add(bud);
        }
        obj.position.set(d.pos.x, d.pos.y + 0.3, d.pos.z);
      }
      this.object.add(distanceCulled(obj, obj.position));
      this.density.set(d.def.id, obj);
    }

    // ── Sky Ring Trial ──
    const startGeo = this.geo(new THREE.CylinderGeometry(0.5, 0.7, 1.6, 6));
    const start = new THREE.Mesh(startGeo, toon(0x9fb4d6, 0x203050));
    const s = SKY_RING_TRIAL.start;
    start.position.set(s.x, this.ground(s) + 0.8, s.z);
    this.object.add(start);
    const ringGeo = this.geo(new THREE.TorusGeometry(SKY_RING_TRIAL.ringRadius, 0.18, 8, 40));
    this.ringIdle = basic(0x8fb8e8, { transparent: true, opacity: 0.55 });
    this.ringNext = basic(0xffe38a);
    this.ringDone = basic(0x5a6a88, { transparent: true, opacity: 0.35 });
    const facing = Math.atan2(SKY_RING_DIRECTION.x, SKY_RING_DIRECTION.z);
    for (const r of SKY_RING_TRIAL.rings) {
      const ring = new THREE.Mesh(ringGeo, this.ringIdle);
      ring.position.set(r.x, r.y, r.z);
      ring.rotation.y = facing; // the torus lies in its local XY plane, so it faces along the course
      this.object.add(ring);
      this.rings.push(ring);
    }

    // ── POI structures (from their colliders) ──
    const structureMats = { wood: toon(0x9a6a3c), ruin: toon(0xb8b0a0), rock: toon(0x7d8088) } as const;
    for (const def of POI_STRUCTURES) {
      const c = structureCollider(def, 0, options.heightAt);
      const mat = structureMats[def.look];
      let mesh: THREE.Mesh | null = null;
      if (c.kind === 'aabb') {
        mesh = new THREE.Mesh(this.geo(new THREE.BoxGeometry(c.max.x - c.min.x, c.max.y - c.min.y, c.max.z - c.min.z)), mat);
        mesh.position.set((c.min.x + c.max.x) / 2, (c.min.y + c.max.y) / 2, (c.min.z + c.max.z) / 2);
      } else if (c.kind === 'cylinder') {
        mesh = new THREE.Mesh(this.geo(new THREE.CylinderGeometry(c.radius, c.radius * (def.shape.kind === 'disc' ? 0.7 : 1), c.height, 14)), mat);
        mesh.position.set(c.base.x, c.base.y + c.height / 2, c.base.z);
      }
      if (mesh !== null) this.object.add(mesh);
    }
  }

  /** `time` (s, real) drives the idle glows. */
  update(time: number): void {
    const views = new Map<string, ChestView>(this.o.chests.views().map((v) => [v.def.id, v]));
    for (const c of this.chests) {
      const v = views.get(c.id);
      if (v === undefined) continue;
      c.root.visible = v.present;
      if (!v.present) continue;
      c.root.position.set(v.pos.x, v.pos.y, v.pos.z);
      const appear = v.appearedAgo === null ? 1 : Math.min(1, v.appearedAgo / APPEAR_SECONDS);
      c.root.scale.setScalar(0.2 + 0.8 * appear);
      c.lock.visible = v.locked && !v.opened;
      const openT = v.opened ? (v.openedAgo === null ? 1 : Math.min(1, v.openedAgo / LID_OPEN_SECONDS)) : 0;
      c.lid.rotation.x = -openT * 1.9;
      if (c.glow !== null) {
        c.glow.visible = !v.opened;
        c.glow.position.y = CHEST_SIZE.height + 0.6 + 0.1 * Math.sin(time * 2);
        c.glow.rotation.y = time;
      }
      const span = c.glowing ? PILLAR_SECONDS : BURST_SECONDS;
      const playing = v.openedAgo !== null && v.openedAgo < span;
      c.fx.visible = playing;
      if (playing && v.openedAgo !== null) {
        const t = v.openedAgo / span;
        (c.fx.material as THREE.MeshBasicMaterial).opacity = (c.glowing ? 0.6 : 0.5) * Math.sin(Math.PI * t);
        const grow = 0.3 + 0.7 * Math.min(1, t * 3);
        c.fx.scale.set(1 + t * 0.5, grow, 1 + t * 0.5);
        c.fx.position.y = ((c.glowing ? PILLAR_HEIGHT : 4) * grow) / 2;
      }
    }
    const read = new Set(this.o.state.world.echoTablets);
    for (const t of this.tablets) t.rune.material = read.has(t.id) ? this.runeDim : this.runeLit;
    for (const d of this.o.pois.densityViews()) {
      const obj = this.density.get(d.def.id);
      if (obj !== undefined) obj.visible = !d.spent;
    }
    const run = this.o.pois.trial;
    this.rings.forEach((ring, i) => {
      ring.material = run === null ? this.ringIdle : i < run.next ? this.ringDone : i === run.next ? this.ringNext : this.ringIdle;
      ring.scale.setScalar(run !== null && i === run.next ? 1 + 0.06 * Math.sin(time * 6) : 1);
    });
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    this.object.clear();
  }

  private ground(p: Readonly<Vec3>): number {
    const y = this.o.heightAt(p.x, p.z);
    return Number.isFinite(y) ? y : p.y;
  }

  private geo<T extends THREE.BufferGeometry>(g: T): T {
    this.geometries.push(g);
    return g;
  }

  private mat<T extends THREE.Material>(m: T): T {
    this.materials.push(m);
    return m;
  }
}
