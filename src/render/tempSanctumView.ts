// TEMPORARY Astral Sanctum visuals (task 10.2), replaced by the Sanctum art. Read-only: it mirrors src/data/sanctum.ts
// and the SanctumSystem's seal, and never changes them.
// - Pieces (task 18.4: the Sanctum prefab, src/render/prefabs/keyLocations.ts): pale star-stone floors and steps,
//   darker hall walls and the rim wall with gold cap lines, gold-rimmed floor and pedestals, all one merged mesh plus
//   one gold trim mesh; the ward as a faint starlight shimmer, the Shard_Crystal pedestals with a ring in their
//   Element's colour, the ws_sanctum stone with its floating crystal.
// - Arena floor: the 8 sector boundaries as thin glowing lines from the centre ring to the rim (sectorBlast lights
//   whole sectors later).
// - The mural panel on the hall's west wall: a night-blue slab with a falling star and the four Element stars.
// - The entrance seal: a pulsing starlight curtain while it stands.

import * as THREE from 'three';
import type { AreaShape } from '../data/challengeAreas';
import { ELEMENT_DEFS } from '../data/elements';
import { SANCTUM, type SanctumDef, type SanctumLook } from '../data/sanctum';
import { cullChildren, mergeStaticMeshes } from './distanceCull'; // task 18.4
import { prefabMesh } from './prefabs/kit'; // task 18.4
import { sanctum as sanctumPrefab } from './prefabs/keyLocations'; // task 18.4
import { sharedMaterialVariant } from './toonMaterial'; // task 18.4

const LOOK: Readonly<Record<SanctumLook, { color: number; emissive: number; intensity: number; opacity?: number }>> = {
  floor: { color: 0xc9cce6, emissive: 0x3a4a8a, intensity: 0.12 },
  step: { color: 0xb9bddd, emissive: 0x3a4a8a, intensity: 0.12 },
  hallWall: { color: 0x59618f, emissive: 0x1c2450, intensity: 0.2 },
  rim: { color: 0x8f97c8, emissive: 0x7fb6ff, intensity: 0.25 },
  ward: { color: 0x9fc4ff, emissive: 0x9fc4ff, intensity: 0.6, opacity: 0.05 },
  pedestal: { color: 0x4a4f78, emissive: 0x1c2450, intensity: 0.2 },
  waystone: { color: 0x7d86b8, emissive: 0x3a4a8a, intensity: 0.2 },
};
const SECTOR_LINE_COLOR = 0x9fb6ff;
const GOLD = 0xe9c46a;
const SEAL_COLOR = 0xc8b6ff;
const MURAL_COLOR = 0x1d2a5e;
const STAR_COLOR = 0xfff1c4;

export interface SanctumViewSource {
  readonly sealed: boolean;
}

export class TempSanctumView {
  readonly object = new THREE.Group();
  private readonly disposables: { dispose(): void }[] = [];
  private readonly seal: THREE.Mesh;
  private readonly sealMaterial: THREE.MeshBasicMaterial;
  private readonly crystal: THREE.Mesh;
  private crystalBaseY = 0;
  private readonly source: SanctumViewSource;

