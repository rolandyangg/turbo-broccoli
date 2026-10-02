import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Finding } from '../../src/store/schema.ts';

vi.mock('execa', () => ({ execa: vi.fn() }));
vi.mock('../../src/fix/githubImages.ts', () => ({ uploadToGitHub: vi.fn() }));
vi.mock('../../src/fix/describe.ts', async (original) => ({ ...await original<typeof import('../../src/fix/describe.ts')>(), explainChanges: vi.fn() }));
vi.mock('../server/jobs.ts', () => ({ listJobs: vi.fn(), readEvents: vi.fn(() => ({ events: [] })) }));
vi.mock('../server/workspaces.ts', async (original) => ({ ...await original<typeof import('../server/workspaces.ts')>(), runDirOf: vi.fn() }));

import { execa } from 'execa';
import { uploadToGitHub } from '../../src/fix/githubImages.ts';
import { explainChanges } from '../../src/fix/describe.ts';
import { listJobs } from '../server/jobs.ts';
import { runDirOf } from '../server/workspaces.ts';
import { updatePrBody } from '../server/prBody.ts';

const url = 'https://github.com/example/app/pull/12';
let dir: string;
let finding: Finding;
let head = 'published';
let state = 'OPEN';
let dirty = '';
let failEdit = false;
let job: Record<string, unknown>;
function save() {
  writeFileSync(join(dir, 'findings.json'), JSON.stringify({ schemaVersion: 1, run_id: 'run', target: 'app', generated_at: 'now', groups: [{ id: 'RC-001', summary: 'Nav spacing', component: null, css_rule: null, files: [], fix_plan: '', confidence: 1, status_rollup: {}, findings: [finding] }] }));
}

beforeEach(() => {
  vi.clearAllMocks();
  dir = mkdtempSync(join(tmpdir(), 'bb-pr-body-'));
  mkdirSync(join(dir, 'evidence'));
  writeFileSync(join(dir, 'evidence/before.png'), 'before');
  writeFileSync(join(dir, 'evidence/latest.png'), 'latest');
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ run_id: 'run', target: 'app', workspace: dir, repo_path: dir, config: {} }));
  finding = Finding.parse({ id: 'BB-0001', fingerprint: 'nav', type: 'overlap', title: 'Nav overlap', confidence: 1, page: '/', screenshots: { annotated: 'evidence/before.png' }, reproduction: { environment: { browser: 'chromium', viewport: { width: 700, height: 900 }, variant: {} } }, fix: { branch: 'bugbash/nav', pr_url: url, verified: true, at: 'now', verification: { result: 'fixed', method: 'detector', checks: [{ browser: 'chromium', width: 700, height: 900, present: false, error: null }], at: '2026-10-01T12:00:00Z', after: { annotated: 'evidence/latest.png', crop: null, full: null, element_found: true } } } });
  save();
  head = 'published'; state = 'OPEN'; dirty = ''; failEdit = false;
  job = { id: 'verify-latest', branch: 'bugbash/nav', pr_url: url, options: {}, state: 'succeeded', stage: 'record', alive: false, dir, worktree: dir };
  vi.mocked(runDirOf).mockReturnValue(dir);
  vi.mocked(listJobs).mockImplementation(() => [{ ...job, kind: 'fix' }] as any);
  vi.mocked(uploadToGitHub).mockImplementation(async (_url, files) => new Map(files.map((f) => [f.name, `https://github.com/user-attachments/assets/new-${f.name}`])));
  vi.mocked(explainChanges).mockResolvedValue(null);
  vi.mocked(execa).mockImplementation((async (_command: unknown, args: unknown) => {
    const a = args as string[];
    if (a.includes('edit') && failEdit) throw new Error('GitHub edit failed');
    let stdout = '';
    if (a.includes('view')) stdout = JSON.stringify({ state, headRefName: 'bugbash/nav', headRefOid: 'published', files: [{ path: 'nav.css', additions: 2, deletions: 1 }] });
    if (a.includes('rev-parse')) stdout = head;
    if (a.includes('worktree')) stdout = `worktree ${dir}\nbranch refs/heads/bugbash/nav\n\n`;
    if (a.includes('status')) stdout = dirty;
    if (a.includes('--patch')) stdout = 'diff --git a/nav.css b/nav.css';
    return { stdout };
  }) as any);
});
const update = () => updatePrBody({ ws: 'ws', run: 'run', url });
const edits = () => vi.mocked(execa).mock.calls.filter(([, args]) => (args as string[]).includes('edit'));

