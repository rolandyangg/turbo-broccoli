import { Command } from 'commander';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { type Config } from './config.js';
import { resolveTarget } from './target/resolve.js';
import { readRun, resolveRunDir, readFindings, writeFindings, findById, allFindings, listRuns } from './store/store.js';
import { exploreRun } from './explore/run.js';
import { Memory } from './memory/siteMemory.js';
import { fitCalibration, saveCalibration } from './memory/calibration.js';
import { BrowserName, FindingStatus, type RootCauseGroup } from './store/schema.js';
import { writeReport } from './store/report.js';

const log = (m: string) => console.error(`[bugbash] ${m}`);
const int = (v: string) => parseInt(v, 10);
const LAST = join(homedir(), '.bugbash', 'last-run');

function rememberRun(runDir: string) {
  mkdirSync(join(homedir(), '.bugbash'), { recursive: true });
  writeFileSync(LAST, runDir);
}

/** --run (id or path) + --out, falling back to ./.bugbash, then the last run used on this machine. */
function findRunDir(o: { run?: string; out?: string }): string {
  if (o.run && existsSync(join(resolve(o.run), 'run.json'))) return resolve(o.run);
  if (o.out) return resolveRunDir(resolve(o.out), o.run);
  if (existsSync('.bugbash') && listRuns(resolve('.bugbash')).length) return resolveRunDir(resolve('.bugbash'), o.run);
  if (existsSync(LAST)) {
    const last = readFileSync(LAST, 'utf8').trim();
    if (!o.run) return last;
    return resolveRunDir(resolve(last, '..', '..'), o.run);
  }
  throw new Error('No run found. Pass --run <id|path> and/or --out <workspace>.');
}

function overrides(o: Record<string, any>): Partial<Config> {
  return {
    budgetSessions: o.budgetSessions,
    parallel: o.parallel,
    maxToolCallsPerSession: o.maxCalls,
    timeLimitMs: o.timeLimit ? o.timeLimit * 60_000 : undefined,
    browsers: o.browsers ? o.browsers.split(',').map((b: string) => BrowserName.parse(b.trim())) : undefined,
    startPaths: o.start ? o.start.split(',') : undefined,
    model: o.model,
    devCommand: o.devCommand,
    devPort: o.devPort,
  };
}

const program = new Command();
program.name('bugbash').description('Agentic UI bug-bash: explore → triage → (only when asked) fix').version('0.1.0');

const exploreOpts = (c: Command) =>
  c
    .option('--repo <path>', 'Local source repo when the target is a URL (enables code intel + source hints + fixing)')
    .option('--out <dir>', 'Workspace directory (default: <repo>/.bugbash or ./.bugbash)')
    .option('--budget-sessions <n>', 'Max explorer sessions', int)
    .option('--parallel <n>', 'Explorer sessions in parallel', int)
    .option('--max-calls <n>', 'Tool-call budget per explorer session', int)
    .option('--time-limit <minutes>', 'Wall-clock limit', int)
    .option('--browsers <list>', 'Comma list: chromium,webkit,firefox')
    .option('--start <paths>', 'Comma list of start paths')
    .option('--model <model>', 'Claude model alias for all agents')
    .option('--dev-command <cmd>', 'Command that starts the app')
    .option('--dev-port <port>', 'Port the dev server listens on', int)
    .option('--no-lead', 'Skip the lead agent; run a fixed default plan')
    .option('--no-code-intel', 'Black-box mode: do not read source code');

exploreOpts(program.command('explore').description('Agentically bug-bash a site (lead agent + explorer agents across sizes, browsers, personas)').argument('<target>', 'URL, local static folder, or local repo with a dev/start script'))
  .option('--then-triage', 'Run triage right after exploring')
  .action(async (targetArg: string, o) => {
    const target = await resolveTarget(targetArg, { repo: o.repo, devCommand: o.devCommand, devPort: o.devPort, log });
    try {
      const { runDir, runId } = await exploreRun({ targetArg, target, out: o.out, overrides: overrides(o), noLead: o.lead === false, codeIntel: o.codeIntel, log });
      rememberRun(runDir);
      if (o.thenTriage) {
        const { triageRun } = await import('./triage/triage.js');
        await triageRun({ runDir, baseUrl: target.baseUrl, log });
      } else log(`Next: bugbash triage --run ${runDir}`);
      void runId;
    } finally {
      await target.stop();
    }
  });

