import { describe, expect, it } from 'vitest';
import {
  buildChecklist, buildVerificationSummary, EXPECTED_SCREENSHOTS, FAIL, PASS, PROPERTY_COUNT, statusText,
  type VerificationInputs, type VitestJson,
} from '../tools/verificationSummary';

// Task 25.4 (Req 42.9, 42.10, 43.10): every item is exactly 통과 / 실패 / 미실행(원인); missing results are only ever
// 미실행; the static sections are always there.

const empty: VerificationInputs = {
  generatedAt: '2026-09-29T00:00:00.000Z', build: null, vitest: null, e2e: null, screenshots: null, perf: null, modelSwap: null,
  vitestMissing: 'Vitest 미실행', e2eMissing: '브라우저 사용 불가',
};

function vitest(propertyStatus: (n: number) => string, unitStatus = 'passed'): VitestJson {
  return {
    numTotalTests: PROPERTY_COUNT + 1, numPassedTests: PROPERTY_COUNT, numFailedTests: 0,
    testResults: [
      { name: 'C:/p/tests/unit/a.test.ts', assertionResults: [{ title: 'unit', status: unitStatus }] },
      ...Array.from({ length: PROPERTY_COUNT }, (_, i) => ({
        name: `C:/p/tests/property/p${i + 1}.property.test.ts`,
        assertionResults: [{ title: 'holds', ancestorTitles: [`Property ${i + 1}: something`], status: propertyStatus(i + 1) }],
      })),
    ],
  };
}

const STATUS = /^(통과|실패|미실행\(.+\))$/;

describe('verification summary', () => {
  it('with no results at all, every item is 미실행 with a reason and nothing passes or fails', () => {
    const items = buildChecklist(empty);
    expect(items.length).toBeGreaterThan(PROPERTY_COUNT + 8);
    for (const i of items) {
      expect(i.status.kind, i.label).toBe('notRun');
      expect(statusText(i.status)).toMatch(/^미실행\(.+\)$/);
    }
  });

  it('every status reads 통과, 실패 or 미실행(원인)', () => {
    const input: VerificationInputs = {
      ...empty,
      build: { ok: true },
      vitest: vitest((n) => (n === 7 ? 'failed' : n === 31 ? 'skipped' : 'passed')),
      e2e: [
        { project: 'system', title: 'movement', file: 'a', status: 'passed', durationMs: 1 },
        { project: 'playthrough', title: 'full run', file: 'b', status: 'failed', durationMs: 1, message: 'timeout' },
      ],
      screenshots: ['a.png', 'b.png'],
      perf: [{ label: 'Thistlewick', avgFps: 72, drawCalls: 320, triangles: 900_000 }, { label: 'Sanctum', avgFps: 48, drawCalls: 510, triangles: 1_000_000 }],
      modelSwap: [{ format: 'glb', status: 'passed' }, { format: 'fbx', status: 'notRun', reason: 'CC0 FBX 샘플 없음' }],
    };
    const items = buildChecklist(input);
    for (const i of items) expect(statusText(i.status), i.label).toMatch(STATUS);
    const by = (label: string): string => statusText(items.find((i) => i.label.startsWith(label))?.status ?? { kind: 'notRun', reason: '?' });
    expect(by('npm run build')).toBe(PASS);
    expect(by('Property 7')).toBe(FAIL);
    expect(by('Property 31')).toBe('미실행(모두 건너뜀)');
    expect(by('Property 1')).toBe(PASS);
    expect(by('속성 테스트')).toBe(FAIL);
    expect(by('Playwright 시스템')).toBe(PASS);
    expect(by('입력 전용 완주 봇')).toBe(FAIL);
    expect(by('완주 스크린샷')).toBe(FAIL);
    expect(by('Thistlewick')).toBe(PASS);
    expect(by('Sanctum')).toBe(FAIL);
    expect(by('CC0 FBX')).toBe('미실행(CC0 FBX 샘플 없음)');
    expect(by('VRM')).toMatch(/^미실행/);
  });

  it('a property without a result is 미실행, never 통과', () => {
    const v = vitest(() => 'passed');
    const partial: VitestJson = { ...v, testResults: v.testResults.filter((f) => !f.name.includes('p12.')) };
    const items = buildChecklist({ ...empty, vitest: partial });
    expect(statusText(items.find((i) => i.label === 'Property 12')!.status)).toBe('미실행(해당 속성 테스트 결과 없음)');
  });

  it('enough screenshots and an in-budget perf point pass', () => {
    const items = buildChecklist({
      ...empty, e2e: [], screenshots: Array.from({ length: EXPECTED_SCREENSHOTS }, (_, i) => `${i}.png`),
      perf: [{ label: 'Village', avgFps: 60, drawCalls: 500, triangles: 1_500_000 }],
    });
    expect(statusText(items.find((i) => i.label.startsWith('완주 스크린샷'))!.status)).toBe(PASS);
    expect(statusText(items.find((i) => i.label.startsWith('Village'))!.status)).toBe(PASS);
  });

  it('the document has the counts, every section and the static run / controls / model-swap sections', () => {
    const md = buildVerificationSummary(empty);
    for (const heading of ['# 검증 요약', '## 빌드', '## Vitest', '## Correctness Properties', '## 브라우저 검증', '## 스크린샷', '## 성능', '## 시각 모델 교체', '## 실행 방법', '## 기본 조작', '## 시각 모델 교체 절차']) {
      expect(md, heading).toContain(heading);
    }
    expect(md).toContain('npm run dev');
    expect(md).toContain('model-lab.html?entity=<id>');
    expect(md).toContain('| 점프 | Space |');
    expect(md).toMatch(/통과 0 · 실패 0 · 미실행 \d+/);
  });
});
