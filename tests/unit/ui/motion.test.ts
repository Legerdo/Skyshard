import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UiScreenId } from '../../../src/core/gameEvents';
import { MOTION_SECONDS, motionSpec, playMotion, prefersReducedMotion, type MotionHandle } from '../../../src/ui/motion';
import { ScreenManager, screenMotion, type Screen } from '../../../src/ui/screenManager';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('motionSpec', () => {
  it('opens a panel over 0.2 s ease-out (opacity, translateY 12 px, scale 0.97) and closes it over 0.15 s', () => {
    expect(MOTION_SECONDS).toEqual({ open: 0.2, close: 0.15, fullscreen: 0.3, reduced: 0.1 });
    const open = motionSpec('panel', 'open', false);
    expect(open).toEqual({
      keyframes: [{ opacity: 0, transform: 'translateY(12px) scale(0.97)' }, { opacity: 1, transform: 'none' }],
      duration: 200,
      easing: 'ease-out',
    });
    const close = motionSpec('panel', 'close', false);
    expect(close?.duration).toBe(150);
    expect(close?.keyframes).toEqual([...(open?.keyframes ?? [])].reverse());
  });

  it('moves full-screen screens 16 px over 0.3 s', () => {
    for (const phase of ['open', 'close'] as const) {
      const spec = motionSpec('fullscreen', phase, false);
      expect(spec?.duration).toBe(300);
      expect(JSON.stringify(spec?.keyframes)).toContain('translateY(16px)');
    }
  });

  it('with reduced motion changes only the opacity, over 0.1 s, for every kind', () => {
    for (const kind of ['panel', 'fullscreen', 'fade'] as const) {
      for (const phase of ['open', 'close'] as const) {
        const spec = motionSpec(kind, phase, true);
        expect(spec?.duration, `${kind} ${phase}`).toBe(100);
        for (const frame of spec?.keyframes ?? []) expect(Object.keys(frame)).toEqual(['opacity']);
        expect(spec?.keyframes[0].opacity).toBe(phase === 'open' ? 0 : 1);
      }
    }
    expect(motionSpec('none', 'open', false)).toBeNull();
    expect(motionSpec('none', 'close', true)).toBeNull();
    expect(motionSpec('fade', 'open', false)?.duration).toBe(200);
  });

  it('picks the default motion per screen', () => {
    expect(screenMotion({ id: 'map' })).toBe('fullscreen');
    expect(screenMotion({ id: 'gameplay' })).toBe('fade');
    expect(screenMotion({ id: 'settings' })).toBe('panel');
    expect(screenMotion({ id: 'map', motion: 'none' })).toBe('none');
  });
});

describe('motion guards outside a browser', () => {
  it('prefersReducedMotion is false without matchMedia, follows it when present and survives a throw', () => {
    expect(prefersReducedMotion()).toBe(false); // Node: no matchMedia
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(prefers-reduced-motion: reduce)' }));
    expect(prefersReducedMotion()).toBe(true);
    vi.stubGlobal('matchMedia', () => {
      throw new Error('blocked');
    });
    expect(prefersReducedMotion()).toBe(false);
  });

  it('playMotion needs the Web Animations API and holds the last frame only when closing', () => {
    const spec = motionSpec('panel', 'open', false);
    expect(playMotion({}, spec, 'open')).toBeNull();
    expect(playMotion(null, spec, 'open')).toBeNull();
    const calls: KeyframeAnimationOptions[] = [];
    const handle: MotionHandle = { finished: Promise.resolve(), cancel: () => undefined };
    const el = { animate: (_k: Keyframe[], o: KeyframeAnimationOptions) => (calls.push(o), handle) };
    expect(playMotion(el, null, 'open')).toBeNull();
    expect(playMotion(el, spec, 'open')).toBe(handle);
    expect(playMotion(el, motionSpec('panel', 'close', false), 'close')).toBe(handle);
    expect(calls).toEqual([
      { duration: 200, easing: 'ease-out', fill: 'none' },
      { duration: 150, easing: 'ease-in', fill: 'forwards' },
    ]);
    const broken = { animate: () => { throw new Error('no'); } };
    expect(playMotion(broken, spec, 'open')).toBeNull();
  });
});

