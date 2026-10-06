/*
 * Icon sprite (design "색 외 구별", Req 35.7, 31.2; task 14.1): one inline SVG of `<symbol>`s, referenced with
 * `<use>`, drawn in `currentColor` so icons stay sharp at any UI scale. Element icons differ in shape as well as
 * colour: Ember a three-tongued flame, Tide overlapping wave circles, Gale a spiral, Terra a hexagonal crystal; the
 * danger mark is a triangle with an exclamation point. Built with createElementNS (no innerHTML). The shapes are
 * data (ICON_SHAPES) so they can be checked without a DOM.
 */
import type { ElementId } from '../data/ids';

export type IconName = ElementId | 'danger';

export const ICON_NAMES: readonly IconName[] = ['ember', 'tide', 'gale', 'terra', 'danger'];

/** One SVG child of a symbol: tag and attributes. */
export interface IconShape {
  readonly tag: 'path' | 'circle';
  readonly attrs: Readonly<Record<string, string>>;
}

const STROKE = { fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };

/** 24 × 24 symbol contents. */
export const ICON_SHAPES: Readonly<Record<IconName, readonly IconShape[]>> = {
  // Three flame tongues rising from one base.
  ember: [
    { tag: 'path', attrs: { d: 'M12 2c1.9 3.2 4.6 5.5 4.6 9.6a4.6 4.6 0 0 1-9.2 0C7.4 7.5 10.1 5.2 12 2z' } },
    { tag: 'path', attrs: { d: 'M6 8.2c1 1.9 2.4 3.1 2.4 5.3a2.7 2.7 0 0 1-5.4 0C3 11.3 5 10.1 6 8.2z' } },
    { tag: 'path', attrs: { d: 'M18 8.2c1 1.9 3 3.1 3 5.3a2.7 2.7 0 0 1-5.4 0c0-2.2 1.4-3.4 2.4-5.3z' } },
    { tag: 'path', attrs: { d: 'M4.5 18.2h15a1.4 1.4 0 0 1 0 2.8h-15a1.4 1.4 0 0 1 0-2.8z' } },
  ],
  // Two overlapping circles crossed by a wave.
  tide: [
    { tag: 'circle', attrs: { cx: '9', cy: '12', r: '6', ...STROKE } },
    { tag: 'circle', attrs: { cx: '15', cy: '12', r: '6', ...STROKE } },
    { tag: 'path', attrs: { d: 'M3 12.5c1.5-1.6 3-1.6 4.5 0s3 1.6 4.5 0 3-1.6 4.5 0 3 1.6 4.5 0', ...STROKE } },
  ],
  // A spiral of growing half-turns.
  gale: [
    { tag: 'path', attrs: { d: 'M12 12a1.5 1.5 0 0 1 3 0a3 3 0 0 1-6 0a4.5 4.5 0 0 1 9 0a6 6 0 0 1-12 0a7.5 7.5 0 0 1 15 0', ...STROKE } },
  ],
  // A hexagonal crystal with its facets.
  terra: [
    { tag: 'path', attrs: { d: 'M12 2l8.7 5v10L12 22l-8.7-5V7z', 'fill-opacity': '0.35' } },
    { tag: 'path', attrs: { d: 'M12 2l8.7 5v10L12 22l-8.7-5V7zM12 12v10M12 12l8.7-5M12 12L3.3 7', ...STROKE } },
  ],
  // Warning triangle with an exclamation point cut out.
  danger: [
    { tag: 'path', attrs: { d: 'M12 2.5L22.5 20.5H1.5zM10.9 9h2.2v6.2h-2.2zM10.9 16.6h2.2v2.2h-2.2z', 'fill-rule': 'evenodd' } },
  ],
};

/** Korean names for assistive technology ("Ember" etc. are proper nouns and stay English, Req 35.4). */
export const ICON_LABELS: Readonly<Record<IconName, string>> = {
  ember: 'Ember',
  tide: 'Tide',
  gale: 'Gale',
  terra: 'Terra',
  danger: '위험',
};

const SVG_NS = 'http://www.w3.org/2000/svg';
export const ICON_SPRITE_ID = 'ui-icon-sprite';

export function iconSymbolId(name: IconName): string {
  return `ui-icon-${name}`;
}

/** Adds the sprite to `doc.body` once (hidden, zero size). */
export function ensureIconSprite(doc: Document = document): SVGSVGElement {
  const existing = doc.getElementById(ICON_SPRITE_ID);
  if (existing instanceof SVGSVGElement) return existing;
  const sprite = doc.createElementNS(SVG_NS, 'svg');
  sprite.id = ICON_SPRITE_ID;
  sprite.setAttribute('aria-hidden', 'true');
  sprite.setAttribute('focusable', 'false');
  sprite.setAttribute('width', '0');
  sprite.setAttribute('height', '0');
  sprite.style.position = 'absolute';
  sprite.style.width = '0';
  sprite.style.height = '0';
  sprite.style.overflow = 'hidden';
  for (const name of ICON_NAMES) {
    const symbol = doc.createElementNS(SVG_NS, 'symbol');
    symbol.id = iconSymbolId(name);
    symbol.setAttribute('viewBox', '0 0 24 24');
    for (const shape of ICON_SHAPES[name]) {
      const child = doc.createElementNS(SVG_NS, shape.tag);
      for (const [key, value] of Object.entries(shape.attrs)) child.setAttribute(key, value);
      symbol.append(child);
    }
    sprite.append(symbol);
  }
  doc.body.prepend(sprite);
  return sprite;
}

export interface IconOptions {
  /** Spoken name; omitted: decorative (aria-hidden) because a text label sits next to it. */
  label?: string;
  className?: string;
}

/** `<svg class="ui-icon ui-icon--{name}"><use href="#ui-icon-{name}"/></svg>`, coloured by its token. */
export function icon(name: IconName, options: IconOptions = {}): SVGSVGElement {
  ensureIconSprite();
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', `ui-icon ui-icon--${name}${options.className ? ` ${options.className}` : ''}`);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('focusable', 'false');
  if (options.label !== undefined) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', options.label);
  } else {
    svg.setAttribute('aria-hidden', 'true');
  }
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#${iconSymbolId(name)}`);
  svg.append(use);
  return svg;
}
