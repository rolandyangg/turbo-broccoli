// Runs LLM root-cause grouping on an existing run and reports timing/errors.
import { readFindings, allFindings, readRun } from '../src/store/store.ts';
import { runClaude } from '../src/llm/claude.ts';
import { proposeRootCauses } from '../src/triage/review.ts';
const runDir = process.argv[2];
const info = readRun(runDir);
const fs = allFindings(readFindings(runDir)!);
const t = Date.now();
const g = await proposeRootCauses(fs, { repo: info.repo_path, intelSummary: '', model: null });
console.log('secs', Math.round((Date.now() - t) / 1000), 'groups', g?.length ?? null);
if (g) for (const x of g) console.log(x.finding_ids.join(','), '|', x.summary.slice(0, 90));
void runClaude;
