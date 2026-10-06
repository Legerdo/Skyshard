/*
 * Colour contrast (Req 35.6; task 14.1): WCAG 2 relative luminance and contrast ratio, with alpha compositing so a
 * translucent panel can be judged over the scene behind it (worst case: a white scene). Pure.
 */

export interface Rgba {
  /** 0–255. */
  readonly r: number;
  readonly g: number;
  readonly b: number;
  /** 0–1. */
  readonly a: number;
}

/** Parses `#RGB`, `#RRGGBB`, `rgb(r, g, b)` and `rgba(r, g, b, a)`; throws on anything else. */
export function parseColor(css: string): Rgba {
  const s = css.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1];
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 };
  }
  const fn = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(s);
  if (fn) {
    return { r: Number(fn[1]), g: Number(fn[2]), b: Number(fn[3]), a: fn[4] === undefined ? 1 : Number(fn[4]) };
  }
  throw new Error(`Unsupported colour: ${css}`);
}

/** `top` composited over `bottom` (source-over); the result is opaque when `bottom` is. */
export function composite(top: Rgba, bottom: Rgba): Rgba {
  const a = top.a + bottom.a * (1 - top.a);
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const mix = (t: number, b: number): number => (t * top.a + b * bottom.a * (1 - top.a)) / a;
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a };
}

function channel(v: number): number {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of an (opaque) colour. */
export function relativeLuminance(c: Rgba): number {
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

/** WCAG contrast ratio (1–21) between two opaque colours. */
export function contrastRatio(a: Rgba, b: Rgba): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Contrast of `text` on `panel` laid over `scene` (all CSS colours). */
export function textContrastOver(text: string, panel: string, scene: string): number {
  const backdrop = composite(parseColor(panel), parseColor(scene));
  return contrastRatio(composite(parseColor(text), backdrop), backdrop);
}
