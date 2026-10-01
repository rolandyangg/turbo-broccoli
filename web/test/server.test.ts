import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolated workspace + jobs dir, configured before the server modules load.
const root = mkdtempSync(join(tmpdir(), 'bbweb-'));
const ws = join(root, 'ws');
const jobsDir = join(root, 'web-jobs');
process.env.BUGBASH_WORKSPACES = ws;
process.env.BUGBASH_WEB_JOBS = jobsDir;

const RUN = '2026-01-01T00-00-00Z';
let app: typeof import('../server/app.ts').app;
let wsId: string;

beforeAll(async () => {
  const { Finding, SCHEMA_VERSION } = await import('../../src/store/schema.ts');
  const run = join(ws, 'runs', RUN);
  mkdirSync(join(run, 'videos'), { recursive: true });
  mkdirSync(join(ws, 'memory'), { recursive: true });
  writeFileSync(join(ws, 'memory', 'secret.txt'), 'nope');
  writeFileSync(join(run, 'videos', 'BB-0001.mp4'), Buffer.alloc(5000, 7));
  writeFileSync(join(run, 'report.html'), '<script>alert(1)</script>');
  writeFileSync(join(run, 'run.json'), JSON.stringify({ run_id: RUN, target: 'fixtures/x', base_url: 'http://127.0.0.1:1', target_kind: 'static', repo_path: null, workspace: ws, started_at: '2026-01-01T00:00:00Z', ended_at: null, head_commit: null, config: {}, stop_reason: 'test', lead_decisions: [], jobs: [], stages: {} }));
  const f = Finding.parse({ id: 'BB-0001', fingerprint: 'fp', type: 'overlap', title: 'Nav overlaps logo', confidence: 0.9, page: '/', element: { selector: '.logo', text: null, bbox: null, signature: null }, reproduction: { environment: { browser: 'chromium', viewport: { width: 700, height: 900 }, variant: {} } }, video: { mp4: 'videos/BB-0001.mp4', gif: null, webm: null, filmstrip: null, trace: null, bug_at_ms: 1200, chapters: [{ t_ms: 100, step_index: 0, label: 'Step 1: Open /', kind: 'step' }] } });
  writeFileSync(join(run, 'findings.json'), JSON.stringify({ schemaVersion: SCHEMA_VERSION, run_id: RUN, target: 'fixtures/x', generated_at: 'now', groups: [{ id: 'RC-001', summary: 'nav', component: null, css_rule: null, files: [], fix_plan: '', confidence: 0.5, status_rollup: {}, findings: [f] }] }));
  ({ app } = await import('../server/app.ts'));
  const { wsId: id, initWorkspaces } = await import('../server/workspaces.ts');
  initWorkspaces([]);
  wsId = id(ws);
});

const get = (p: string, h: Record<string, string> = {}) => app.request(`/api${p}`, { headers: h });

describe('bugbash web API', () => {
  it('lists the run with finding counts', async () => {
    const runs = await (await get('/runs')).json();
    const r = runs.find((x: { run: string }) => x.run === RUN);
    expect(r).toBeTruthy();
    expect(r.counts.active).toBe(1);
    expect(r.counts.with_video).toBe(1);
  });

  it('returns a bug with its group and chapters', async () => {
    const d = await (await get(`/runs/${wsId}/${RUN}/bugs/BB-0001`)).json();
    expect(d.finding.video.chapters[0].label).toBe('Step 1: Open /');
    expect(d.group.id).toBe('RC-001');
  });

  it('serves video byte ranges (206) for seeking', async () => {
    const res = await get(`/runs/${wsId}/${RUN}/files/videos/BB-0001.mp4`, { range: 'bytes=100-199' });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 100-199/5000');
    expect((await res.arrayBuffer()).byteLength).toBe(100);
  });

  it('refuses paths outside the run directory', async () => {
    expect((await get(`/runs/${wsId}/${RUN}/files/..%2F..%2Fmemory%2Fsecret.txt`)).status).toBe(403);
    expect((await get(`/runs/${wsId}/${RUN}/files/..%2Frun.json`)).status).toBe(403);
    expect((await get(`/runs/nope/${RUN}`)).status).toBe(404);
  });

  it('never serves run HTML as HTML', async () => {
    const res = await get(`/runs/${wsId}/${RUN}/files/report.html`);
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
  });

  it('rejects fixes without a repo, bad ids, and PRs without push confirmation', async () => {
    const post = (body: unknown) => app.request(`/api/runs/${wsId}/${RUN}/fix`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    expect((await post({ ids: ['x; rm -rf /'] })).status).toBe(400);
    expect((await post({ ids: ['BB-0001'], pr: true })).status).toBe(400);
    const r = await post({ ids: ['BB-0001'] });
    expect(r.status).toBe(409); // no repo_path on this run
  });

  it('streams job events over SSE as they are appended', async () => {
    const dir = join(jobsDir, 'fix-test-1');
    mkdirSync(dir, { recursive: true });
    const status = { id: 'fix-test-1', kind: 'fix', state: 'running', stage: 'resolve', pid: process.pid, run_dir: null, finding_ids: ['BB-0001'], scope: 'BB-0001', branch: null, base: null, worktree: null, pr_url: null, verified: null, also_fixed: [], options: {}, started_at: new Date().toISOString(), updated_at: '', ended_at: null, error: null, summary: null };
    writeFileSync(join(dir, 'status.json'), JSON.stringify(status));
    appendFileSync(join(dir, 'events.jsonl'), JSON.stringify({ t: 'x', stage: 'resolve', level: 'info', msg: 'first' }) + '\n');
    const res = await get('/jobs/fix-test-1/events');
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = '';
    const readUntil = async (needle: string) => {
      const deadline = Date.now() + 8000;
      while (!text.includes(needle) && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        text += dec.decode(value);
      }
      return text.includes(needle);
    };
    expect(await readUntil('first')).toBe(true);
    appendFileSync(join(dir, 'events.jsonl'), JSON.stringify({ t: 'y', stage: 'commit', level: 'success', msg: 'second' }) + '\n');
    expect(await readUntil('second')).toBe(true);
    writeFileSync(join(dir, 'status.json'), JSON.stringify({ ...status, state: 'succeeded', stage: 'done' }));
    expect(await readUntil('event: end')).toBe(true);
    await reader.cancel();
  });

  it('scopes the dashboard to one run and lists runs for the filter', async () => {
    const all = await (await get('/dashboard')).json();
    expect(all.scope).toBeNull();
    expect(all.runs.some((r: { run: string }) => r.run === RUN)).toBe(true);
    const one = await (await get(`/dashboard?ws=${wsId}&run=${RUN}`)).json();
    expect(one.scope.run).toBe(RUN);
    expect(one.kpis.active).toBe(1);
    expect(one.kpis.targets).toBe(1);
    expect((await get(`/dashboard?ws=${wsId}&run=nope`)).status).toBe(404);
  });

  it('renames a run without changing its id, and validates input', async () => {
    const post = (body: unknown) => app.request(`/api/runs/${wsId}/${RUN}/rename`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    const r = await (await post({ name: '  Nightly\n  pricing check  ' })).json();
    expect(r).toEqual({ run: RUN, name: 'Nightly pricing check' });
    const runs = await (await get('/runs')).json();
    expect(runs.find((x: { run: string }) => x.run === RUN).name).toBe('Nightly pricing check');
    expect((await post({ name: 42 })).status).toBe(400);
    expect((await (await post({ name: null })).json()).name).toBeNull();
  });
});
