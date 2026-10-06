import { describe, expect, it } from 'vitest';
import { navFromCode } from '../../../src/ui/navInput';
import { FOCUSED_CLASS, pauseModeFor, ScreenManager, type ScreenContext, type ScreenEvent } from '../../../src/ui/screenManager';
import { FAKE_ROOT, fakeElement, fakeScreen } from './fakes';

function setup() {
  const events: ScreenEvent[] = [];
  const contexts: (ScreenContext | null)[] = [];
  const ui = new ScreenManager({
    root: FAKE_ROOT,
    onScreen: (e) => events.push(e),
    onContext: (c) => contexts.push(c),
  });
  return { ui, events, contexts };
}

describe('ScreenManager stack', () => {
  it('mounts on push, unmounts on pop, reports ui:screen for each and the context only when it changes', () => {
    const { ui, events, contexts } = setup();
    const hud = fakeScreen('gameplay', 'gameplay');
    const defeat = fakeScreen('defeat', 'menu');
    const victory = fakeScreen('victory', 'menu');
    ui.push(hud);
    ui.push(defeat);
    ui.push(victory);
    expect(ui.ids).toEqual(['gameplay', 'defeat', 'victory']);
    expect([ui.top, ui.context]).toEqual([victory, 'menu']);
    ui.pop();
    ui.pop();
    expect(ui.top).toBe(hud);
    expect([defeat.mounted, defeat.unmounted, victory.unmounted, hud.unmounted]).toEqual([1, 1, 1, 0]);
    expect(events).toEqual([
      { screen: 'gameplay', open: true },
      { screen: 'defeat', open: true },
      { screen: 'victory', open: true },
      { screen: 'victory', open: false },
      { screen: 'defeat', open: false },
    ]);
    expect(contexts).toEqual(['gameplay', 'menu', 'gameplay']);
  });

  it('replaceAll empties the stack top first, pushes the new bottom and reports the context once', () => {
    const { ui, events, contexts } = setup();
    ui.push(fakeScreen('title', 'menu'));
    const hud = fakeScreen('gameplay', 'gameplay');
    ui.replaceAll(hud);
    expect(ui.ids).toEqual(['gameplay']);
    expect(events.slice(1)).toEqual([
      { screen: 'title', open: false },
      { screen: 'gameplay', open: true },
    ]);
    expect(contexts).toEqual(['menu', 'gameplay']);
    ui.push(fakeScreen('victory', 'menu'));
    ui.replaceAll(fakeScreen('title', 'menu'));
    expect(ui.ids).toEqual(['title']);
    expect(events.slice(-3)).toEqual([
      { screen: 'victory', open: false },
      { screen: 'gameplay', open: false },
      { screen: 'title', open: true },
    ]);
    expect(contexts).toEqual(['menu', 'gameplay', 'menu']);
  });

  it('maps the top context to the PauseMode: menus and an empty stack stop game time', () => {
    expect(pauseModeFor('gameplay')).toBe('none');
    expect(pauseModeFor('dialogue')).toBe('dialogue');
    expect(pauseModeFor('menu')).toBe('menu');
    expect(pauseModeFor('map')).toBe('menu');
    expect(pauseModeFor(null)).toBe('menu');
  });
});

