import { describe, expect, it } from 'vitest';
import { ASSET_CREDITS, ASSET_LICENSE, creditSections, LIBRARY_CREDITS } from '../../src/data/credits';
import { projectRoot, readSourceFile } from './helpers/importScan';

// Task 25.2 (Req 40.2, 40.3, 43.9): CREDITS.md and src/data/credits.ts list the same libraries and assets field by
// field; every manifest entry is credited as CC0-1.0; the package.json dependencies are all credited.

const root = projectRoot();

/** Rows of the markdown table under `## <section>` as cell arrays (header and separator dropped). */
function tableRows(markdown: string, section: string): string[][] {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `## ${section}`);
  if (start < 0) throw new Error(`CREDITS.md has no "## ${section}"`);
  const rows: string[][] = [];
  let seenHeader = false;
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## ')) break;
    if (!line.trim().startsWith('|')) continue;
    const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    if (!seenHeader) {
      seenHeader = true;
      continue;
    }
    if (cells.every((c) => /^-+$/.test(c))) continue;
    rows.push(cells);
  }
  return rows;
}

describe('credits', () => {
  const md = readSourceFile(root, 'CREDITS.md');

  it('CREDITS.md Libraries table matches LIBRARY_CREDITS field by field', () => {
    const rows = tableRows(md, 'Libraries');
    expect(rows).toEqual(LIBRARY_CREDITS.map((l) => [l.name, l.version, l.author, l.url, l.license, l.use]));
  });

  it('CREDITS.md Assets table matches ASSET_CREDITS field by field, all CC0-1.0', () => {
    const rows = tableRows(md, 'Assets');
    expect(rows).toEqual(ASSET_CREDITS.map((a) => [a.id, a.name, a.author, a.url, a.license, a.path]));
    for (const a of ASSET_CREDITS) expect(a.license, a.id).toBe(ASSET_LICENSE);
  });

  it('every package.json dependency is credited with its exact version', () => {
    const pkg = JSON.parse(readSourceFile(root, 'package.json')) as {
      dependencies?: Record<string, string>; devDependencies?: Record<string, string>;
    };
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    for (const [name, version] of Object.entries(deps)) {
      const credit = LIBRARY_CREDITS.find((l) => l.name === name);
      expect(credit, `${name} is not credited`).toBeDefined();
      expect(credit?.version, name).toBe(version);
      expect(credit?.use, name).toBe(pkg.dependencies?.[name] !== undefined ? 'runtime' : 'dev');
    }
  });

  it('every manifest entry is credited as CC0-1.0 with its file path', () => {
    const manifest = JSON.parse(readSourceFile(root, 'public/assets/manifest.json')) as {
      audio?: { id: string; file: string; license: string }[]; models?: { id: string; file: string; license: string }[];
    };
    for (const entry of [...(manifest.audio ?? []), ...(manifest.models ?? [])]) {
      expect(entry.license, entry.id).toBe(ASSET_LICENSE);
      const credit = ASSET_CREDITS.find((a) => a.id === entry.id);
      expect(credit, `${entry.id} is not credited`).toBeDefined();
      expect(credit?.path.endsWith(entry.file), entry.id).toBe(true);
    }
  });

  it('the Credits screen sections list every library', () => {
    const sections = creditSections();
    const libs = sections.find((s) => s.title === '사용 라이브러리');
    expect(libs?.lines).toHaveLength(LIBRARY_CREDITS.length);
    for (const l of LIBRARY_CREDITS) expect(libs?.lines.some((line) => line.includes(l.name) && line.includes(l.license))).toBe(true);
  });
});
