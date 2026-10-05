import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

vi.mock('../server/jobs.ts', () => ({ listJobs: () => [] }));
import { Finding, SCHEMA_VERSION } from '../../src/store/schema.ts';
import { attachment, attachCommands, shellQuote } from '../server/attach.ts';

const root = mkdtempSync(join(tmpdir(), 'bb-attach-'));
const repo = join(root, 'repo');
const run = join(root, 'run');
mkdirSync(repo); mkdirSync(run);
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
git('init'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'Initial');
git('branch', 'bugbash/test');
writeFileSync(join(run, 'run.json'), JSON.stringify({ repo_path: repo }));
function saveFinding(id: string, branch: string) {
  const finding = Finding.parse({ id, fingerprint: id, type: 'overlap', title: 'Test bug', confidence: 0.9, page: '/', element: { selector: '.test', text: null, bbox: null, signature: null }, reproduction: { environment: { browser: 'chromium', viewport: { width: 700, height: 900 }, variant: {} } }, fix: { branch, base: 'master', pr_url: null, verified: false, fixed_by: 'test', at: 'now' } });
  writeFileSync(join(run, 'findings.json'), JSON.stringify({ schemaVersion: SCHEMA_VERSION, run_id: 'run', target: 'test', generated_at: 'now', groups: [{ id: 'RC-001', summary: 'test', findings: [finding] }] }));
}
saveFinding('BB-001', 'bugbash/test');
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('session attachment', () => {
  it('creates a dedicated checkout and starts an interactive contextual session', async () => {
    const plan = await attachment(run, 'BB-001');
    expect(plan.commands).toContain('worktree add --');
    expect(plan.commands).toContain("git checkout 'bugbash/test'");
    expect(plan.commands).toContain('findings.json');
    expect(plan.commands).not.toContain('--resume');
    expect(plan.commands).not.toContain('--dangerously-skip-permissions');
    git('worktree', 'add', plan.worktree, plan.branch);
    const reused = await attachment(run, 'BB-001');
    expect(realpathSync(reused.worktree)).toBe(realpathSync(plan.worktree));
    expect(reused.commands).not.toContain('worktree add');
  });

  it('shell-quotes paths and prompt text without executing metacharacters', () => {
    const text = "a'b $(touch /tmp/nope) `whoami`\nnext";
    const out = execFileSync('/bin/sh', ['-c', `printf %s ${shellQuote(text)}`], { encoding: 'utf8' });
    expect(out).toBe(text);
    const commands = attachCommands('/repo', '/work tree', 'bugbash/test', '/run', 'BB-001', false);
    execFileSync('/bin/sh', ['-n', '-c', commands]);
    expect(commands).toContain("cd '/work tree' &&");
  });

  it('rejects a missing local branch', async () => {
    saveFinding('BB-002', 'bugbash/missing');
    await expect(attachment(run, 'BB-002')).rejects.toThrow('no longer available locally');
  });
});
