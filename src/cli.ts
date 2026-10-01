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
import { workspaceFor } from './store/store.js';
import { JobReporter, newJobId } from './jobs/events.js';

/** Creates a job reporter and a logger that writes to both stderr and the job's event stream. */
function jobLogger(root: string, id: string | undefined, kind: 'explore' | 'triage', init: Record<string, unknown>) {
  const rep = new JobReporter(join(root, 'jobs'), id ?? newJobId(kind), kind, init);
  const stageOf = (m: string) => (m.startsWith('▶') ? 'session-start' : m.startsWith('■') ? 'session-end' : /^Triage|^\s+\[\d+\/\d+\]|Grouping|Report:|Summary:/.test(m) ? 'triage' : kind);
  const logf = (m: string) => {
    console.error(`[bugbash] ${m}`);
    rep.event(stageOf(m), m.trim(), /error|failed/i.test(m) ? 'warn' : m.startsWith('■') ? 'success' : 'info');
  };
  process.on('SIGTERM', () => {
    rep.finish('cancelled', { error: 'cancelled' });
    process.exit(143);
  });
  return { rep, logf };
}

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
    personas: o.personas ? o.personas.split(',').map((x: string) => x.trim()) : undefined,
    devices: o.devices ? o.devices.split(',').map((x: string) => x.trim()) : undefined,
    personaSessions: o.personaSessions ? Object.fromEntries(o.personaSessions.split(',').map((kv: string) => kv.split('=')).map(([k, v]: string[]) => [k.trim(), Number(v)])) : undefined,
    strategies: o.strategies || o.excludeStrategies ? { include: o.strategies ? o.strategies.split(',').map((x: string) => x.trim()) : [], exclude: o.excludeStrategies ? o.excludeStrategies.split(',').map((x: string) => x.trim()) : [] } : undefined,
    focusPaths: o.focus ? o.focus.split(',').map((x: string) => x.trim()) : undefined,
    disabledPersonas: o.disablePersonas !== undefined ? o.disablePersonas.split(',').map((x: string) => x.trim()).filter(Boolean) : undefined,
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
    .option('--preset <id>', 'Run setup preset: standard (default), quick, mobile, desktop, deep, or one you saved')
    .option('--config <file>', 'JSON file with config overrides (used by the web launcher)')
    .option('--devices <list>', 'Allowed device profiles (e.g. iphone-15,pixel-7,laptop)')
    .option('--persona-sessions <list>', 'Minimum sessions per persona, e.g. phone-user=3,everyday-user=3')
    .option('--strategies <list>', 'Only these attack strategies')
    .option('--exclude-strategies <list>', 'Attack strategies to turn off (their tools are refused)')
    .option('--focus <paths>', 'Pages the lead must cover')
    .option('--personas <list>', 'Only use these personas (e.g. everyday-user,phone-user)')
    .option('--disable-personas <list>', 'Personas to turn off (default: low-vision-user; pass "" to enable all)')
    .option('--model <model>', 'Claude model alias for all agents')
    .option('--dev-command <cmd>', 'Command that starts the app')
    .option('--dev-port <port>', 'Port the dev server listens on', int)
    .option('--no-lead', 'Skip the lead agent; run a fixed default plan')
    .option('--no-code-intel', 'Black-box mode: do not read source code');

