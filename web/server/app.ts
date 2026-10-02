import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readRun, readFindings, findById, renameRun } from '../../src/store/store.ts';
import { setWorkflow } from '../../src/store/workflow.ts';
import { writeReport } from '../../src/store/report.ts';
import { FindingStatus } from '../../src/store/schema.ts';
import { Config, pickConfig } from '../../src/config.ts';
import { PERSONA_REGISTRY } from '../../src/explore/personas.ts';
import { DEVICE_PROFILES } from '../../src/explore/devices.ts';
import { STRATEGIES } from '../../src/explore/strategies.ts';
import { listPresets, getPreset, savePreset, deletePreset, DEFAULT_PRESET } from '../../src/presets.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { workspaces, workspaceById, runDirOf, addWorkspace, HttpError } from './workspaces.ts';
import { listAllRuns, runDetail, transcriptFor, findFinding, sessionTail } from './runs.ts';
import { safePath, fileResponse } from './files.ts';
import { listJobs, getJob, launchJob, cancelJob, readEvents, CLI, REPO_ROOT, WEB_JOBS } from './jobs.ts';
import { branchInfo } from './git.ts';
import { dashboard } from './dashboard.ts';
import { agentsOverview } from './agentStats.ts';
import { compareRuns } from './compare.ts';
import { addReport, readReports, REPORT_CATEGORIES } from '../../src/learn/investigate.ts';
import { postMessage, readMessages } from '../../src/jobs/inbox.ts';
import { listPRs } from './prs.ts';
import { listImprovementPRs, mergeImprovementPR, closeImprovementPR } from './improvementPrs.ts';
import { githubStatus, connectGitHub, disconnectGitHub } from './github.ts';
import { schedulesOverview, previewCron, createSchedule, toggleSchedule, deleteSchedule, runScheduleNow } from './schedules.ts';
import { publicSettings, saveSettings, inbox, readMany, sendTest } from './notifications.ts';
import { improvementsOverview, decideProposal, launchRetro, launchImplement, launchImplementBatch } from './improvements.ts';

const exec = promisify(execFile);
const ID = /^(BB|RC)-\d{3,5}$/i;

export const app = new Hono().basePath('/api');

app.onError((err, c) => {
  const status = err instanceof HttpError ? err.status : 500;
  if (status === 500) console.error(err);
  return c.json({ error: err.message }, status);
});

// ---------- workspaces & runs ----------
app.get('/workspaces', (c) => c.json(workspaces().map((w) => ({ id: w.id, path: w.path, runs: w.runs.length }))));
app.post('/workspaces', async (c) => {
  const { path } = await c.req.json<{ path: string }>();
  return c.json({ path: addWorkspace(path) });
});

app.get('/runs', (c) => c.json(listAllRuns()));
app.get('/agents', (c) => {
  const ws = c.req.query('ws');
  const run = c.req.query('run');
  return c.json(agentsOverview(ws && run ? { ws, run } : null));
});

app.get('/dashboard', (c) => {
  const ws = c.req.query('ws');
  const run = c.req.query('run');
  return c.json(dashboard(ws && run ? { ws, run } : null));
});

app.get('/runs/:ws/:run', (c) => {
  const w = workspaceById(c.req.param('ws'));
  runDirOf(w.id, c.req.param('run'));
  return c.json(runDetail(w.id, w.path, c.req.param('run')));
});

app.post('/runs/:ws/:run/rename', async (c) => {
  const dir = runDirOf(c.req.param('ws'), c.req.param('run'));
  const b = await c.req.json<{ name?: unknown }>().catch(() => ({}) as { name?: unknown });
  if (b.name !== null && typeof b.name !== 'string') throw new HttpError(400, 'name must be a string (or null to clear)');
  if (typeof b.name === 'string' && b.name.length > 200) throw new HttpError(400, 'name is too long');
  const info = renameRun(dir, b.name as string | null);
  return c.json({ run: info.run_id, name: info.name ?? null });
});

