import { describe, expect, it } from 'vitest';
import { composite, contrastRatio, parseColor, relativeLuminance, textContrastOver } from '../../../src/ui/contrast';
import { formatPercent, snapValue, stepValue, valueAtRatio, valueRatio } from '../../../src/ui/controls/values';
import { ICON_LABELS, ICON_NAMES, ICON_SHAPES, iconSymbolId } from '../../../src/ui/icons';
import {
  FONT_STACK,
  MIN_TEXT_CONTRAST,
  PANEL_TEXT_TOKENS,
  ROOT_FONT_PX,
  TOKEN_VARS,
  TOKENS,
} from '../../../src/ui/styles/tokens';
import { collectSourceFiles, projectRoot, readSourceFile } from '../helpers/importScan';

const ROOT = projectRoot();
const BASE_CSS = readSourceFile(ROOT, 'src/ui/styles/base.css');

/** The `:root { ... }` block of base.css. */
function rootBlock(css: string): string {
  const match = /:root\s*\{([\s\S]*?)\n\}/.exec(css);
  if (match === null) throw new Error('base.css has no :root block');
  return match[1];
}

describe('colour contrast (WCAG 2)', () => {
  it('parses CSS colours and computes luminance and ratios', () => {
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor('#E9C46A')).toEqual({ r: 233, g: 196, b: 106, a: 1 });
    expect(parseColor('rgba(14, 24, 56, 0.86)')).toEqual({ r: 14, g: 24, b: 56, a: 0.86 });
    expect(parseColor('rgb(1,2,3)')).toEqual({ r: 1, g: 2, b: 3, a: 1 });
    expect(() => parseColor('gold')).toThrow();
    expect(relativeLuminance(parseColor('#000'))).toBe(0);
    expect(relativeLuminance(parseColor('#fff'))).toBeCloseTo(1, 10);
    expect(contrastRatio(parseColor('#000'), parseColor('#fff'))).toBeCloseTo(21, 10);
    expect(contrastRatio(parseColor('#777'), parseColor('#777'))).toBe(1);
    const half = composite({ r: 0, g: 0, b: 0, a: 0.5 }, parseColor('#fff'));
    expect(half).toEqual({ r: 127.5, g: 127.5, b: 127.5, a: 1 });
  });

  it('keeps every panel text colour at ≥ 4.5:1 over the panel, even with a white scene behind it', () => {
    for (const scene of ['#FFFFFF', '#808080', '#000000']) {
      for (const token of PANEL_TEXT_TOKENS) {
        const ratio = textContrastOver(TOKENS[token], TOKENS.panelBg, scene);
        expect(ratio, `${token} over ${scene}`).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
      }
    }
    // Design figures: ≈ 13:1 / 8:1 over a mid-grey scene; ≈ 10 / 6.4 / 6.9 over white (worst case).
    expect(textContrastOver(TOKENS.text, TOKENS.panelBg, '#808080')).toBeGreaterThan(12);
    expect(textContrastOver(TOKENS.textMuted, TOKENS.panelBg, '#808080')).toBeGreaterThan(7.5);
    expect(textContrastOver(TOKENS.text, TOKENS.panelBg, '#FFFFFF')).toBeGreaterThan(9);
    expect(textContrastOver(TOKENS.textMuted, TOKENS.panelBg, '#FFFFFF')).toBeGreaterThan(6);
    expect(textContrastOver(TOKENS.gold, TOKENS.panelBg, '#FFFFFF')).toBeGreaterThan(6);
  });
});

