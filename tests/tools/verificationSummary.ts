/*
 * Verification summary (task 25.4; Req 42.9, 42.10, 43.10): one pure function turns every verification result the
 * run produced into test-results/verification-summary.md, the basis of the final report. Every checklist item is
 * exactly one of `통과`, `실패` or `미실행(원인)`; an item whose result is missing is `미실행` with the reason (browser
 * or WebGL unavailable, no FBX sample, …), never passed. The Playwright summary reporter
 * (tests/e2e/reporters/summaryReporter.ts) gathers the inputs and writes the file.
 */
import { DEFAULT_BINDINGS } from '../../src/input/bindings';
import { keyLabel } from '../../src/input/keyLabels';
import { ACTION_LABELS } from '../../src/settings/remapFlow';

// ── Inputs ──────────────────────────────────────────────────────────────────

/** The part of Vitest's `--reporter=json` output the summary reads. */
export interface VitestJson {
  readonly numTotalTests?: number;
  readonly numPassedTests?: number;
  readonly numFailedTests?: number;
  readonly testResults: readonly {
    readonly name: string;
    readonly status?: string;
    readonly assertionResults: readonly {
      readonly fullName?: string;
      readonly title: string;
      readonly ancestorTitles?: readonly string[];
      readonly status: string;
    }[];
  }[];
}

export type E2eStatus = 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted';

export interface E2eResult {
  readonly project: string;
  readonly title: string;
  readonly file: string;
  readonly status: E2eStatus;
  readonly durationMs: number;
  /** First error line, or the skip reason. */
  readonly message?: string;
}

export interface PerfPoint {
  readonly label: string;
  readonly avgFps: number;
  readonly drawCalls: number;
  readonly triangles: number;
  /** GPU in use (the renderer string), e.g. SwiftShader: fps is then not a Dev_Machine figure. */
  readonly gpu?: string;
}

export type ModelFormat = 'glb' | 'vrm' | 'fbx' | 'corrupt';

export interface ModelSwapResult {
  readonly format: ModelFormat;
  readonly status: 'passed' | 'failed' | 'notRun';
  readonly reason?: string;
}

/** Build step result (`npm run build`). */
export interface BuildResult {
  readonly ok: boolean;
  readonly message?: string;
}

export interface VerificationInputs {
  /** ISO time the summary was made. */
  readonly generatedAt: string;
  readonly build: BuildResult | null;
  /** Vitest JSON, or null with the reason it is missing. */
  readonly vitest: VitestJson | null;
  readonly vitestMissing?: string;
  /** Playwright results; null when Playwright did not run. */
  readonly e2e: readonly E2eResult[] | null;
  readonly e2eMissing?: string;
  /** Screenshot file names found under test-results/screenshots/. */
  readonly screenshots: readonly string[] | null;
  readonly perf: readonly PerfPoint[] | null;
  readonly modelSwap: readonly ModelSwapResult[] | null;
}

// ── Checklist ───────────────────────────────────────────────────────────────

export type ItemStatus = { readonly kind: 'pass' } | { readonly kind: 'fail'; readonly detail?: string } | { readonly kind: 'notRun'; readonly reason: string };

export interface ChecklistItem {
  readonly section: string;
  readonly label: string;
  readonly status: ItemStatus;
}

export const PASS = '통과';
export const FAIL = '실패';
export const notRunText = (reason: string): string => `미실행(${reason})`;

export function statusText(s: ItemStatus): string {
  if (s.kind === 'pass') return PASS;
  if (s.kind === 'fail') return FAIL;
  return notRunText(s.reason);
}

/** Screenshots the playthrough takes: 12 scenes, the three Challenge_Areas counted separately (14 files). */
export const EXPECTED_SCREENSHOTS = 14;
/** Performance budget (Req 38.3, 38.4). */
export const PERF_BUDGET = { drawCalls: 500, triangles: 1_500_000, fps: 60 } as const;
export const PROPERTY_COUNT = 32;
const MODEL_FORMATS: readonly ModelFormat[] = ['glb', 'vrm', 'fbx', 'corrupt'];
const MODEL_LABELS: Readonly<Record<ModelFormat, string>> = {
  glb: '절차적 Kairen GLB 내보내기 → 교체 경로로 불러오기',
  vrm: 'VRM(VRMC_vrm) 불러오기',
  fbx: 'CC0 FBX 샘플 불러오기',
  corrupt: '손상 파일 → 절차적 대체',
};
const E2E_PROJECTS: readonly { readonly project: string; readonly label: string }[] = [
  { project: 'system', label: 'Playwright 시스템 시나리오' },
  { project: 'playthrough', label: '입력 전용 완주 봇 (Title → Victory)' },
];

type Assertion = VitestJson['testResults'][number]['assertionResults'][number];

