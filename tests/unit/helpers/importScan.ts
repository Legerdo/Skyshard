/*
 * Dependency-boundary scanner for tests/unit/layering.test.ts (design.md, "모듈 의존 규칙").
 *
 * TypeScript 7's native compiler has no JS API, so sources are analysed with a small lexer plus
 * regexes: `lexSource` blanks comments, string/template text and regex-literal bodies while keeping
 * offsets and line breaks, import specifiers are read back from the recorded string literals, and
 * forbidden references are matched on the remaining code. It is intentionally simple (no alias or
 * re-export tracing); layering.test.ts self-checks it on in-memory samples.
 */

// ── Rules ───────────────────────────────────────────────────────────────────

/** Pure rule layers: no three.js / VRM, DOM / Web globals, Math.random, or other src imports. */
export const PURE_LAYER_DIRS = ['src/logic', 'src/data'] as const;

/** The only src/core modules the pure layers may import (with or without `.ts` / `/index`). */
export const PURE_CORE_MODULES = ['src/core/rng', 'src/core/math', 'src/core/types'] as const;

/** Packages (and their subpaths) the pure layers must not import. */
export const FORBIDDEN_PACKAGES: readonly RegExp[] = [/^three(?:\/|$)/, /^@pixiv\/three-vrm(?:[-/]|$)/];

/** DOM / Web globals the pure layers must not reference. */
export const FORBIDDEN_GLOBALS = [
  'window',
  'document',
  'navigator',
  'localStorage',
  'AudioContext',
  'requestAnimationFrame',
] as const;

/** Simulation systems (and the pure layers) that must not import presentation modules. */
export const SIMULATION_DIRS = [
  'src/logic',
  'src/data',
  'src/physics',
  'src/player',
  'src/party',
  'src/combat',
  'src/element',
  'src/enemies',
  'src/boss',
  'src/quest',
  'src/progression',
  'src/inventory',
  'src/loot',
  'src/save',
  // Task 19.7 (design "모듈 의존 규칙"): the remaining simulation systems.
  'src/world',
  'src/dialogue',
  'src/tutorial',
] as const;

/** Task 19.7: single-file simulation modules (the headless PlaySim composition) under the same rule. */
export const SIMULATION_FILES = ['src/playSim.ts'] as const;

/** Presentation modules. */
export const PRESENTATION_DIRS = [
  'src/render',
  'src/visual',
  'src/anim',
  'src/vfx',
  'src/ui',
  'src/audio',
  'src/camera',
] as const;

export type RuleId =
  | 'forbidden-package'
  | 'forbidden-src-import'
  | 'forbidden-global'
  | 'math-random'
  | 'presentation-import';

export interface Violation {
  /** Root-relative POSIX path. */
  readonly file: string;
  /** 1-based. */
  readonly line: number;
  /** 1-based. */
  readonly column: number;
  readonly rule: RuleId;
  readonly message: string;
}

export function formatViolation(v: Violation): string {
  return `${v.file}:${v.line}:${v.column} [${v.rule}] ${v.message}`;
}

// ── Lexing ──────────────────────────────────────────────────────────────────

export interface LexedSource {
  /** Source with comments, string/template text and regex bodies replaced by spaces; line breaks and offsets are kept. */
  readonly code: string;
  /** Raw text of each string literal and substitution-free template literal, keyed by the offset of its opening quote. */
  readonly strings: ReadonlyMap<number, string>;
}

const IDENTIFIER_CHAR = /[\w$]/;
const WHITESPACE = /\s/;
const REGEX_FLAG = /[a-z]/i;
/** After these characters (or at the start of the file) a `/` begins a regex literal, not a division. */
const REGEX_AFTER_CHAR = new Set([...'([{},;:=!?&|^~+-*%<>', '']);
/** After these keywords a `/` begins a regex literal. */
const REGEX_AFTER_WORD = new Set(
  'return typeof instanceof in of new delete void throw case do else yield await'.split(' '),
);
/** Stand-in for "the previous token ended an expression" (string, template, regex literal). */
const EXPRESSION_END = ')';