describe('design tokens in base.css', () => {
  const root = rootBlock(BASE_CSS);

  it('declares every token with the value of tokens.ts', () => {
    for (const key of Object.keys(TOKENS) as (keyof typeof TOKENS)[]) {
      const declared = new RegExp(`${TOKEN_VARS[key]}:\\s*([^;]+);`).exec(root);
      expect(declared, TOKEN_VARS[key]).not.toBeNull();
      expect(parseColor(declared?.[1] ?? '')).toEqual(parseColor(TOKENS[key]));
    }
    expect(root).toContain('--focus: 0 0 0 2px #E9C46A, 0 0 10px rgba(233, 196, 106, 0.6);');
  });

  it('draws the starlight gold frame as a border-image of four-point stars', () => {
    const frame = /--gold-frame:\s*url\("data:image\/svg\+xml,([^"]+)"\)/.exec(root);
    expect(frame).not.toBeNull();
    const svg = decodeURIComponent(frame?.[1] ?? '');
    expect(svg).toContain("stroke='#E9C46A'");
    expect(svg.match(/<path d='M\d+ \d+L/g)?.length).toBe(4); // one star per corner
    expect(BASE_CSS).toMatch(/border-image:\s*var\(--gold-frame\)/);
    expect(readSourceFile(ROOT, 'src/ui/screens.css')).toMatch(/\.ui-panel\s*\{[^}]*background:\s*var\(--panel-bg\)/);
  });

  it('uses the system Korean font stack and scales every rem with --ui-scale', () => {
    expect(FONT_STACK).toBe("'Malgun Gothic', 'Apple SD Gothic Neo', 'Noto Sans CJK KR', sans-serif");
    expect(root).toContain(`--font-ui: ${FONT_STACK};`);
    expect(BASE_CSS).toMatch(/body\s*\{[^}]*font-family:\s*var\(--font-ui\)/);
    expect(BASE_CSS).not.toMatch(/@font-face|@import|fonts\.googleapis/);
    expect(root).toContain('--ui-scale: 1;');
    expect(root).toContain(`font-size: calc(${ROOT_FONT_PX}px * var(--ui-scale));`);
    expect(ROOT_FONT_PX * 0.8).toBe(16); // body text (1 rem) at the smallest UI scale
  });
});

describe('icon sprite', () => {
  it('has the four Element icons and the danger triangle, each a distinct shape', () => {
    expect(ICON_NAMES).toEqual(['ember', 'tide', 'gale', 'terra', 'danger']);
    const signatures = ICON_NAMES.map((name) => JSON.stringify(ICON_SHAPES[name]));
    expect(new Set(signatures).size).toBe(ICON_NAMES.length);
    for (const name of ICON_NAMES) {
      expect(ICON_SHAPES[name].length, name).toBeGreaterThan(0);
      expect(ICON_LABELS[name]).not.toBe('');
      expect(iconSymbolId(name)).toBe(`ui-icon-${name}`);
    }
    expect(ICON_SHAPES.ember.length).toBeGreaterThanOrEqual(3); // three flame tongues
    expect(ICON_SHAPES.tide.filter((s) => s.tag === 'circle')).toHaveLength(2); // overlapping circles
    expect(ICON_LABELS.danger).toBe('위험');
  });
});

describe('UI DOM rules', () => {
  it('never writes HTML strings into the DOM under src/ui', () => {
    for (const file of collectSourceFiles(ROOT, ['src/ui'])) {
      const code = readSourceFile(ROOT, file).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      expect(code, file).not.toMatch(/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML\s*\(/);
    }
  });

  it('slider values clamp, snap to the step and map to the drawn ratio', () => {
    const range = { min: 0.8, max: 1.3, step: 0.05 };
    expect(snapValue(1.02, range)).toBe(1);
    expect(snapValue(9, range)).toBe(1.3);
    expect(snapValue(Number.NaN, range)).toBe(0.8);
    expect(stepValue(1.3, 1, range)).toBe(1.3);
    expect(stepValue(1, -1, range)).toBe(0.95);
    expect(valueRatio(1.05, range)).toBeCloseTo(0.5, 10);
    expect(valueAtRatio(1, range)).toBe(1.3);
    expect(formatPercent(0.7)).toBe('70%');
  });
});
