import { describe, expect, it } from 'vitest';
import {
  CROSS_AXIS_WEIGHT,
  focusScore,
  hasLayout,
  NAV_REPEAT_DELAY,
  NAV_REPEAT_INTERVAL,
  navHandlerOf,
  NavRepeater,
  nextFocusIndex,
  pickGeometric,
  readRect,
  setNavHandler,
  type FocusRect,
} from '../../../src/ui/focusNav';
import { FOCUSED_CLASS, ScreenManager, type UiFeedback } from '../../../src/ui/screenManager';
import { FAKE_ROOT, fakeElement, fakeScreen, type FakeElement } from './fakes';

const rect = (left: number, top: number, width = 100, height = 40): FocusRect => ({ left, top, width, height });

/** A stand-in element laid out at `r` (the manager reads `getBoundingClientRect`). */
function placed(name: string, r: FocusRect): FakeElement {
  return Object.assign(fakeElement(name), { getBoundingClientRect: () => r });
}

describe('FocusNav geometry: main-axis distance + 2 × cross-axis offset', () => {
  it('scores candidates on the side of the direction only, with a zero offset where the rects overlap', () => {
    expect(CROSS_AXIS_WEIGHT).toBe(2);
    const from = rect(0, 0);
    expect(focusScore(from, rect(0, 100), 'down')).toBe(100); // aligned below
    expect(focusScore(from, rect(50, 100), 'down')).toBe(100); // partial overlap: offset 0
    expect(focusScore(from, rect(150, 100), 'down')).toBe(100 + 2 * 50); // 50 px apart on x
    expect(focusScore(from, rect(200, 50), 'right')).toBe(200 + 2 * 10); // 10 px apart on y
    expect(focusScore(from, rect(0, 100), 'up')).toBeNull();
    expect(focusScore(from, rect(0, 0), 'down')).toBeNull(); // same centre: not on that side
    expect(focusScore(rect(0, 100), from, 'up')).toBe(100);
    expect(focusScore(rect(200, 0), from, 'left')).toBe(200);
  });

  it('moves through a grid by its visible layout and stays at the edge', () => {
    // 3 × 2 grid: index = row * 3 + column.
    const grid = [0, 1].flatMap((row) => [0, 1, 2].map((col) => rect(col * 120, row * 60)));
    expect(pickGeometric(grid, 0, 'right')).toBe(1);
    expect(pickGeometric(grid, 0, 'down')).toBe(3);
    expect(pickGeometric(grid, 4, 'left')).toBe(3);
    expect(pickGeometric(grid, 4, 'up')).toBe(1);
    expect(pickGeometric(grid, 5, 'up')).toBe(2);
    expect(pickGeometric(grid, 2, 'right')).toBe(-1);
    expect(pickGeometric(grid, 0, 'up')).toBe(-1);
    expect(nextFocusIndex(grid.length, 2, 'right', grid)).toBe(2); // no candidate: the focus stays
    expect(nextFocusIndex(grid.length, 0, 'down', grid)).toBe(3);
  });

  it('weighs the cross-axis offset twice against the main-axis distance', () => {
    const from = rect(0, 0);
    const aligned = rect(0, 200); // score 200
    const near = (gap: number): FocusRect => rect(100 + gap, 100); // score 100 + 2 × gap
    expect(pickGeometric([from, aligned, near(40)], 0, 'down')).toBe(2); // 180 < 200
    expect(pickGeometric([from, aligned, near(60)], 0, 'down')).toBe(1); // 220 > 200
    // Equal scores: the smaller centre offset wins, then the earlier element.
    expect(pickGeometric([from, aligned, near(50)], 0, 'down')).toBe(1);
    expect(pickGeometric([from, rect(0, 100), rect(0, 100)], 0, 'down')).toBe(1);
  });

  it('goes from a wide panel item up to the nearest tab of a tab row', () => {
    const tabs = [0, 1, 2, 3].map((i) => rect(i * 120, 0));
    const content = rect(0, 100, 460, 40); // centre x 230
    const rects = [...tabs, content];
    // Every tab overlaps on x (offset 0) at the same distance; centres 170 and 290 tie, the earlier one wins.
    expect(pickGeometric(rects, 4, 'up')).toBe(1);
    expect(pickGeometric(rects, 0, 'down')).toBe(4);
    expect(pickGeometric(rects, 3, 'down')).toBe(4);
  });

  it('skips elements without layout and falls back to list order without rects', () => {
    expect(hasLayout(rect(0, 0))).toBe(true);
    expect(hasLayout(rect(0, 0, 0, 40))).toBe(false);
    expect(hasLayout(rect(Number.NaN, 0))).toBe(false);
    expect(hasLayout(null)).toBe(false);
    expect(pickGeometric([rect(0, 0), rect(0, 60, 0, 0), rect(0, 120)], 0, 'down')).toBe(2);
    expect(pickGeometric([null, rect(0, 60)], 0, 'down')).toBe(-1);
    // List order: up / left −1, down / right +1, clamped, no wrapping.
    expect(nextFocusIndex(3, 0, 'down', null)).toBe(1);
    expect(nextFocusIndex(3, 1, 'right', null)).toBe(2);
    expect(nextFocusIndex(3, 2, 'down', null)).toBe(2);
    expect(nextFocusIndex(3, 0, 'up', null)).toBe(0);
    expect(nextFocusIndex(3, 2, 'left', null)).toBe(1);
    expect(nextFocusIndex(3, 1, 'down', [null, null, null])).toBe(2); // current element not laid out
    expect(nextFocusIndex(0, 0, 'down', null)).toBe(-1);
    expect(readRect({})).toBeNull();
    expect(readRect(null)).toBeNull();
    expect(readRect({ getBoundingClientRect: () => rect(1, 2) })).toEqual(rect(1, 2));
  });
});

