// Regenerate repro specs for an existing run (after generator changes).
import { readFindings, allFindings, readRun } from '../src/store/store.ts';
import { writeReproSpec } from '../src/triage/reproSpec.ts';
const runDir = process.argv[2];
const ff = readFindings(runDir)!;
for (const f of allFindings(ff)) writeReproSpec(runDir, f, readRun(runDir).base_url);
console.log('ok');