const isPassed = (s: string): boolean => s === 'passed';
const isFailed = (s: string): boolean => s === 'failed';

function groupStatus(assertions: readonly Assertion[], missing: string): ItemStatus {
  if (assertions.length === 0) return { kind: 'notRun', reason: missing };
  const failed = assertions.filter((a) => isFailed(a.status));
  if (failed.length > 0) return { kind: 'fail', detail: `${failed.length}개 실패: ${failed[0]?.title ?? ''}` };
  if (assertions.every((a) => !isPassed(a.status))) return { kind: 'notRun', reason: '모두 건너뜀' };
  return { kind: 'pass' };
}

/** Property N of a Vitest assertion, from its describe titles or full name. */
function propertyOf(a: Assertion): number | null {
  const text = [...(a.ancestorTitles ?? []), a.fullName ?? '', a.title].join(' ');
  const m = /Property (\d+)\b/.exec(text);
  return m === null ? null : Number(m[1]);
}

/** Every checklist item, in report order. */
export function buildChecklist(input: VerificationInputs): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  const add = (section: string, label: string, status: ItemStatus): void => {
    items.push({ section, label, status });
  };

  // Build
  add('빌드', 'npm run build (tsc --noEmit && vite build)', input.build === null
    ? { kind: 'notRun', reason: '빌드 결과 없음' }
    : input.build.ok ? { kind: 'pass' } : { kind: 'fail', detail: input.build.message });

  // Vitest
  const vitestMissing = input.vitestMissing ?? 'Vitest 결과 없음';
  const files = input.vitest?.testResults ?? [];
  const inDir = (dir: string): Assertion[] => files.filter((f) => f.name.replace(/\\/g, '/').includes(`/tests/${dir}/`)).flatMap((f) => f.assertionResults);
  add('Vitest', '단위·예시·데이터 테스트 (tests/unit)', input.vitest === null ? { kind: 'notRun', reason: vitestMissing } : groupStatus(inDir('unit'), 'tests/unit 결과 없음'));
  const properties = inDir('property');
  add('Vitest', '속성 테스트 (tests/property)', input.vitest === null ? { kind: 'notRun', reason: vitestMissing } : groupStatus(properties, 'tests/property 결과 없음'));
  for (let n = 1; n <= PROPERTY_COUNT; n++) {
    const of = properties.filter((a) => propertyOf(a) === n);
    add('Correctness Properties', `Property ${n}`, input.vitest === null ? { kind: 'notRun', reason: vitestMissing } : groupStatus(of, '해당 속성 테스트 결과 없음'));
  }

  // Playwright
  const e2eMissing = input.e2eMissing ?? 'Playwright 미실행';
  for (const { project, label } of E2E_PROJECTS) {
    if (input.e2e === null) {
      add('브라우저 검증', label, { kind: 'notRun', reason: e2eMissing });
      continue;
    }
    const results = input.e2e.filter((r) => r.project === project);
    if (results.length === 0) add('브라우저 검증', label, { kind: 'notRun', reason: `${project} 프로젝트 결과 없음` });
    else {
      const failed = results.filter((r) => r.status === 'failed' || r.status === 'timedOut' || r.status === 'interrupted');
      if (failed.length > 0) add('브라우저 검증', label, { kind: 'fail', detail: `${failed.length}개 실패: ${failed[0]?.title ?? ''}` });
      else if (results.every((r) => r.status === 'skipped')) add('브라우저 검증', label, { kind: 'notRun', reason: results[0]?.message ?? '모두 건너뜀' });
      else add('브라우저 검증', label, { kind: 'pass' });
    }
  }

  // Screenshots
  add('스크린샷', `완주 스크린샷 ${EXPECTED_SCREENSHOTS}장 (test-results/screenshots/)`, input.screenshots === null || input.screenshots.length === 0
    ? { kind: 'notRun', reason: input.e2e === null ? e2eMissing : '스크린샷 없음' }
    : input.screenshots.length >= EXPECTED_SCREENSHOTS ? { kind: 'pass' } : { kind: 'fail', detail: `${input.screenshots.length}/${EXPECTED_SCREENSHOTS}장` });

  // Performance
  if (input.perf === null || input.perf.length === 0) {
    add('성능', `draw call ≤ ${PERF_BUDGET.drawCalls} · 삼각형 ≤ 1.5M · 평균 ${PERF_BUDGET.fps} fps`, { kind: 'notRun', reason: input.e2e === null ? e2eMissing : '측정값 없음' });
  } else {
    for (const p of input.perf) {
      const over: string[] = [];
      if (p.drawCalls > PERF_BUDGET.drawCalls) over.push(`draw call ${p.drawCalls}`);
      if (p.triangles > PERF_BUDGET.triangles) over.push(`삼각형 ${p.triangles}`);
      if (p.avgFps < PERF_BUDGET.fps) over.push(`fps ${p.avgFps.toFixed(1)}`);
      add('성능', `${p.label}: ${p.drawCalls} calls · ${p.triangles} tris · ${p.avgFps.toFixed(1)} fps`, over.length === 0 ? { kind: 'pass' } : { kind: 'fail', detail: over.join(', ') });
    }
  }

  // Model swap
  for (const format of MODEL_FORMATS) {
    const r = input.modelSwap?.find((m) => m.format === format);
    const status: ItemStatus = r === undefined
      ? { kind: 'notRun', reason: input.modelSwap === null ? (input.e2e === null ? e2eMissing : '모델 교체 결과 없음') : '결과 없음' }
      : r.status === 'passed' ? { kind: 'pass' } : r.status === 'failed' ? { kind: 'fail', detail: r.reason } : { kind: 'notRun', reason: r.reason ?? '미실행' };
    add('시각 모델 교체', MODEL_LABELS[format], status);
  }
  return items;
}