export function lexSource(source: string): LexedSource {
  const chars = source.split(''); // UTF-16 code units, so indices match `source`
  const strings = new Map<number, string>();
  const substitutionDepths: number[] = []; // brace depth at which each open `${ … }` started
  let depth = 0;
  let prevChar = ''; // last significant code character
  let prevWord = ''; // identifier or keyword that ended at prevChar, if any

  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) {
      if (chars[k] !== '\n' && chars[k] !== '\r') chars[k] = ' ';
    }
  };

  /** Scans template text from `from`; returns the offset after the closing backtick or after `${`. */
  const scanTemplate = (from: number, openQuote: number | null): number => {
    for (let k = from; k < source.length; k++) {
      const c = source[k];
      if (c === '\\') {
        k++;
      } else if (c === '`') {
        blank(from, k);
        if (openQuote !== null) strings.set(openQuote, source.slice(from, k));
        prevChar = EXPRESSION_END;
        prevWord = '';
        return k + 1;
      } else if (c === '$' && source[k + 1] === '{') {
        blank(from, k);
        substitutionDepths.push(depth);
        prevChar = '{';
        prevWord = '';
        return k + 2;
      }
    }
    blank(from, source.length);
    return source.length;
  };

  let i = 0;
  while (i < source.length) {
    const c = source[i] ?? '';
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === '"' || c === "'") {
      const close = closingQuote(source, i);
      strings.set(i, source.slice(i + 1, close));
      blank(i + 1, close);
      i = source[close] === c ? close + 1 : close;
      prevChar = EXPRESSION_END;
      prevWord = '';
    } else if (c === '`') {
      i = scanTemplate(i + 1, i);
    } else if (c === '}' && substitutionDepths.at(-1) === depth) {
      substitutionDepths.pop();
      i = scanTemplate(i + 1, null);
    } else if (c === '/' && (prevWord !== '' ? REGEX_AFTER_WORD.has(prevWord) : REGEX_AFTER_CHAR.has(prevChar))) {
      const close = closingSlash(source, i);
      if (close === -1) {
        // No closing slash on this line: it was a division after all.
        prevChar = c;
        prevWord = '';
        i++;
      } else {
        blank(i + 1, close);
        i = close + 1;
        while (i < source.length && REGEX_FLAG.test(source[i] ?? '')) i++;
        prevChar = EXPRESSION_END;
        prevWord = '';
      }
    } else {
      if (c === '{') depth++;
      else if (c === '}') depth--;
      if (IDENTIFIER_CHAR.test(c)) {
        prevWord = i > 0 && IDENTIFIER_CHAR.test(source[i - 1] ?? '') ? prevWord + c : c;
        prevChar = c;
      } else if (!WHITESPACE.test(c)) {
        prevChar = c;
        prevWord = '';
      }
      i++;
    }
  }
  return { code: chars.join(''), strings };
}

/** Offset of the quote closing the string literal that opens at `start` (line end / EOF if unterminated). */
function closingQuote(source: string, start: number): number {
  const quote = source[start];
  for (let k = start + 1; k < source.length; k++) {
    const c = source[k];
    if (c === '\\') {
      k++;
      if (source[k] === '\r' && source[k + 1] === '\n') k++;
    } else if (c === quote || c === '\n') {
      return k;
    }
  }
  return source.length;
}

/** Offset of the slash closing the regex literal that opens at `start`, or -1 if none on this line. */
function closingSlash(source: string, start: number): number {
  let inClass = false;
  for (let k = start + 1; k < source.length; k++) {
    const c = source[k];
    if (c === '\n' || c === '\r') return -1;
    if (c === '\\') k++;
    else if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) return k;
  }
  return -1;
}

// ── Finders ─────────────────────────────────────────────────────────────────

export type ImportKind = 'static' | 'dynamic' | 'require';

export interface ImportRef {
  readonly specifier: string;
  /** Offset of the specifier's opening quote. */
  readonly offset: number;
  readonly kind: ImportKind;
}

