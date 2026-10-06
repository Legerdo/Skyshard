// Enemy presentation (task 19.3 models, task 19.4 animation; the public API the session uses is unchanged): one
// VisualLibrary EntityView per RuntimeState enemy — the kind's procedural rig (Elites: 1.4× with their aura, Rootbound
// Warden its own model) — interpolated between its last two tick poses with the loop's alpha:
// - Animation: `selectEnemyAnim` from the AI state and the attack playback (windup until `firstHit − lead`, then the
//   strike; the attack's clip time is the sim's attack clock, render-interpolated), `hurt` for a flinch, `stagger`,
//   `defeat`; Aether Sentinel's rings spin on their own axes (faster through a windup) and its eye turns to the target.
// - Telegraph (Req 26.5): the body glows orange-red from the attack start to its first HitEvent (`uFlash` colour);
//   the ground Telegraph decals and the Stagger stars are the VfxSystem's (src/vfx, task 19.5).
// - Hit (Req 26.1): the VfxSystem's 0.1 s `uHitFlash` (`flashOf`; without it the flinch's first 0.1 s), the `hurt`
//   clip over the 0.2 s flinch.
// - Death (Req 26.6): the `defeat` clip (0.4 s death motion), then the 1.0 s `uDissolve` with its glowing edge, gone
//   by 1.4 s, before the simulation removes the body at 1.5 s.
// - Alert: a yellow "!" over the head while the AI state is `alert` (its 0.5 s, Req 28.3).
// - Element_Shield (Req 25.10): the shared Element shell (src/anim/shellMaterial, as Caelith's Starshell) round the
//   body in its current Element's colour and icon, crossfading on a rotation, thinning as it wears, shattering on a
//   break. Sentinel Prime's drones are reduced Sentinels (eye and one ring) glowing through their bolt's Telegraph.

import * as THREE from 'three';
import type { AnimRequest } from '../anim/animator';
import { selectEnemyAnim, type EnemyClipSet } from '../anim/animState';
import { ENEMY_CLIP_SETS } from '../anim/clips';
import { DRONE_RIG_SPEC, SENTINEL_RINGS } from '../anim/enemyRigs';
import { assembleRig, prepareRig, type PreparedRig } from '../anim/rigKit';
import { ElementShell } from '../anim/shellMaterial';
import { SIM_DT } from '../core/loop';
import { lerpAngle, lerpV3 } from '../core/math';
import type { Vec3 } from '../core/types';
import { getEnemyDef } from '../data/enemies';
import type { EntityId } from '../data/ids';
import { ENEMY_FLINCH_SECONDS, type DroneView } from '../enemies/enemySystem';
import type { EnemyRuntime } from '../save/runtimeState';
import { AnimatedView } from '../visual/animatedView';
import { EntityView } from '../visual/entityView';
import { ProceduralVisualInstance } from '../visual/proceduralProvider';
import { defaultVisualLibrary, type VisualLibrary } from '../visual/visualLibrary';

const TELEGRAPH_COLOR = 0xff4d1a;
const FLASH_COLOR = 0xffffff;
const ALERT_COLOR = 0xffd23f;
/** Element_Shield shell opacity at full durability (it thins toward half as the shield wears down). */
const SHELL_OPACITY = 0.9;
/** Status icons float this far above the head (m). */
const ICON_LIFT = 0.45;
/** Hit flash length within the flinch when no `flashOf` hook is set (Req 26.1: 0.1 s). */
const FLASH_SECONDS = 0.1;
/** Death: the defeat clip for DEATH_MOTION_SECONDS, then the dissolve over DISSOLVE_SECONDS. */
export const DEATH_MOTION_SECONDS = 0.4;
export const DISSOLVE_SECONDS = 1.0;
/** Ring spin (deg/s) of an Aether Sentinel's three rings (Y, Z, X axes), ×2.5 through a windup. */
const RING_SPIN = [60, -45, 80] as const;
const RING_AXES = [new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0)] as const;
/** The Sentinel eye tracks its target this far (m). */
const EYE_RANGE = 24;

