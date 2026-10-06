/*
 * Caelith on screen (design.md "Caelith 구성", task 19.3; animation task 19.4): the procedural star knight from the
 * VisualLibrary (body + outline, crystal greatsword + outline, starlight cape), the halo — 8 crystal shards on a 1.8 m
 * ring behind the head, one InstancedMesh whose instance matrices follow the `head` bone every frame — and the
 * Starshell, the shared Element shell at 3.4 m round the body centre. Seven draw calls in all.
 *
 * - Phase 2 on: the Starshell shows the current Element's colour and icon, crossfading over 0.3 s when it changes
 *   (Req 6.4); a break shatters it (the VfxSystem throws the shards, Req 6.5).
 * - Final Phase (Req 6.7): the crack lines' `uGlow` rises 0 → 1 and the halo widens and brightens.
 * - A Phase transition pulses white, a vulnerable window gold.
 * - Death (Req 6.14): the `death` clip, the body dissolving from the feet up while the halo shards scatter upward.
 */
import * as THREE from 'three';
import { selectBossAnim } from '../anim/animState';
import { CAELITH_HALO, haloShardGeometry } from '../anim/caelithRig';
import { CAELITH_ATTACK_CLIPS, CAELITH_CLIP_LIST } from '../anim/clips';
import { ElementShell } from '../anim/shellMaterial';
import type { BossState, StarshellSnapshot } from '../boss/bossSnapshot';
import { SIM_DT } from '../core/loop';
import type { Vec3 } from '../core/types';
import { CAELITH_ATTACKS, type CaelithAttack } from '../data/boss';
import { AnimatedView, humanoidProcedural } from './animatedView';
import type { EntityView } from './entityView';
import type { VisualLibrary } from './visualLibrary';

export const STARSHELL_RADIUS = 3.4;
/** Final Phase: halo radius and the crack glow ramp (per s). */
const FINAL_HALO_RADIUS = 2.3;
const GLOW_RATE = 0.8;
/** Death: the dissolve starts after the recoil and rises over this long; the halo scatters meanwhile. */
export const DEATH_DISSOLVE_DELAY = 0.5;
export const DEATH_DISSOLVE_SECONDS = 2.5;
const HALO_COLOR = new THREE.Color(0xfff0b8);
const TRANSITION_COLOR = 0xffffff;
const VULNERABLE_COLOR = 0xffd166;

/** What the view reads of the fight each frame (a CaelithSnapshot fits). */
export interface CaelithViewInput {
  readonly state: BossState;
  readonly phase: number;
  readonly attack: string | null;
  readonly attackTime: number;
  readonly stateTime: number;
  readonly starshell: StarshellSnapshot | null;
  readonly starshellBreaks: number;
  readonly vulnerable: boolean;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _head = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

const shortAttack = (id: string | null): CaelithAttack | null => {
  if (id === null) return null;
  const name = id.replace(/^atk_caelith_/, '');
  return (CAELITH_ATTACKS as readonly string[]).includes(name) ? (name as CaelithAttack) : null;
};

export class CaelithView {
  /** Unplaced group: the model places itself; halo and Starshell are drawn in world space. */
  readonly object = new THREE.Group();
  readonly view: EntityView;
  readonly anim: AnimatedView;
  readonly halo: THREE.InstancedMesh;
  readonly starshell: ElementShell;
  private readonly haloMaterial: THREE.MeshBasicMaterial;
  private lastAttack: CaelithAttack | null = null;
  private seenBreaks = -1;
  private glow = 0;
  private haloAngle = 0;
  private time = 0;
  private readonly lastPos = new THREE.Vector3();
  private hasLast = false;

  constructor(library: VisualLibrary) {
    this.object.name = 'caelith';
    this.view = library.createView('caelith');
    this.view.object.name = 'caelith:model';
    this.view.setGlow(0);
    this.anim = new AnimatedView(this.view, { clips: CAELITH_CLIP_LIST, procedural: humanoidProcedural });
    this.haloMaterial = new THREE.MeshBasicMaterial({ color: HALO_COLOR.clone(), transparent: true, opacity: 0.95, depthWrite: false });
    this.haloMaterial.name = 'caelith:halo';
    this.halo = new THREE.InstancedMesh(haloShardGeometry(), this.haloMaterial, CAELITH_HALO.count);
    this.halo.name = 'caelith:halo';
    this.halo.frustumCulled = false;
    this.starshell = new ElementShell({ radius: STARSHELL_RADIUS, center: [0, 0, 0], opacity: 0.8 });
    this.starshell.mesh.name = 'caelith:starshell';
    this.object.add(this.view.object, this.halo, this.starshell.mesh);
  }

  /** Crack glow now (`uGlow` 0 in Phases 1–2, 1 in the Final Phase). */
  get crackGlow(): number {
    return this.glow;
  }