const IMPORT_PATTERNS: ReadonlyArray<readonly [RegExp, ImportKind]> = [
  // import … from '…', export … from '…', import '…'
  [/(?<![\w$.])(?:from|import)\s*(?=["'])/g, 'static'],
  // import('…'), typeof import('…')
  [/(?<![\w$.])import\s*\(\s*(?=["'`])/g, 'dynamic'],
  // require('…'), import x = require('…')
  [/(?<![\w$.])require\s*\(\s*(?=["'`])/g, 'require'],
];

/** Import specifiers of every static, dynamic and `require` import, in source order. */
export function findImports(lexed: LexedSource): ImportRef[] {
  const refs: ImportRef[] = [];
  for (const [pattern, kind] of IMPORT_PATTERNS) {
    for (const match of lexed.code.matchAll(pattern)) {
      const offset = match.index + match[0].length;
      const specifier = lexed.strings.get(offset);
      if (specifier !== undefined) refs.push({ specifier, offset, kind });
    }
  }
  return refs.sort((a, b) => a.offset - b.offset);
}

export interface GlobalRef {
  readonly name: (typeof FORBIDDEN_GLOBALS)[number];
  readonly offset: number;
}

// A bare identifier, or a member of `globalThis` / `self`; `obj.window` and `windowSize` do not match.
const FORBIDDEN_GLOBAL_PATTERN = new RegExp(
  String.raw`(?<![\w$.])(?:(?:globalThis|self)\s*\??\.\s*)?(${FORBIDDEN_GLOBALS.join('|')})(?![\w$])`,
  'g',
);

/** References to {@link FORBIDDEN_GLOBALS} outside comments and strings. */
export function findForbiddenGlobals(lexed: LexedSource): GlobalRef[] {
  const refs: GlobalRef[] = [];
  for (const match of lexed.code.matchAll(FORBIDDEN_GLOBAL_PATTERN)) {
    const name = FORBIDDEN_GLOBALS.find((g) => g === match[1]);
    if (name !== undefined) refs.push({ name, offset: match.index + match[0].length - name.length });
  }
  return refs;
}

const MATH_RANDOM_PATTERNS: readonly RegExp[] = [
  // Math.random, Math?.random, globalThis.Math.random
  /(?<![\w$])Math\s*\??\.\s*random(?![\w$])/g,
  // const { random } = Math
  /\{[^{}]*(?<![\w$.])random(?![\w$])[^{}]*\}\s*=\s*(?:globalThis\s*\.\s*)?Math(?![\w$])/g,
];
// Math['random'] (the key is read back from the recorded string literal)
const MATH_INDEX_PATTERN = /(?<![\w$])Math\s*\[\s*(?=["'`])/g;

/** Offsets of every `Math.random` use outside comments and strings. */
export function findMathRandom(lexed: LexedSource): number[] {
  const offsets = MATH_RANDOM_PATTERNS.flatMap((pattern) =>
    [...lexed.code.matchAll(pattern)].map((match) => match.index),
  );
  for (const match of lexed.code.matchAll(MATH_INDEX_PATTERN)) {
    if (lexed.strings.get(match.index + match[0].length) === 'random') offsets.push(match.index);
  }
  return offsets.sort((a, b) => a - b);
}

// ── Path resolution ─────────────────────────────────────────────────────────

/**
 * Resolves a relative (`./`, `../`) or root-absolute (`/src/…`, Vite style) specifier against the
 * root-relative POSIX path of the importing file. Returns null for package specifiers. Query and
 * hash suffixes (`?raw`) are dropped; paths escaping the root keep leading `../` segments.
 */
export function resolveImport(fromFile: string, specifier: string): string | null {
  const path = specifier.replace(/[?#].*$/, '');
  let segments: string[];
  if (path.startsWith('/')) {
    segments = [];
  } else if (path === '.' || path === '..' || path.startsWith('./') || path.startsWith('../')) {
    segments = fromFile.split('/').slice(0, -1);
  } else {
    return null;
  }
  let escaped = 0;
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part !== '..') segments.push(part);
    else if (segments.length > 0) segments.pop();
    else escaped++;
  }
  return [...Array<string>(escaped).fill('..'), ...segments].join('/');
}

const isWithin = (path: string, dir: string): boolean => path === dir || path.startsWith(`${dir}/`);

/** Drops a source extension and a trailing `/index`: `src/core/rng.ts`, `src/core/rng/index` → `src/core/rng`. */
function moduleKey(target: string): string {
  return target.replace(/\.(?:d\.)?[cm]?[jt]sx?$/, '').replace(/\/index$/, '');
}

/** Whether a pure-layer file may import the resolved root-relative `target`. Paths outside src/ are not governed. */
export function isPureLayerImportAllowed(target: string): boolean {
  if (!isWithin(target, 'src')) return true;
  const key = moduleKey(target);
  return PURE_LAYER_DIRS.some((dir) => isWithin(key, dir)) || PURE_CORE_MODULES.some((m) => m === key);
}

/** The presentation directory containing the resolved root-relative `target`, or null. */
export function presentationModuleOf(target: string): string | null {
  const key = moduleKey(target);
  return PRESENTATION_DIRS.find((dir) => isWithin(key, dir)) ?? null;
}

// ── Checks ──────────────────────────────────────────────────────────────────

interface Finding {
  readonly offset: number;
  readonly rule: RuleId;
  readonly message: string;
}

/** Rules for src/logic and src/data. `file` is the root-relative POSIX path of `source`. */
export function checkPureLayer(file: string, source: string): Violation[] {
  const lexed = lexSource(source);
  const found: Finding[] = [];
  for (const { specifier, offset } of findImports(lexed)) {
    if (FORBIDDEN_PACKAGES.some((pattern) => pattern.test(specifier))) {
      found.push({ offset, rule: 'forbidden-package', message: `imports '${specifier}'` });
    }
    const target = resolveImport(file, specifier);
    if (target !== null && !isPureLayerImportAllowed(target)) {
      found.push({
        offset,
        rule: 'forbidden-src-import',
        message: `imports '${specifier}' (${target}); allowed: src/logic, src/data, src/core/{rng,math,types}`,
      });
    }
  }
  for (const { name, offset } of findForbiddenGlobals(lexed)) {
    found.push({ offset, rule: 'forbidden-global', message: `references '${name}'` });
  }
  for (const offset of findMathRandom(lexed)) {
    found.push({ offset, rule: 'math-random', message: 'uses Math.random; use a seeded src/core/rng stream' });
  }
  return toViolations(file, source, found);
}

/** Rule for simulation systems: no imports from presentation modules. */
export function checkSimulationLayer(file: string, source: string): Violation[] {
  const found: Finding[] = [];
  for (const { specifier, offset } of findImports(lexSource(source))) {
    const target = resolveImport(file, specifier);
    const presentation = target === null ? null : presentationModuleOf(target);
    if (presentation !== null) {
      found.push({
        offset,
        rule: 'presentation-import',
        message: `imports '${specifier}' from presentation module ${presentation}`,
      });
    }
  }
  return toViolations(file, source, found);
}

function toViolations(file: string, source: string, found: readonly Finding[]): Violation[] {
  const lineStarts = [0];
  for (let k = 0; k < source.length; k++) {
    if (source[k] === '\n') lineStarts.push(k + 1);
  }
  return [...found]
    .sort((a, b) => a.offset - b.offset)
    .map(({ offset, rule, message }) => {
      let line = 0; // index of the last line start <= offset (binary search)
      let hi = lineStarts.length - 1;
      while (line < hi) {
        const mid = (line + hi + 1) >> 1;
        if ((lineStarts[mid] ?? 0) <= offset) line = mid;
        else hi = mid - 1;
      }
      return { file, line: line + 1, column: offset - (lineStarts[line] ?? 0) + 1, rule, message };
    });
}

// ── File system ─────────────────────────────────────────────────────────────
// @types/node is not installed: vite's typings reference it, so installing it would add Node
// globals to the type check of the browser code. The few Node APIs used here are typed locally
// and loaded through `process.getBuiltinModule` (Node >= 20.16).

interface DirEntry {
  readonly name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

interface NodeFs {
  existsSync(path: string): boolean;
  readdirSync(path: string, options: { withFileTypes: true }): DirEntry[];
  readFileSync(path: string, encoding: 'utf8'): string;
}

interface NodePath {
  join(...paths: string[]): string;
}

interface NodeUrl {
  fileURLToPath(url: string | URL): string;
}

interface NodeBuiltins {
  'node:fs': NodeFs;
  'node:path': NodePath;
  'node:url': NodeUrl;
}

function builtin<K extends keyof NodeBuiltins>(id: K): NodeBuiltins[K] {
  const nodeProcess = (globalThis as unknown as { process?: { getBuiltinModule?: (id: string) => unknown } })
    .process;
  if (typeof nodeProcess?.getBuiltinModule !== 'function') {
    throw new Error(`Cannot load ${id}: run this test under Node.js >= 20.16.`);
  }
  return nodeProcess.getBuiltinModule(id) as NodeBuiltins[K];
}

const SOURCE_FILE = /\.[cm]?[jt]sx?$/;

/** Absolute path of the project root (this file lives in tests/unit/helpers). */
export function projectRoot(): string {
  return builtin('node:url').fileURLToPath(new URL('../../../', import.meta.url));
}

/**
 * Source files (.ts, .tsx, .mts, .cts, .js, …) under the given root-relative directories, recursively,
 * as sorted root-relative POSIX paths. Missing directories and non-source files (.gitkeep) are skipped.
 */
export function collectSourceFiles(root: string, dirs: readonly string[]): string[] {
  const fs = builtin('node:fs');
  const path = builtin('node:path');
  const files = new Set<string>();
  const walk = (dir: string): void => {
    const absolute = path.join(root, ...dir.split('/'));
    if (!fs.existsSync(absolute)) return;
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const child = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile() && SOURCE_FILE.test(entry.name)) files.add(child);
    }
  };
  for (const dir of dirs) walk(dir);
  return [...files].sort();
}

/** Reads a root-relative POSIX path as UTF-8. */
export function readSourceFile(root: string, file: string): string {
  return builtin('node:fs').readFileSync(builtin('node:path').join(root, ...file.split('/')), 'utf8');
}
