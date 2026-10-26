#!/usr/bin/env node
/**
 * qualify-verdicts.ts — #2609 review (MINOR): the qualification command.
 *
 * Reads the structured verdict artifacts written by the live golden suite and
 * turns them into a process exit code:
 *   - no artifact      -> exit 1 (the gates measured nothing on this run)
 *   - any FAIL         -> exit 1
 *   - any INCONCLUSIVE -> exit 1, unless --allow-inconclusive is passed
 *                         (explicit opt-in for a documented outage)
 *
 * Usage:
 *   npm run eval:qualify
 *   npm run eval:qualify -- --allow-inconclusive
 *
 * The live eval suite itself never runs in CI (tests/eval-harness/** is
 * excluded from vitest.config.ci.ts): THIS command is the consumer that turns
 * the textual verdicts into a distinct process state.
 */

import { qualifyVerdicts, readVerdictArtifacts, verdictDir } from './verdict-artifact.js';

const allowInconclusive = process.argv.includes('--allow-inconclusive');
const dir = verdictDir();
const artifacts = readVerdictArtifacts(dir);
const report = qualifyVerdicts(artifacts, { allowInconclusive });

console.log(`eval qualification: dir=${dir}`);
console.log(`measured=${report.measured} pass=${report.pass} fail=${report.fail} inconclusive=${report.inconclusive}`);
for (const problem of report.problems) {
  console.log(`[${report.ok ? 'WARN' : 'FAIL'}] ${problem}`);
}
console.log(report.ok ? 'RESULT: qualified' : 'RESULT: NOT qualified');
process.exit(report.ok ? 0 : 1);
