import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readRun, readFindings, findById, renameRun } from '../../src/store/store.ts';
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
  const b = await c.req.json<{ ids: string[]; pr?: boolean; draft?: boolean; base?: string; maxAttempts?: number; keepWorktree?: boolean; prAssets?: boolean; confirmPush?: boolean }>();
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
  if (b.prAssets === false) args.push('--no-pr-assets');
  return c.json(launchJob('fix', args, { run_dir: dir, finding_ids: ids, scope: ids.join(','), options: { pr: !!b.pr, draft: b.draft !== false, base: b.base ?? null } }), 202);
});

app.post('/runs/:ws/:run/bugs/:id/reproduce', async (c) => {
  const dir = runDirOf(c.req.param('ws'), c.req.param('run'));
  const id = c.req.param('id').toUpperCase();
  if (!/^BB-\d{3,5}$/.test(id)) throw new HttpError(400, 'Bad finding id');
  findFinding(dir, id);
  const b = await c.req.json<{ mode?: string; slow?: boolean; browser?: string; guardrails?: boolean }>().catch(() => ({}) as { mode?: string; slow?: boolean; browser?: string; guardrails?: boolean });
  const args = ['reproduce', id, '--run', dir, '--mode', b.mode === 'start' ? 'start' : 'full'];
  if (b.slow) args.push('--slow');
  if (b.browser && ['chromium', 'webkit', 'firefox'].includes(b.browser)) args.push('--browser', b.browser);
  if (b.guardrails === false) args.push('--no-guardrails');
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
app.get('/jobs/:id', (c) => c.json(getJob(c.req.param('id'))));
app.post('/jobs/:id/cancel', (c) => c.json(cancelJob(c.req.param('id'))));

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
