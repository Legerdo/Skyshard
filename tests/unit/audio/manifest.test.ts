import { describe, expect, it } from 'vitest';
import manifest from '../../../public/assets/manifest.json';
import { loadAudioAssets, parseAudioManifest } from '../../../src/audio/assets';
import { sfxRecipe } from '../../../src/audio/sfxRecipes';
import { isMusicTrackId, TRACKS } from '../../../src/data/music';

describe('CC0 audio manifest (task 16.4, Req 40.1, 40.6)', () => {
  it('every manifest audio id has a same-id recipe or TrackDef, so it sounds with or without the file', () => {
    const raw = (manifest as { audio?: unknown }).audio;
    expect(Array.isArray(raw)).toBe(true);
    const warnings: string[] = [];
    const entries = parseAudioManifest(manifest, (m) => warnings.push(m));
    expect(warnings).toEqual([]);
    expect(entries).toHaveLength((raw as unknown[]).length);
    for (const e of entries) {
      if (e.kind === 'music') {
        expect(isMusicTrackId(e.id), e.id).toBe(true);
        if (isMusicTrackId(e.id)) expect(TRACKS[e.id]).toBeDefined();
      } else {
        expect(sfxRecipe(e.id), e.id).not.toBeNull();
      }
    }
  });

  it('skips malformed, non-CC0 and unsafe entries with a warning', () => {
    const warnings: string[] = [];
    const entries = parseAudioManifest({
      audio: [
        { id: 'sfx_jump', kind: 'sfx', file: 'audio/jump.ogg', license: 'CC0-1.0', author: 'a' },
        { id: 'sfx_jump', kind: 'sfx', file: 'audio/jump2.ogg', license: 'CC0-1.0' },
        { id: 'mus_verdant', kind: 'sfx', file: 'audio/v.ogg', license: 'CC0-1.0' },
        { id: 'sfx_land', kind: 'sfx', file: '../secret.ogg', license: 'CC0-1.0' },
        { id: 'sfx_land', kind: 'sfx', file: 'audio/land.ogg', license: 'CC-BY-4.0' },
        'nope',
      ],
    }, (m) => warnings.push(m));
    expect(entries.map((e) => e.id)).toEqual(['sfx_jump']);
    expect(warnings).toHaveLength(5);
    expect(parseAudioManifest({ models: [] })).toEqual([]);
  });

  it('decodes the listed files; a missing file or a failed decode only warns and leaves the id out', async () => {
    const files: Record<string, number> = { 'assets/audio/jump.ogg': 8, 'assets/audio/bad.ogg': 0 };
    const warnings: string[] = [];
    const buffers = await loadAudioAssets({
      assetsUrl: 'assets/',
      fetch: (url) => {
        if (url === 'assets/manifest.json') {
          return Promise.resolve(new Response(JSON.stringify({
            audio: [
              { id: 'sfx_jump', kind: 'sfx', file: 'audio/jump.ogg', license: 'CC0-1.0' },
              { id: 'sfx_land', kind: 'sfx', file: 'audio/missing.ogg', license: 'CC0-1.0' },
              { id: 'mus_verdant', kind: 'music', file: 'audio/bad.ogg', license: 'CC0-1.0' },
            ],
          })));
        }
        const size = files[url];
        return Promise.resolve(size === undefined ? new Response(null, { status: 404 }) : new Response(new Uint8Array(size)));
      },
      decode: (data) => (data.byteLength > 0 ? Promise.resolve({ duration: 1 } as AudioBuffer) : Promise.reject(new Error('EncodingError'))),
      warn: (m) => warnings.push(m),
    });
    expect([...buffers.keys()]).toEqual(['sfx_jump']);
    expect(warnings).toHaveLength(2);
    const none = await loadAudioAssets({
      assetsUrl: 'x/', fetch: () => Promise.reject(new Error('offline')), decode: () => Promise.reject(new Error('never')), warn: (m) => warnings.push(m),
    });
    expect(none.size).toBe(0);
  });
});