  constructor(source: SanctumViewSource, def: SanctumDef = SANCTUM) {
    this.object.name = 'tempSanctum';
    this.source = source;
    const materials = new Map<SanctumLook, THREE.Material>();
    const material = (look: SanctumLook): THREE.Material => {
      let m = materials.get(look);
      if (m === undefined) {
        const l = LOOK[look];
        m = l.opacity !== undefined
          ? this.track(new THREE.MeshBasicMaterial({ color: l.color, transparent: true, opacity: l.opacity, depthWrite: false, side: THREE.DoubleSide }))
          : this.track(new THREE.MeshLambertMaterial({ color: l.color, emissive: l.emissive, emissiveIntensity: l.intensity, flatShading: true }));
        materials.set(look, m);
      }
      return m;
    };
    // Task 18.4: the Sanctum prefab (star-stone pieces exactly their colliders, gold trims); the ward stays a shimmer.
    const prefab = sanctumPrefab(def);
    this.object.add(prefabMesh(this.track(prefab.body), 'sanctum:prefab'));
    const gold = this.track(sharedMaterialVariant('stone', { emissive: 0xffd66b, emissiveIntensity: 0.35 }));
    this.object.add(prefabMesh(this.track(prefab.trim), 'sanctum:prefab:trim', false, gold));
    const skipped = new Set(prefab.skipped);
    const kept = new Set<THREE.Object3D>(this.object.children);
    // Task 18.4: the skipped pieces (the ward) merge per look into one mesh each.
    const byLook = new Map<SanctumLook, THREE.Mesh[]>();
    for (const piece of def.pieces) {
      if (!skipped.has(piece.id)) continue;
      const mesh = this.shapeMesh(piece.shape, material(piece.look), `sanctum:${piece.id}`);
      mesh.castShadow = piece.look !== 'ward';
      mesh.receiveShadow = piece.look !== 'ward';
      const list = byLook.get(piece.look) ?? [];
      list.push(mesh);
      byLook.set(piece.look, list);
    }
    for (const [look, meshes] of byLook) {
      const merged = mergeStaticMeshes(meshes, material(look), `sanctum:${look}`);
      if (merged === null) {
        this.object.add(...meshes);
        continue;
      }
      this.track(merged.geometry);
      merged.castShadow = look !== 'ward';
      merged.receiveShadow = look !== 'ward';
      this.object.add(merged);
    }
    this.addSectorLines(def);
    this.addPedestalRings(def);
    this.crystal = this.addWaystoneCrystal(def);
    this.addMural(def);
    this.sealMaterial = this.track(new THREE.MeshBasicMaterial({
      color: SEAL_COLOR, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    }));
    this.seal = this.shapeMesh(def.arena.seal.shape, this.sealMaterial, 'sanctum:seal');
    this.seal.visible = false;
    this.object.add(this.seal);
    // Task 18.4: everything but the prefab body and trims hides beyond 160 m of the Sanctum (draw-call budget; the
    // Landmark draws the silhouette from afar).
    cullChildren(this.object, this.object.children.filter((c) => !kept.has(c)), 'sanctum:detail');
  }

