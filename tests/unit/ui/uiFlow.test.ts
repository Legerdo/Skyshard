import { describe, expect, it } from 'vitest';
import { UiCommandQueue } from '../../../src/core/uiCommands';
import type { DefeatScreenOptions } from '../../../src/ui/defeatScreen';
import { pauseModeFor, ScreenManager, type ScreenContext } from '../../../src/ui/screenManager';
import type { TitleScreenOptions } from '../../../src/ui/titleScreen';
import { UiFlow } from '../../../src/ui/uiFlow';
import type { VictoryScreenOptions } from '../../../src/ui/victoryScreen';
import type { VictoryView } from '../../../src/ui/victoryView';
import { FAKE_ROOT, fakeScreen } from './fakes';

const VIEW: VictoryView = {
  playTimeSec: 1500,
  enemiesDefeated: 40,
  questsCompleted: 2,
  partyLevel: 8,
  places: { found: 6, total: 8 },
  chests: { found: 5, total: 12 },
  abilityRanks: {
    kairen: { skill: 2, burst: 1 },
    isla: { skill: 0, burst: 0 },
    wren: { skill: 1, burst: 0 },
    talus: { skill: 0, burst: 3 },
  },
  debugUsed: false,
};

function setup(options: { hasSave?: boolean; canContinue?: boolean } = {}) {
  const contexts: (ScreenContext | null)[] = [];
  const ui = new ScreenManager({ root: FAKE_ROOT, onContext: (c) => contexts.push(c) });
  const commands = new UiCommandQueue();
  const made = {
    title: [] as TitleScreenOptions[],
    defeat: [] as DefeatScreenOptions[],
    victory: [] as VictoryScreenOptions[],
  };
  const calls = { newGame: 0, continue: 0, endSession: 0, views: 0 };
  const hud = fakeScreen('gameplay', 'gameplay');
  const flow = new UiFlow({
    ui,
    commands,
    screens: {
      title: (o) => (made.title.push(o), fakeScreen('title', 'menu')),
      defeat: (o) => (made.defeat.push(o), fakeScreen('defeat', 'menu')),
      victory: (o) => (made.victory.push(o), fakeScreen('victory', 'menu')),
    },
    hasSave: () => options.hasSave ?? false,
    startNewGame: () => (calls.newGame++, hud),
    continueGame: () => (calls.continue++, options.canContinue === true ? hud : null),
    endSession: () => void calls.endSession++,
  });
  const view = (): VictoryView => (calls.views++, VIEW);
  return { ui, commands, flow, made, calls, contexts, view };
}

describe('UiFlow: Title → Gameplay HUD', () => {
  it('puts the Title at the bottom after Loading, with the first-input prompt and Continue following the save', () => {
    const { ui, flow, made, contexts } = setup({ hasSave: false });
    flow.showTitle();
    expect(ui.ids).toEqual(['title']);
    expect(pauseModeFor(ui.context)).toBe('menu'); // the simulation does not tick under the Title
    expect(made.title[0]).toMatchObject({ hasSave: false, skipPrompt: false });
    expect(contexts).toEqual(['menu']);
  });

  it('New Game empties the stack and puts the Gameplay HUD at the bottom', () => {
    const { ui, flow, made, calls } = setup();
    flow.showTitle();
    made.title[0].onNewGame();
    expect(ui.ids).toEqual(['gameplay']);
    expect(pauseModeFor(ui.context)).toBe('none');
    expect(calls.newGame).toBe(1);
  });

  it('Continue that cannot load keeps the Title; one that can enters the game the same way', () => {
    const blocked = setup({ hasSave: true, canContinue: false });
    blocked.flow.showTitle();
    blocked.made.title[0].onContinue();
    expect(blocked.ui.ids).toEqual(['title']);
    const ok = setup({ hasSave: true, canContinue: true });
    ok.flow.showTitle();
    expect(ok.made.title[0].hasSave).toBe(true);
    ok.made.title[0].onContinue();
    expect(ok.ui.ids).toEqual(['gameplay']);
  });
});

describe('UiFlow: Defeat', () => {
  it("'party:wipe' pushes Defeat over the game once; the choice closes it and becomes a UiCommand", () => {
    const { ui, flow, made, commands } = setup();
    flow.showTitle();
    flow.partyWiped(null); // not in a game yet: ignored
    expect(ui.ids).toEqual(['title']);
    made.title[0].onNewGame();
    flow.partyWiped(null);
    flow.partyWiped(null);
    expect(ui.ids).toEqual(['gameplay', 'defeat']);
    expect(pauseModeFor(ui.context)).toBe('menu');
    expect(made.defeat).toHaveLength(1);
    expect(made.defeat[0].bossPhase).toBeNull();
    expect(commands.size).toBe(0);
    made.defeat[0].onChoose('respawn');
    expect(ui.ids).toEqual(['gameplay']);
    expect(pauseModeFor(ui.context)).toBe('none'); // the next tick applies the command
    expect(commands.drain()).toEqual([{ kind: 'defeatChoice', choice: 'respawn' }]);
  });

  it('passes the Caelith Phase through to the Defeat Screen', () => {
    const { flow, made } = setup();
    flow.showTitle();
    made.title[0].onNewGame();
    flow.partyWiped(2);
    expect(made.defeat[0].bossPhase).toBe(2);
  });
});

describe('UiFlow: Victory', () => {
  it('the end of cin_ending pushes Victory with the view read once; "탐험 계속" closes it into a UiCommand', () => {
    const { ui, flow, made, commands, calls, view } = setup();
    flow.showTitle();
    made.title[0].onNewGame();
    flow.endingFinished(view);
    flow.endingFinished(view);
    expect(ui.ids).toEqual(['gameplay', 'victory']);
    expect(pauseModeFor(ui.context)).toBe('menu');
    expect([made.victory.length, calls.views]).toEqual([1, 1]);
    expect(made.victory[0].view).toBe(VIEW);
    made.victory[0].onContinueExploring();
    expect(ui.ids).toEqual(['gameplay']);
    expect(commands.drain()).toEqual([{ kind: 'continueExploring' }]);
  });

  it('"메인 메뉴" ends the session, drops waiting commands and puts the Title back with its menu open', () => {
    const { ui, flow, made, commands, calls, view } = setup();
    flow.showTitle();
    made.title[0].onNewGame();
    flow.endingFinished(view);
    commands.push({ kind: 'continueExploring' });
    made.victory[0].onMainMenu();
    expect(ui.ids).toEqual(['title']);
    expect(calls.endSession).toBe(1);
    expect(commands.size).toBe(0);
    expect(made.title[1]).toMatchObject({ skipPrompt: true });
    made.title[1].onNewGame();
    expect([ui.ids, calls.newGame]).toEqual([['gameplay'], 2]);
  });
});

describe('UiCommandQueue', () => {
  it('drains in push order and empties', () => {
    const queue = new UiCommandQueue();
    queue.push({ kind: 'defeatChoice', choice: 'retryPhase' });
    queue.push({ kind: 'continueExploring' });
    expect(queue.drain()).toEqual([{ kind: 'defeatChoice', choice: 'retryPhase' }, { kind: 'continueExploring' }]);
    expect([queue.size, queue.drain()]).toEqual([0, []]);
  });
});
