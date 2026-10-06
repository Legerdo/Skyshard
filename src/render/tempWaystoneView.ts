// TEMPORARY Waystone visuals until the art tasks (task 13.7; Req 11.1): the five ground stones (tapered standing
// stones on the collider of src/world/waystoneSystem.ts) and, over every Waystone including ws_sanctum (whose stone the
// Sanctum view draws), a floating crystal: dim while inactive, glowing and slowly turning once activated. The
// activation plays a light column that rises and fades over ACTIVATION_SECONDS (the activation's "연출"; its sound
// is the Audio_System's on 'waystone:activated').

import * as THREE from 'three';
import { WAYSTONE_LIST, WAYSTONE_STONE } from '../data/waystones';
import type { WaystoneSystem } from '../world/waystoneSystem';
import { createToonMaterial } from './toonMaterial';

const ACTIVATION_SECONDS = 2.2;
const CRYSTAL_SIZE = 0.3;
const CRYSTAL_LIFT = 0.55;
const COLUMN_HEIGHT = 14;

interface StoneView {
  readonly id: (typeof WAYSTONE_LIST)[number]['id'];
  readonly crystal: THREE.Mesh;
  readonly column: THREE.Mesh;
  readonly baseY: number;
  readonly groundY: number;
}

export class TempWaystoneView {
  readonly object = new THREE.Group();
  private readonly stoneGeometry = new THREE.CylinderGeometry(WAYSTONE_STONE.radius * 0.62, WAYSTONE_STONE.radius, WAYSTONE_STONE.height, 6);
  private readonly crystalGeometry = new THREE.OctahedronGeometry(CRYSTAL_SIZE, 0);
  private readonly columnGeometry = new THREE.CylinderGeometry(0.9, 1.3, COLUMN_HEIGHT, 16, 1, true);
  private readonly stoneMaterial = createToonMaterial({ color: 0x8b90a3, vertexColors: false });
  private readonly dim = new THREE.MeshBasicMaterial({ color: 0x5a6680 });
  private readonly lit = new THREE.MeshBasicMaterial({ color: 0x9fdcff });
  private readonly columnMaterial = new THREE.MeshBasicMaterial({
    color: 0xbfe8ff, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
  });
  private readonly stones: StoneView[] = [];

  constructor(private readonly waystones: WaystoneSystem) {
    this.object.name = 'tempWaystones';
    for (const w of WAYSTONE_LIST) {
      if (!w.sanctumPiece) {
        const stone = new THREE.Mesh(this.stoneGeometry, this.stoneMaterial);
        stone.position.set(w.x, w.groundY + WAYSTONE_STONE.height / 2, w.z);
        stone.rotation.y = Math.atan2(w.front.x, w.front.z);
        this.object.add(stone);
      }
      const baseY = w.groundY + WAYSTONE_STONE.height + CRYSTAL_LIFT;
      const crystal = new THREE.Mesh(this.crystalGeometry, this.dim);
      crystal.position.set(w.x, baseY, w.z);
      const column = new THREE.Mesh(this.columnGeometry, this.columnMaterial.clone());
      column.position.set(w.x, w.groundY + COLUMN_HEIGHT / 2, w.z);
      column.visible = false;
      this.object.add(crystal, column);
      this.stones.push({ id: w.id, crystal, column, baseY, groundY: w.groundY });
    }
  }

  /** `time` (s, real) drives the idle bob and turn. */
  update(time: number): void {
    for (const s of this.stones) {
      const active = this.waystones.isActive(s.id);
      s.crystal.material = active ? this.lit : this.dim;
      s.crystal.position.y = s.baseY + (active ? 0.12 * Math.sin(time * 1.6) : 0);
      s.crystal.rotation.y = active ? time * 0.8 : 0;
      const since = this.waystones.sinceActivation(s.id);
      const playing = since !== null && since < ACTIVATION_SECONDS;
      s.column.visible = playing;
      if (playing && since !== null) {
        const t = since / ACTIVATION_SECONDS;
        (s.column.material as THREE.MeshBasicMaterial).opacity = 0.55 * Math.sin(Math.PI * t);
        const rise = 0.3 + 0.7 * Math.min(1, t * 2.5); // the column grows up from the ground
        s.column.scale.set(1 + t * 0.6, rise, 1 + t * 0.6);
        s.column.position.y = s.groundY + (COLUMN_HEIGHT * rise) / 2;
        s.crystal.scale.setScalar(1 + 0.8 * Math.sin(Math.PI * t));
      } else {
        s.crystal.scale.setScalar(1);
      }
    }
  }

  dispose(): void {
    this.stoneGeometry.dispose();
    this.crystalGeometry.dispose();
    this.columnGeometry.dispose();
    this.stoneMaterial.dispose();
    this.dim.dispose();
    this.lit.dispose();
    this.columnMaterial.dispose();
    for (const s of this.stones) (s.column.material as THREE.Material).dispose();
    this.object.clear();
  }
}
