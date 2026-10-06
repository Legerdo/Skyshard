// Full verification (task 25.4): build → Vitest (JSON to test-results/vitest.json) → Playwright (whose summary
// reporter writes test-results/verification-summary.md). Every step runs even when an earlier one fails, so the
// summary shows each result; the exit code is non-zero when any step failed.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const out = 'test-results';
mkdirSync(out, { recursive: true });
const run = (cmd) => spawnSync(cmd, { stdio: 'inherit', shell: true }).status === 0;

const build = run('npm run build');
writeFileSync(`${out}/build.json`, JSON.stringify({ ok: build, ...(build ? {} : { message: 'npm run build 실패' }) }));
const unit = run(`npx vitest run --reporter=default --reporter=json --outputFile.json=${out}/vitest.json`);
const e2e = run('npx playwright test');
console.log(`\nverification: build ${build ? 'ok' : 'FAILED'} · vitest ${unit ? 'ok' : 'FAILED'} · playwright ${e2e ? 'ok' : 'FAILED'}`);
console.log(`summary: ${out}/verification-summary.md`);
process.exit(build && unit && e2e ? 0 : 1);