app.get('/runs/:ws/:run/bugs/:id', (c) => {
  const dir = runDirOf(c.req.param('ws'), c.req.param('run'));
  const id = c.req.param('id').toUpperCase();
  const ff = readFindings(dir);
  const hit = ff && findById(ff, id);
  if (!hit) throw new HttpError(404, `Unknown finding ${id}`);
  const spec = hit.finding.reproduction.spec && existsSync(join(dir, hit.finding.reproduction.spec)) ? readFileSync(join(dir, hit.finding.reproduction.spec), 'utf8') : null;
  const fixDir = hit.finding.fix?.branch ? join('fixes', hit.finding.fix.branch.replace(/\//g, '__')) : null;
  const afterShot = fixDir && existsSync(join(dir, fixDir, `${id}-after.png`)) ? join(fixDir, `${id}-after.png`) : null;
  const prBody = fixDir && existsSync(join(dir, fixDir, 'pr-body.md')) ? readFileSync(join(dir, fixDir, 'pr-body.md'), 'utf8') : null;
  return c.json({
    finding: hit.finding,
    group: { ...hit.group, findings: hit.group.findings.map((f) => ({ id: f.id, title: f.title, status: f.status, severity: f.severity, type: f.type, page: f.page })) },
    groups: ff!.groups.map((g) => ({ id: g.id, summary: g.summary, count: g.findings.length })),
    spec,
    after_shot: afterShot,
    pr_body: prBody,
    jobs: listJobs({ runDir: dir }).filter((j) => j.finding_ids.includes(id) || j.scope?.split(/[+,]/).includes(hit.group.id)),
    reports: readReports(readRun(dir).workspace).filter((r) => r.run === c.req.param('run') && r.bug === id).reverse(),
    run: { target: readRun(dir).target, name: readRun(dir).name ?? null, repo_path: readRun(dir).repo_path, base_url: readRun(dir).base_url },
  });
});

app.get('/runs/:ws/:run/bugs/:id/transcript', (c) => {
  const dir = runDirOf(c.req.param('ws'), c.req.param('run'));
  return c.json(transcriptFor(dir, findFinding(dir, c.req.param('id').toUpperCase())));
});

app.get('/runs/:ws/:run/sessions/:session/tail', (c) => {
  const dir = runDirOf(c.req.param('ws'), c.req.param('run'));
  return c.json(sessionTail(dir, c.req.param('session'), Math.min(50, Number(c.req.query('n') ?? 12))));
});

app.get('/runs/:ws/:run/files/*', (c) => {
  const dir = runDirOf(c.req.param('ws'), c.req.param('run'));
  const rel = decodeURIComponent(c.req.path.split('/files/').slice(1).join('/files/'));
  return fileResponse(safePath(dir, rel), c.req.header('range'), c.req.query('download') === '1');
});

// ---------- actions ----------
app.post('/runs/:ws/:run/fix', async (c) => {
  const dir = runDirOf(c.req.param('ws'), c.req.param('run'));
  const b = await c.req.json<{ ids: string[]; pr?: boolean; draft?: boolean; base?: string; maxAttempts?: number; keepWorktree?: boolean; confirmPush?: boolean; mode?: string; branch?: string; instructions?: string; publishUnverified?: boolean; confirmUnverified?: boolean }>();
  if (b.publishUnverified && !(b.pr && b.confirmUnverified)) throw new HttpError(400, 'Publishing an unverified fix needs pr and an explicit confirmUnverified');
  if (b.mode !== undefined && !['new', 'retry', 'continue', 'verify'].includes(b.mode)) throw new HttpError(400, 'mode must be new, retry, continue or verify');
  if (b.instructions !== undefined && (typeof b.instructions !== 'string' || b.instructions.length > 4000)) throw new HttpError(400, 'instructions must be text (4000 characters max)');
  if (b.branch !== undefined && !/^bugbash\/[\w./-]+$/.test(b.branch)) throw new HttpError(400, 'Bad branch (must be a bugbash/… branch)');
  const ids = (b.ids ?? []).map((x) => String(x).toUpperCase());
  if (!ids.length || !ids.every((x) => ID.test(x))) throw new HttpError(400, 'ids must be BB-/RC- ids');
  if (b.pr && !b.confirmPush) throw new HttpError(400, 'Opening a PR pushes to GitHub: confirmPush must be true');
  if (b.base && !/^[\w./-]+$/.test(b.base)) throw new HttpError(400, 'Bad base branch');
  const info = readRun(dir);
  if (!info.repo_path) throw new HttpError(409, 'This run has no local repository, so it cannot be fixed.');
  const busy = listJobs({ runDir: dir }).find((j) => j.kind === 'fix' && j.alive && j.finding_ids.some((x) => ids.includes(x)));
  if (busy) throw new HttpError(409, `A fix job (${busy.id}) is already running for ${busy.finding_ids.join(', ')}`);
  const args = ['fix', ...ids, '--run', dir, '--max-attempts', String(Math.min(5, Math.max(1, b.maxAttempts ?? 3)))];
  if (b.pr) args.push('--pr');
  if (b.pr && b.draft !== false) args.push('--draft');
  if (b.base) args.push('--base', b.base);
  if (b.keepWorktree) args.push('--keep-worktree');
  if (b.mode === 'retry') args.push('--retry');
  if (b.mode === 'continue') args.push('--continue', ...(b.branch ? [b.branch] : []));
  if (b.mode === 'verify') args.push('--verify', ...(b.branch ? [b.branch] : []));
  if (b.instructions?.trim()) args.push('--instructions', b.instructions.trim());
  if (b.publishUnverified) args.push('--publish-unverified');
  return c.json(launchJob('fix', args, { run_dir: dir, finding_ids: ids, scope: ids.join(','), branch: b.mode === 'continue' ? (b.branch ?? null) : null, options: { pr: !!b.pr, draft: b.draft !== false, base: b.base ?? null, mode: b.mode ?? 'new', branch: b.branch ?? null, instructions: b.instructions?.trim() || null } }), 202);
});

app.get('/github', async (c) => c.json(await githubStatus(c.req.query('fresh') === '1')));
app.post('/github/connect', (c) => c.json(connectGitHub(), 202));
app.post('/github/disconnect', async (c) => c.json(await disconnectGitHub()));
app.get('/notifications', (c) => c.json(inbox()));
app.post('/notifications/read', async (c) => c.json(readMany(await c.req.json<{ ids?: string[]; all?: boolean }>().catch(() => ({})))));
app.get('/settings', (c) => c.json(publicSettings()));
app.put('/settings', async (c) => c.json(saveSettings(await c.req.json())));
app.post('/settings/test', async (c) => c.json(await sendTest((await c.req.json<{ channel: string }>()).channel)));
app.get('/schedules', async (c) => c.json(await schedulesOverview()));
app.get('/schedules/preview', (c) => c.json(previewCron(c.req.query('cron') ?? '')));
app.post('/schedules', async (c) => c.json(await createSchedule(await c.req.json()), 201));
app.post('/schedules/:id/enable', async (c) => c.json(await toggleSchedule(c.req.param('id'), true)));
app.post('/schedules/:id/disable', async (c) => c.json(await toggleSchedule(c.req.param('id'), false)));
app.post('/schedules/:id/run', async (c) => c.json(await runScheduleNow(c.req.param('id')), 202));
app.delete('/schedules/:id', async (c) => {
  await deleteSchedule(c.req.param('id'));
  return c.json({ ok: true });
});
app.get('/prs', async (c) => {
  const ws = c.req.query('ws');
  const run = c.req.query('run');
  return c.json(await listPRs(ws && run ? { ws, run } : null, c.req.query('fresh') === '1'));
});
app.get('/compare', (c) => {
  const a = c.req.query('a');
  const b = c.req.query('b');
  if (!a || !b) throw new HttpError(400, 'Pass a=ws/run and b=ws/run');
  return c.json(compareRuns(a, b));
});
app.get('/improvements', (c) => c.json(improvementsOverview()));
app.get('/improvements/prs', async (c) => c.json(await listImprovementPRs(c.req.query('fresh') === '1')));
app.post('/improvements/prs/merge', async (c) => c.json(await mergeImprovementPR(await c.req.json().catch(() => ({})))));
app.post('/improvements/prs/close', async (c) => c.json(await closeImprovementPR(await c.req.json().catch(() => ({})))));
app.post('/improvements/:ws/:run/:id', async (c) => {
  runDirOf(c.req.param('ws'), c.req.param('run')); // validates the run
  const b = await c.req.json<{ action: 'approve' | 'reject'; title?: string; body?: string; note?: string }>();
  return c.json(decideProposal(c.req.param('ws'), c.req.param('run'), c.req.param('id'), b));
});
app.post('/runs/:ws/:run/retro', (c) => {
  const dir = runDirOf(c.req.param('ws'), c.req.param('run'));
  if (!readFindings(dir)) throw new HttpError(409, 'Triage this run before running a retrospective.');
  return c.json(launchRetro(c.req.param('ws'), c.req.param('run'), dir), 202);
});
app.post('/backlog/:ws/implement', async (c) => {
  const b = await c.req.json<{ ids?: string[]; all?: boolean; pr?: boolean; confirmPush?: boolean }>().catch(() => ({}));
  return c.json(launchImplementBatch(c.req.param('ws'), b), 202);
});
app.post('/backlog/:ws/:id/implement', async (c) => {
  const b = await c.req.json<{ pr?: boolean; confirmPush?: boolean }>().catch(() => ({}));
  return c.json(launchImplement(c.req.param('ws'), c.req.param('id'), b), 202);
});

app.post('/runs/:ws/:run/bugs/:id/report', async (c) => {
  const dir = runDirOf(c.req.param('ws'), c.req.param('run'));
  const id = c.req.param('id').toUpperCase();
  if (!/^BB-\d{3,5}$/.test(id)) throw new HttpError(400, 'Bad finding id');
  findFinding(dir, id);
  const b = await c.req.json<{ category?: string; text?: string }>().catch(() => ({}) as { category?: string; text?: string });
  if (!b.category || !(b.category in REPORT_CATEGORIES)) throw new HttpError(400, `category must be one of ${Object.keys(REPORT_CATEGORIES).join(', ')}`);
  const text = String(b.text ?? '').trim().slice(0, 4000);
  const info = readRun(dir);
  const report = addReport(info.workspace, { run: info.run_id, bug: id, category: b.category as keyof typeof REPORT_CATEGORIES, text });
  const job = launchJob('investigate', ['report-problem', id, '--run', dir, '--category', b.category, '--text', text, '--report-id', report.id], { run_dir: dir, finding_ids: [id], scope: `${id}: ${REPORT_CATEGORIES[b.category as keyof typeof REPORT_CATEGORIES]}`, options: { report_id: report.id } });
  return c.json({ report, job }, 202);
});

app.post('/runs/:ws/:run/bugs/:id/reproduce', async (c) => {
  const dir = runDirOf(c.req.param('ws'), c.req.param('run'));
  const id = c.req.param('id').toUpperCase();
  if (!/^BB-\d{3,5}$/.test(id)) throw new HttpError(400, 'Bad finding id');
  findFinding(dir, id);
  const b = await c.req.json<{ mode?: string; slow?: boolean; browser?: string; guardrails?: boolean; branch?: string }>().catch(() => ({}) as { mode?: string; slow?: boolean; browser?: string; guardrails?: boolean; branch?: string });
  if (b.branch !== undefined && !/^bugbash\/[\w./-]+$/.test(b.branch)) throw new HttpError(400, 'Bad branch (must be a bugbash/… fix branch)');
  const args = ['reproduce', id, '--run', dir, '--mode', b.mode === 'start' ? 'start' : 'full'];
  if (b.slow) args.push('--slow');
  if (b.browser && ['chromium', 'webkit', 'firefox'].includes(b.browser)) args.push('--browser', b.browser);
  if (b.guardrails === false) args.push('--no-guardrails');
  if (b.branch) args.push('--branch', b.branch);
  return c.json(launchJob('reproduce', args, { run_dir: dir, finding_ids: [id], scope: id, options: { mode: b.mode ?? 'full', slow: !!b.slow } }), 202);
});

app.post('/runs/:ws/:run/triage', async (c) => {
  const dir = runDirOf(c.req.param('ws'), c.req.param('run'));
  const b = await c.req.json<{ video?: boolean; review?: boolean }>().catch(() => ({}) as { video?: boolean; review?: boolean });
  const args = ['triage', '--run', dir];
  if (b.video === false) args.push('--no-video');
  if (b.review === false) args.push('--no-review');
  return c.json(launchJob('triage', args, { run_dir: dir }), 202);
});

async function cli(args: string[]) {
  try {
    const r = await exec(process.execPath, [CLI, ...args], { cwd: REPO_ROOT, maxBuffer: 16 * 1024 * 1024, timeout: 120_000 });
    const last = r.stdout.trim().split('\n').pop() ?? '';
    return last.startsWith('{') ? JSON.parse(last) : { ok: true };
  } catch (e: any) {
    const text = String(e.stderr || e.message).replace(/\[bugbash\]\s*/g, '').trim();
    const line = text.split('\n').find((l) => /\w{3,}/.test(l) && !/^\s*[[\]{}]/.test(l)) ?? 'CLI failed';
    throw new HttpError(400, line.trim().slice(0, 300));
  }
}

app.post('/runs/:ws/:run/label', async (c) => {
  const dir = runDirOf(c.req.param('ws'), c.req.param('run'));
  const b = await c.req.json<{ id: string; status: string; note?: string; pattern?: boolean; patternScope?: string }>();
  if (!ID.test(b.id)) throw new HttpError(400, 'Bad finding id');
  if (!FindingStatus.options.includes(b.status as never)) throw new HttpError(400, `status must be one of: ${FindingStatus.options.join(', ')}`);
  const args = ['label', b.id, b.status, '--run', dir, '--json'];
  if (b.note) args.push('--note', b.note.slice(0, 500));
  if (b.pattern === false) args.push('--no-pattern');
  if (b.patternScope && /^(element|component|type-on-page)$/.test(b.patternScope)) args.push('--pattern-scope', b.patternScope);
  return c.json(await cli(args));
});

app.post('/runs/:ws/:run/workflow', async (c) => {
  const dir = runDirOf(c.req.param('ws'), c.req.param('run'));
  const b = await c.req.json<{ ids: string[]; state?: string | null; archived?: boolean }>();
  const ids = (b.ids ?? []).map((x) => String(x).toUpperCase());
  if (!ids.length || ids.length > 500 || !ids.every((x) => /^BB-\d{3,5}$/.test(x))) throw new HttpError(400, 'ids must be BB- ids');
  if (b.state !== undefined && b.state !== null && !['todo', 'in_progress', 'done'].includes(b.state)) throw new HttpError(400, 'state must be todo, in_progress, done or null');
  if (b.archived !== undefined && typeof b.archived !== 'boolean') throw new HttpError(400, 'archived must be true or false');
  if (b.state === undefined && b.archived === undefined) throw new HttpError(400, 'Nothing to change');
  try {
    const hits = setWorkflow(dir, ids, { ...(b.state !== undefined ? { state: b.state as 'todo' | 'in_progress' | 'done' | null } : {}), ...(b.archived !== undefined ? { archived: b.archived } : {}) });
    writeReport(dir);
    return c.json({ updated: hits.map((f) => ({ id: f.id, status: f.status, workflow: f.workflow })) });
  } catch (e) {
    throw new HttpError(/Unknown finding/.test((e as Error).message) ? 404 : 409, (e as Error).message);
  }
});

app.post('/runs/:ws/:run/regroup', async (c) => {
  const dir = runDirOf(c.req.param('ws'), c.req.param('run'));
  const b = await c.req.json<{ id: string; group: string; summary?: string }>();
  if (!ID.test(b.id) || !(/^RC-\d+$/i.test(b.group) || b.group === 'new')) throw new HttpError(400, 'Bad id or group');
  const args = ['regroup', b.id, b.group, '--run', dir, '--json'];
  if (b.summary) args.push('--summary', b.summary.slice(0, 300));
  return c.json(await cli(args));
});

/** Everything the launcher needs to build its form: personas, devices, strategies, browsers, defaults. */
app.get('/catalog', (c) => {
  const defaults = Config.parse({});
  return c.json({
    personas: PERSONA_REGISTRY.map((p) => ({ ...p, enabledByDefault: !defaults.disabledPersonas.includes(p.id) })),
    devices: DEVICE_PROFILES,
    strategies: Object.entries(STRATEGIES).map(([id, label]) => ({ id, label, group: id.split('.')[0] })),
    browsers: ['chromium', 'webkit', 'firefox'],
    defaults: { denylist: defaults.guardrails.denylist },
  });
});

app.get('/presets', (c) => c.json({ presets: listPresets(), default: DEFAULT_PRESET }));
app.post('/presets', async (c) => {
  const b = await c.req.json<{ id?: string; name: string; description?: string; config: Record<string, unknown> }>();
  if (!b.name?.trim()) throw new HttpError(400, 'name is required');
  const parsed = pickConfig(b.config ?? {});
  if (!parsed.ok) throw new HttpError(400, `Invalid config: ${parsed.error}`);
  return c.json(savePreset({ id: b.id, name: b.name, description: b.description, config: parsed.config }));
});
app.delete('/presets/:id', (c) => {
  try {
    return c.json({ deleted: deletePreset(c.req.param('id')) });
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
});

/** Start a bug bash: a preset plus explicit settings (validated, written to a config file the CLI layers on top). */
app.post('/explore', async (c) => {
  const b = await c.req.json<{ target: string; repo?: string; out?: string; name?: string; preset?: string; config?: Record<string, unknown>; thenTriage?: boolean }>();
  if (!b.target?.trim()) throw new HttpError(400, 'target is required');
  if (b.preset && !getPreset(b.preset)) throw new HttpError(400, `Unknown preset ${b.preset}`);
  const parsed = pickConfig(b.config ?? {});
  if (!parsed.ok) throw new HttpError(400, `Invalid settings: ${parsed.error}`);
  const args = ['explore', b.target.trim(), '--preset', b.preset ?? DEFAULT_PRESET];
  if (Object.keys(parsed.config).length) {
    mkdirSync(join(WEB_JOBS, 'configs'), { recursive: true });
    const file = join(WEB_JOBS, 'configs', `${Date.now()}-${Math.random().toString(16).slice(2, 8)}.json`);
    writeFileSync(file, JSON.stringify(parsed.config, null, 2));
    args.push('--config', file);
  }
  if (b.repo) args.push('--repo', b.repo);
  if (b.out) args.push('--out', b.out);
  if (b.name?.trim()) args.push('--name', b.name.trim().slice(0, 80));
  if (b.thenTriage !== false) args.push('--then-triage');
  return c.json(launchJob('explore', args, { options: { target: b.target, preset: b.preset ?? DEFAULT_PRESET, name: b.name ?? null, thenTriage: b.thenTriage !== false } }), 202);
});

// ---------- jobs ----------
app.get('/jobs', (c) => {
  const ws = c.req.query('ws');
  const run = c.req.query('run');
  return c.json(listJobs(ws && run ? { runDir: runDirOf(ws, run) } : {}));
});
app.get('/jobs/:id', async (c) => {
  const j = getJob(c.req.param('id'));
  // For finished fix jobs: does the branch still exist locally (so "Continue" is possible)?
  let branch_exists: boolean | null = null;
  if (j.kind === 'fix' && j.branch && j.run_dir && !j.alive) {
    try {
      const repo = readRun(j.run_dir).repo_path;
      if (repo) branch_exists = await exec('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${j.branch}`], { cwd: repo }).then(() => true, () => false);
    } catch {}
  }
  return c.json({ ...j, branch_exists });
});
app.post('/jobs/:id/cancel', (c) => c.json(cancelJob(c.req.param('id'))));
// A message to a FINISHED job starts it again with those instructions (fix: continue its branch; bug bash: a
// follow-up run of the same target; improvement: re-run the same items).
app.post('/jobs/:id/followup', async (c) => {
  const j = getJob(c.req.param('id'));
  if (j.state === 'running' && j.alive) throw new HttpError(409, 'The job is still running: send it a message instead');
  const b = await c.req.json<{ text?: string; pr?: boolean; confirmPush?: boolean }>().catch(() => ({}) as { text?: string; pr?: boolean; confirmPush?: boolean });
  const text = String(b.text ?? '').trim();
  if (!text) throw new HttpError(400, 'Write what you want the agent to do');
  if (text.length > 4000) throw new HttpError(400, 'Message is too long (4000 characters max)');
  if (b.pr && !b.confirmPush) throw new HttpError(400, 'Opening a PR pushes to GitHub: confirmPush must be true');
  const opts = (j.options ?? {}) as Record<string, unknown>;
  if (j.kind === 'fix') {
    if (!j.run_dir) throw new HttpError(409, "This fix job's run is unknown");
    const ids = j.scope && /^RC-\d+$/i.test(j.scope) ? [j.scope] : j.finding_ids;
    let hasBranch = false;
    try {
      const repo = readRun(j.run_dir).repo_path;
      if (repo && j.branch) hasBranch = await exec('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${j.branch}`], { cwd: repo }).then(() => true, () => false);
    } catch {}
    const args = ['fix', ...ids, '--run', j.run_dir, '--instructions', text, ...(hasBranch ? ['--continue', j.branch!] : ['--retry'])];
    if (b.pr) args.push('--pr', ...(opts.draft !== false ? ['--draft'] : []));
    return c.json(launchJob('fix', args, { run_dir: j.run_dir, finding_ids: j.finding_ids, scope: j.scope, branch: hasBranch ? j.branch : null, options: { ...opts, pr: !!b.pr, mode: hasBranch ? 'continue' : 'retry', instructions: text, followup_of: j.id } }), 202);
  }
  if (j.kind === 'explore') {
    const target = (opts.target as string | undefined) ?? (j.run_dir ? readRun(j.run_dir).target : null);
    if (!target) throw new HttpError(409, "This bug bash's target is unknown");
    const args = ['explore', target, '--then-triage', '--instructions', text];
    if (opts.repo) args.push('--repo', String(opts.repo));
    if (opts.preset) args.push('--preset', String(opts.preset));
    return c.json(launchJob('explore', args, { scope: target, options: { ...opts, instructions: text, followup_of: j.id } }), 202);
  }
  if (j.kind === 'improve') {
    const ids = ((opts.backlog_ids as string[] | undefined) ?? [opts.backlog_id as string]).filter(Boolean);
    const ws = workspaces().find((w) => w.id === opts.ws);
    if (!ids.length || !ws) throw new HttpError(409, "This improvement job's items are unknown");
    const args = ['improve', ...ids, '--out', ws.path, '--instructions', text, ...(b.pr ? ['--pr'] : [])];
    return c.json(launchJob('improve', args, { scope: j.scope, options: { ...opts, pr: !!b.pr, instructions: text, followup_of: j.id } }), 202);
  }
  throw new HttpError(409, `A ${j.kind} job can't be restarted with instructions`);
});

app.get('/jobs/:id/messages', (c) => c.json(readMessages(getJob(c.req.param('id')).dir)));
app.post('/jobs/:id/messages', async (c) => {
  const j = getJob(c.req.param('id'));
  if (!(j.state === 'running' && j.alive)) throw new HttpError(409, 'This job has finished; there is no agent to talk to');
  const b = await c.req.json<{ text?: string }>().catch(() => ({}) as { text?: string });
  const text = String(b.text ?? '').trim();
  if (!text) throw new HttpError(400, 'Write a message');
  if (text.length > 4000) throw new HttpError(400, 'Message is too long (4000 characters max)');
  return c.json(postMessage(j.dir, text), 201);
});

/** Server-sent events: every existing event, then new ones as they are appended; plus status snapshots. */
app.get('/jobs/:id/events', (c) => {
  const job = getJob(c.req.param('id'));
  return streamSSE(c, async (stream) => {
    let offset = 0;
    let lastStatus = '';
    let quietTicks = 0;
    let closed = false;
    stream.onAbort(() => {
      closed = true;
    });
    while (!closed) {
      const { events, next } = readEvents(job.dir, offset);
      offset = next;
      for (const e of events) await stream.writeSSE({ event: 'event', data: JSON.stringify(e) });
      const st = getJob(job.id);
      const snap = JSON.stringify(st);
      if (snap !== lastStatus) {
        lastStatus = snap;
        await stream.writeSSE({ event: 'status', data: snap });
      }
      if (st.state !== 'running' || !st.alive) quietTicks = events.length ? 0 : quietTicks + 1;
      if (quietTicks > 3) {
        await stream.writeSSE({ event: 'end', data: st.state });
        break;
      }
      await stream.sleep(600);
    }
  });
});

// ---------- git ----------
app.get('/branches', async (c) => {
  const dir = runDirOf(c.req.query('ws') ?? '', c.req.query('run') ?? '');
  const branch = c.req.query('branch') ?? '';
  if (!/^[\w./-]+$/.test(branch)) throw new HttpError(400, 'Bad branch');
  const base = c.req.query('base');
  const info = readRun(dir);
  if (!info.repo_path) throw new HttpError(409, 'Run has no repository');
  return c.json(await branchInfo(info.repo_path, branch, base && /^[\w./-]+$/.test(base) ? base : null));
});

app.get('/health', (c) => c.json({ ok: true, repo: REPO_ROOT }));