interface EnemyVisual {
  readonly root: THREE.Group;
  readonly view: EntityView;
  readonly anim: AnimatedView;
  readonly set: EnemyClipSet;
  /** Element_Shield shell (kinds with a shield). */
  readonly shell: ElementShell | null;
  /** "!" shown during alert. */
  readonly alertMark: THREE.Group;
  readonly rings: THREE.Object3D[];
  readonly ringAngles: number[];
  shieldUp: boolean;
}

interface DroneVisual {
  readonly view: EntityView;
  readonly anim: AnimatedView;
  readonly ring: THREE.Object3D | null;
  ringAngle: number;
  telegraphTime: number;
  strikeTime: number | null;
}

const _q = new THREE.Quaternion();

export class TempEnemyView {
  readonly object = new THREE.Group();
  /** Task 19.5: the VfxSystem's `uHitFlash` of an enemy (1 at the hit → 0 after 0.1 s), or null for the flinch fallback. */
  flashOf: ((id: EntityId) => number) | null = null;
  /** Where Sentinels' eyes (and the drones) turn: the Active_Character's chest, or null. */
  lookTarget: (() => Readonly<Vec3> | null) | null = null;
  private readonly visuals = new Map<EntityId, EnemyVisual>();
  private readonly droneVisuals = new Map<EntityId, DroneVisual>();
  private readonly alertBarGeometry = new THREE.BoxGeometry(0.1, 0.34, 0.1);
  private readonly alertDotGeometry = new THREE.SphereGeometry(0.065, 8, 6);
  private readonly alertMaterial = new THREE.MeshBasicMaterial({ color: ALERT_COLOR });
  private dronePrepared: PreparedRig | null = null;

  constructor(private readonly library: VisualLibrary = defaultVisualLibrary()) {
    this.object.name = 'tempEnemies';
  }

  /** Mirrors `enemies` (adds, updates and removes visuals) at interpolation `alpha`, animating by `dt` scaled s. */
  sync(enemies: ReadonlyMap<EntityId, Readonly<EnemyRuntime>>, alpha: number, dt = SIM_DT): void {
    const t = Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : 1;
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    for (const [id, e] of enemies) {
      let visual = this.visuals.get(id);
      if (visual === undefined) {
        visual = this.create(e);
        this.visuals.set(id, visual);
        this.object.add(visual.root);
      }
      this.update(visual, e, t, step);
    }
    for (const [id, visual] of this.visuals) {
      if (enemies.has(id)) continue;
      this.remove(visual);
      this.visuals.delete(id);
    }
  }

  /** The model view of an enemy (tests, debug tools), or undefined. */
  viewOf(id: EntityId): EntityView | undefined {
    return this.visuals.get(id)?.view;
  }

  /** The animation of an enemy (tests), or undefined. */
  animationOf(id: EntityId): AnimatedView | undefined {
    return this.visuals.get(id)?.anim;
  }

  dispose(): void {
    for (const visual of this.visuals.values()) this.remove(visual);
    this.visuals.clear();
    for (const d of this.droneVisuals.values()) this.removeDrone(d);
    this.droneVisuals.clear();
    this.alertBarGeometry.dispose();
    this.alertDotGeometry.dispose();
    this.alertMaterial.dispose();
    this.dronePrepared?.geometry.dispose();
    this.dronePrepared = null;
    this.object.clear();
  }

