import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FixVerification } from '../src/components/FixVerification.tsx';
import { bugFixStatus } from '../src/lib/bugFixStatus.ts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Finding, SCHEMA_VERSION } from '../../src/store/schema.ts';
import { readFindings, findById } from '../../src/store/store.ts';
import { candidateKey, manualReviewValid } from '../../src/fix/manualReview.ts';
import { verificationSection } from '../../src/fix/prBody.ts';
vi.mock('execa', () => ({ execa: vi.fn() }));
vi.mock('../server/jobs.ts', () => ({ listJobs: vi.fn(() => []), readEvents: vi.fn(() => ({ events: [] })) }));
import { execa } from 'execa';
import { saveManualReview } from '../server/manualReview.ts';
let dir: string;
let head: string;
let dirty: string;
const candidate = { page: '/home', width: 1280, type: 'overlap', selector: '.quote', message: 'Text overlaps', text: 'Quote', preview: null };
function saved() { return findById(readFindings(dir)!, 'BB-0094')!.finding; }
function write(f: Finding) {
  writeFileSync(join(dir, 'findings.json'), JSON.stringify({ schemaVersion: SCHEMA_VERSION, run_id: 'run', target: 'app', generated_at: 'now', groups: [{ id: 'RC-001', summary: 'Cards', confidence: .9, findings: [f] }] }));
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'manual-review-')); head = 'commit-a'; dirty = '';
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ run_id: 'run', workspace: dir, repo_path: dir, target: 'app', base_url: 'http://localhost:1', target_kind: 'repo', started_at: 'now', config: {} }));
  write(Finding.parse({ id: 'BB-0094', fingerprint: 'test', type: 'other', title: 'Mirrored cards', confidence: .9, page: '/home',
    reproduction: { environment: { browser: 'webkit', viewport: { width: 768, height: 1024 }, variant: {} } },
    fix: { branch: 'bugbash/cards', pr_url: null, verified: false, at: 'now', blocked: true,
      flags: ['BB-0094: verified only by a visual review (90% confident), not by a detector', '1 new layout problem(s) on the pages it touched'],
      verification: { result: 'fixed', method: 'visual-review', at: 'evidence-a', after: { annotated: 'after.png', crop: null, full: null, element_found: true }, regressions: [candidate] } } }));
  vi.mocked(execa).mockImplementation((async (_cmd: string, args: string[]) => ({ stdout: args[0] === 'rev-parse' ? head : args[0] === 'worktree' ? `worktree ${dir}\nbranch refs/heads/bugbash/cards\n` : dirty })) as never);
});
const dismiss = () => saveManualReview(dir, 'BB-0094', { evidenceAt: 'evidence-a', candidate: candidateKey(candidate), dismissed: true });
const confirm = () => saveManualReview(dir, 'BB-0094', { evidenceAt: 'evidence-a', confirm: true });
describe('manual verification approval', () => {
  it('requires every candidate to be dismissed and explicit manual confirmation', async () => {
    await expect(confirm()).rejects.toThrow('dismiss every');
    await dismiss();
    expect(saved().fix?.manual_review?.verified_at).toBeNull();
    await expect(saveManualReview(dir, 'BB-0094', { evidenceAt: 'evidence-a' })).rejects.toThrow('Explicit');
    await confirm();
    expect(manualReviewValid(saved(), head)).toBe(true);
    expect(saved().fix?.blocked).toBe(false);
    expect(saved().fix?.verified).toBe(false);
    expect(saved().fix?.flags).toHaveLength(2);
  });
  it('shows manually verified readiness and a separate Create PR action', async () => {
    await dismiss(); await confirm();
    const f = saved();
    expect(bugFixStatus(f)?.label).toBe('Ready for PR');
    const html = renderToStaticMarkup(createElement(FixVerification, { f, ws: 'ws', run: 'run', branch: f.fix!.branch,
      afterShot: null, running: false, prUrl: null, reproducing: false, onReproduceStarted: () => {}, manuallyVerified: true, regressions: [candidate] }));
    expect(html).toContain('manually verified');
    expect(html).toContain('Create PR');
    expect(html).toContain('Reopen candidate');
    expect(html).not.toContain('blocked: not published');
    expect(html).not.toContain('Publish anyway…');
  });
  it('allows visual-review-only approval without layout candidates', async () => {
    const f = saved(); f.fix!.verification!.regressions = []; f.fix!.flags = f.fix!.flags.slice(0, 1); write(f);
    await confirm();
    expect(manualReviewValid(saved(), head)).toBe(true);
  });
  it('allows manual review of BB-0036 when a visual verdict is fixed but a swipe check was inconclusive', async () => {
    const f = saved();
    f.fix!.verification!.regressions = [];
    f.fix!.verification!.checks = [{ browser: 'webkit (swipe in chromium)', width: 1280, height: 800, present: null, error: 'The element is not inside an open overlay' }];
    f.fix!.flags = ['BB-0036: verified only by a visual review (60% confident), not by a detector', 'BB-0036: some checks were inconclusive (webkit (swipe in chromium) 1280px)'];
    write(f);
    await confirm();
    expect(manualReviewValid(saved(), head)).toBe(true);
    expect(saved().fix!.verification!.checks[0].present).toBeNull();
    expect(saved().fix!.flags).toHaveLength(2);
  });
  it('reopening a candidate revokes approval', async () => {
    await dismiss(); await confirm();
    await saveManualReview(dir, 'BB-0094', { evidenceAt: 'evidence-a', candidate: candidateKey(candidate), dismissed: false });
    expect(manualReviewValid(saved(), head)).toBe(false);
    expect(saved().fix?.blocked).toBe(true);
  });
  it('invalidates approval for a new commit or new evidence', async () => {
    await dismiss(); await confirm();
    expect(manualReviewValid(saved(), 'commit-b')).toBe(false);
    head = 'commit-b';
    await expect(confirm()).rejects.toThrow('dismiss every');
    await expect(saveManualReview(dir, 'BB-0094', { evidenceAt: 'old', confirm: true })).rejects.toThrow('Verification changed');
  });
  it('rejects dirty worktrees and remaining or inconclusive original bugs', async () => {
    dirty = ' M component.tsx';
    await expect(dismiss()).rejects.toThrow('Commit changes');
    dirty = ''; await dismiss();
    const f = saved(); f.fix!.verification!.result = 'present'; write(f);
    await expect(confirm()).rejects.toThrow('original bug');
  });
  it('reports manual approval separately from the automatic outcomes in PRs', async () => {
    await dismiss(); await confirm();
    const text = verificationSection({ verified: false, flags: saved().fix!.flags, regressions: [candidate.message], attempts: 3, manualVerified: true, manualOverride: true }).join('\n');
    expect(text).toContain('Automatic verification was not fully complete');
    expect(text).toContain('user reports manually verifying');
    expect(text).toContain('explicit approval');
  });
});
