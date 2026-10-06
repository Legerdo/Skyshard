/*
 * EntityView (design.md "시각 모델 교체 구조"): the presentation object of one entity. The sim decides where it stands
 * (setPose: feet position and yaw, controller convention: yaw 0 faces +Z, positive turns toward +X); the view holds
 * the current VisualInstance under `object` and can swap it live (`swapVisual`) without stopping gameplay: the new
 * instance inherits opacity, glow, flash and visibility, the old one is disposed and swap listeners run (the party HUD
 * re-renders its portrait, Req 43.8).
 */
import * as THREE from 'three';
import type { Vec3 } from '../core/types';
import type { VisualEntityId } from '../data/ids';
import type { VisualInstance } from './types';

export type SwapListener = (view: EntityView, next: VisualInstance, previous: VisualInstance) => void;

export class EntityView {
  /** Placed at the feet and turned by yaw; the instance root is its only visual child. */
  readonly object = new THREE.Group();
  private current: VisualInstance;
  private readonly listeners = new Set<SwapListener>();
  private opacity = 1;
  private glow: number | null = null;
  private flash = { t: 0, color: 0xffffff as THREE.ColorRepresentation };
  private dissolve = { amount: 0, rise: false };
  private disposed = false;

  constructor(readonly id: VisualEntityId, initial: VisualInstance) {
    this.object.name = `entity:${id}`;
    this.object.rotation.order = 'YXZ'; // yaw, then a lean about the turned local X axis
    this.current = initial;
    this.object.add(initial.root);
  }

  get instance(): VisualInstance {
    return this.current;
  }

  /** Feet position and facing (rad). */
  setPose(pos: Readonly<Vec3>, yaw: number): void {
    this.object.position.set(pos.x, pos.y, pos.z);
    this.object.rotation.y = yaw;
  }

  setOpacity(a: number): void {
    this.opacity = Number.isFinite(a) ? Math.min(1, Math.max(0, a)) : 1;
    this.current.setOpacity(this.opacity);
  }

  setGlow(v: number): void {
    this.glow = v;
    this.current.setGlow(v);
  }

  setFlash(t: number, color: THREE.ColorRepresentation = 0xffffff): void {
    this.flash = { t, color };
    this.current.setFlash(t, color);
  }

  /** Death dissolve 0 → 1 (`rise`: from the feet up); instances without one ignore it. */
  setDissolve(amount: number, rise = false): void {
    this.dissolve = { amount, rise };
    this.current.setDissolve?.(amount, rise);
  }

  /** Replaces the visual now (a loaded external model, an equipment change); the old instance is disposed. */
  swapVisual(next: VisualInstance): void {
    if (next === this.current) return;
    if (this.disposed) {
      next.dispose(); // a model that finished loading after its entity left
      return;
    }
    const previous = this.current;
    this.object.remove(previous.root);
    this.object.add(next.root);
    this.current = next;
    next.setOpacity(this.opacity);
    if (this.glow !== null) next.setGlow(this.glow);
    next.setFlash(this.flash.t, this.flash.color);
    if (this.dissolve.amount > 0) next.setDissolve?.(this.dissolve.amount, this.dissolve.rise);
    this.object.updateMatrixWorld(true);
    next.resetSecondary();
    for (const listener of [...this.listeners]) listener(this, next, previous);
    previous.dispose();
  }

  /** Called after every swap (before the old instance is disposed); returns an unsubscribe function. */
  onSwap(listener: SwapListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  update(dt: number, wind?: Readonly<{ x: number; y: number; z: number }>): void {
    this.current.update(dt, wind);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear();
    this.object.remove(this.current.root);
    this.current.dispose();
  }
}
