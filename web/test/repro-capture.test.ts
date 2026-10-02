import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { listenForCaptures, readCapture } from '../../src/repro/capture.ts';
import { Finding, SCHEMA_VERSION } from '../../src/store/schema.ts';

const root = mkdtempSync(join(tmpdir(), 'bb-capture-'));
const ws = join(root, 'ws');
const run = join(ws, 'runs', 'run');
const jobs = join(root, 'jobs');
const jobDir = join(jobs, 'reproduce-test');
process.env.BUGBASH_WORKSPACES = ws;
process.env.BUGBASH_WEB_JOBS = jobs;
process.env.BUGBASH_HOME = join(root, 'home');
let app: typeof import('../server/app.ts').app;
let browser: Browser;
let stop: () => void;
const post = (path: string) => app.request(`/api${path}`, { method: 'POST' });
const status = (branch: string | null = 'bugbash/fix', state = 'running') => writeFileSync(join(jobDir, 'status.json'), JSON.stringify({ id: 'reproduce-test', kind: 'reproduce', state, stage: 'ready', pid: process.pid, run_dir: run, finding_ids: ['BB-0001'], branch, started_at: 'now', options: {} }));
beforeAll(async () => {
  mkdirSync(run, { recursive: true }); mkdirSync(jobDir, { recursive: true });
  writeFileSync(join(run, 'run.json'), JSON.stringify({ run_id: 'run', workspace: ws, target: 'test', config: {} }));
  const finding = Finding.parse({ id: 'BB-0001', fingerprint: 'fp', type: 'overlap', title: 'Overlap', confidence: 1, page: '/', reproduction: { environment: { browser: 'chromium', viewport: { width: 700, height: 900 }, variant: {} } }, fix: { branch: 'bugbash/fix', pr_url: null, verified: false, at: 'now', flags: ['unverified'], blocked: true, verification: { result: 'present', method: 'detector', at: 'old', after: { annotated: 'shots/old.png', crop: null, full: null, element_found: true } } } });
  writeFileSync(join(run, 'findings.json'), JSON.stringify({ schemaVersion: SCHEMA_VERSION, run_id: 'run', target: 'test', generated_at: 'now', groups: [{ id: 'RC-001', summary: 'test', confidence: 1, findings: [finding] }] }));
  status(); writeFileSync(join(jobDir, 'events.jsonl'), JSON.stringify({ stage: 'ready' }) + '\n');
  ({ app } = await import('../server/app.ts'));
  const { initWorkspaces } = await import('../server/workspaces.ts'); initWorkspaces([]);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 700, height: 900 } });
  await page.setContent('<body style="background:white"><button>Original</button><div data-bugbash-overlay style="position:fixed;inset:0;background:red"></div></body>');
  // Simulate the person changing the current page after reproduction.
  await page.evaluate(() => { document.querySelector('button')!.textContent = 'Looks right'; });
  stop = listenForCaptures(page, run, jobDir, 'reproduce-test');
}, 20_000);
afterAll(async () => { stop?.(); await browser?.close(); rmSync(root, { recursive: true, force: true }); });

describe('manual reproduction screenshots', () => {
  it('captures the live viewport, saves a preview, and replaces only the chosen after evidence', async () => {
    const response = await post('/jobs/reproduce-test/capture'); expect(response.status).toBe(202);
    const { id } = await response.json();
    let capture: ReturnType<typeof readCapture> = null;
    for (let i = 0; i < 60 && !capture; i++) { await new Promise((r) => setTimeout(r, 100)); capture = readCapture(jobDir, id); }
    expect(capture).toMatchObject({ viewport: { width: 700, height: 900 } });
    if (!capture || 'error' in capture) throw new Error('No capture');
    const png = readFileSync(join(run, capture.path));
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect(png.readUInt32BE(16)).toBe(700); expect(png.readUInt32BE(20)).toBe(900);
    // Selection remains possible after closing the browser window.
    status('bugbash/fix', 'succeeded');
    expect((await post(`/jobs/reproduce-test/captures/${id}/replace-after`)).status).toBe(200);
    const f = JSON.parse(readFileSync(join(run, 'findings.json'), 'utf8')).groups[0].findings[0];
    expect(f.fix.manual_after.path).toBe(capture.path);
    expect(f.fix.verification.after.annotated).toBe('shots/old.png');
    expect(f.fix.verification.result).toBe('present'); expect(f.fix.verified).toBe(false); expect(f.fix.blocked).toBe(true); expect(f.fix.flags).toEqual(['unverified']);
    status('other-branch');
    expect((await post(`/jobs/reproduce-test/captures/${id}/replace-after`)).status).toBe(409);
    status();
  });
  it('rejects closed or original-version captures and invalid identifiers', async () => {
    status(null); expect((await post('/jobs/reproduce-test/capture')).status).toBe(409);
    status('bugbash/fix', 'succeeded'); expect((await post('/jobs/reproduce-test/capture')).status).toBe(409);
    expect((await post('/jobs/reproduce-test/captures/not-an-id/replace-after')).status).toBe(400);
    expect(readdirSync(join(jobDir, 'captures')).filter((n) => n.endsWith('.png'))).toEqual([]);
  });
});