program
  .command('triage')
  .description('Cluster, reproduce, minimize, annotate (screenshot/video), review, group and score findings')
  .option('--run <id|path>', 'Run id or path (default: latest)')
  .option('--out <dir>', 'Workspace directory')
  .option('--target <target>', "Serve this target instead of the run's original one")
  .option('--no-video', 'Skip video recording')
  .option('--no-review', 'Skip the independent LLM review and LLM root-cause grouping')
  .option('--repro-runs <n>', 'Replays per finding for the reproduction rate', int, 3)
  .option('--concurrency <n>', 'Findings triaged in parallel', int, 3)
  .action(async (o) => {
    const runDir = findRunDir(o);
    rememberRun(runDir);
    const info = readRun(runDir);
    const target = await resolveTarget(o.target ?? (info.target_kind === 'url' ? info.base_url : info.repo_path ?? info.target), { repo: info.repo_path, log });
    try {
      const { triageRun } = await import('./triage/triage.js');
      await triageRun({ runDir, baseUrl: target.baseUrl, log, video: o.video !== false, review: o.review !== false, reproRuns: o.reproRuns, concurrency: o.concurrency });
    } finally {
      await target.stop();
    }
  });

program
  .command('fix')
  .description('Fix findings on a new branch (only when you ask). Pass finding ids (BB-…) to fix individually/together, or a group id (RC-…) to fix a whole root cause.')
  .argument('<ids...>', 'BB-xxxx ids and/or one RC-xxx id')
  .option('--run <id|path>', 'Run id or path (default: latest)')
  .option('--out <dir>', 'Workspace directory')
  .option('--pr', 'Push the branch and open a GitHub PR (gh)')
  .option('--draft', 'Open the PR as a draft')
  .option('--base <branch>', 'Base branch (default: current branch)')
  .option('--max-attempts <n>', 'Fix/verify attempts', int, 3)
  .option('--keep-worktree', 'Keep the git worktree after finishing')
  .option('--no-pr-assets', 'Do not commit before/after images for the PR description')
  .action(async (ids: string[], o) => {
    const runDir = findRunDir(o);
    const { fixFindings } = await import('./fix/fixGroup.js');
    await fixFindings({ runDir, ids: ids.map((x) => x.toUpperCase()), pr: !!o.pr, draft: !!o.draft, base: o.base, maxAttempts: o.maxAttempts, keepWorktree: !!o.keepWorktree, prAssets: o.prAssets !== false, log });
  });

program
  .command('list')
  .description('List findings of a run, grouped by root cause')
  .option('--run <id|path>')
  .option('--out <dir>')
  .option('--all', 'Include low-confidence / flaky / suppressed / false positives')
  .option('--json', 'Print the flat findings as JSON')
  .action((o) => {
    const runDir = findRunDir(o);
    const ff = readFindings(runDir);
    if (!ff) throw new Error('No findings.json yet — run triage.');
    if (o.json) return console.log(JSON.stringify(allFindings(ff), null, 2));
    const show = (s: string) => o.all || ['new', 'confirmed', 'fixing', 'fixed'].includes(s);
    console.log(`Run ${ff.run_id} — ${ff.target}\n`);
    for (const g of ff.groups) {
      const fs = g.findings.filter((f) => show(f.status));
      if (!fs.length) continue;
      console.log(`${g.id}  ${g.summary}${g.findings.length > 1 ? `  (${g.findings.length} findings)` : ''}`);
      for (const f of fs) console.log(`   ${f.id}  ${f.severity.padEnd(8)} ${String(Math.round(f.confidence * 100)).padStart(3)}%  ${f.status.padEnd(14)} ${f.page.padEnd(12)} ${f.title}`);
    }
    console.log(`\nReport: ${join(runDir, 'report.html')}`);
  });