  private create(e: Readonly<EnemyRuntime>): EnemyVisual {
    const def = getEnemyDef(e.def);
    const root = new THREE.Group();
    root.name = `enemy:${e.id}`;
    const view = this.library.createView(e.def);
    root.add(view.object);
    const entry = ENEMY_CLIP_SETS[e.def];
    const sentinel = e.def === 'aetherSentinel' || e.def === 'sentinelPrime';
    const anim = new AnimatedView(view, {
      clips: entry.clips,
      procedural: sentinel ? (i) => ({ height: i.height, breathe: [], lean: [], look: [['head', 1]], lookRange: EYE_RANGE }) : null,
    });
    const rings = sentinel ? SENTINEL_RINGS.map((n) => view.instance.joints.get(n)).filter((b): b is THREE.Object3D => b !== undefined) : [];

    // Status icon over the head: unlit so it reads in any light.
    const alertMark = new THREE.Group();
    const bar = new THREE.Mesh(this.alertBarGeometry, this.alertMaterial);
    bar.position.y = 0.3;
    alertMark.add(bar, new THREE.Mesh(this.alertDotGeometry, this.alertMaterial));
    alertMark.position.y = Math.max(def.height, view.instance.height) + ICON_LIFT;
    alertMark.visible = false;
    root.add(alertMark);

    let shell: ElementShell | null = null;
    if (def.shield !== undefined) {
      const half = def.height / 2;
      shell = new ElementShell({ radius: [def.radius * 1.45, half * 1.2, def.radius * 1.45], center: [0, half, 0], opacity: SHELL_OPACITY });
      shell.mesh.name = `shield:${e.id}`;
      root.add(shell.mesh);
    }
    return { root, view, anim, set: entry.set, shell, alertMark, rings, ringAngles: rings.map(() => 0), shieldUp: false };
  }

  private update(visual: EnemyVisual, e: Readonly<EnemyRuntime>, alpha: number, dt: number): void {
    const pos = lerpV3(e.prevPos, e.pos, alpha);
    visual.root.position.set(pos.x, pos.y, pos.z);
    visual.root.rotation.y = lerpAngle(e.prevYaw, e.yaw, alpha);
    visual.alertMark.visible = e.state === 'alert';
    const back = (1 - alpha) * SIM_DT;
    const first = e.attack?.def.hits[0];
    const speed = Math.hypot(e.pos.x - e.prevPos.x, e.pos.z - e.prevPos.z) / SIM_DT;
    const flinch = e.flinch > 0 ? ENEMY_FLINCH_SECONDS - e.flinch : null;
    const req = selectEnemyAnim({
      state: e.state,
      stateTime: e.state === 'dead' ? Math.max(0, e.stateTime - back) : e.stateTime,
      speed,
      attack: e.attack === null || first === undefined ? null : { clip: e.attack.def.clip, time: Math.max(0, e.attack.t - back), firstHit: first.t },
      flinch,
    }, visual.set);
    const look = this.lookTarget?.() ?? null;
    visual.view.object.updateMatrixWorld(true);
    visual.anim.update(dt, req, visual.anim.procedural === null ? undefined : {
      grounded: false, speed, yawRate: 0, lean: 'none', sprinting: false, landing: null, lookAt: e.state === 'dead' ? null : look,
    });
    // Rings: each on its own axis, faster through a windup.
    const winding = e.attack !== null && first !== undefined && e.attack.t < first.t;
    visual.rings.forEach((bone, i) => {
      visual.ringAngles[i] = (visual.ringAngles[i]! + dt * RING_SPIN[i % 3]! * (winding ? 2.5 : 1) * Math.PI / 180) % (Math.PI * 2);
      bone.quaternion.copy(_q.setFromAxisAngle(RING_AXES[i % 3]!, visual.ringAngles[i]!));
    });
    // Glow: hit flash, else the Telegraph ramp to the first hit, else none.
    const flash = this.flashOf === null ? (e.flinch > ENEMY_FLINCH_SECONDS - FLASH_SECONDS ? 1 : 0) : this.flashOf(e.id);
    if (e.state !== 'dead' && flash > 0) visual.view.setFlash(Math.min(1, flash), FLASH_COLOR);
    else if (e.state !== 'dead' && e.attack !== null && first !== undefined && e.attack.t < first.t) {
      visual.view.setFlash(0.35 + 0.65 * (e.attack.t / first.t), TELEGRAPH_COLOR);
    } else visual.view.setFlash(0);
    visual.view.setDissolve(e.state === 'dead' ? dissolveAt(e.stateTime) : 0);
    // Element_Shield: shown while it stands; a break shatters it.
    if (visual.shell !== null) {
      const shield = e.element.shield;
      if (shield !== null && e.state !== 'dead') {
        visual.shell.show(shield.element, shield.durability / Math.max(1, shield.max));
        visual.shieldUp = true;
      } else {
        if (visual.shieldUp && e.state !== 'dead') visual.shell.shatter();
        else visual.shell.hide();
        visual.shieldUp = false;
      }
      visual.shell.update(dt);
    }
    visual.view.update(dt);
  }

