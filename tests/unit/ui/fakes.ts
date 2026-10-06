// Stand-in screens and focusable elements for the ScreenManager / UiFlow tests (Node, no DOM).
import type { UiScreenId } from '../../../src/core/gameEvents';
import type { NavInput } from '../../../src/ui/navInput';
import type { Focusable, Screen, ScreenContext } from '../../../src/ui/screenManager';

export interface FakeElement extends Focusable {
  readonly name: string;
  readonly classes: Set<string>;
  focusCount: number;
  clicks: number;
}

export function fakeElement(name: string, onClick: () => void = () => undefined): FakeElement {
  const classes = new Set<string>();
  const el = {
    name,
    classes,
    focusCount: 0,
    clicks: 0,
    focus(): void {
      el.focusCount++;
    },
    click(): void {
      el.clicks++;
      onClick();
    },
    classList: {
      toggle(token: string, force?: boolean): boolean {
        const on = force ?? !classes.has(token);
        if (on) classes.add(token);
        else classes.delete(token);
        return on;
      },
      contains: (token: string) => classes.has(token),
    },
  };
  return el as unknown as FakeElement;
}

export interface FakeScreen extends Screen {
  mounted: number;
  unmounted: number;
  items: FakeElement[];
  navs: NavInput[];
  /** onInput result per nav (default false: the manager's default handling). */
  consume: Partial<Record<NavInput, boolean>>;
}

export function fakeScreen(
  id: UiScreenId,
  context: ScreenContext,
  items: FakeElement[] = [],
  extra: Partial<Pick<Screen, 'onAnyInput' | 'focusables'>> = {},
): FakeScreen {
  const screen: FakeScreen = {
    id,
    context,
    mounted: 0,
    unmounted: 0,
    items,
    navs: [],
    consume: {},
    mount(): void {
      screen.mounted++;
    },
    unmount(): void {
      screen.unmounted++;
    },
    onInput(nav: NavInput): boolean {
      screen.navs.push(nav);
      return screen.consume[nav] ?? false;
    },
    focusables: () => screen.items,
    ...extra,
  };
  return screen;
}

/** A root the manager only passes through to `mount`. */
export const FAKE_ROOT = {} as HTMLElement;