program
  .command('report')
  .description('Regenerate report.html and summary.md from findings.json (after hand edits)')
  .option('--run <id|path>')
  .option('--out <dir>')
  .action((o) => {
    const runDir = findRunDir(o);
    const r = writeReport(runDir);
    log(`Report: ${r.html}\nSummary: ${r.md}`);
  });

program
  .command('label')
  .description('Label a finding (confirmed / false_positive / any status). False positives can become suppression patterns.')
  .argument('<id>', 'BB-xxxx')
  .argument('<status>', `one of ${FindingStatus.options.join(', ')}`)
  .option('--run <id|path>')
  .option('--out <dir>')
  .option('--note <text>', 'Why')
  .option('--no-pattern', 'For false_positive: do not create a suppression pattern')
  .option('--pattern-scope <scope>', 'false_positive pattern scope: element (default) | component | type-on-page', 'element')
  .action((id: string, status: string, o) => {
    const runDir = findRunDir(o);
    const info = readRun(runDir);
    const ff = readFindings(runDir)!;
    const hit = findById(ff, id.toUpperCase());
    if (!hit) throw new Error(`Unknown finding ${id}`);
    const st = FindingStatus.parse(status);
    const f = hit.finding;
    f.status = st;
    f.label_note = o.note ?? null;
    const memory = new Memory(info.workspace);
    memory.setBugStatus(f.fingerprint, st, info.run_id, f.id);
    if (st === 'confirmed' || st === 'false_positive') memory.addLabel({ finding_id: f.id, run: info.run_id, fingerprint: f.fingerprint, type: f.type, label: st, raw_confidence: f.confidence_breakdown.raw, note: o.note ?? null, at: new Date().toISOString() });
    if (st === 'false_positive' && o.pattern !== false) {
      const leaf = (f.element.selector ?? '').split('>').pop()?.trim() ?? '';
      const cls = leaf.match(/\.[\w-]+/)?.[0] ?? null;
      const pats = memory.fpPatterns();
      const scope = o.patternScope;
      pats.push({
        id: `FP-${String(pats.length + 1).padStart(3, '0')}`,
        type: f.type,
        selector_contains: scope === 'type-on-page' ? null : scope === 'component' ? cls ?? leaf : leaf || null,
        text_contains: null,
        page: scope === 'component' ? null : f.page,
        reason: o.note ?? `labeled false positive (${f.id})`,
        source_finding: f.id,
        created: new Date().toISOString(),
      });
      memory.saveFpPatterns(pats);
      log(`Added false-positive pattern ${pats[pats.length - 1].id} (${scope}); future runs will suppress matching findings.`);
    }
    writeFindings(runDir, { run_id: ff.run_id, target: ff.target, generated_at: ff.generated_at, groups: ff.groups });
    writeReport(runDir);
    log(`${f.id} → ${st}`);
  });

program
  .command('regroup')
  .description('Move a finding to another root-cause group (or "new" to split it into its own group)')
  .argument('<id>', 'BB-xxxx')
  .argument('<group>', 'RC-xxx or "new"')
  .option('--run <id|path>')
  .option('--out <dir>')
  .option('--summary <text>', 'Summary for a new group')
  .action((id: string, group: string, o) => {
    const runDir = findRunDir(o);
    const ff = readFindings(runDir)!;
    const hit = findById(ff, id.toUpperCase());
    if (!hit) throw new Error(`Unknown finding ${id}`);
    hit.group.findings = hit.group.findings.filter((f) => f.id !== hit.finding.id);
    let target: RootCauseGroup | undefined = ff.groups.find((g) => g.id === group.toUpperCase());
    if (!target) {
      if (group.toLowerCase() !== 'new') throw new Error(`Unknown group ${group}`);
      const n = Math.max(0, ...ff.groups.map((g) => parseInt(g.id.replace(/\D/g, ''), 10) || 0)) + 1;
      target = { id: `RC-${String(n).padStart(3, '0')}`, summary: o.summary ?? hit.finding.title, component: null, css_rule: null, files: hit.finding.source_hints.slice(0, 2).map((h) => h.file), fix_plan: hit.finding.fix_hint, confidence: 0.5, status_rollup: {}, findings: [] };
      ff.groups.push(target);
    }
    target.findings.push(hit.finding);
    hit.finding.root_cause_id = target.id;
    const groups = ff.groups.filter((g) => g.findings.length);
    for (const g of groups) for (const f of g.findings) f.siblings = g.findings.filter((x) => x.id !== f.id).map((x) => x.id);
    writeFindings(runDir, { run_id: ff.run_id, target: ff.target, generated_at: ff.generated_at, groups });
    writeReport(runDir);
    log(`${hit.finding.id} → ${target.id}`);
  });

