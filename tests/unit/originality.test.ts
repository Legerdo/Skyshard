import { describe, expect, it } from 'vitest';
import { collectSourceFiles, lexSource, projectRoot, readSourceFile } from './helpers/importScan';

// Task 25.3 (Req 40.7): no display string or id of the game copies another open-world action RPG's element names,
// places, characters, monsters, ability or system terms. Every string literal of src/ (names, dialogue, quest and
// tutorial text, UI text, ids) and index.html is checked against tests/fixtures/originality-denylist.json:
// - Latin entries match as a sequence of whole words, case-insensitive, with camelCase / snake_case / kebab-case split
//   ("pyroSlime" → pyro slime; "Electro-Charged" → electro charged);
// - Korean entries match a whole space- or punctuation-separated word, optionally followed by a Korean particle
//   ("몬드에서" matches 몬드; "나타나다" does not match 나타).

const root = projectRoot();

interface Denylist {
  readonly [category: string]: unknown;
}

const HANGUL = /[\uac00-\ud7a3]/;
/** Particles that may follow a Korean proper noun. */
const PARTICLES = ['', '의', '에', '에서', '은', '는', '이', '가', '을', '를', '로', '으로', '와', '과', '도', '만', '까지', '부터', '족'];

/** Lower-case whole words of a Latin text: camelCase, digits and every non-letter split. */
export function latinWords(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z']+/)
    .map((w) => w.replace(/^'+|'+$/g, ''))
    .filter((w) => w.length > 0);
}

/** Korean words: runs of Hangul separated by anything else. */
function koreanWords(text: string): string[] {
  return text.split(/[^\uac00-\ud7a3]+/).filter((w) => w.length > 0);
}

interface Matcher {
  /** Denylist entries found in `text`. */
  find(text: string): string[];
}

export function buildMatcher(entries: readonly string[]): Matcher {
  const latin = entries.filter((e) => !HANGUL.test(e)).map((e) => ({ entry: e, words: latinWords(e) })).filter((e) => e.words.length > 0);
  const korean = entries.filter((e) => HANGUL.test(e)).map((e) => ({ entry: e, words: koreanWords(e) }));
  return {
    find(text: string): string[] {
      const found: string[] = [];
      const lw = latinWords(text);
      for (const { entry, words } of latin) {
        for (let i = 0; i + words.length <= lw.length; i++) {
          if (words.every((w, k) => lw[i + k] === w)) {
            found.push(entry);
            break;
          }
        }
      }
      if (HANGUL.test(text)) {
        const kw = koreanWords(text);
        for (const { entry, words } of korean) {
          const last = words.length - 1;
          for (let i = 0; i + words.length <= kw.length; i++) {
            const ok = words.every((w, k) => (k < last ? kw[i + k] === w : PARTICLES.some((p) => kw[i + k] === w + p)));
            if (ok) {
              found.push(entry);
              break;
            }
          }
        }
      }
      return found;
    },
  };
}

function loadDenylist(): string[] {
  const raw = JSON.parse(readSourceFile(root, 'tests/fixtures/originality-denylist.json')) as Denylist;
  return Object.entries(raw)
    .filter(([key]) => !key.startsWith('_'))
    .flatMap(([, list]) => (Array.isArray(list) ? list.filter((e): e is string => typeof e === 'string') : []));
}

describe('originality guard (Req 40.7)', () => {
  const entries = loadDenylist();
  const matcher = buildMatcher(entries);

  it('the denylist covers every category and the matcher is not vacuous', () => {
    expect(entries.length).toBeGreaterThan(150);
    expect(matcher.find('Mondstadt의 바람')).toEqual(['Mondstadt']);
    expect(matcher.find('pyroSlime')).toEqual(['Pyro']);
    expect(matcher.find('ELECTRO_CHARGED burst')).toEqual(expect.arrayContaining(['Electro', 'Electro-Charged']));
    expect(matcher.find('몬드에서 온 여행자')).toEqual(['몬드']);
    expect(matcher.find('원소 폭발 게이지')).toEqual(['원소 폭발']);
    expect(matcher.find('적이 나타나다')).toEqual([]);
    expect(matcher.find('geometry')).toEqual([]);
    expect(matcher.find('Aether Sentinel')).toEqual([]); // dictionary words are not listed
  });

  it('no string literal of src/ or index.html uses a denylisted name', () => {
    const files = collectSourceFiles(root, ['src']);
    expect(files.length).toBeGreaterThan(100);
    const hits: string[] = [];
    for (const file of files) {
      const { strings } = lexSource(readSourceFile(root, file));
      for (const text of strings.values()) {
        for (const entry of matcher.find(text)) hits.push(`${file}: "${text.slice(0, 60)}" → ${entry}`);
      }
    }
    for (const entry of matcher.find(readSourceFile(root, 'index.html'))) hits.push(`index.html → ${entry}`);
    expect(hits).toEqual([]);
  });

  it('no registered id or display name uses a denylisted name', async () => {
    const ids = await import('../../src/data/ids');
    const values: string[] = [];
    for (const value of Object.values(ids)) {
      if (Array.isArray(value)) values.push(...value.filter((v): v is string => typeof v === 'string'));
      else if (value !== null && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) values.push(k, ...(typeof v === 'string' ? [v] : []));
      }
    }
    expect(values.length).toBeGreaterThan(80);
    const hits = values.flatMap((v) => matcher.find(v).map((e) => `${v} → ${e}`));
    expect(hits).toEqual([]);
  });
});
