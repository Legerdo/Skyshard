/*
 * The Active_Character on screen (task 19.2): one EntityView per hero from the VisualLibrary (procedural rigs by
 * default), only the active one visible. Replaces the temporary capsule; the collision capsule and the sim are
 * unchanged (the rig's soles sit on the capsule bottom = the pose position).
 *
 * Per frame (task 19.4, all in the clips' scaled time): the pose from the sim (feet, yaw); `selectAnimState` from the
 * controller mode and the playing attack (its clip driven by the sim's attack clock, render-interpolated); the
 * Animator's three layers and the procedural layers (pelvis height, breathing, look-at, lean, landing squash); the
 * weapon on the back while climbing / gliding / swimming; springs and face; the Element glow (`uGlow` 0.3, 1.0 while a
 * Skill or Burst is cast); the 0.4 s `hurt` clip with a red flush (Req 26.7); the weapon trail anchors between the
 * attack clip's `trail:on` / `trail:off` events (closed when the clip is cut off) and Isla's bow string following her
 * drawing hand between `draw:on` / `draw:off`; the camera near-fade (Req 21.4). A party switch shows the new hero with
 * its chains at rest; a teleport resets them too. Portraits are rendered once at load and again after a swap.
 */
import * as THREE from 'three';
import type { AnimatorEvent } from '../anim/animator';
import { climbDirection, HERO_BLENDS, HERO_HURT_SECONDS, selectAnimState } from '../anim/animState';
import { heroClips } from '../anim/clips';
import { SIM_DT } from '../core/loop';
import type { Vec3 } from '../core/types';
import { CHARACTERS } from '../data/characters';
import { CHARACTER_IDS, type CharacterId, type ElementId } from '../data/ids';
import { PARTY_SLOTS } from '../logic/party';
import { RUN_SPEED } from '../player/core/constants';
import { AnimatedView, humanoidProcedural } from './animatedView';
import type { EntityView } from './entityView';
import { renderPortrait } from './portrait';
import { ProceduralVisualInstance } from './proceduralProvider';
import type { VisualInstance } from './types';
import type { VisualLibrary } from './visualLibrary';

export const HERO_IDLE_GLOW = 0.3;
export const HERO_CAST_GLOW = 1.0;
export const HURT_SECONDS = HERO_HURT_SECONDS;
const HURT_COLOR = 0xff3040;
/** Global breeze for the spring chains (m/s, world). */
const BREEZE = { x: 0.6, y: 0, z: 0.35 };
const AIR = new Set(['jump', 'fall', 'glide', 'glideDeploy', 'climbLeap', 'slide']);

/** What the heroes read from the sim each frame. */
export interface HeroViewState {
  readonly active: CharacterId;
  readonly mode: string;
  readonly vel: Readonly<Vec3>;
  /** Seconds in the mode at the end of the last tick. */
  readonly modeTime?: number;
  /** The attack playing (its AttackDef clip and seconds since it started at the end of the last tick), or null. */
  readonly attack?: { readonly def: { readonly clip: string }; readonly t: number } | null;
  /** Where the head turns (Lock-on target, else a nearby NPC), or null. */
  readonly lookAt?: Readonly<Vec3> | null;
}

/** The weapon-trail sink (VfxSystem.trailSample / trailEnd). */
export interface TrailSink {
  sample(key: string, tip: Readonly<Vec3>, base: Readonly<Vec3>, element: ElementId | null): void;
  end(key: string): void;
}

export interface HeroViewsOptions {
  readonly library: VisualLibrary;
  readonly state: () => HeroViewState;
}

const _tip = new THREE.Vector3();
const _base = new THREE.Vector3();
const _hand = new THREE.Vector3();

export class HeroViews {
  readonly object = new THREE.Group();
  /** Weapon trails go here (set by the session once the VFX exist). */
  trailSink: TrailSink | null = null;
  private readonly views = new Map<CharacterId, EntityView>();
  private readonly animated = new Map<CharacterId, AnimatedView>();
  private readonly glowLeft = new Map<CharacterId, number>();
  private readonly unsubscribe: (() => void)[] = [];
  private portraitSink: ((slot: number, url: string) => void) | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private active: CharacterId | null = null;
  private hurtLeft = 0;
  private opacity = 1;
  /** Reset the active hero's chains to rest on the next update (switch, teleport, first frame). */
  private pendingReset = true;
  private yaw = 0;
  private lastYaw: number | null = null;
  private lastMode = 'grounded';
  private lastVy = 0;
  private trailOn = false;
  private drawing = false;
  private actionClip: string | null = null;