describe('ScreenManager navigation', () => {
  it('focuses the first item on push, moves by direction without wrapping and confirms by clicking', () => {
    const { ui } = setup();
    const items = [fakeElement('a'), fakeElement('b'), fakeElement('c')];
    ui.push(fakeScreen('title', 'menu', items));
    expect(ui.focusIndex).toBe(0);
    expect(items[0].classes.has(FOCUSED_CLASS)).toBe(true);
    ui.nav('up');
    expect(ui.focusIndex).toBe(0);
    ui.nav('down');
    ui.nav('right');
    ui.nav('down');
    expect(ui.focusIndex).toBe(2);
    expect(items.map((i) => i.classes.has(FOCUSED_CLASS))).toEqual([false, false, true]);
    ui.nav('left');
    ui.nav('confirm');
    expect(items.map((i) => i.clicks)).toEqual([0, 1, 0]);
  });

  it('cancel pops everything but the bottom screen; a screen that consumes the input blocks the default', () => {
    const { ui } = setup();
    const title = fakeScreen('title', 'menu');
    ui.push(title);
    ui.nav('cancel');
    expect(ui.ids).toEqual(['title']);
    const defeat = fakeScreen('defeat', 'menu', [fakeElement('respawn')]);
    defeat.consume.cancel = true;
    ui.push(defeat);
    ui.nav('cancel');
    expect(ui.ids).toEqual(['title', 'defeat']);
    defeat.consume.cancel = false;
    ui.nav('cancel');
    expect(ui.ids).toEqual(['title']);
  });

  it('gives a covered screen its focus back when the screen above closes', () => {
    const { ui } = setup();
    const items = [fakeElement('a'), fakeElement('b')];
    ui.push(fakeScreen('title', 'menu', items));
    ui.nav('down');
    const over = fakeScreen('defeat', 'menu', [fakeElement('x')]);
    ui.push(over);
    expect(items[1].classes.has(FOCUSED_CLASS)).toBe(false); // covered: no focus mark
    ui.pop();
    expect(ui.focusIndex).toBe(1);
    expect(items[1].classes.has(FOCUSED_CLASS)).toBe(true);
  });

  it('follows focus changes from the mouse or Tab onto the top screen only', () => {
    const { ui } = setup();
    const items = [fakeElement('a'), fakeElement('b')];
    ui.push(fakeScreen('title', 'menu', items));
    ui.focusElement(items[1]);
    expect(ui.focusIndex).toBe(1);
    expect(items.map((i) => i.classes.has(FOCUSED_CLASS))).toEqual([false, true]);
    ui.focusElement(fakeElement('elsewhere'));
    expect(ui.focusIndex).toBe(1);
  });

  it('routes key and pad presses as navigation only while a non-gameplay screen is on top', () => {
    const { ui } = setup();
    const hudItem = fakeElement('hud');
    const hud = fakeScreen('gameplay', 'gameplay', [hudItem]);
    ui.push(hud);
    ui.input('Enter');
    ui.input('ArrowDown');
    expect([hud.navs, hudItem.clicks]).toEqual([[], 0]); // gameplay reads these keys itself
    const items = [fakeElement('a'), fakeElement('b')];
    const menu = fakeScreen('victory', 'menu', items);
    ui.push(menu);
    ui.input('PadDown');
    ui.input('KeyW'); // not a navigation input
    ui.input('PadA');
    expect(menu.navs).toEqual(['down', 'confirm']);
    expect(items.map((i) => i.clicks)).toEqual([0, 1]);
  });

  it('a first input the screen consumes is not handled as a selection (Title "아무 키나 눌러 시작")', () => {
    const { ui } = setup();
    let revealed = false;
    const newGame = fakeElement('newGame');
    const title = fakeScreen('title', 'menu', [newGame], {
      focusables: () => (revealed ? [newGame] : []),
      onAnyInput: () => {
        if (revealed) return false;
        revealed = true;
        return true;
      },
    });
    ui.push(title);
    expect(ui.focusIndex).toBe(-1);
    ui.input('Enter'); // first input: opens the menu, selects nothing
    expect([revealed, newGame.clicks, ui.focusIndex, newGame.focusCount]).toEqual([true, 0, 0, 1]);
    ui.input('Enter');
    expect(newGame.clicks).toBe(1);
  });
});

describe('navFromCode', () => {
  it('maps the fixed UI inputs of keyboard and gamepad and nothing else', () => {
    const cases: [string, ReturnType<typeof navFromCode>][] = [
      ['ArrowUp', 'up'], ['ArrowDown', 'down'], ['ArrowLeft', 'left'], ['ArrowRight', 'right'],
      ['Enter', 'confirm'], ['NumpadEnter', 'confirm'], ['Escape', 'cancel'],
      ['PadUp', 'up'], ['PadDown', 'down'], ['PadLeft', 'left'], ['PadRight', 'right'], ['PadA', 'confirm'], ['PadB', 'cancel'],
      ['Space', null], ['KeyW', null], ['Mouse0', null], ['toString', null], ['', null],
    ];
    for (const [code, nav] of cases) expect(navFromCode(code), code).toBe(nav);
  });
});