/** An animatable stand-in element: records its animations, which finish when the test says so. */
function animatedElement() {
  const animations: { options: KeyframeAnimationOptions; finish: () => void; cancelled: boolean }[] = [];
  const attrs = new Set<string>();
  const el = {
    inert: false,
    isConnected: true,
    attrs,
    animations,
    animate(_k: Keyframe[], options: KeyframeAnimationOptions): MotionHandle {
      let finish = (): void => undefined;
      const finished = new Promise<void>((resolve) => {
        finish = () => resolve();
      });
      const record = { options, finish, cancelled: false };
      animations.push(record);
      return { finished, cancel: () => void (record.cancelled = true) };
    },
    setAttribute: (name: string) => void attrs.add(name),
    removeAttribute: (name: string) => void attrs.delete(name),
  };
  return el;
}

type AnimatedElement = ReturnType<typeof animatedElement>;

/** A root whose `children` the manager diffs around `mount`. */
function fakeRoot() {
  return { children: [] as AnimatedElement[] };
}

function animatedScreen(id: UiScreenId, root: ReturnType<typeof fakeRoot>) {
  const el = animatedElement();
  const screen: Screen & { el: AnimatedElement; unmounted: number } = {
    id,
    context: 'menu',
    el,
    unmounted: 0,
    mount: () => void root.children.push(el),
    unmount: () => {
      screen.unmounted++;
      root.children.splice(root.children.indexOf(el), 1);
    },
    onInput: () => false,
    focusables: () => [],
  };
  return screen;
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('ScreenManager transition motion', () => {
  it('opens with the motion, and a popped screen stays inert until its closing motion has finished', async () => {
    const root = fakeRoot();
    const ui = new ScreenManager({ root: root as unknown as HTMLElement, reducedMotion: () => false });
    const title = animatedScreen('title', root);
    const settings = animatedScreen('settings', root);
    ui.push(title);
    ui.push(settings);
    expect(settings.el.animations.map((a) => a.options.duration)).toEqual([200]);
    ui.pop();
    // Out of the stack at once (input goes to the Title), DOM kept inert while the 0.15 s motion plays.
    expect([ui.ids, ui.closingCount, settings.unmounted]).toEqual([['title'], 1, 0]);
    expect(settings.el.animations[0].cancelled).toBe(true); // the open motion stopped
    expect(settings.el.animations[1].options).toMatchObject({ duration: 150, fill: 'forwards' });
    expect([settings.el.inert, settings.el.attrs.has('inert')]).toEqual([true, true]);
    settings.el.animations[1].finish();
    await flush();
    expect([ui.closingCount, settings.unmounted, settings.el.inert]).toEqual([0, 1, false]);
    expect(settings.el.animations[1].cancelled).toBe(true); // the held last frame is released
    expect(root.children).toEqual([title.el]);
  });

  it('unmounts anyway after the motion time plus a grace period when `finished` never settles', () => {
    vi.useFakeTimers();
    const root = fakeRoot();
    const ui = new ScreenManager({ root: root as unknown as HTMLElement, reducedMotion: () => true });
    const map = animatedScreen('map', root);
    ui.push(map);
    expect(map.el.animations[0].options.duration).toBe(100); // reduced motion
    ui.pop();
    expect(map.unmounted).toBe(0);
    vi.advanceTimersByTime(100 + 150);
    expect([map.unmounted, ui.closingCount]).toEqual([1, 0]);
  });

  it('a screen pushed again while still closing is unmounted first; without motion it unmounts at once', () => {
    const root = fakeRoot();
    const ui = new ScreenManager({ root: root as unknown as HTMLElement, reducedMotion: () => false });
    const pause = animatedScreen('pause', root);
    ui.push(pause);
    ui.pop();
    ui.push(pause);
    expect([pause.unmounted, ui.closingCount, root.children.length]).toEqual([1, 0, 1]);

    const still = new ScreenManager({ root: fakeRoot() as unknown as HTMLElement, motion: false });
    const other = animatedScreen('pause', fakeRoot());
    still.push(other);
    still.pop();
    expect([other.unmounted, other.el.animations.length]).toEqual([1, 0]);
  });
});
