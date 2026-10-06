// TEMPORARY Puzzle_Mechanism visuals (task 9.5) until the art tasks. Read-only: mirrors PuzzleSystem.views() every
// frame and never changes puzzle state.
// - Each part: a simple body by device (brazier bowl, wind-wheel pole with blades and order notches, hexagonal
//   Heat_Crystal door, Unstable_Crystal cluster, stone pressure plate, boulder / bramble / fire mound, arrival ring,
//   the Observatory's star pedestal column)
//   and above it the Element emblem it needs in that Element's colour and icon silhouette (Req 13.2: flame, ringed
//   waves, spiral, hexagonal crystal).
// - A right input shows on the next frame (Req 13.3): lit braziers burn, wheels spin, crystals cool to blue,
//   plates sink, active emblems glow brighter. A failure flashes the parts red; a running sequence shrinks a light
//   ring under its parts with the time left.
// - Solving: gate parts and broken devices vanish, a rising ring plays at the opened target for 1.5 s and a gold
//   marker stays there while it is open (the Chest / door / platform the later tasks draw).

import * as THREE from 'three';
import { ELEMENT_DEFS, type ElementIconShape } from '../data/elements';
import type { PuzzlePartView, PuzzleView } from '../world/puzzleSystem';
import { cullChildren } from './distanceCull'; // task 18.4

const FAIL_COLOR = new THREE.Color(0xff3a2a);
const HOT_COLOR = 0xff6a2a;
const COOL_COLOR = 0x9fd8ff;
const STONE_COLOR = 0x9a927f;
const WOOD_COLOR = 0x8a6a45;
const UNSTABLE_COLOR = 0xc06bff;
const MARKER_COLOR = 0xffd66b;
const TIMER_COLOR = 0xe9f4ff;
/** Seconds of the opening ring after a solve. */
const OPENING_SECONDS = 1.5;

interface PartHandle {
  readonly group: THREE.Group;
  readonly body: THREE.MeshLambertMaterial;
  readonly baseEmissive: THREE.Color;
  readonly emblem: THREE.Mesh;
  readonly emblemMaterial: THREE.MeshLambertMaterial | null;
  readonly spinner: THREE.Object3D | null;
  readonly flame: THREE.Object3D | null;
  readonly timer: THREE.Mesh;
  readonly lift: THREE.Object3D;
}

interface PuzzleHandle {
  readonly parts: readonly PartHandle[];
  readonly marker: THREE.Mesh | null;
  readonly ring: THREE.Mesh | null;
  readonly ringMaterial: THREE.MeshBasicMaterial | null;
}

export class TempPuzzleView {
  readonly object = new THREE.Group();
  private readonly source: { views(): PuzzleView[] };
  private readonly disposables: { dispose(): void }[] = [];
  private readonly handles: PuzzleHandle[] = [];
  private readonly emblemGeometry = new Map<ElementIconShape, THREE.BufferGeometry>();

  constructor(source: { views(): PuzzleView[] }) {
    this.source = source;
    this.object.name = 'tempPuzzles';
    for (const view of source.views()) this.handles.push(this.build(view));
  }