  /**
   * Places and animates Caelith: feet `pos`, facing `yaw`, `dt` scaled s (the attack clock is interpolated back by
   * `(1 − alpha)` of a tick); `shown` false hides everything (dormant, or gone after death).
   */
  update(input: CaelithViewInput, pos: Readonly<Vec3>, yaw: number, dt: number, alpha = 1, shown = true): void {
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    this.time += step;
    this.object.visible = shown;
    if (!shown) {
      this.starshell.hide();
      this.hasLast = false;
      return;
    }
    this.view.setPose(pos, yaw);
    const back = (1 - Math.min(1, Math.max(0, alpha))) * SIM_DT;
    const attack = shortAttack(input.attack);
    if (attack !== null) this.lastAttack = attack;
    const speed = this.hasLast && step > 0 ? Math.hypot(pos.x - this.lastPos.x, pos.z - this.lastPos.z) / step : 0;
    this.lastPos.set(pos.x, pos.y, pos.z);
    this.hasLast = true;
    const req = selectBossAnim({
      state: input.state, phase: input.phase, attack, attackTime: Math.max(0, input.attackTime - back),
      stateTime: Math.max(0, input.stateTime), lastAttack: input.state === 'recovery' ? this.lastAttack : null, speed: Math.min(speed, 8),
    }, (a) => CAELITH_ATTACK_CLIPS[a]);
    this.view.object.updateMatrixWorld(true);
    this.anim.update(step, req, { grounded: false, speed, yawRate: 0, lean: 'none', sprinting: false, landing: null, lookAt: null });
    // Final Phase cracks; transition / vulnerable flashes.
    const final = input.phase >= 3 && input.state !== 'dead';
    this.glow = Math.min(1, Math.max(0, this.glow + (final ? 1 : -1) * GLOW_RATE * step));
    this.view.setGlow(this.glow);
    if (input.state === 'transition') this.view.setFlash(0.35 + 0.25 * Math.sin(this.time * 12), TRANSITION_COLOR);
    else if (input.vulnerable) this.view.setFlash(0.18 + 0.1 * Math.sin(this.time * 8), VULNERABLE_COLOR);
    else this.view.setFlash(0);
    const dying = input.state === 'dead' ? Math.min(1, Math.max(0, (input.stateTime - DEATH_DISSOLVE_DELAY) / DEATH_DISSOLVE_SECONDS)) : 0;
    this.view.setDissolve(dying, true);
    this.view.update(step, { x: 0.8, y: 0, z: 0.4 });
    // Starshell round the body centre.
    const centre: Vec3 = { x: pos.x, y: pos.y + this.view.instance.height * 0.5, z: pos.z };
    this.starshell.mesh.position.set(centre.x, centre.y, centre.z);
    if (this.seenBreaks >= 0 && input.starshellBreaks > this.seenBreaks) this.starshell.shatter();
    this.seenBreaks = input.starshellBreaks;
    if (input.starshell !== null && input.state !== 'dead') this.starshell.show(input.starshell.element, input.starshell.durability / Math.max(1, input.starshell.max));
    else this.starshell.hide();
    this.starshell.update(step);
    this.updateHalo(final, dying, yaw, step);
  }

  /** The 8 halo shards on their ring behind the head (instance matrices only); scattering while Caelith dissolves. */
  private updateHalo(final: boolean, dying: number, yaw: number, dt: number): void {
    const head = this.view.instance.joints.get('head');
    if (head === undefined) return;
    head.getWorldPosition(_head);
    _fwd.set(Math.sin(yaw), 0, Math.cos(yaw));
    _right.crossVectors(UP, _fwd).normalize();
    const radius = final ? FINAL_HALO_RADIUS : CAELITH_HALO.radius;
    this.haloAngle = (this.haloAngle + dt * (final ? 0.9 : 0.45)) % (Math.PI * 2);
    const n = CAELITH_HALO.count;
    const scatter = dying * dying;
    for (let i = 0; i < n; i++) {
      const a = this.haloAngle + (i / n) * Math.PI * 2;
      const r = radius * (1 + scatter * 3);
      // Ring in the plane behind the head (spanned by right and up), each shard pointing outward.
      _p.copy(_head).addScaledVector(_fwd, -0.6 - scatter * 2).addScaledVector(_right, Math.cos(a) * r).addScaledVector(UP, 0.35 + Math.sin(a) * r + scatter * 6 * (0.6 + 0.4 * Math.sin(i * 1.7)));
      const outward = _s.copy(_right).multiplyScalar(Math.cos(a)).addScaledVector(UP, Math.sin(a)).normalize();
      _q.setFromUnitVectors(UP, outward);
      const size = (final ? 1.25 : 1) * (1 - 0.6 * scatter);
      _m.compose(_p, _q, _s.set(size, size, size));
      this.halo.setMatrixAt(i, _m);
    }
    this.halo.instanceMatrix.needsUpdate = true;
    this.haloMaterial.color.copy(HALO_COLOR).multiplyScalar(final ? 1.4 : 1);
    this.haloMaterial.opacity = 0.95 * (1 - dying);
  }

  dispose(): void {
    this.anim.dispose();
    this.view.dispose();
    this.halo.geometry.dispose();
    this.haloMaterial.dispose();
    this.halo.dispose();
    this.starshell.dispose();
    this.object.clear();
  }
}
