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
process.env.BUGBASH_PRESETS_FILE = join(root, 'presets.json');
process.env.BUGBASH_HOME = join(root, 'home');

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

  it('serves the launcher catalog and manages presets', async () => {
    const cat = await (await get('/catalog')).json();
    expect(cat.personas.find((p: { id: string }) => p.id === 'low-vision-user').enabledByDefault).toBe(false);
    expect(cat.devices.length).toBeGreaterThan(8);
    expect(cat.strategies.some((s: { id: string }) => s.id === 'size.devices')).toBe(true);
    const json = (method: string, path: string, body?: unknown) => app.request(`/api${path}`, { method, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json' } });
    const saved = await (await json('POST', '/presets', { name: 'Night shift', config: { personas: ['phone-user'], budgetSessions: 3 } })).json();
    expect(saved.id).toBe('night-shift');
    const list = await (await get('/presets')).json();
    expect(list.default).toBe('standard');
    expect(list.presets.map((p: { id: string }) => p.id)).toContain('night-shift');
    expect((await json('POST', '/presets', { name: 'bad', config: { budgetSessions: 'lots' } })).status).toBe(400);
    expect((await json('DELETE', '/presets/standard')).status).toBe(400);
    expect((await (await json('DELETE', '/presets/night-shift')).json()).deleted).toBe(true);
  });

  it('validates bug bash launches before starting anything', async () => {
    const json = (body: unknown) => app.request('/api/explore', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    expect((await json({ target: '' })).status).toBe(400);
    expect((await json({ target: 'http://x.test', preset: 'nope' })).status).toBe(400);
    expect((await json({ target: 'http://x.test', config: { parallel: 0 } })).status).toBe(400);
  });

  it('reports agent cost, tool timing and explorer rows for a run, and totals for all runs', async () => {
    const run2 = '2026-01-02T00-00-00Z';
    const dir = join(ws, 'runs', run2);
    mkdirSync(join(dir, 'sessions'), { recursive: true });
    mkdirSync(join(dir, 'transcripts'), { recursive: true });
    writeFileSync(join(dir, 'run.json'), JSON.stringify({ run_id: run2, target: 'fixtures/x', base_url: 'http://127.0.0.1:1', target_kind: 'static', repo_path: null, workspace: ws, started_at: '2026-01-02T00:00:00Z', ended_at: '2026-01-02T00:05:00Z', head_commit: null, config: {}, stop_reason: 'test', lead_decisions: [], jobs: [], stages: {} }));
    writeFileSync(join(dir, 'campaign.json'), JSON.stringify({ jobs: [{ id: 's-001', persona: 'everyday-user', browser: 'chromium', device: null, goal: 'look around', status: 'done', started_at: '2026-01-02T00:00:10Z', ended_at: '2026-01-02T00:01:10Z', tool_calls: 3 }] }));
    const result = (cost: number) => JSON.stringify({ type: 'result', total_cost_usd: cost, duration_ms: 60000, duration_api_ms: 30000, num_turns: 4, usage: { input_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50, output_tokens: 200 } });
    writeFileSync(join(dir, 'transcripts', 's-001.jsonl'), JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__browser__click' }] } }) + '\n' + result(0.5) + '\n');
    writeFileSync(join(dir, 'transcripts', 'lead.jsonl'), result(0.25) + '\n');
    for (const [name, ms, ok, blocked] of [['click', 10, true, undefined], ['click', 30, true, undefined], ['resize', 1, false, 'selection']] as const)
      appendFileSync(join(dir, 'sessions', 's-001.jsonl'), JSON.stringify({ at: 'now', kind: 'tool', name, ms, ok, ...(blocked ? { blocked, error: 'refused' } : {}) }) + '\n');

    const d = await (await get(`/agents?ws=${wsId}&run=${run2}`)).json();
    expect(d.scope).toBe('run');
    expect(d.stats.kpis.cost_usd).toBeCloseTo(0.75);
    expect(d.stats.kpis.tokens).toBe(2 * 1350);
    expect(d.stats.phases.find((p: { phase: string }) => p.phase === 'lead').cost_usd).toBeCloseTo(0.25);
    expect(d.stats.explorers).toHaveLength(1);
    expect(d.stats.explorers[0]).toMatchObject({ id: 's-001', persona: 'everyday-user', browser: 'chromium' });
    expect(d.stats.tools_timed).toBe(true);
    const click = d.stats.tools.find((t: { name: string }) => t.name === 'click');
    expect(click).toMatchObject({ calls: 2, errors: 0, p95_ms: 30 });
    const resize = d.stats.tools.find((t: { name: string }) => t.name === 'resize');
    expect(resize).toMatchObject({ calls: 1, errors: 0, blocked: 1 });
    expect(d.stats.reliability.selection_refusals).toBe(1);

    const all = await (await get('/agents')).json();
    expect(all.scope).toBe('all');
    expect(all.runs.map((r: { run: string }) => r.run)).toContain(run2);
    expect(all.runs.find((r: { run: string }) => r.run === run2).cost_usd).toBeCloseTo(0.75);
    expect(all.totals.cost_usd).toBeGreaterThanOrEqual(0.75);
    expect((await get(`/agents?ws=${wsId}&run=nope`)).status).toBe(404);
  });

  it('lists improvement proposals and applies approve / edit / reject decisions', async () => {
    const { addProposals, backlog } = await import('../../src/learn/proposals.ts');
    const { readFileSync, existsSync } = await import('node:fs');
    const { added } = addProposals(ws, RUN, 'retro', [
      { kind: 'lesson', title: 'Open the plan modal before resizing', body: 'BUG-07 only shows with it open.' },
      { kind: 'tweak', title: 'Show known findings in explorer briefs', body: '33% duplicates', tweak: { target: 'explorer-prompt', change: 'list known bugs' } },
      { kind: 'lesson', title: 'Something wrong', body: 'nope' },
    ]);
    const ov = await (await get('/improvements')).json();
    expect(ov.pending).toBeGreaterThanOrEqual(3);
    expect(ov.runs.find((r: { run: string }) => r.run === RUN).proposals).toHaveLength(3);

    const post = (id: string, body: unknown) => app.request(`/api/improvements/${wsId}/${RUN}/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const a = await post(added[0].id, { action: 'approve', body: 'Click "Compare plans" first, then resize.' });
    expect(a.status).toBe(200);
    expect((await a.json()).proposal).toMatchObject({ status: 'approved', edited: true });
    expect(readFileSync(join(ws, 'memory', 'lessons.md'), 'utf8')).toMatch(/Compare plans/);
    expect((await post(added[1].id, { action: 'approve' })).status).toBe(200);
    expect(backlog(ws).map((b) => b.title)).toContain('Show known findings in explorer briefs');
    expect((await post(added[2].id, { action: 'reject', note: 'wrong' })).status).toBe(200);
    expect(existsSync(join(ws, 'improvements', 'rejected.json'))).toBe(true);
    expect((await post(added[2].id, { action: 'approve' })).status).toBe(409); // already decided
    expect((await post('P-nope-99', { action: 'approve' })).status).toBe(404);
    expect((await post(added[0].id, { action: 'delete' })).status).toBe(400);

    const impl = (id: string, body: unknown) => app.request(`/api/backlog/${wsId}/${id}/implement`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await impl('B-1', { pr: true })).status).toBe(400); // pushing needs explicit confirmation
    expect((await impl('B-99', {})).status).toBe(404);
    expect((await impl('../x', {})).status).toBe(404);
  });

  it('compares two triaged runs by fingerprint', async () => {
    const { Finding, SCHEMA_VERSION } = await import('../../src/store/schema.ts');
    const mk = (id: string, fingerprint: string, extra: Record<string, unknown> = {}) =>
      Finding.parse({ id, fingerprint, type: 'overlap', title: `Bug ${fingerprint}`, confidence: 0.9, page: '/', element: { selector: '.x', text: null, bbox: null, signature: null }, reproduction: { environment: { browser: 'chromium', viewport: { width: 700, height: 900 }, variant: {} } }, ...extra });
    const write = (run: string, findings: unknown[]) => {
      const dir = join(ws, 'runs', run);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'run.json'), JSON.stringify({ run_id: run, target: 'fixtures/x', base_url: 'http://127.0.0.1:1', target_kind: 'static', repo_path: null, workspace: ws, started_at: run.replace(/T(\d\d)-(\d\d)-(\d\d)Z/, 'T$1:$2:$3Z'), ended_at: null, head_commit: null, config: {}, stop_reason: 'test', lead_decisions: [], jobs: [], stages: {} }));
      writeFileSync(join(dir, 'findings.json'), JSON.stringify({ schemaVersion: SCHEMA_VERSION, run_id: run, target: 'fixtures/x', generated_at: 'now', groups: [{ id: 'RC-001', summary: 'g', component: null, css_rule: null, files: [], fix_plan: '', confidence: 0.5, status_rollup: {}, findings }] }));
    };
    write('2026-03-01T00-00-00Z', [mk('BB-0001', 'same', { severity: 'minor' }), mk('BB-0002', 'gone'), mk('BB-0003', 'was-fixed', { status: 'fixed' })]);
    write('2026-03-02T00-00-00Z', [mk('BB-0001', 'same', { severity: 'major' }), mk('BB-0002', 'brand-new'), mk('BB-0003', 'was-fixed')]);
    const d = await (await get(`/compare?a=${wsId}/2026-03-01T00-00-00Z&b=${wsId}/2026-03-02T00-00-00Z`)).json();
    expect(d.counts).toMatchObject({ 'still-open': 1, new: 1, regressed: 1 });
    expect(d.counts['not-found'] + d.counts['not-tested']).toBe(1);
    const same = d.entries.find((e: { fingerprint: string }) => e.fingerprint === 'same');
    expect(same.severity_change).toEqual({ from: 'minor', to: 'major', direction: 'worse' });
    expect(same.group).toMatchObject({ id: 'RC-001', side: 'b' });
    expect((await get(`/compare?a=${wsId}/2026-03-01T00-00-00Z`)).status).toBe(400);
  });

  it('saves notification settings, masks the Slack webhook, and keeps an inbox', async () => {
    const put = (body: unknown) => app.request('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const post = (p: string, body: unknown) => app.request(`/api${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await (await get('/settings')).json()).channels).toEqual({ macos: true, inbox: true, slack: false });
    expect((await put({ slack_webhook: 'https://evil.example.com/x' })).status).toBe(400);
    const hook = 'https://hooks.slack.com/services/T000/B000/abcdefghijklmnop';
    const saved = await (await put({ slack_webhook: hook, channels: { macos: false }, events: { proposals: false } })).json();
    expect(saved.slack_webhook).toBeNull();
    expect(saved.slack_webhook_set).toBe(true);
    expect(saved.slack_webhook_hint).not.toContain('abcdefghijklmnop');
    expect(saved.channels.macos).toBe(false);
    expect(saved.events.proposals).toBe(false);
    expect((await (await put({ web_url: 'http://localhost:9999' })).json()).slack_webhook_set).toBe(true); // kept when omitted
    expect((await (await put({ slack_webhook: null })).json()).slack_webhook_set).toBe(false);

    process.env.BUGBASH_NOTIFY_TEST = '1';
    try {
      expect(await (await post('/settings/test', { channel: 'inbox' })).json()).toEqual({ channel: 'inbox', result: 'sent' });
      const { notify } = await import('../../src/notify/notify.ts');
      await notify({ event: 'proposals', title: 'muted by settings', body: '' }); // proposals turned off above
      await notify({ event: 'failure', level: 'error', title: 'Fix failed', body: 'boom', path: '/jobs/x' }, { only: ['inbox'] });
    } finally {
      delete process.env.BUGBASH_NOTIFY_TEST;
    }
    const box = await (await get('/notifications')).json();
    expect(box.items.map((n: { title: string }) => n.title)).toEqual(['Fix failed', 'Test notification']);
    expect(box.unread).toBe(2);
    expect((await (await post('/notifications/read', { ids: [box.items[0].id] })).json()).marked).toBe(1);
    expect((await (await get('/notifications')).json()).unread).toBe(1);
    await post('/notifications/read', { all: true });
    expect((await (await get('/notifications')).json()).unread).toBe(0);
    expect((await post('/settings/test', { channel: 'email' })).status).toBe(400);
  });
});
