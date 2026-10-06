/*
 * FNV-1a 32-bit hash (design SaveEnvelope `checksum`): over the UTF-16 code units of the string, as 8 lowercase hex
 * digits. Not a security measure: it catches truncation, hand edits and bit rot before the schema checks.
 */

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export function fnv1a32(text: string): number {
  let h = FNV_OFFSET;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME) >>> 0;
  }
  return h >>> 0;
}

export function fnv1a32Hex(text: string): string {
  return fnv1a32(text).toString(16).padStart(8, '0');
}