  private remove(visual: EnemyVisual): void {
    this.object.remove(visual.root);
    visual.anim.dispose();
    visual.view.dispose();
    visual.shell?.dispose();
  }

  /** Mirrors the Elites' drones (Sentinel Prime's): reduced Sentinels glowing through their bolt's Telegraph. */
  syncDrones(drones: readonly DroneView[], alpha: number, dt = SIM_DT): void {
    const t = Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : 1;
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    const seen = new Set<EntityId>();
    const set = ENEMY_CLIP_SETS.sentinelPrime_drone.set;
    const bolt = set.attacks.sentinelPrime_droneBolt!;
    for (const d of drones) {
      seen.add(d.id);
      let visual = this.droneVisuals.get(d.id);
      if (visual === undefined) {
        visual = this.createDrone(d.id);
        this.droneVisuals.set(d.id, visual);
        this.object.add(visual.view.object);
      }
      const pos = lerpV3(d.prevPos, d.pos, t);
      // The drone's body centre sits 0.55 of its height above the rig origin.
      const yaw = this.droneYaw(pos);
      visual.view.setPose({ x: pos.x, y: pos.y - 0.55 * DRONE_RIG_SPEC.height, z: pos.z }, yaw);
      let req: AnimRequest;
      if (d.telegraph) {
        visual.telegraphTime += step;
        visual.strikeTime = null;
        req = { base: { clip: set.idle }, action: { clip: bolt.windup, time: visual.telegraphTime }, override: null };
      } else {
        if (visual.telegraphTime > 0) visual.strikeTime = 0;
        visual.telegraphTime = 0;
        const strike = visual.strikeTime;
        if (strike !== null && strike < 0.55) {
          visual.strikeTime = strike + step;
          req = { base: { clip: set.idle }, action: { clip: bolt.strike, time: strike }, override: null };
        } else {
          visual.strikeTime = null;
          req = { base: { clip: set.idle }, action: null, override: null };
        }
      }
      visual.anim.update(step, req);
      if (visual.ring !== null) {
        visual.ringAngle = (visual.ringAngle + step * (d.telegraph ? 3 : 1.2)) % (Math.PI * 2);
        visual.ring.quaternion.setFromAxisAngle(RING_AXES[0], visual.ringAngle);
      }
      visual.view.setFlash(d.telegraph ? 1 : 0, TELEGRAPH_COLOR);
      visual.view.update(step);
    }
    for (const [id, visual] of this.droneVisuals) {
      if (seen.has(id)) continue;
      this.removeDrone(visual);
      this.droneVisuals.delete(id);
    }
  }

  private droneYaw(pos: Readonly<Vec3>): number {
    const target = this.lookTarget?.() ?? null;
    if (target === null) return 0;
    return Math.atan2(target.x - pos.x, target.z - pos.z);
  }

  private createDrone(id: EntityId): DroneVisual {
    if (this.dronePrepared === null) this.dronePrepared = prepareRig(DRONE_RIG_SPEC);
    const rig = assembleRig(this.dronePrepared, {}, false);
    const view = new EntityView('sentinelPrime', new ProceduralVisualInstance('sentinelPrime', rig));
    view.object.name = `drone:${id}`;
    const anim = new AnimatedView(view, { clips: ENEMY_CLIP_SETS.sentinelPrime_drone.clips });
    return { view, anim, ring: view.instance.joints.get('ring0') ?? null, ringAngle: 0, telegraphTime: 0, strikeTime: null };
  }

  private removeDrone(visual: DroneVisual): void {
    this.object.remove(visual.view.object);
    visual.anim.dispose();
    visual.view.dispose();
  }
}

/** Dissolve progress 0..1 at `seconds` after death: after the death motion, over DISSOLVE_SECONDS. */
export function dissolveAt(seconds: number): number {
  return Math.min(1, Math.max(0, (seconds - DEATH_MOTION_SECONDS) / DISSOLVE_SECONDS));
}