program
  .command('group')
  .description('Re-run root-cause grouping on a triaged run (keeps every finding and its status)')
  .option('--run <id|path>')
  .option('--out <dir>')
  .option('--no-llm', 'Structural grouping only')
  .action(async (o) => {
    const runDir = findRunDir(o);
    const { regroupRun } = await import('./triage/triage.js');
    await regroupRun(runDir, log, o.llm !== false);
  });

program
  .command('calibrate')
  .description('Fit confidence calibration from your labels (+ benchmark labels)')
  .option('--out <dir>', 'Workspace directory')
  .option('--run <id|path>', 'Any run in the workspace')
  .action((o) => {
    const runDir = findRunDir(o);
    const memory = new Memory(readRun(runDir).workspace);
    const labels = memory.labels();
    const model = fitCalibration(labels);
    saveCalibration(memory, model);
    console.log(`Fitted on ${labels.length} labels (${Object.keys(model.per_type).length} per-type curves${model.global ? ' + global' : ', not enough for a global curve yet (need 8)'}).`);
    console.table(model.table.map((r) => ({ 'raw confidence': r.bin, labeled: r.count, precision: r.precision == null ? '—' : `${Math.round(r.precision * 100)}%` })));
    console.log('New triage runs will use it; re-run `bugbash triage` to rescore an existing run.');
  });

program
  .command('bench')
  .description('Run explore + triage on the seeded fixture and score recall/precision (and record calibration labels)')
  .option('--out <dir>', 'Workspace (default: ./.bugbash-bench)', '.bugbash-bench')
  .option('--black-box', 'Disable code intel')
  .option('--no-lead', 'Fixed plan instead of the lead agent')
  .option('--budget-sessions <n>', 'Explorer sessions', int, 6)
  .option('--max-calls <n>', 'Tool calls per session', int, 60)
  .option('--parallel <n>', '', int, 3)
  .option('--browsers <list>', '', 'chromium,webkit')
  .option('--model <model>')
  .option('--no-video')
  .option('--score-only <run>', 'Only score an existing triaged run (id or path)')
  .action(async (o) => {
    const { scoreRun } = await import('./bench.js');
    let runDir: string;
    if (o.scoreOnly) runDir = findRunDir({ run: o.scoreOnly, out: o.out });
    else {
      const target = await resolveTarget('fixtures/buggy-site', { log });
      try {
        const r = await exploreRun({ targetArg: 'fixtures/buggy-site', target, out: o.out, overrides: overrides(o), noLead: o.lead === false, codeIntel: !o.blackBox, log });
        runDir = r.runDir;
        rememberRun(runDir);
        const { triageRun } = await import('./triage/triage.js');
        await triageRun({ runDir, baseUrl: target.baseUrl, log, video: o.video !== false });
      } finally {
        await target.stop();
      }
    }
    const res = scoreRun(runDir, { label: true });
    console.log(JSON.stringify(res, null, 2));
  });

program
  .command('runs')
  .description('List runs in a workspace')
  .option('--out <dir>', 'Workspace', '.bugbash')
  .action((o) => {
    for (const r of listRuns(resolve(o.out))) console.log(r);
  });

program
  .command('serve')
  .description('Serve a local static folder (handy for the fixture site)')
  .argument('<dir>')
  .action(async (dir: string) => {
    const t = await resolveTarget(dir, { log });
    log(`Serving at ${t.baseUrl} (Ctrl-C to stop)`);
    await new Promise(() => {});
  });

program.parseAsync().catch((e) => {
  console.error(`[bugbash] ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