describe('refresh PR body', () => {
  it('uses new saved screenshots/checks and the published diff without pushing or fixing', async () => {
    const result = await update();
    expect(result.images).toBe(2);
    expect(vi.mocked(uploadToGitHub).mock.calls[0][1][1].path).toBe(realpathSync(join(dir, 'evidence/latest.png')));
    const body = readFileSync(join(dir, 'fixes/bugbash__nav/pr-body.md'), 'utf8');
    expect(body).toContain('new-BB-0001-after.png');
    expect(body).toContain('700px ✓');
    expect(body).toContain('2026-10-01T12:00:00Z');
    expect(body).toContain('nav.css');
    expect(body).not.toContain('0 attempts');
    expect(edits()).toHaveLength(1);
    expect(vi.mocked(execa).mock.calls.some(([, a]) => (a as string[]).includes('push'))).toBe(false);
  });
  it('refreshes incomplete verification and records manual override only with explicit saved approval', async () => {
    finding.fix!.verified = false;
    finding.fix!.flags = ['BB-0001: Firefox verification did not complete'];
    finding.fix!.verification!.result = 'inconclusive';
    save();
    await update();
    let body = readFileSync(join(dir, 'fixes/bugbash__nav/pr-body.md'), 'utf8');
    expect(body).toContain('Firefox verification did not complete');
    expect(body).not.toContain('manual approval');
    job.options = { publishUnverified: true };
    await update();
    body = readFileSync(join(dir, 'fixes/bugbash__nav/pr-body.md'), 'utf8');
    expect(body).not.toContain('the user reports manually verifying the fix');
    expect(body).toContain('explicit manual approval by the user');
    expect(body).not.toContain('[!WARNING]');
    expect(body).toMatch(/^## Summary/);
    expect(body).toContain('### 🤖 Automated verification results');
    expect(body).toContain('Please see the results below.');
    expect(body.indexOf('Firefox verification did not complete')).toBeGreaterThan(body.indexOf('## Verification'));
  });
  it('adds manual verification only when explicitly confirmed on this update', async () => {
    await updatePrBody({ ws: 'ws', run: 'run', url, manuallyVerified: true });
    let body = readFileSync(join(dir, 'fixes/bugbash__nav/pr-body.md'), 'utf8');
    expect(body).toContain('✅ Manual verification: the user reports manually verifying the fix');
    expect(body.indexOf('Manual verification:')).toBeGreaterThan(body.indexOf('## Verification'));
    await update();
    body = readFileSync(join(dir, 'fixes/bugbash__nav/pr-body.md'), 'utf8');
    expect(body).not.toContain('Manual verification:');
    await expect(updatePrBody({ ws: 'ws', run: 'run', url, manuallyVerified: 'yes' as any })).rejects.toThrow('must be true or false');
  });
  it.each(['unpublished', 'dirty', 'running', 'closed', 'unknown'])('rejects %s before changing the body', async (reason) => {
    if (reason === 'unpublished') head = 'new-local';
    if (reason === 'dirty') dirty = ' M nav.css';
    if (reason === 'running') job.alive = true;
    if (reason === 'closed') state = 'CLOSED';
    await expect(reason === 'unknown' ? updatePrBody({ ws: 'ws', run: 'run', url: url.replace('/12', '/99') }) : update()).rejects.toThrow();
    expect(edits()).toHaveLength(0);
  });
  it('leaves the body unchanged when new evidence upload fails and allows retry', async () => {
    vi.mocked(uploadToGitHub).mockRejectedValueOnce(new Error('session signed out'));
    await expect(update()).rejects.toThrow('session signed out');
    expect(edits()).toHaveLength(0);
    await expect(update()).resolves.toMatchObject({ ok: true });
  });
  it('reports GitHub edit failures instead of claiming success', async () => {
    failEdit = true;
    await expect(update()).rejects.toThrow('GitHub edit failed');
  });
});
