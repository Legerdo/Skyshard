import { describe, expect, it } from 'vitest';
import {
  PRESENTATION_DIRS,
  PURE_LAYER_DIRS,
  SIMULATION_DIRS,
  SIMULATION_FILES,
  checkPureLayer,
  checkSimulationLayer,
  collectSourceFiles,
  findForbiddenGlobals,
  findImports,
  findMathRandom,
  formatViolation,
  isPureLayerImportAllowed,
  lexSource,
  presentationModuleOf,
  projectRoot,
  readSourceFile,
  resolveImport,
  type Violation,
} from './helpers/importScan';

// Dependency rules from design.md "모듈 의존 규칙" (Req 42.1, 43.3), checked on the real sources.
describe('layer boundaries', () => {
  const root = projectRoot();

  it('src/logic and src/data import no three.js / VRM, reference no DOM or Web globals, avoid Math.random, and import only logic, data and core/{rng,math,types}', () => {
    const files = collectSourceFiles(root, PURE_LAYER_DIRS);
    expect(files).toContain('src/data/ids.ts');
    const violations = files.flatMap((file) => checkPureLayer(file, readSourceFile(root, file)));
    expect(violations.map(formatViolation)).toEqual([]);
  });

  it('the pure player controller core (src/player/core) imports no three.js / DOM and avoids Math.random, importing only core, data, logic, physics and itself', () => {
    const files = collectSourceFiles(root, ['src/player/core']);
    expect(files).toContain('src/player/core/glide.ts');
    const allowed = ['src/core', 'src/data', 'src/logic', 'src/physics', 'src/player/core'];
    const problems = files.flatMap((file) => {
      const lexed = lexSource(readSourceFile(root, file));
      const imports = findImports(lexed).map((ref) => ref.specifier);
      return [
        ...imports
          .filter((spec) => {
            const target = resolveImport(file, spec);
            return target === null || !allowed.some((dir) => target === dir || target.startsWith(`${dir}/`));
          })
          .map((spec) => `${file}: imports ${spec}`),
        ...findForbiddenGlobals(lexed).map((ref) => `${file}: references ${ref.name}`),
        ...findMathRandom(lexed).map(() => `${file}: uses Math.random`),
      ];
    });
    expect(problems).toEqual([]);
  });

  it('simulation systems do not import presentation modules', () => {
    const files = collectSourceFiles(root, SIMULATION_DIRS);
    const violations = files.flatMap((file) => checkSimulationLayer(file, readSourceFile(root, file)));
    expect(violations.map(formatViolation)).toEqual([]);
  });

  // Task 19.7 (Req 43.3): swapping visual models cannot reach collision, movement, hits or rules.
  it('simulation modules, src/logic and src/data never import src/visual, src/anim or src/render', () => {
    for (const dir of ['src/logic', 'src/data', 'src/world', 'src/dialogue', 'src/tutorial']) expect(SIMULATION_DIRS).toContain(dir);
    for (const dir of ['src/visual', 'src/anim', 'src/render']) expect(PRESENTATION_DIRS).toContain(dir);
    const files = [...collectSourceFiles(root, SIMULATION_DIRS), ...SIMULATION_FILES];
    expect(files).toContain('src/data/visualManifest.ts');
    expect(files).toContain('src/playSim.ts');
    const visual = files.flatMap((file) => checkSimulationLayer(file, readSourceFile(root, file)))
      .filter((v) => /presentation module src\/(visual|anim|render)$/.test(v.message));
    expect(visual.map(formatViolation)).toEqual([]);
    expect(summarize(checkSimulationLayer('src/playSim.ts', "import { buildRig } from './anim/rigKit';\nimport { EntityView } from './visual/entityView';")))
      .toEqual([[1, 'presentation-import'], [2, 'presentation-import']]);
  });

  it('file walker recurses into subdirectories, lists only source files and skips missing directories', () => {
    const files = collectSourceFiles(root, ['tests/unit', 'src/__missing__']);
    expect(files).toContain('tests/unit/layering.test.ts');
    expect(files).toContain('tests/unit/helpers/importScan.ts');
    expect(files.filter((file) => !/\.[cm]?[jt]sx?$/.test(file))).toEqual([]);
  });
});

