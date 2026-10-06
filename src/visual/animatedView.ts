/*
 * An EntityView driven by the Animation_System: its Animator (clip layers) and procedural layers, rebuilt when the view
 * swaps to another VisualInstance (a loaded external model brings other joints). A model whose joints do not take
 * the clips (an external model missing a joint) warns once and stands still instead of stopping the game.
 */
import { Animator, type AnimatorEvent, type AnimRequest, type BlendDef } from '../anim/animator';
import type { PoseClip } from '../anim/clip';
import { ProceduralLayers, type ProceduralFrame, type ProceduralOptions } from '../anim/procedural';
import type { EntityView } from './entityView';
import type { VisualInstance } from './types';

export interface AnimatedViewOptions {
  readonly clips: readonly PoseClip[];
  readonly blends?: Readonly<Record<string, BlendDef>>;
  /** Procedural layers for this rig (null: none), built from the instance's height. */
  readonly procedural?: ((instance: VisualInstance) => ProceduralOptions) | null;
  readonly warn?: (message: string) => void;
}

const NO_EVENTS: readonly AnimatorEvent[] = [];

export class AnimatedView {
  animator: Animator | null = null;
  procedural: ProceduralLayers | null = null;
  private readonly off: () => void;
  /** What an external model may ask about the pose clips (their durations, the blends). */
  private readonly clipContext: { clip(name: string): PoseClip | undefined; readonly blends?: Readonly<Record<string, BlendDef>> };

  constructor(readonly view: EntityView, private readonly options: AnimatedViewOptions) {
    this.clipContext = { clip: (name) => this.animator?.clip(name), blends: options.blends };
    this.bind(view.instance);
    this.off = view.onSwap((_v, next) => this.bind(next));
  }

  private bind(instance: VisualInstance): void {
    try {
      this.animator = new Animator(instance.joints, this.options.clips, { name: this.view.id, blends: this.options.blends });
    } catch (error) {
      this.animator = null;
      (this.options.warn ?? ((m: string) => console.warn(m)))(`animation ${this.view.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const proc = this.options.procedural;
    this.procedural = proc === undefined || proc === null ? null : new ProceduralLayers(instance.root, instance.joints, proc(instance));
  }

  /**
   * Poses the rig for this frame: clips, then the procedural layers (when `frame` is given); an external model then
   * receives the request (its own mixer clips, retarget or generic root motion, task 19.8).
   */
  update(dt: number, req: AnimRequest, frame?: ProceduralFrame): readonly AnimatorEvent[] {
    const events = this.animator === null ? NO_EVENTS : this.animator.update(dt, req);
    if (frame !== undefined) this.procedural?.apply(dt, frame);
    this.view.instance.animate?.(dt, req, this.clipContext);
    return events;
  }

  dispose(): void {
    this.off();
  }
}

/** Procedural options of a humanoid (feet on the ground, breathing, look-at, lean). */
export const humanoidProcedural = (instance: VisualInstance): ProceduralOptions => ({
  height: instance.height, feet: ['leftFoot', 'rightFoot'],
});