  /** Mirrors the puzzles; `time` (s) animates spin, flames and pulses. */
  update(time: number): void {
    const views = this.source.views();
    views.forEach((view, i) => {
      const h = this.handles[i];
      if (h === undefined) return;
      view.parts.forEach((part, j) => {
        const p = h.parts[j];
        if (p !== undefined) this.updatePart(p, part, view, time);
      });
      if (h.marker !== null) {
        h.marker.visible = view.open;
        h.marker.rotation.y = time * 1.5;
      }
      if (h.ring !== null && h.ringMaterial !== null) {
        const t = view.solvedAgo === null ? 1 : view.solvedAgo / OPENING_SECONDS;
        h.ring.visible = t < 1;
        h.ring.position.y = 0.2 + 3 * t;
        h.ring.scale.setScalar(1 + 2 * t);
        h.ringMaterial.opacity = 0.7 * (1 - t);
      }
    });
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

  private updatePart(p: PartHandle, part: PuzzlePartView, view: PuzzleView, time: number): void {
    p.group.visible = part.present;
    const tint = p.body.emissive.copy(p.baseEmissive);
    if (part.device === 'heatCrystal') {
      const cooled = part.state === 'cooled';
      p.body.color.setHex(cooled ? COOL_COLOR : HOT_COLOR);
      tint.setHex(cooled ? 0x3a78a8 : HOT_COLOR);
    }
    if (part.device === 'unstableCrystal' && part.telegraph > 0) tint.setHex(0xffffff).multiplyScalar(0.5 + 0.5 * Math.sin(time * 30));
    if (view.failFlash > 0) tint.lerp(FAIL_COLOR, view.failFlash);
    p.body.emissiveIntensity = part.active ? 0.7 : 0.25;
    if (p.emblemMaterial !== null) p.emblemMaterial.emissiveIntensity = part.active || view.solved ? 1.2 : 0.45 + 0.15 * Math.sin(time * 3);
    p.emblem.rotation.y = time * 0.8;
    if (p.spinner !== null && part.state === 'spinning') p.spinner.rotation.z = time * 8;
    if (p.flame !== null) {
      p.flame.visible = part.state === 'lit';
      p.flame.scale.y = 1 + 0.15 * Math.sin(time * 12);
    }
    p.lift.position.y = part.device === 'pressurePlate' && part.active ? -0.08 : 0;
    const left = view.timeLeft;
    // Star pedestals all show it, so the ring never tells the decoy apart.
    p.timer.visible = left !== null && (part.notches > 0 || part.device === 'elementPedestal');
    if (left !== null) p.timer.scale.setScalar(Math.max(0.05, left));
  }

  private build(view: PuzzleView): PuzzleHandle {
    const parts = view.parts.map((part) => this.buildPart(part));
    let marker: THREE.Mesh | null = null;
    let ring: THREE.Mesh | null = null;
    let ringMaterial: THREE.MeshBasicMaterial | null = null;
    if (view.opensAt !== null) {
      const at = view.opensAt;
      marker = new THREE.Mesh(
        this.track(new THREE.OctahedronGeometry(0.35)),
        this.track(new THREE.MeshLambertMaterial({ color: MARKER_COLOR, emissive: MARKER_COLOR, emissiveIntensity: 0.9 })),
      );
      marker.position.set(at.x, at.y + 1.2, at.z);
      marker.name = `puzzleOpens:${view.id}`;
      ringMaterial = this.track(new THREE.MeshBasicMaterial({
        color: MARKER_COLOR, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }));
      ring = new THREE.Mesh(this.track(new THREE.TorusGeometry(1.2, 0.08, 8, 40)), ringMaterial);
      ring.rotation.x = Math.PI / 2;
      const holder = new THREE.Group();
      holder.position.set(at.x, at.y, at.z);
      holder.add(ring);
      ring.visible = false;
      this.object.add(marker, holder);
    }
    // Task 18.4: the puzzle's parts and markers hide beyond 160 m of their bounds (draw-call budget).
    const content: THREE.Object3D[] = parts.map((p) => p.group);
    if (marker !== null) content.push(marker);
    if (ring?.parent != null) content.push(ring.parent);
    cullChildren(this.object, content, `puzzle:${view.id}`);
    return { parts, marker, ring, ringMaterial };
  }

  private buildPart(part: PuzzlePartView): PartHandle {
    const group = new THREE.Group();
    group.name = `puzzlePart:${part.id}`;
    group.position.set(part.pos.x, part.pos.y, part.pos.z);
    const lift = new THREE.Group();
    group.add(lift);
    const { radius: r, height: h } = part;
    const color = part.device === 'unstableCrystal' ? UNSTABLE_COLOR : part.device === 'windWheel' ? WOOD_COLOR : STONE_COLOR;
    const body = this.track(new THREE.MeshLambertMaterial({ color, emissive: color, emissiveIntensity: 0.25, flatShading: true }));
    const baseEmissive = body.emissive.clone();
    const mesh = (geometry: THREE.BufferGeometry, material: THREE.Material = body): THREE.Mesh => {
      const m = new THREE.Mesh(this.track(geometry), material);
      m.castShadow = false; // task 18.4: small devices only receive (casters: characters, enemies, large structures)
      return m;
    };
    let spinner: THREE.Object3D | null = null;
    let flame: THREE.Object3D | null = null;
    let top = h;
    switch (part.device) {
      case 'brazier': {
        const bowl = mesh(new THREE.CylinderGeometry(r, r * 0.55, h * 0.45, 10));
        bowl.position.y = h * 0.775;
        const stand = mesh(new THREE.CylinderGeometry(r * 0.3, r * 0.45, h * 0.55, 8));
        stand.position.y = h * 0.275;
        const fire = ELEMENT_DEFS.ember.color;
        flame = mesh(new THREE.ConeGeometry(r * 0.6, 0.7, 7), this.track(new THREE.MeshBasicMaterial({ color: fire })));
        flame.position.y = h + 0.3;
        lift.add(bowl, stand, flame);
        top = h + 0.7;
        break;
      }
      case 'windWheel': {
        const pole = mesh(new THREE.CylinderGeometry(0.1, 0.14, h, 8));
        pole.position.y = h / 2;
        const hub = new THREE.Group();
        hub.position.set(0, h - 0.2, r * 0.6);
        for (let i = 0; i < 4; i++) {
          const blade = mesh(new THREE.BoxGeometry(0.16, 0.9, 0.04));
          blade.position.y = 0.45;
          const arm = new THREE.Group();
          arm.rotation.z = (i * Math.PI) / 2;
          arm.add(blade);
          hub.add(arm);
        }
        spinner = hub;
        lift.add(pole, hub);
        // Order notches (the chime's step): bright bands low on the pole.
        for (let i = 0; i < part.notches; i++) {
          const notch = mesh(new THREE.TorusGeometry(0.15, 0.035, 6, 16), this.track(new THREE.MeshBasicMaterial({ color: 0xf5f1e6 })));
          notch.rotation.x = Math.PI / 2;
          notch.position.y = 0.6 + i * 0.25;
          lift.add(notch);
        }
        top = h + 0.5;
        break;
      }
      case 'heatCrystal': {
        // A wall its Challenge_Area draws (Cinderspire H1) shows only the emblem here, on the wall's face.
        if (!part.body) break;
        const door = mesh(new THREE.CylinderGeometry(r * 0.8, r, h, 6));
        door.position.y = h / 2;
        lift.add(door);
        break;
      }
      case 'unstableCrystal': {
        for (let i = 0; i < 3; i++) {
          const shard = mesh(new THREE.OctahedronGeometry(r * (0.6 - i * 0.12)));
          shard.scale.y = 1.8;
          shard.position.set((i - 1) * r * 0.55, h * (0.45 + i * 0.08), (i % 2) * 0.3);
          lift.add(shard);
        }
        break;
      }
      case 'pressurePlate': {
        const plate = mesh(new THREE.CylinderGeometry(r, r, 0.12, 20));
        plate.position.y = 0.06;
        lift.add(plate);
        top = 0.35;
        break;
      }
      case 'elementPedestal': {
        // A white stone column with a wide cap; its Element emblem floats above and the cap glows once lit.
        const column = mesh(new THREE.CylinderGeometry(r * 0.55, r * 0.8, h * 0.85, 8));
        column.position.y = h * 0.425;
        const cap = mesh(new THREE.CylinderGeometry(r, r * 0.6, h * 0.15, 8));
        cap.position.y = h * 0.925;
        lift.add(column, cap);
        break;
      }
      case 'arrival': {
        const ring = mesh(new THREE.TorusGeometry(r, 0.05, 6, 32), this.track(new THREE.MeshBasicMaterial({ color: TIMER_COLOR, transparent: true, opacity: 0.35 })));
        ring.rotation.x = Math.PI / 2;
        ring.position.y = 0.05;
        lift.add(ring);
        top = 0.6;
        break;
      }
      default: {
        const mound = mesh(new THREE.DodecahedronGeometry(Math.min(r, h / 2)));
        mound.position.y = Math.min(r, h / 2);
        lift.add(mound);
      }
    }
    // Element emblem (Req 13.2).
    let emblemMaterial: THREE.MeshLambertMaterial | null = null;
    let emblem: THREE.Mesh;
    if (part.element !== null) {
      const el = ELEMENT_DEFS[part.element];
      emblemMaterial = this.track(new THREE.MeshLambertMaterial({ color: el.color, emissive: el.color, emissiveIntensity: 0.5 }));
      emblem = new THREE.Mesh(this.emblemFor(el.icon), emblemMaterial);
    } else {
      emblem = new THREE.Mesh();
      emblem.visible = false;
    }
    emblem.name = `puzzleIcon:${part.id}`;
    emblem.position.y = top + 0.35;
    lift.add(emblem);
    // Time-left ring for sequence parts.
    const timer = new THREE.Mesh(
      this.track(new THREE.RingGeometry(r + 0.4, r + 0.6, 40)),
      this.track(new THREE.MeshBasicMaterial({ color: TIMER_COLOR, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false })),
    );
    timer.rotation.x = -Math.PI / 2;
    timer.position.y = 0.05;
    timer.visible = false;
    group.add(timer);
    this.object.add(group);
    return { group, body, baseEmissive, emblem, emblemMaterial, spinner, flame, timer, lift };
  }

  /** One shared geometry per icon silhouette. */
  private emblemFor(icon: ElementIconShape): THREE.BufferGeometry {
    let g = this.emblemGeometry.get(icon);
    if (g !== undefined) return g;
    switch (icon) {
      case 'triFlame':
        g = new THREE.ConeGeometry(0.2, 0.45, 3);
        break;
      case 'ringWaves':
        g = new THREE.TorusGeometry(0.18, 0.05, 8, 24);
        break;
      case 'spiral':
        g = new THREE.TorusKnotGeometry(0.13, 0.04, 48, 6, 2, 3);
        break;
      case 'hexCrystal':
        g = new THREE.CylinderGeometry(0.17, 0.17, 0.36, 6);
        break;
    }
    this.emblemGeometry.set(icon, this.track(g));
    return g;
  }
}