const lines = (...sourceLines: string[]): string => sourceLines.join('\n');
const summarize = (violations: readonly Violation[]): Array<[number, string]> =>
  violations.map((v) => [v.line, v.rule]);

describe('import scanner self-test', () => {
  it('lexSource blanks comments, string text and regex bodies but keeps offsets and template substitutions', () => {
    const source = lines(
      "const a = 'window'; // document",
      '/* navigator */ const b = `x ${localStorage} y`;',
      'const c = /AudioContext/g;',
    );
    const { code, strings } = lexSource(source);
    expect(code).toHaveLength(source.length);
    expect(code.split('\n')).toHaveLength(3);
    expect(code).not.toMatch(/window|document|navigator|AudioContext/);
    expect(code).toContain('${localStorage}');
    expect(strings.get(source.indexOf("'window'"))).toBe('window');
  });

  it('findImports sees every import form and ignores comments and strings', () => {
    const source = lines(
      "import a from 'pkg-a';",
      'import {',
      '  b,',
      '} from "pkg-b";',
      "import 'pkg-c';",
      "export * from 'pkg-d';",
      "const e = await import('pkg-e');",
      "type F = typeof import('pkg-f');",
      "import g = require('pkg-g');",
      "import type { H } from 'pkg-h';",
      "// import x from 'commented';",
      "/* export * from 'block-commented'; */",
      "const s = \"import y from 'in-string'\";",
      'const t = `import z from "in-template"`;',
    );
    expect(findImports(lexSource(source)).map((ref) => ref.specifier)).toEqual([
      'pkg-a',
      'pkg-b',
      'pkg-c',
      'pkg-d',
      'pkg-e',
      'pkg-f',
      'pkg-g',
      'pkg-h',
    ]);
  });

  it('findForbiddenGlobals matches global identifiers only', () => {
    const source = lines(
      'window.alert(1);',
      'const t = typeof navigator;',
      'globalThis.document.title;',
      'self.localStorage.clear();',
      'const ctx = new AudioContext();',
      'requestAnimationFrame(step);',
      'const ok = [windowSize, myDocument, documentation, options.window, $navigator, AudioContextLike];',
      "const s = 'window'; // document",
    );
    expect(findForbiddenGlobals(lexSource(source)).map((ref) => ref.name)).toEqual([
      'window',
      'navigator',
      'document',
      'localStorage',
      'AudioContext',
      'requestAnimationFrame',
    ]);
  });

  it('findMathRandom matches Math.random uses only', () => {
    const source = lines(
      'const a = Math.random();',
      'const b = Math?.random;',
      'const c = globalThis.Math.random();',
      "const d = Math['random']();",
      'const { floor, random } = Math;',
      'const ok = [rng.random(), Math.randomInt, MathRandom, Math.round(1), { random: 1 }];',
      "const s = 'Math.random()'; // Math.random()",
    );
    const lexed = lexSource(source);
    expect(findMathRandom(lexed).map((offset) => source.slice(0, offset).split('\n').length)).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });

  it('resolveImport resolves relative and root-absolute specifiers only', () => {
    expect(resolveImport('src/logic/combat/damage.ts', '../../core/rng')).toBe('src/core/rng');
    expect(resolveImport('src/logic/a.ts', './b.ts')).toBe('src/logic/b.ts');
    expect(resolveImport('src/logic/a.ts', '.')).toBe('src/logic');
    expect(resolveImport('src/logic/a.ts', '/src/ui/hud')).toBe('src/ui/hud');
    expect(resolveImport('src/data/a.ts', './shader.glsl?raw')).toBe('src/data/shader.glsl');
    expect(resolveImport('src/logic/a.ts', '../../../outside')).toBe('../outside');
    expect(resolveImport('src/logic/a.ts', 'three')).toBeNull();
    expect(resolveImport('src/logic/a.ts', '@pixiv/three-vrm')).toBeNull();
  });

  it('pure-layer allowlist accepts logic, data and core/{rng,math,types} only', () => {
    for (const target of [
      'src/logic/damage',
      'src/data/ids.ts',
      'src/data/table.json',
      'src/core/rng',
      'src/core/rng.ts',
      'src/core/math/index',
      'src/core/math/index.ts',
      'src/core/types.js',
      'tests/unit/helpers/importScan',
    ]) {
      expect(isPureLayerImportAllowed(target), target).toBe(true);
    }
    for (const target of ['src/core/loop', 'src/core', 'src/core/rng/extra', 'src/main.ts', 'src/ui/hud', 'src/combat']) {
      expect(isPureLayerImportAllowed(target), target).toBe(false);
    }
    expect(presentationModuleOf('src/ui/styles/base.css')).toBe('src/ui');
    expect(presentationModuleOf('src/render.ts')).toBe('src/render');
    expect(presentationModuleOf('src/renderer/x')).toBeNull();
  });

  it('checkPureLayer reports every violation in a violating sample', () => {
    const sample = lines(
      "import * as THREE from 'three';",
      "import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';",
      "import { VRMLoaderPlugin } from '@pixiv/three-vrm';",
      "import { startLoop } from '../core/loop';",
      "import { drawHud } from '../ui/hud';",
      "export { shake } from '../camera/shake.ts';",
      'const width = window.innerWidth;',
      'document.title = `${navigator.language}`;',
      "const saved = globalThis.localStorage.getItem('save');",
      'const audio = new AudioContext();',
      'requestAnimationFrame(() => undefined);',
      'const roll = Math.random();',
      'const { random } = Math;',
      "const lazy = import('three');",
    );
    expect(summarize(checkPureLayer('src/logic/sample.ts', sample))).toEqual([
      [1, 'forbidden-package'],
      [2, 'forbidden-package'],
      [3, 'forbidden-package'],
      [4, 'forbidden-src-import'],
      [5, 'forbidden-src-import'],
      [6, 'forbidden-src-import'],
      [7, 'forbidden-global'],
      [8, 'forbidden-global'],
      [8, 'forbidden-global'],
      [9, 'forbidden-global'],
      [10, 'forbidden-global'],
      [11, 'forbidden-global'],
      [12, 'math-random'],
      [13, 'math-random'],
      [14, 'forbidden-package'],
    ]);
  });

  it('checkPureLayer accepts a clean sample', () => {
    const sample = lines(
      "import { createRng } from '../core/rng';",
      "import type { Vec3 } from '../core/math.ts';",
      "import type { Seed } from '../core/types/index';",
      "import { CHARACTER_IDS } from '../data/ids';",
      "import { clamp } from './util/clamp';",
      "export { REGION_IDS } from '../data/ids.ts';",
      "// window.alert(document.title); Math.random(); import * as THREE from 'three';",
      '/* new AudioContext(); requestAnimationFrame(tick); localStorage.clear(); */',
      "const label = 'window document navigator Math.random()';",
      "const note = \"import { Mesh } from 'three'\";",
      'const text = `requestAnimationFrame ${CHARACTER_IDS.length} localStorage`;',
      'const pattern = /window|document/g;',
      'const windowSize = 3; const documentation = windowSize;',
      'const hint = settings.document ?? options.navigator;',
      'const roll = createRng(1).random();',
      'export const ratio = windowSize / 2 / documentation;',
    );
    expect(checkPureLayer('src/logic/sample.ts', sample).map(formatViolation)).toEqual([]);
  });

  it('checkSimulationLayer reports presentation imports and nothing else', () => {
    const violating = lines(
      "import { spawnHitSpark } from '../vfx/hitSpark';",
      "import type { Renderer } from '../render/renderer.ts';",
      "import { playSfx } from '../audio';",
      "import { CameraRig } from '/src/camera/rig';",
      "export * from '../ui/index.ts';",
      "const model = await import('../visual/provider');",
      "import { clip } from '../anim/clips/idle';",
    );
    expect(summarize(checkSimulationLayer('src/combat/hits.ts', violating))).toEqual(
      [1, 2, 3, 4, 5, 6, 7].map((line) => [line, 'presentation-import']),
    );

    const clean = lines(
      "import * as THREE from 'three';",
      "import { emit } from '../core/eventBus';",
      "import { applyReaction } from '../element/reactions';",
      "import { damage } from '../logic/damage';",
      "import { renderStats } from './renderStats';",
      "// import { drawHud } from '../ui/hud';",
      "const path = '../render/renderer';",
    );
    expect(checkSimulationLayer('src/combat/hits.ts', clean).map(formatViolation)).toEqual([]);
  });
});
