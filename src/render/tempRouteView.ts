// TEMPORARY visuals of the minimal route (task 4.9), removed with the pieces they draw (tasks 9.x, 13.x and the art
// tasks). Read-only: the view mirrors the route data and the stub / lift state, and never changes them.
// - Pieces (src/data/tempRoute.ts): the Breezewatch windmill stand and the Broken Bridge are prefabs over their shapes
//   (task 18.4, src/render/prefabs/keyLocations.ts); any other piece is a flat-shaded box or cylinder by look.
// - Lift pads: a carved stone waystep with a rune ring and a faint low column, gold for climbs, pale blue for
//   glides, violet for Updrafts; shown only while the pad is offered.
// - Skyshard pedestals with a floating, turning crystal until it is taken.
// The Astral Sanctum (gate, hall, mural, arena) has its own view since task 10.2 (src/render/tempSanctumView.ts); the
// NPCs and Thistlewick have theirs since tasks 13.1–13.2 (src/render/tempVillageView.ts).

import * as THREE from 'three';
import type { Vec3 } from '../core/types';
import { TEMP_LIFT_PAD_RADIUS, TEMP_PIECES, type TempLiftDef, type TempLook, type TempPieceDef } from '../data/tempRoute';
import { STUB_DEVICE_HEIGHT, STUB_DEVICE_RADIUS, type RouteStubs } from '../world/routeStubs';
import type { TempRoute } from '../world/tempRoute';
import { prefabMesh } from './prefabs/kit'; // task 18.4
import { brokenBridge, windmillStand } from './prefabs/keyLocations'; // task 18.4

const LOOK: Readonly<Record<TempLook, { color: number; emissive: number; intensity: number }>> = {
  wood: { color: 0x8a6a45, emissive: 0x000000, intensity: 0 },
  stone: { color: 0xb3ad9c, emissive: 0x000000, intensity: 0 },
  crystal: { color: 0xc4533a, emissive: 0xff6a2a, intensity: 0.35 },
  starlight: { color: 0x2c3f7a, emissive: 0x7fb6ff, intensity: 0.4 },
};
const LIFT_COLOR: Readonly<Record<TempLiftDef['stands'], number>> = { climb: 0xe9c46a, glide: 0x9fe3ff, updraft: 0xc8b6ff };
const SKYSHARD_COLOR = 0xfff1c4;
const PEDESTAL_COLOR = 0x9a927f;

interface Toggle {
  readonly object: THREE.Object3D;
  readonly visible: () => boolean;
}

export class TempRouteView {
  readonly object = new THREE.Group();
  private readonly disposables: { dispose(): void }[] = [];
  private readonly toggles: Toggle[] = [];
  private readonly crystals: THREE.Mesh[] = [];
  private readonly columnMaterials: THREE.MeshBasicMaterial[] = [];

  constructor(route: TempRoute, stubs: RouteStubs, pieces: readonly TempPieceDef[] = TEMP_PIECES) {
    this.object.name = 'tempRoute';
    const materials = new Map<TempLook, THREE.MeshLambertMaterial>();
    const lookMaterial = (look: TempLook): THREE.MeshLambertMaterial => {
      let m = materials.get(look);
      if (m === undefined) {
        const l = LOOK[look];
        m = this.track(new THREE.MeshLambertMaterial({ color: l.color, emissive: l.emissive, emissiveIntensity: l.intensity, flatShading: true }));
        materials.set(look, m);
      }
      return m;
    };
    // Task 18.4: the Breezewatch windmill stand and the Broken Bridge are prefabs over the same shapes (the walked
    // surfaces match the colliders); any other piece stays a flat-shaded stand-in.
    const handled = new Set<string>();
    const tower = pieces.find((p) => p.id === 'bw_tower');
    const top = pieces.find((p) => p.id === 'bw_top');
    if (tower?.shape.kind === 'cylinder' && top?.shape.kind === 'box') {
      this.object.add(prefabMesh(this.track(windmillStand({ tower: tower.shape, top: top.shape })), 'prefab:windmill'));
      handled.add(tower.id).add(top.id);
    }
    const bridge = pieces.find((p) => p.id === 'bridge_plank');
    if (bridge?.shape.kind === 'obb') {
      this.object.add(prefabMesh(this.track(brokenBridge(bridge.shape)), 'prefab:bridge'));
      handled.add(bridge.id);
    }
    for (const piece of pieces) if (!handled.has(piece.id)) this.object.add(this.pieceMesh(piece, lookMaterial(piece.look)));
    for (const lift of route.lifts) this.addLift(lift.def, lift.pad, () => route.offered(lift.def));
    for (const { def, pos } of stubs.pedestals) this.addPedestal(pos, () => stubs.pedestalFull(def));
  }

