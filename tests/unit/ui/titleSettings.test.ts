import { describe, expect, it } from 'vitest';
import { UiCommandQueue } from '../../../src/core/uiCommands';
import { ScreenManager } from '../../../src/ui/screenManager';
import { titleMenuItems } from '../../../src/ui/screenModels';
import { SETTINGS_TABS } from '../../../src/ui/settingsScreen';
import type { TitleScreenOptions } from '../../../src/ui/titleScreen';
import { UiFlow } from '../../../src/ui/uiFlow';
import { FAKE_ROOT, fakeScreen } from './fakes';

describe('Title "설정" → Settings (task 14.4)', () => {
  it('lists "설정" after New Game / Continue only when the Title can open Settings', () => {
    expect(titleMenuItems(false).map((i) => i.id)).toEqual(['newGame', 'continue']);
    expect(titleMenuItems(false, ['settings'])).toEqual([
      { id: 'newGame', label: '새로 시작', disabledReason: null },
      { id: 'continue', label: '이어하기', disabledReason: '저장 데이터 없음' },
      { id: 'settings', label: '설정', disabledReason: null },
    ]);
  });

  it('hands openSettings to the Title, which pushes the Settings screen over it', () => {
    const ui = new ScreenManager({ root: FAKE_ROOT });
    const made: TitleScreenOptions[] = [];
    const openSettings = (): void => ui.push(fakeScreen('settings', 'menu'));
    const flow = new UiFlow({
      ui,
      commands: new UiCommandQueue(),
      screens: {
        title: (o) => (made.push(o), fakeScreen('title', 'menu')),
        defeat: () => fakeScreen('defeat', 'menu'),
        victory: () => fakeScreen('victory', 'menu'),
      },
      hasSave: () => false,
      startNewGame: () => fakeScreen('gameplay', 'gameplay'),
      continueGame: () => null,
      endSession: () => undefined,
      openSettings,
    });
    flow.showTitle();
    made[0].onSettings?.();
    expect(ui.ids).toEqual(['title', 'settings']);
    expect(ui.context).toBe('menu');
  });

  it('has the five Settings tabs in order, ending with "조작 안내 보기"', () => {
    expect(SETTINGS_TABS.map((t) => t.label)).toEqual(['오디오', '그래픽', '조작', '접근성', '조작 안내 보기']);
  });
});
