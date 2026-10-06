import { describe, expect, it } from 'vitest';
import {
  HUD_AREA_LIMIT, HUD_LAYOUT, HUD_REFERENCE, HUD_UI_SCALE_RANGE, HUD_WORLD_BARS, hudArea, hudAreaShare, hudBox, hudBoxArea,
  hudLayoutCssVars, remOf,
} from '../../../src/ui/hudLayout';
import { projectRoot, readSourceFile } from '../helpers/importScan';

// Task 14.3 (design "HUD 레이아웃", Req 32.1, 32.4): the placement table as data and its area budget.

describe('HUD layout table', () => {
  it('places every element of the design table at its size and corner', () => {
    const rows = HUD_LAYOUT.map((b) => [b.id, b.anchor, b.shape, b.width, b.height, b.count, b.conditional]);
    expect(rows).toEqual([
      ['compass', 'top', 'rect', 560, 40, 1, false],
      ['objective', 'topLeft', 'rect', 420, 64, 1, false],
      ['skyshard', 'topRight', 'rect', 180, 48, 1, false],
      ['party', 'bottomLeft', 'rect', 72, 92, 4, false],
      ['vitals', 'bottom', 'rect', 480, 40, 1, false],
      ['skill', 'bottomRight', 'circle', 76, 76, 1, false],
      ['burst', 'bottomRight', 'circle', 92, 92, 1, false],
      ['stamina', 'world', 'circle', 48, 48, 1, true],
      ['prompt', 'center', 'rect', 320, 48, 1, true],
    ]);
    // Skill sits left of Burst in the bottom-right pair without overlapping it.
    expect(hudBox('skill').x).toBeGreaterThanOrEqual(hudBox('burst').x + hudBox('burst').width);
    expect(HUD_WORLD_BARS).toEqual({ pool: 12, enemy: { width: 96, height: 8 }, elite: { width: 128, height: 10 }, boss: { width: 720, height: 20 } });
  });

  it('matches the design area figures: always-on ≈ 5.7 %, with the conditional rows ≈ 6.5 %', () => {
    const screen = HUD_REFERENCE.width * HUD_REFERENCE.height;
    expect(screen).toBe(2_073_600);
    expect(hudBoxArea(hudBox('party'))).toBe(26_496);
    expect(hudBoxArea(hudBox('skill')) + hudBoxArea(hudBox('burst'))).toBe(14_240);
    expect(hudArea()).toBe(117_856);
    expect(hudArea(HUD_LAYOUT, { conditional: true })).toBe(135_520);
    expect(hudAreaShare() * 100).toBeCloseTo(5.7, 1);
    expect(hudAreaShare(HUD_LAYOUT, { conditional: true }) * 100).toBeCloseTo(6.5, 1);
  });

  it('stays within 15 % of the screen at every UI scale up to 130 % (worst case ≈ 11.0 %)', () => {
    expect(HUD_UI_SCALE_RANGE.max).toBe(1.3);
    const worst = hudAreaShare(HUD_LAYOUT, { conditional: true, scale: HUD_UI_SCALE_RANGE.max });
    expect(worst * 100).toBeCloseTo(11.0, 1);
    for (let scale = HUD_UI_SCALE_RANGE.min; scale <= HUD_UI_SCALE_RANGE.max + 1e-9; scale += 0.05) {
      expect(hudAreaShare(HUD_LAYOUT, { conditional: true, scale }), `scale ${scale}`).toBeLessThanOrEqual(HUD_AREA_LIMIT);
    }
  });

  it('turns the table into rem custom properties (1 rem = 20 px at UI scale 1)', () => {
    const vars = hudLayoutCssVars();
    expect(remOf(20)).toBe('1rem');
    expect(vars['--hud-party-w']).toBe('3.6rem');
    expect(vars['--hud-party-h']).toBe('4.6rem');
    expect(vars['--hud-skill-w']).toBe('3.8rem');
    expect(vars['--hud-burst-w']).toBe('4.6rem');
    expect(vars['--hud-stamina-w']).toBe('2.4rem');
    expect(vars['--hud-boss-bar-w']).toBe('36rem');
    expect(vars['--hud-boss-bar-h']).toBe('1rem');
    expect(vars['--hud-enemy-bar-w']).toBe('4.8rem');
    for (const box of HUD_LAYOUT) for (const k of ['w', 'h', 'x', 'y']) expect(vars[`--hud-${box.id}-${k}`], `${box.id}-${k}`).toMatch(/^\d+(\.\d+)?rem$/);
  });

  it('the HUD stylesheets size their elements from those properties', () => {
    const root = projectRoot();
    const css = (file: string): string => readSourceFile(root, file);
    const combat = css('src/ui/combatHud.css');
    for (const v of ['--hud-party-w', '--hud-party-h', '--hud-portrait', '--hud-vitals-w', '--hud-skill-w', '--hud-burst-w']) {
      expect(combat, v).toContain(`var(${v}`);
    }
    expect(css('src/ui/staminaRing.css')).toContain('var(--hud-stamina-w');
    expect(css('src/ui/bossBar.css')).toContain('var(--hud-boss-bar-w');
    expect(css('src/ui/enemyBars.css')).toContain('var(--hud-enemy-bar-w');
    expect(css('src/ui/enemyBars.css')).toContain('var(--hud-elite-bar-w');
    expect(css('src/ui/hud.css')).toContain('var(--hud-objective-w');
    expect(css('src/ui/hud.css')).toContain('var(--hud-skyshard-w');
    expect(css('src/ui/compass.css')).toContain('var(--hud-compass-w');
    expect(css('src/ui/interactPrompt.css')).toContain('var(--hud-prompt-w');
  });
});