describe('FocusNav hold-to-repeat', () => {
  it('repeats a held direction after 0.4 s, then every 0.1 s, until that input is released', () => {
    expect([NAV_REPEAT_DELAY, NAV_REPEAT_INTERVAL]).toEqual([0.4, 0.1]);
    const r = new NavRepeater();
    expect(r.update(1)).toEqual([]); // nothing held
    r.press('ArrowDown', 'down');
    expect(r.direction).toBe('down');
    expect(r.update(0.39)).toEqual([]);
    expect(r.update(0.01)).toEqual(['down']); // 0.4 s
    expect(r.update(0.05)).toEqual([]);
    expect(r.update(0.05)).toEqual(['down']); // 0.5 s
    expect(r.update(0.1)).toEqual(['down']); // 0.6 s
    r.release('ArrowUp'); // another code: still held
    expect(r.update(0.1)).toEqual(['down']);
    r.release('ArrowDown');
    expect(r.direction).toBeNull();
    expect(r.update(1)).toEqual([]);
  });

  it('caps a long frame, lets a newer direction replace the held one and ignores zero or negative time', () => {
    const r = new NavRepeater();
    r.press('PadDown', 'down');
    expect(r.update(2)).toEqual(['down', 'down', 'down']); // no burst after a stall
    expect(r.update(0.05)).toEqual([]);
    expect(r.update(0.05)).toEqual(['down']); // back on the 0.1 s grid
    r.press('PadRight', 'right');
    expect(r.update(0.3)).toEqual([]);
    expect(r.update(0.1)).toEqual(['right']);
    expect(r.update(0)).toEqual([]);
    expect(r.update(-1)).toEqual([]);
    r.clear();
    expect(r.update(1)).toEqual([]);
  });

  it('stores per-element handlers for custom controls', () => {
    const el = {};
    const handler = (): boolean => true;
    setNavHandler(el, handler);
    expect(navHandlerOf(el)).toBe(handler);
    setNavHandler(el, null);
    expect(navHandlerOf(el)).toBeNull();
    expect(navHandlerOf(null)).toBeNull();
  });
});