  /** Mirrors what is offered or present; `time` (s) turns the crystals and pulses the columns. */
  update(time: number): void {
    for (const t of this.toggles) t.object.visible = t.visible();
    this.crystals.forEach((c, i) => {
      c.rotation.y = time * 1.2 + i;
      c.position.y = 1.9 + 0.12 * Math.sin(time * 2 + i);
    });
    for (const m of this.columnMaterials) m.opacity = 0.1 + 0.05 * Math.sin(time * 2.5);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.object.clear();
  }

  private track<T extends { dispose(): void }>(resource: T): T {
    this.disposables.push(resource);
    return resource;
  }

  private pieceMesh(piece: TempPieceDef, material: THREE.Material): THREE.Mesh {
    const s = piece.shape;
    let mesh: THREE.Mesh;
    switch (s.kind) {
      case 'box':
        mesh = new THREE.Mesh(this.track(new THREE.BoxGeometry(s.max.x - s.min.x, s.max.y - s.min.y, s.max.z - s.min.z)), material);
        mesh.position.set((s.min.x + s.max.x) / 2, (s.min.y + s.max.y) / 2, (s.min.z + s.max.z) / 2);
        break;
      case 'obb':
        mesh = new THREE.Mesh(this.track(new THREE.BoxGeometry(s.half.x * 2, s.half.y * 2, s.half.z * 2)), material);
        mesh.position.set(s.center.x, s.center.y, s.center.z);
        mesh.rotation.y = s.yaw;
        break;
      case 'cylinder':
        mesh = new THREE.Mesh(this.track(new THREE.CylinderGeometry(s.radius, s.radius, s.height, s.radius > 4 ? 48 : 16)), material);
        mesh.position.set(s.base.x, s.base.y + s.height / 2, s.base.z);
        break;
    }
    mesh.name = `temp:${piece.id}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  private addLift(def: TempLiftDef, pad: Readonly<Vec3>, visible: () => boolean): void {
    const group = new THREE.Group();
    group.name = `lift:${def.id}`;
    group.position.set(pad.x, pad.y, pad.z);
    const color = LIFT_COLOR[def.stands];
    // Task 24.5 review: a carved stone waystep with a glowing rune ring instead of a flat coloured disc.
    const disc = new THREE.Mesh(
      this.track(new THREE.CylinderGeometry(TEMP_LIFT_PAD_RADIUS, TEMP_LIFT_PAD_RADIUS * 1.08, 0.18, 10)),
      this.track(new THREE.MeshToonMaterial({ color: 0x8c8678 })),
    );
    disc.position.y = 0.09;
    disc.receiveShadow = true;
    const rune = new THREE.Mesh(
      this.track(new THREE.TorusGeometry(TEMP_LIFT_PAD_RADIUS * 0.72, 0.05, 6, 32)),
      this.track(new THREE.MeshBasicMaterial({ color })),
    );
    rune.rotation.x = Math.PI / 2;
    rune.position.y = 0.2;
    const columnMaterial = this.track(
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.columnMaterials.push(columnMaterial);
    const column = new THREE.Mesh(this.track(new THREE.CylinderGeometry(TEMP_LIFT_PAD_RADIUS * 0.55, TEMP_LIFT_PAD_RADIUS * 0.72, 1.4, 20, 1, true)), columnMaterial);
    column.position.y = 0.9;
    group.add(disc, rune, column);
    this.object.add(group);
    this.toggles.push({ object: group, visible });
  }

  private addPedestal(pos: Readonly<Vec3>, full: () => boolean): void {
    const group = new THREE.Group();
    group.position.set(pos.x, pos.y, pos.z);
    const stone = new THREE.Mesh(
      this.track(new THREE.CylinderGeometry(STUB_DEVICE_RADIUS * 0.7, STUB_DEVICE_RADIUS, STUB_DEVICE_HEIGHT, 8)),
      this.track(new THREE.MeshLambertMaterial({ color: PEDESTAL_COLOR, flatShading: true })),
    );
    stone.position.y = STUB_DEVICE_HEIGHT / 2;
    const crystal = new THREE.Mesh(
      this.track(new THREE.OctahedronGeometry(0.35)),
      this.track(new THREE.MeshLambertMaterial({ color: SKYSHARD_COLOR, emissive: SKYSHARD_COLOR, emissiveIntensity: 1 })),
    );
    crystal.scale.set(0.8, 1.4, 0.8);
    crystal.position.y = 1.9;
    group.add(stone, crystal);
    this.object.add(group);
    this.crystals.push(crystal);
    this.toggles.push({ object: crystal, visible: full });
  }
}