exploreOpts(program.command('explore').description('Agentically bug-bash a site (lead agent + explorer agents across sizes, browsers, personas)').argument('<target>', 'URL, local static folder, or local repo with a dev/start script'))
  .option('--then-triage', 'Run triage right after exploring')
  .option('--name <name>', 'Display name for the run')
  .option('--job <id>', 'Job id for progress events (used by the web app)')
  .option('--schedule <id>', 'Set by scheduled runs (launchd): records the result for the Schedules page')
  .action(async (targetArg: string, o) => {
    const sched = o.schedule ? await import('./schedule/schedule.js') : null;
    const started = new Date().toISOString();
    let schedRunDir: string | null = null;
    sched?.recordLast(o.schedule, { state: 'running', at: started, ended_at: null, run_dir: null, error: null });
    const target = await resolveTarget(targetArg, { repo: o.repo, devCommand: o.devCommand, devPort: o.devPort, log });
    const ws = workspaceFor(target.repoPath, o.out);
    const { rep, logf } = jobLogger(ws, o.job, 'explore', { options: { target: targetArg, repo: o.repo ?? null, thenTriage: !!o.thenTriage, browsers: o.browsers ?? null, budgetSessions: o.budgetSessions ?? null, noLead: o.lead === false, codeIntel: o.codeIntel !== false } });
    try {
      const { getPreset, DEFAULT_PRESET } = await import('./presets.js');
      const preset = getPreset(o.preset ?? DEFAULT_PRESET);
      if (o.preset && !preset) throw new Error(`Unknown preset "${o.preset}"`);
      const { pickConfig } = await import('./config.js');
      const picked = o.config ? pickConfig(JSON.parse(readFileSync(resolve(o.config), 'utf8'))) : { ok: true as const, config: {} };
      if (!picked.ok) throw new Error(`Invalid --config: ${picked.error}`);
      const fileOverrides = picked.config;
      logf(`Preset: ${preset?.name ?? 'none'}${o.config ? ' + custom settings' : ''}`);
      const { runDir, config } = await exploreRun({
        targetArg,
        target,
        out: ws,
        preset: preset?.config,
        overrides: { ...fileOverrides, ...Object.fromEntries(Object.entries(overrides(o)).filter(([, v]) => v !== undefined)) },
        noLead: o.lead === false ? true : undefined,
        codeIntel: o.codeIntel === false ? false : undefined,
        name: o.name,
        log: logf,
        onRun: (runDir) => {
          rep.update({ run_dir: runDir });
          schedRunDir = runDir;
          sched?.recordLast(o.schedule, { state: 'running', at: started, ended_at: null, run_dir: runDir, error: null });
        },
      });
      rememberRun(runDir);
      if (o.thenTriage) {
        const { triageRun } = await import('./triage/triage.js');
        await triageRun({ runDir, baseUrl: target.baseUrl, log: logf, video: config.triage.video, review: config.triage.review });
        if (config.retrospective) {
          // Proposals only: nothing is applied until approved on the Improvements page.
          const { runRetro } = await import('./learn/retro.js');
          await runRetro({ runDir, model: config.model, log: logf }).catch((e) => logf(`Retrospective failed: ${(e as Error).message}`));
        }
      } else logf(`Next: bugbash triage --run ${runDir}`);
      (await import('./notify/events.js')).notifyRunDone(runDir);
      rep.finish('succeeded', { summary: o.thenTriage ? 'Explored and triaged' : 'Explored' });
      sched?.recordLast(o.schedule, { state: 'succeeded', at: started, ended_at: new Date().toISOString(), run_dir: runDir, error: null });
    } catch (e) {
      rep.finish('failed', { error: (e as Error).message });
      sched?.recordLast(o.schedule, { state: 'failed', at: started, ended_at: new Date().toISOString(), run_dir: schedRunDir, error: (e as Error).message.slice(0, 500) });
      throw e;
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
  .option('--job <id>', 'Job id for progress events (used by the web app)')
  .action(async (o) => {
    const runDir = findRunDir(o);
    rememberRun(runDir);
    const info = readRun(runDir);
    const { rep, logf } = jobLogger(runDir, o.job, 'triage', { run_dir: runDir, options: { video: o.video !== false, review: o.review !== false } });
    const target = await resolveTarget(o.target ?? (info.target_kind === 'url' ? info.base_url : info.repo_path ?? info.target), { repo: info.repo_path, log: logf });
    try {
      const { triageRun } = await import('./triage/triage.js');
      await triageRun({ runDir, baseUrl: target.baseUrl, log: logf, video: o.video !== false, review: o.review !== false, reproRuns: o.reproRuns, concurrency: o.concurrency });
      rep.finish('succeeded', { summary: 'Triage complete' });
      (await import('./notify/events.js')).notifyRunDone(runDir);
    } catch (e) {
      rep.finish('failed', { error: (e as Error).message });
      throw e;
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
  .option('--job <id>', 'Job id for progress events (used by the web app)')
  .action(async (ids: string[], o) => {
    const runDir = findRunDir(o);
    const { fixFindings } = await import('./fix/fixGroup.js');
    await fixFindings({ runDir, ids: ids.map((x) => x.toUpperCase()), pr: !!o.pr, draft: !!o.draft, base: o.base, maxAttempts: o.maxAttempts, keepWorktree: !!o.keepWorktree, prAssets: o.prAssets !== false, log, jobId: o.job });
  });

program
  .command('reproduce')
  .description("Open a real browser window with a bug's exact environment (browser, device, size, settings), replay its steps and highlight it")
  .argument('<id>', 'BB-xxxx')
  .option('--run <id|path>')
  .option('--out <dir>')
  .option('--mode <mode>', 'full (replay steps up to the bug) | start (just open the page in that environment)', 'full')
  .option('--slow', 'Slow motion')
  .option('--browser <name>', 'Override the browser engine (chromium, webkit, firefox)')
  .option('--no-guardrails', 'Let the page make real requests and navigate anywhere (manual testing)')
  .option('--job <id>', 'Job id for progress events (used by the web app)')
  .action(async (id: string, o) => {
    const runDir = findRunDir(o);
    const { reproduce } = await import('./repro/reproduce.js');
    await reproduce({ runDir, id: id.toUpperCase(), mode: o.mode === 'start' ? 'start' : 'full', slow: !!o.slow, browser: o.browser ? BrowserName.parse(o.browser) : null, guardrails: o.guardrails !== false, jobId: o.job, log });
  });

program
  .command('rename')
  .description('Give a run a display name (its id and folder stay the same). Pass "" to clear it.')
  .argument('<run>', 'Run id or path')
  .argument('<name>', 'New display name')
  .option('--out <dir>', 'Workspace directory')
  .action(async (run: string, name: string, o) => {
    const { renameRun } = await import('./store/store.js');
    const info = renameRun(findRunDir({ run, out: o.out }), name);
    log(info.name ? `${info.run_id} → "${info.name}"` : `${info.run_id}: name cleared`);
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
  .option('--json', 'Print the updated finding as JSON')
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
    if (o.json) console.log(JSON.stringify(f));
    else log(`${f.id} → ${st}`);
  });

program
  .command('mark')
  .description('Sort findings for yourself: to do / in progress / done (marks fixed) / unsorted, and archive or unarchive')
  .argument('<ids...>', 'BB-xxxx ids')
  .option('--run <id|path>')
  .option('--out <dir>')
  .option('--todo')
  .option('--doing', 'In progress')
  .option('--done', 'Done (marks the finding fixed; moving it back restores its status)')
  .option('--unsorted', 'Clear your to do / in progress / done choice')
  .option('--archive', 'Move to the run\'s archive (kept, but out of the active lists and counts)')
  .option('--unarchive')
  .action(async (ids: string[], o) => {
    const states = [o.todo && 'todo', o.doing && 'in_progress', o.done && 'done', o.unsorted && 'unsorted'].filter(Boolean) as string[];
    if (states.length > 1) throw new Error('Pick one of --todo, --doing, --done, --unsorted');
    if (o.archive && o.unarchive) throw new Error('Pick --archive or --unarchive');
    if (!states.length && !o.archive && !o.unarchive) throw new Error('Nothing to do: pass a state and/or --archive / --unarchive');
    const { setWorkflow } = await import('./store/workflow.js');
    const runDir = findRunDir(o);
    const hits = setWorkflow(runDir, ids, { ...(states.length ? { state: states[0] === 'unsorted' ? null : (states[0] as 'todo' | 'in_progress' | 'done') } : {}), ...(o.archive || o.unarchive ? { archived: !!o.archive } : {}) });
    writeReport(runDir);
    for (const f of hits) log(`${f.id} → ${f.workflow.state ?? 'unsorted'}${f.workflow.archived ? ', archived' : ''} (status ${f.status})`);
  });

program
  .command('regroup')
  .description('Move a finding to another root-cause group (or "new" to split it into its own group)')
  .argument('<id>', 'BB-xxxx')
  .argument('<group>', 'RC-xxx or "new"')
  .option('--run <id|path>')
  .option('--out <dir>')
  .option('--summary <text>', 'Summary for a new group')
  .option('--json', 'Print the updated finding as JSON')
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
    if (o.json) console.log(JSON.stringify(hit.finding));
    else log(`${hit.finding.id} → ${target.id}`);
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
  .command('retro')
  .description('Post-mortem a triaged run: propose lessons, strategy priors, detector suggestions and prompt/config tweaks (applied only when you approve them)')
  .option('--run <id|path>', 'Run id or path (default: latest)')
  .option('--out <dir>', 'Workspace directory')
  .option('--model <model>')
  .option('--job <id>', 'Job id for progress events (used by the web app)')
  .action(async (o) => {
    const runDir = findRunDir(o);
    const { runRetro } = await import('./learn/retro.js');
    const r = await runRetro({ runDir, model: o.model, log, jobId: o.job });
    for (const p of r.added) console.log(`${p.id} [${p.kind}] ${p.title}`);
    console.log(`Review them in the web app (Improvements) or with: bugbash improvements approve|reject <id>`);
  });

program
  .command('improvements')
  .description('List, approve or reject improvement proposals, and show the backlog')
  .argument('[action]', 'list | approve | reject | backlog', 'list')
  .argument('[id]', 'Proposal id (P-…)')
  .option('--out <dir>', 'Workspace directory')
  .option('--repo <path>', 'Repo whose workspace to use')
  .option('--note <text>', 'Reason (kept with the decision)')
  .action(async (action: string, id: string | undefined, o) => {
    const ws = workspaceFor(o.repo ?? null, o.out);
    const P = await import('./learn/proposals.js');
    if (action === 'list') {
      for (const f of P.listImprovementRuns(ws)) for (const p of f.proposals) console.log(`${p.id.padEnd(14)} ${p.status.padEnd(9)} [${p.kind}] ${p.title}`);
    } else if (action === 'backlog') {
      for (const b of P.backlog(ws)) console.log(`${b.id.padEnd(5)} ${b.status.padEnd(12)} [${b.kind}] ${b.title}${b.branch ? ` (${b.branch})` : ''}`);
    } else if (action === 'approve' || action === 'reject') {
      if (!id) throw new Error('Pass a proposal id');
      const run = P.listImprovementRuns(ws).find((f) => f.proposals.some((p) => p.id === id))?.run;
      if (!run) throw new Error(`No proposal ${id}`);
      console.log(P.decide(ws, run, id, { action, note: o.note ?? null }).applied);
    } else throw new Error(`Unknown action ${action}`);
  });

program
  .command('improve')
  .description('Implement an approved backlog item (detector suggestion or prompt/config tweak) on a new branch of this repo, verified by typecheck and tests')
  .argument('<id>', 'Backlog id (B-…)')
  .option('--out <dir>', 'Workspace directory the backlog lives in')
  .option('--repo <path>', 'Repo whose workspace to use')
  .option('--pr', 'Push the branch and open a PR (gh)')
  .option('--max-attempts <n>', 'Implement/verify attempts', int, 2)
  .option('--keep-worktree', 'Keep the git worktree after finishing')
  .option('--job <id>', 'Job id for progress events (used by the web app)')
  .action(async (id: string, o) => {
    const ws = workspaceFor(o.repo ?? null, o.out);
    const { implementBacklogItem } = await import('./learn/implement.js');
    const r = await implementBacklogItem({ ws, id, pr: !!o.pr, maxAttempts: o.maxAttempts, keepWorktree: !!o.keepWorktree, log, jobId: o.job });
    console.log(r.verified ? `Implemented on ${r.branch} (typecheck + tests pass)` : `Committed on ${r.branch}, but verification failed`);
  });

const schedule = program.command('schedule').description('Scheduled bug bashes via macOS launchd (run only while the Mac is awake and you are logged in)');
schedule
  .command('add')
  .description('Add a schedule (installs a LaunchAgent)')
  .requiredOption('--target <target>', 'URL, local static folder, or local repo')
  .requiredOption('--cron <expr>', 'minute hour day month weekday, e.g. "0 2 * * 1-5" (numbers, lists and ranges; no */n)')
  .option('--preset <id>', 'Run preset', 'standard')
  .option('--name <name>', 'Display name')
  .option('--repo <path>', 'Source repo (white-box + fixes)')
  .option('--disabled', 'Save without installing')
  .action(async (o) => {
    const S = await import('./schedule/schedule.js');
    const s = await S.addSchedule({ target: o.target, cron: o.cron, preset: o.preset, name: o.name, repo: o.repo, enabled: !o.disabled });
    console.log(`Added ${s.id}: ${s.name} — ${S.describeCron(s.cron)}${s.enabled ? `, next ${S.nextRun(s.cron)?.toLocaleString()}` : ' (disabled)'}\n${s.enabled ? `LaunchAgent: ${S.plistPath(s.id)}` : ''}`);
  });
schedule
  .command('list')
  .description('List schedules')
  .action(async () => {
    const S = await import('./schedule/schedule.js');
    const all = S.listSchedules();
    if (!all.length) console.log('No schedules.');
    for (const s of all) {
      const last = S.lastResult(s.id);
      console.log(`${s.id}  ${s.enabled ? (await S.isLoaded(s.id)) ? 'on ' : 'on (not loaded!)' : 'off'}  ${s.name} — ${S.describeCron(s.cron)} · ${s.preset} · ${s.target}${s.enabled ? ` · next ${S.nextRun(s.cron)?.toLocaleString()}` : ''}${last ? ` · last: ${last.state} ${last.at}` : ''}`);
    }
  });
for (const [cmd, desc] of [
  ['enable', 'Install the LaunchAgent'],
  ['disable', 'Uninstall the LaunchAgent (keeps the schedule)'],
  ['remove', 'Uninstall and delete the schedule'],
  ['run-now', 'Run it now (detached, same command and log as launchd)'],
] as const)
  schedule
    .command(cmd)
    .description(desc)
    .argument('<id>')
    .action(async (id: string) => {
      const S = await import('./schedule/schedule.js');
      if (cmd === 'enable' || cmd === 'disable') await S.setEnabled(id, cmd === 'enable');
      else if (cmd === 'remove') await S.removeSchedule(id);
      else console.log(`Started (pid ${S.runNow(id).pid}); log: ${S.logPath(id)}`);
      if (cmd !== 'run-now') console.log(`${cmd}d ${id}`);
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
    const { benchHistory } = await import('./bench.js');
    const latest = benchHistory().at(-1);
    if (latest?.regression) (await import('./notify/events.js')).notifyFailure(`Benchmark regression: recall dropped ${Math.round(latest.regression.drop * 100)} pts`, `Agent version ${latest.version} (commit ${latest.commit ?? '?'}) found fewer seeded bugs than ${latest.regression.from}. Best recall now ${Math.round(latest.best_recall * 100)}%.`, '/improvements?tab=bench');
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
