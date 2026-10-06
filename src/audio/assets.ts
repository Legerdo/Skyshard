/*
 * Optional CC0 audio files (design "CC0 파일 연동", task 16.4, Req 40.1, 40.6). `public/assets/manifest.json` lists
 * them as `{ "audio": [...], "models": [...] }`; an audio entry is
 *   { "id": "sfx_step_grass" | "mus_verdant" ..., "kind": "sfx" | "music", "file": "audio/<name>.ogg",
 *     "author": "...", "sourceUrl": "https://...", "license": "CC0-1.0" }
 * with `file` relative to `public/assets/`. After the Title shows, the page fetches the manifest (same origin) and
 * each listed file, decodes it and hands the AudioEngine an id → AudioBuffer map; `sfx(id)` / `playMusic(id)` then
 * prefer the file and fall back to the synthesized recipe / TrackDef of the same id. A missing manifest, a missing
 * file or a failed decode only logs a warning. Only CC0-1.0 entries are accepted; used files go into CREDITS.md.
 */

/** The only license accepted for bundled assets. */
export const ASSET_LICENSE = 'CC0-1.0';

export interface AudioAssetEntry {
  readonly id: string;
  readonly kind: 'sfx' | 'music';
  /** Path under public/assets/. */
  readonly file: string;
  readonly author?: string;
  readonly sourceUrl?: string;
  readonly license: string;
}

export interface AssetManifest {
  readonly audio: readonly AudioAssetEntry[];
  readonly models: readonly unknown[];
}

type Warn = (message: string) => void;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The usable audio entries of a parsed manifest: an `sfx_` / `mus_` id matching its kind, a relative file path
 * without `..`, and the CC0-1.0 license. Anything else is skipped with a warning.
 */
export function parseAudioManifest(json: unknown, warn: Warn = () => undefined): AudioAssetEntry[] {
  if (!isRecord(json)) {
    warn('audio manifest: not an object');
    return [];
  }
  const list = json.audio;
  if (list === undefined) return [];
  if (!Array.isArray(list)) {
    warn('audio manifest: "audio" is not an array');
    return [];
  }
  const out: AudioAssetEntry[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    if (!isRecord(raw)) {
      warn('audio manifest: skipped a non-object entry');
      continue;
    }
    const { id, kind, file, license, author, sourceUrl } = raw;
    if (typeof id !== 'string' || typeof file !== 'string' || (kind !== 'sfx' && kind !== 'music')) {
      warn(`audio manifest: skipped an entry without id / kind / file (${String(id)})`);
      continue;
    }
    if ((kind === 'sfx' && !id.startsWith('sfx_')) || (kind === 'music' && !id.startsWith('mus_'))) {
      warn(`audio manifest: ${id} does not match its kind ${kind}`);
      continue;
    }
    if (license !== ASSET_LICENSE) {
      warn(`audio manifest: ${id} is not ${ASSET_LICENSE} (${String(license)}); skipped`);
      continue;
    }
    if (file.startsWith('/') || file.includes('..') || /^[a-z]+:/i.test(file)) {
      warn(`audio manifest: ${id} has a non-relative file path; skipped`);
      continue;
    }
    if (seen.has(id)) {
      warn(`audio manifest: duplicate id ${id}; the first entry is used`);
      continue;
    }
    seen.add(id);
    out.push({
      id, kind, file, license,
      ...(typeof author === 'string' ? { author } : {}),
      ...(typeof sourceUrl === 'string' ? { sourceUrl } : {}),
    });
  }
  return out;
}

export interface LoadAudioAssetsOptions {
  /** URL of the assets folder, ending in '/' (e.g. `${import.meta.env.BASE_URL}assets/`). */
  readonly assetsUrl: string;
  readonly fetch: (url: string) => Promise<Response>;
  readonly decode: (data: ArrayBuffer) => Promise<AudioBuffer>;
  readonly warn?: Warn;
}

/** Fetches the manifest and decodes every listed audio file; failures are warnings and leave the id out. */
export async function loadAudioAssets(o: LoadAudioAssetsOptions): Promise<Map<string, AudioBuffer>> {
  const warn = o.warn ?? ((m: string) => console.warn(m));
  const buffers = new Map<string, AudioBuffer>();
  let json: unknown;
  try {
    const res = await o.fetch(`${o.assetsUrl}manifest.json`);
    if (!res.ok) {
      warn(`audio manifest: HTTP ${res.status}; using synthesized sounds only`);
      return buffers;
    }
    json = await res.json();
  } catch (err) {
    warn(`audio manifest: could not be read (${String(err)}); using synthesized sounds only`);
    return buffers;
  }
  const entries = parseAudioManifest(json, warn);
  await Promise.all(entries.map(async (entry) => {
    try {
      const res = await o.fetch(`${o.assetsUrl}${entry.file}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      buffers.set(entry.id, await o.decode(await res.arrayBuffer()));
    } catch (err) {
      warn(`audio asset ${entry.id} (${entry.file}) failed: ${String(err)}; the synthesized sound is used`);
    }
  }));
  return buffers;
}