  /** Mirrors the seal; `time` (s) pulses the curtain and turns the Waystone crystal. */
  update(time: number): void {
    this.seal.visible = this.source.sealed;
    if (this.seal.visible) this.sealMaterial.opacity = 0.3 + 0.12 * Math.sin(time * 3);
    this.crystal.rotation.y = time * 0.8;
    this.crystal.position.y = this.crystalBaseY + 0.1 * Math.sin(time * 1.7);
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

  private shapeMesh(shape: AreaShape, material: THREE.Material, name: string): THREE.Mesh {
    let mesh: THREE.Mesh;
    if (shape.kind === 'obb') {
      mesh = new THREE.Mesh(this.track(new THREE.BoxGeometry(shape.half.x * 2, shape.half.y * 2, shape.half.z * 2)), material);
      mesh.position.set(shape.center.x, shape.center.y, shape.center.z);
      mesh.rotation.y = shape.yaw;
    } else {
      const segments = shape.radius > 4 ? 64 : 16;
      mesh = new THREE.Mesh(this.track(new THREE.CylinderGeometry(shape.radius, shape.radius, shape.height, segments)), material);
      mesh.position.set(shape.base.x, shape.base.y + shape.height / 2, shape.base.z);
    }
    mesh.name = name;
    return mesh;
  }

  /** The sector boundaries (every 45°, between the sector centres) and a ring around the centre. */
  private addSectorLines(def: SanctumDef): void {
    const { center, radius, sectors, rim } = def.arena;
    const lineMaterial = this.track(new THREE.MeshBasicMaterial({ color: SECTOR_LINE_COLOR, transparent: true, opacity: 0.45, depthWrite: false }));
    const inner = 3;
    const outer = radius - rim.thickness;
    const length = outer - inner;
    const geometry = this.track(new THREE.PlaneGeometry(0.12, length));
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(0, 0, -(inner + length / 2)); // along −z (north) before the turn
    const parts: THREE.Mesh[] = [];
    for (const s of sectors) {
      const line = new THREE.Mesh(geometry, lineMaterial);
      line.position.set(center.x, center.y + 0.02, center.z);
      // Bearing b (clockwise from north) is the object's turn of −b about +Y.
      line.rotation.y = -(s.fromDeg * Math.PI) / 180;
      parts.push(line);
    }
    const ring = new THREE.Mesh(this.track(new THREE.RingGeometry(inner - 0.1, inner + 0.05, 48)), lineMaterial);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(center.x, center.y + 0.02, center.z);
    parts.push(ring);
    // Task 18.4: the lines and the ring as one mesh (one draw call).
    const merged = mergeStaticMeshes(parts, lineMaterial, 'sanctum:sectorLines');
    if (merged === null) {
      this.object.add(...parts);
      return;
    }
    this.track(merged.geometry);
    this.object.add(merged);
  }

  /** A glowing ring in each pedestal's Element colour on its top. */
  private addPedestalRings(def: SanctumDef): void {
    for (const p of def.arena.pedestals) {
      const color = ELEMENT_DEFS[p.element].color;
      const ring = new THREE.Mesh(
        this.track(new THREE.TorusGeometry(p.radius * 0.7, 0.06, 6, 32)),
        this.track(new THREE.MeshBasicMaterial({ color })),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(p.pos.x, p.pos.y + p.height + 0.02, p.pos.z);
      this.object.add(ring);
    }
  }

  /** The Waystone's floating crystal above its stone. */
  private addWaystoneCrystal(def: SanctumDef): THREE.Mesh {
    const w = def.waystone;
    const crystal = new THREE.Mesh(
      this.track(new THREE.OctahedronGeometry(0.4)),
      this.track(new THREE.MeshLambertMaterial({ color: 0x9fe3ff, emissive: 0x7fb6ff, emissiveIntensity: 0.9, flatShading: true })),
    );
    crystal.scale.set(0.8, 1.5, 0.8);
    this.crystalBaseY = w.pos.y + w.height + 0.7;
    crystal.position.set(w.pos.x, this.crystalBaseY, w.pos.z);
    this.object.add(crystal);
    const cap = new THREE.Mesh(this.track(new THREE.TorusGeometry(w.radius + 0.05, 0.05, 6, 24)), this.track(new THREE.MeshBasicMaterial({ color: GOLD })));
    cap.rotation.x = -Math.PI / 2;
    cap.position.set(w.pos.x, w.pos.y + w.height, w.pos.z);
    this.object.add(cap);
    return crystal;
  }

  /** The mural: a night-blue panel with a star falling toward the four Element stars. */
  private addMural(def: SanctumDef): void {
    const p = def.mural.panel;
    const group = new THREE.Group();
    group.name = 'sanctum:mural';
    group.position.set(p.center.x, p.center.y, p.center.z);
    const panel = new THREE.Mesh(
      this.track(new THREE.BoxGeometry(p.half.x * 2, p.half.y * 2, p.half.z * 2)),
      this.track(new THREE.MeshLambertMaterial({ color: MURAL_COLOR, emissive: 0x3a4a8a, emissiveIntensity: 0.35, flatShading: true })),
    );
    group.add(panel);
    const face = p.half.x + 0.02; // the panel faces +x (into the hall)
    const star = (color: number, size: number, y: number, z: number): void => {
      const m = new THREE.Mesh(this.track(new THREE.OctahedronGeometry(size)), this.track(new THREE.MeshBasicMaterial({ color })));
      m.position.set(face, y, z);
      group.add(m);
    };
    star(STAR_COLOR, 0.22, 0.8, -2.2);
    const trail = new THREE.Mesh(this.track(new THREE.PlaneGeometry(2.4, 0.06)), this.track(new THREE.MeshBasicMaterial({ color: STAR_COLOR, side: THREE.DoubleSide })));
    trail.rotation.set(0, Math.PI / 2, -0.45);
    trail.position.set(face, 0.3, -1.1);
    group.add(trail);
    (['ember', 'tide', 'gale', 'terra'] as const).forEach((element, i) => star(ELEMENT_DEFS[element].color, 0.14, -0.7, -0.9 + i * 0.9));
    this.object.add(group);
  }
}
