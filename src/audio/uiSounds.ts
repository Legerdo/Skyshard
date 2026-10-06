/*
 * Menu sounds of the screen stack (design "효과음 카탈로그" UI, Req 31.6): opening and closing a menu screen, the
 * Defeat sting. The ScreenManager's `onScreen` callback in main.ts feeds it (menus stop game time, so these do not
 * wait for the session's EventDispatch).
 */

import type { UiScreenId } from '../core/gameEvents';
import type { SfxId } from '../data/ids';

const MENU_SCREENS: ReadonlySet<UiScreenId> = new Set<UiScreenId>([
  'pause', 'settings', 'map', 'inventory', 'quest', 'codex', 'shop', 'echoAltar', 'newGameConfirm', 'credits',
]);

/** The sound of `screen` opening or closing, or null (gameplay, title, dialogue, loading...). */
export function uiScreenSfx(screen: UiScreenId, open: boolean): SfxId | null {
  if (screen === 'defeat') return open ? 'sfx_defeat' : null;
  if (!MENU_SCREENS.has(screen)) return null;
  return open ? 'sfx_ui_open' : 'sfx_ui_close';
}