  constructor(private readonly options: HeroViewsOptions) {
    this.object.name = 'heroes';
    for (const id of CHARACTER_IDS) {
      const view = options.library.createView(id);
      view.object.visible = false;
      view.setGlow(HERO_IDLE_GLOW);
      this.views.set(id, view);
      this.animated.set(id, new AnimatedView(view, { clips: heroClips(id), blends: HERO_BLENDS, procedural: humanoidProcedural }));
      this.unsubscribe.push(view.onSwap((_v, next) => this.swapped(id, next)));
      this.object.add(view.object);
    }
  }

  /** The view of a hero (tests, debug tools). */
  view(id: CharacterId): EntityView {
    return this.views.get(id)!;
  }

  /** The hero's Animator and procedural layers (tests, debug tools). */
  animation(id: CharacterId): AnimatedView {
    return this.animated.get(id)!;
  }

  private swapped(id: CharacterId, _next: VisualInstance): void {
    this.renderPortraitOf(id);
  }

  /** Feet position and facing of the Active_Character (interpolated pose). */
  setPose(pos: Readonly<Vec3>, yaw: number): void {
    const id = this.options.state().active;
    this.setActive(id);
    this.views.get(id)!.setPose(pos, yaw);
    this.yaw = yaw;
  }

  private setActive(id: CharacterId): void {
    if (id === this.active) return;
    if (this.active !== null) {
      this.views.get(this.active)!.object.visible = false;
      this.closeTrail(this.active);
    }
    this.active = id;
    const view = this.views.get(id)!;
    view.object.visible = true;
    view.setOpacity(this.opacity);
    this.animated.get(id)!.procedural?.reset();
    // Switch: the new hero's chains start at rest (after this frame's pose is placed, see update()).
    this.pendingReset = true;
  }

  /** The Active_Character took damage: (re)start the 0.4 s hurt clip. */
  hurt(): void {
    this.hurtLeft = HURT_SECONDS;
  }

  get hurtRemaining(): number {
    return this.hurtLeft;
  }

  /** A Skill / Burst cast: the hero's Element glow lines at 1.0 for `seconds` (the cast), then back to 0.3. */
  cast(id: CharacterId, seconds: number): void {
    this.glowLeft.set(id, Math.max(this.glowLeft.get(id) ?? 0, Number.isFinite(seconds) ? seconds : 0));
    this.views.get(id)?.setGlow(HERO_CAST_GLOW);
  }

  /** A teleport / respawn / fast travel: chains back to rest at the new place. */
  teleported(): void {
    this.pendingReset = true;
    this.lastYaw = null;
  }

  /**
   * Advances the animation, springs, face, glow and hurt flush by `dt` scaled s; `alpha` is the render interpolation
   * of the last tick (attack and mode clocks are interpolated with it).
   */
  update(dt: number, alpha = 1): void {
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    const state = this.options.state();
    this.setActive(state.active);
    for (const [id, left] of this.glowLeft) {
      const next = left - step;
      if (next <= 0) {
        this.glowLeft.delete(id);
        this.views.get(id)?.setGlow(HERO_IDLE_GLOW);
      } else {
        this.glowLeft.set(id, next);
      }
    }
    const id = state.active;
    const view = this.views.get(id)!;
    const anim = this.animated.get(id)!;
    const back = (1 - Math.min(1, Math.max(0, Number.isFinite(alpha) ? alpha : 1))) * SIM_DT;
    const hurtTime = this.hurtLeft > 0 ? HURT_SECONDS - this.hurtLeft : null;
    this.hurtLeft = Math.max(0, this.hurtLeft - step);
    view.setFlash(0.6 * (this.hurtLeft / HURT_SECONDS), HURT_COLOR);
    const speed = Math.hypot(state.vel.x, state.vel.z);
    const attack = state.attack ?? null;
    const selected = selectAnimState({
      mode: state.mode,
      modeTime: Math.max(0, (state.modeTime ?? 0) - back),
      speed,
      climb: climbDirection(state.vel, this.yaw),
      attack: attack === null ? null : { clip: attack.def.clip, time: Math.max(0, attack.t - back) },
      hurtTime,
    });
    // Yaw rate for the lean, the landing impact for the squash.
    let yawRate = 0;
    if (this.lastYaw !== null && step > 0) {
      let d = this.yaw - this.lastYaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      yawRate = d / step;
    }
    this.lastYaw = this.yaw;
    const landed = AIR.has(this.lastMode) && (state.mode === 'landing' || state.mode === 'grounded') ? Math.max(0, -this.lastVy) : null;
    this.lastMode = state.mode;
    this.lastVy = state.vel.y;
    view.object.updateMatrixWorld(true);
    const events = anim.update(step, selected, {
      grounded: selected.grounded, speed, yawRate, lean: selected.lean, sprinting: state.mode === 'grounded' && speed > RUN_SPEED + 0.5,
      landing: landed, lookAt: state.lookAt ?? null,
    });
    view.instance.stowWeapon(selected.weaponOnBack);
    if (this.pendingReset) {
      this.pendingReset = false;
      view.object.updateMatrixWorld(true);
      view.instance.resetSecondary();
    }
    view.update(step, BREEZE);
    this.handleEvents(id, events, anim.animator?.current('action') ?? null);
  }

