/*
 * Design tokens (design "시각 스타일"; task 14.1), mirrored from base.css `:root` for code that needs the values
 * (canvas drawing, the contrast unit test, which also checks that base.css still holds these values). Pure data.
 */
export const TOKENS = {
  panelBg: 'rgba(14, 24, 56, 0.86)',
  gold: '#E9C46A',
  text: '#F5F1E6',
  textMuted: '#B9C2D8',
  danger: '#FF5A6A',
  ember: '#FF7A45',
  tide: '#3FA7F5',
  gale: '#5ED3A5',
  terra: '#D9A441',
} as const;

/** CSS custom property of each token. */
export const TOKEN_VARS: Readonly<Record<keyof typeof TOKENS, string>> = {
  panelBg: '--panel-bg',
  gold: '--gold',
  text: '--text',
  textMuted: '--text-muted',
  danger: '--danger',
  ember: '--ember',
  tide: '--tide',
  gale: '--gale',
  terra: '--terra',
};

/** Colours text on panels may use (Element and danger colours are for icons, gauges and borders only). */
export const PANEL_TEXT_TOKENS = ['text', 'textMuted', 'gold'] as const;

/** System Korean font stack (Req 35.5): no web fonts. */
export const FONT_STACK = "'Malgun Gothic', 'Apple SD Gothic Neo', 'Noto Sans CJK KR', sans-serif";

/** Root font size at UI scale 1 (px): 1 rem; `calc(20px * var(--ui-scale))`. */
export const ROOT_FONT_PX = 20;

/** Minimum text contrast against its panel (Req 35.6, WCAG AA body text). */
export const MIN_TEXT_CONTRAST = 4.5;
