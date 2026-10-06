// Map fog of war (design.md "지도 (Map_System)"; Req 33.2, 33.3). Pure: no DOM.
// World [−560, 560]² in 8 m cells, 140 × 140, kept as a bitset (cell index k → bit k, LSB first) and saved as base64.

export const FOG_CELL = 8, FOG_GRID = 140, FOG_EXTENT = 560;

const BYTES = (FOG_GRID * FOG_GRID) / 8; // 19,600 cells → 2,450 bytes
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Cell along one axis, or −1 outside [−560, 560] (NaN included); 560 clamps to the last cell. */
function axisCell(v: number): number {
  if (!(v >= -FOG_EXTENT && v <= FOG_EXTENT)) return -1;
  return Math.min(FOG_GRID - 1, Math.floor((v + FOG_EXTENT) / FOG_CELL));
}

/** `⌊(z + 560) / 8⌋ × 140 + ⌊(x + 560) / 8⌋`, or −1 when (x, z) is outside the world or not finite. */
export function cellIndex(x: number, z: number): number {
  const i = axisCell(x);
  const j = axisCell(z);
  return i < 0 || j < 0 ? -1 : j * FOG_GRID + i;
}

const cellCenter = (i: number): number => -FOG_EXTENT + (i + 0.5) * FOG_CELL;

/** Cells whose centers may lie in [v − r, v + r], rounded outward; reveal() then tests each cell exactly. */
function span(v: number, r: number): [number, number] {
  const lo = Math.floor((v - r + FOG_EXTENT) / FOG_CELL - 0.5);
  const hi = Math.ceil((v + r + FOG_EXTENT) / FOG_CELL - 0.5);
  return [Math.max(0, lo), Math.min(FOG_GRID - 1, hi)];
}

function popcount(bytes: Uint8Array): number {
  let n = 0;
  for (const byte of bytes) {
    for (let b = byte; b !== 0; b &= b - 1) n++;
  }
  return n;
}

/** Padded standard base64 (RFC 4648) without btoa / Buffer. */
function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const left = bytes.length - i;
    const n = (bytes[i] << 16) | ((left > 1 ? bytes[i + 1] : 0) << 8) | (left > 2 ? bytes[i + 2] : 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    out += (left > 1 ? B64[(n >> 6) & 63] : '=') + (left > 2 ? B64[n & 63] : '=');
  }
  return out;
}

/** The `size` bytes of a padded base64 string of exactly the matching length, or null. */
function fromBase64(s: unknown, size: number): Uint8Array | null {
  const pad = (3 - (size % 3)) % 3;
  if (typeof s !== 'string' || s.length !== Math.ceil(size / 3) * 4 || !s.endsWith('='.repeat(pad))) return null;
  const out = new Uint8Array(size);
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < s.length - pad; i++) {
    const v = B64.indexOf(s.charAt(i));
    if (v < 0) return null;
    acc = ((acc << 6) | v) & 0xfff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}

/** Revealed map cells. Only reveal() changes the state, and a revealed cell never hides again. */
export class FogOfWar {
  private readonly bits = new Uint8Array(BYTES);
  private count: number;

  /** Copies `bits` when it holds exactly 2,450 bytes; anything else starts all hidden. */
  constructor(bits?: Uint8Array) {
    if (bits?.length === BYTES) this.bits.set(bits);
    this.count = popcount(this.bits);
  }

  /** Reveals every cell whose center lies within r of (x, z); returns the number newly revealed. */
  reveal(x: number, z: number, r: number): number {
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(r) || r < 0) return 0;
    const [i0, i1] = span(x, r);
    const [j0, j1] = span(z, r);
    let added = 0;
    for (let j = j0; j <= j1; j++) {
      const dz = cellCenter(j) - z;
      for (let i = i0; i <= i1; i++) {
        const dx = cellCenter(i) - x;
        if (dx * dx + dz * dz > r * r) continue;
        const k = j * FOG_GRID + i;
        const bit = 1 << (k & 7);
        if ((this.bits[k >> 3] & bit) !== 0) continue;
        this.bits[k >> 3] |= bit;
        added++;
      }
    }
    this.count += added;
    return added;
  }

  /** Whether the cell holding (x, z) is revealed; false outside the world. */
  isRevealed(x: number, z: number): boolean {
    const k = cellIndex(x, z);
    return k >= 0 && (this.bits[k >> 3] & (1 << (k & 7))) !== 0;
  }

  /** Whether cell (i, j) (x column, z row, 0–139) is revealed; false outside the grid. The map's fog mask reads this. */
  isCellRevealed(i: number, j: number): boolean {
    if (!(i >= 0 && i < FOG_GRID && j >= 0 && j < FOG_GRID) || !Number.isInteger(i) || !Number.isInteger(j)) return false;
    const k = j * FOG_GRID + i;
    return (this.bits[k >> 3] & (1 << (k & 7))) !== 0;
  }

  revealedCount(): number {
    return this.count;
  }

  /** The bitset as base64: 2,450 bytes → 3,268 characters. */
  encode(): string {
    return toBase64(this.bits);
  }

  /** Inverse of encode(). Any other input (wrong length, bad characters, non-string) gives an all-hidden fog. */
  static decode(s: string): FogOfWar {
    return new FogOfWar(fromBase64(s, BYTES) ?? undefined);
  }

  clone(): FogOfWar {
    return new FogOfWar(this.bits);
  }
}