  /** Trail window and bow draw from the action clip's events; a cut-off clip closes both. */
  private handleEvents(id: CharacterId, events: readonly AnimatorEvent[], actionClip: string | null): void {
    if (actionClip !== this.actionClip) {
      this.closeTrail(id);
      this.drawing = false;
      this.actionClip = actionClip;
    }
    for (const e of events) {
      if (e.layer !== 'action' || e.event.kind !== 'vfx') continue;
      if (e.event.data === 'trail:on') this.trailOn = true;
      else if (e.event.data === 'trail:off') this.closeTrail(id);
      else if (e.event.data === 'draw:on') this.drawing = true;
      else if (e.event.data === 'draw:off') this.drawing = false;
    }
    const instance = this.views.get(id)!.instance;
    const weapon = instance instanceof ProceduralVisualInstance ? instance.rig.weapon : instance.weapon ?? null;
    if (weapon === null) return;
    const hand = instance.joints.get('rightHand');
    if (this.drawing && hand !== undefined) weapon.update?.(hand.getWorldPosition(_hand));
    else weapon.update?.(null);
    if (this.trailOn && this.trailSink !== null) {
      weapon.mesh.updateWorldMatrix(true, false);
      _tip.copy(weapon.anchors.tip).applyMatrix4(weapon.mesh.matrixWorld);
      _base.copy(weapon.anchors.base).applyMatrix4(weapon.mesh.matrixWorld);
      this.trailSink.sample(`hero:${id}`, _tip, _base, CHARACTERS[id].element);
    }
  }

  private closeTrail(id: CharacterId): void {
    if (this.trailOn) this.trailSink?.end(`hero:${id}`);
    this.trailOn = false;
  }

  /** Camera near-fade of the Active_Character (1 opaque). */
  setOpacity(opacity: number): void {
    this.opacity = opacity;
    if (this.active !== null) this.views.get(this.active)!.setOpacity(opacity);
  }

  /**
   * Renders the four 64 × 64 portraits now and hands each to `sink(slot, url)` (slot = PARTY_SLOTS index); later swaps
   * re-render. No renderer (headless) → nothing.
   */
  renderPortraits(renderer: THREE.WebGLRenderer | null, sink: (slot: number, url: string) => void): void {
    this.renderer = renderer;
    this.portraitSink = sink;
    if (renderer === null) return;
    for (const id of CHARACTER_IDS) this.renderPortraitOf(id);
  }

  private renderPortraitOf(id: CharacterId): void {
    if (this.renderer === null || this.portraitSink === null) return;
    const view = this.views.get(id);
    if (view === undefined) return;
    let url: string | null = null;
    try {
      url = renderPortrait(this.renderer, view.instance);
    } catch (error) {
      console.warn(`portrait ${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const slot = (PARTY_SLOTS as readonly CharacterId[]).indexOf(id);
    if (url !== null && slot >= 0) this.portraitSink(slot, url);
  }

  dispose(): void {
    for (const off of this.unsubscribe.splice(0)) off();
    for (const a of this.animated.values()) a.dispose();
    this.animated.clear();
    for (const view of this.views.values()) view.dispose();
    this.views.clear();
    this.object.clear();
  }
}
