/*
 * Playwright summary reporter (task 25.4; Req 42.9, 42.10): collects every e2e result, then at the end of the run
 * reads the other verification outputs under test-results/ and writes test-results/verification-summary.md through
 * the pure buildVerificationSummary (tests/tools/verificationSummary.ts), plus test-results/e2e-results.json.
 *
 * Inputs it reads (each optional; a missing one becomes `미실행(원인)` in the summary):
 * - test-results/build.json          { ok, message? }             written by scripts/verify.mjs
 * - test-results/vitest.json         Vitest --reporter=json output
 * - test-results/screenshots/*.png   the playthrough screenshots
 * - test-results/perf.json           PerfPoint[]                   written by the system performance scenario
 * - test-results/model-swap.json     ModelSwapResult[]             written by the model-swap scenario
 */
import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import {
  buildVerificationSummary, type BuildResult, type E2eResult, type E2eStatus, type ModelSwapResult, type PerfPoint, type VitestJson,
} from '../../tools/verificationSummary';

// @types/node is not installed (see tests/unit/helpers/importScan.ts): the few Node APIs are typed locally.
interface NodeFs {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: 'utf8'): string;
  writeFileSync(path: string, data: string): void;
  mkdirSync(path: string, options: { recursive: true }): void;
  readdirSync(path: string): string[];
}
interface NodePath {
  join(...parts: string[]): string;
  resolve(...parts: string[]): string;
}
function builtin<T>(id: string): T {
  const p = (globalThis as unknown as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
  if (typeof p?.getBuiltinModule !== 'function') throw new Error(`Cannot load ${id} (Node >= 20.16 needed)`);
  return p.getBuiltinModule(id) as T;
}

export default class SummaryReporter implements Reporter {
  private readonly results: E2eResult[] = [];
  private readonly outDir: string;

  constructor(options: { outputDir?: string } = {}) {
    const path = builtin<NodePath>('node:path');
    this.outDir = path.resolve(options.outputDir ?? 'test-results');
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const project = test.parent.project()?.name ?? '';
    const error = result.errors[0]?.message ?? result.error?.message;
    const skip = test.annotations.find((a) => a.type === 'skip')?.description;
    this.results.push({
      project,
      title: test.titlePath().slice(2).join(' › ') || test.title,
      file: test.location.file,
      status: result.status as E2eStatus,
      durationMs: result.duration,
      ...(error !== undefined ? { message: error.split('\n')[0] } : skip !== undefined ? { message: skip } : {}),
    });
  }

  onEnd(result: FullResult): void {
    const fs = builtin<NodeFs>('node:fs');
    const path = builtin<NodePath>('node:path');
    const file = (name: string): string => path.join(this.outDir, name);
    const readJson = <T>(name: string): T | null => {
      try {
        return fs.existsSync(file(name)) ? (JSON.parse(fs.readFileSync(file(name), 'utf8')) as T) : null;
      } catch {
        return null;
      }
    };
    const shotsDir = file('screenshots');
    const screenshots = fs.existsSync(shotsDir) ? fs.readdirSync(shotsDir).filter((n) => n.endsWith('.png')).sort() : null;
    const md = buildVerificationSummary({
      generatedAt: new Date().toISOString(),
      build: readJson<BuildResult>('build.json'),
      vitest: readJson<VitestJson>('vitest.json'),
      vitestMissing: 'test-results/vitest.json 없음 (npm run verify로 생성)',
      e2e: this.results.length === 0 && result.status !== 'passed' ? null : this.results,
      e2eMissing: `Playwright 실행 상태 ${result.status}`,
      screenshots,
      perf: readJson<PerfPoint[]>('perf.json'),
      modelSwap: readJson<ModelSwapResult[]>('model-swap.json'),
    });
    fs.mkdirSync(this.outDir, { recursive: true });
    fs.writeFileSync(file('verification-summary.md'), md);
    fs.writeFileSync(file('e2e-results.json'), JSON.stringify({ status: result.status, results: this.results }, null, 2));
  }

  printsToStdio(): boolean {
    return false;
  }
}