// ── Markdown ────────────────────────────────────────────────────────────────

const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

function controlsTable(): string[] {
  const rows = (Object.keys(ACTION_LABELS) as (keyof typeof ACTION_LABELS)[]).map((a) => `| ${cell(ACTION_LABELS[a])} | ${cell(keyLabel(DEFAULT_BINDINGS[a]))} |`);
  return [
    '| 동작 | 기본 키 |', '|---|---|', ...rows,
    '| 카메라 회전 | 마우스 (포인터 잠금) · 방향키 |', '| 줌 | 마우스 휠 |', '| 일시정지 | Esc |', '| 성능 표시 | F3 |',
  ];
}

const STATIC_RUN = [
  '## 실행 방법', '',
  '```', 'npm install', 'npm run dev          # 개발 서버 (http://localhost:5173)', 'npm run build        # tsc --noEmit && vite build → dist/',
  'npm run preview      # dist/ 정적 서버 (http://localhost:4173)', 'npm test             # Vitest (단위·데이터·속성)',
  'npm run test:e2e     # Playwright (system · playthrough)', 'npm run verify       # 전체 검증 후 test-results/verification-summary.md 생성', '```',
];

const STATIC_MODEL_SWAP = [
  '## 시각 모델 교체 절차', '',
  '1. 모델 파일(glTF/GLB·FBX·VRM)을 `public/assets/models/` 아래에 둔다.',
  '2. `src/data/visualManifest.ts`에서 해당 엔티티 항목의 `source`를 `{ kind: \'gltf\' | \'fbx\' | \'vrm\', url }`로 바꾸고, 필요하면 `boneMap`·`restPose`·`clips`를 지정한다.',
  '3. `npm run dev` 후 `model-lab.html?entity=<id>`에서 bone 대응표·포즈·socket을 확인한다.',
  '4. `CREDITS.md`와 `src/data/credits.ts`의 Assets 표에 이름·제작자·URL·라이선스(CC0-1.0)·경로를 기록한다 (`npm test`의 credits 테스트가 확인).',
];

/** The summary document. */
export function buildVerificationSummary(input: VerificationInputs): string {
  const items = buildChecklist(input);
  const count = (kind: ItemStatus['kind']): number => items.filter((i) => i.status.kind === kind).length;
  const lines: string[] = [
    '# 검증 요약', '',
    `생성: ${input.generatedAt}`, '',
    `통과 ${count('pass')} · 실패 ${count('fail')} · 미실행 ${count('notRun')} (전체 ${items.length})`, '',
  ];
  if (input.vitest !== null) {
    const v = input.vitest;
    lines.push(`Vitest: ${v.numPassedTests ?? '?'} / ${v.numTotalTests ?? '?'} 통과, 실패 ${v.numFailedTests ?? '?'}`, '');
  }
  let section = '';
  for (const item of items) {
    if (item.section !== section) {
      section = item.section;
      lines.push(`## ${section}`, '', '| 항목 | 결과 | 비고 |', '|---|---|---|');
    }
    const detail = item.status.kind === 'fail' ? (item.status.detail ?? '') : '';
    lines.push(`| ${cell(item.label)} | ${cell(statusText(item.status))} | ${cell(detail)} |`);
    const next = items[items.indexOf(item) + 1];
    if (next === undefined || next.section !== section) lines.push('');
  }
  if (input.perf !== null && input.perf.some((p) => p.gpu !== undefined)) {
    lines.push('측정 GPU: ' + [...new Set(input.perf.map((p) => p.gpu).filter((g): g is string => g !== undefined))].join(', '), '');
  }
  lines.push(...STATIC_RUN, '', '## 기본 조작', '', ...controlsTable(), '', ...STATIC_MODEL_SWAP, '');
  return lines.join('\n');
}