describe('ScreenManager with FocusNav', () => {
  it('moves the focus by the laid-out rects, marks it and moves the DOM focus', () => {
    const ui = new ScreenManager({ root: FAKE_ROOT });
    const feedback: UiFeedback[] = [];
    ui.onFeedback((f) => feedback.push(f));
    // Two columns: list order (a, b, c, d) differs from the layout (a c / b d).
    const items = [placed('a', rect(0, 0)), placed('b', rect(0, 60)), placed('c', rect(120, 0)), placed('d', rect(120, 60))];
    ui.push(fakeScreen('settings', 'menu', items));
    expect(feedback).toEqual([{ kind: 'open', screen: 'settings' }]);
    ui.nav('right');
    expect(ui.focusIndex).toBe(2);
    ui.nav('down');
    expect(ui.focusIndex).toBe(3);
    ui.nav('down'); // nothing below: stays, no move sound
    expect(ui.focusIndex).toBe(3);
    expect(items.map((i) => i.classes.has(FOCUSED_CLASS))).toEqual([false, false, false, true]);
    expect(items[3].focusCount).toBe(1);
    expect(feedback.filter((f) => f.kind === 'move')).toHaveLength(2);
  });

  it('repeats a held arrow key or D-pad direction through update() and stops on its release', () => {
    const ui = new ScreenManager({ root: FAKE_ROOT });
    const items = ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => fakeElement(n));
    ui.push(fakeScreen('pause', 'menu', items));
    ui.input('ArrowDown');
    expect(ui.focusIndex).toBe(1);
    ui.update(0.39);
    expect(ui.focusIndex).toBe(1);
    ui.update(0.01);
    expect(ui.focusIndex).toBe(2);
    ui.update(0.1);
    expect(ui.focusIndex).toBe(3);
    ui.input('ArrowDown', 'up');
    ui.update(1);
    expect(ui.focusIndex).toBe(3);
    ui.input('PadUp');
    ui.update(0.4);
    expect(ui.focusIndex).toBe(1);
    ui.releaseInputs(); // window blur
    ui.update(1);
    expect(ui.focusIndex).toBe(1);
  });

  it('lets a focused custom control consume directions (a slider takes left / right)', () => {
    const ui = new ScreenManager({ root: FAKE_ROOT });
    const sliderEl = fakeElement('slider');
    const taken: string[] = [];
    setNavHandler(sliderEl, (nav) => {
      if (nav !== 'left' && nav !== 'right') return false;
      taken.push(nav);
      return true;
    });
    const items = [sliderEl, fakeElement('next')];
    ui.push(fakeScreen('settings', 'menu', items));
    ui.nav('right');
    ui.nav('left');
    expect([ui.focusIndex, taken]).toEqual([0, ['right', 'left']]);
    ui.nav('down');
    expect(ui.focusIndex).toBe(1);
  });

  it('offers raw codes to the top screen first (the Settings remap) and skips navigation when consumed', () => {
    const ui = new ScreenManager({ root: FAKE_ROOT });
    const raw: string[] = [];
    let consume = true;
    const items = [fakeElement('a'), fakeElement('b')];
    const screen = Object.assign(fakeScreen('settings', 'menu', items), {
      onRawInput: (code: string, phase: 'down' | 'up'): boolean => {
        raw.push(`${code}:${phase}`);
        return consume && phase === 'down';
      },
    });
    ui.push(screen);
    ui.input('ArrowDown');
    ui.input('ArrowDown', 'up');
    expect([raw, ui.focusIndex]).toEqual([['ArrowDown:down', 'ArrowDown:up'], 0]);
    consume = false;
    ui.input('ArrowDown');
    expect(ui.focusIndex).toBe(1);
  });
});
