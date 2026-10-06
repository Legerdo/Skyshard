/*
 * Screen transition motion (design "전환 motion", "동작 줄이기", Req 31.6; task 14.1). Opening plays opacity 0 → 1,
 * translateY 12 px → 0 and scale 0.97 → 1 over 0.2 s ease-out, closing the reverse over 0.15 s; full-screen screens
 * (Map) move 16 px over 0.3 s. With `prefers-reduced-motion: reduce` only the opacity changes, over 0.1 s (an
 * intended exception to 0.15–0.3 s). The Web Animations API plays it; where `animate` is missing (Node, old
 * browsers) nothing plays and the ScreenManager unmounts closing screens at once.
 */

/** How a screen moves: a panel over the game, a full-screen layer, a plain fade (the HUD) or not at all. */
export type ScreenMotion = 'panel' | 'fullscreen' | 'fade' | 'none';
export type MotionPhase = 'open' | 'close';

export const MOTION_SECONDS = {
  open: 0.2,
  close: 0.15,
  fullscreen: 0.3,
  reduced: 0.1,
} as const;

export interface MotionSpec {
  readonly keyframes: Keyframe[];
  /** ms. */
  readonly duration: number;
  readonly easing: string;
}

/** Keyframes and timing of a screen's open / close motion; null for 'none'. */
export function motionSpec(kind: ScreenMotion, phase: MotionPhase, reduced: boolean): MotionSpec | null {
  if (kind === 'none') return null;
  const opening = phase === 'open';
  if (reduced || kind === 'fade') {
    const seconds = reduced ? MOTION_SECONDS.reduced : opening ? MOTION_SECONDS.open : MOTION_SECONDS.close;
    const frames = [{ opacity: 0 }, { opacity: 1 }];
    return { keyframes: opening ? frames : frames.reverse(), duration: seconds * 1000, easing: 'linear' };
  }
  const full = kind === 'fullscreen';
  const hidden = { opacity: 0, transform: full ? 'translateY(16px)' : 'translateY(12px) scale(0.97)' };
  const shown = { opacity: 1, transform: 'none' };
  const seconds = full ? MOTION_SECONDS.fullscreen : opening ? MOTION_SECONDS.open : MOTION_SECONDS.close;
  return {
    keyframes: opening ? [hidden, shown] : [shown, hidden],
    duration: seconds * 1000,
    easing: opening ? 'ease-out' : 'ease-in',
  };
}

/** `matchMedia('(prefers-reduced-motion: reduce)')`, false where it cannot be asked. */
export function prefersReducedMotion(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** The part of a Web Animation the ScreenManager uses. */
export interface MotionHandle {
  readonly finished: Promise<unknown>;
  cancel(): void;
}

/**
 * Plays `spec` on `element` and returns the animation, or null when the element cannot animate (no Web Animations
 * API) or there is nothing to play. Closing motion holds its last frame (`fill: 'forwards'`) until cancelled.
 */
export function playMotion(element: unknown, spec: MotionSpec | null, phase: MotionPhase): MotionHandle | null {
  if (spec === null) return null;
  const el = element as { animate?: (k: Keyframe[], o: KeyframeAnimationOptions) => MotionHandle } | null;
  if (el === null || typeof el?.animate !== 'function') return null;
  try {
    return el.animate(spec.keyframes, {
      duration: spec.duration,
      easing: spec.easing,
      fill: phase === 'close' ? 'forwards' : 'none',
    });
  } catch {
    return null;
  }
}
