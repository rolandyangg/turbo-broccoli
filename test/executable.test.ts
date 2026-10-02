import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCodexExecutable, codexProcessError } from '../src/llm/executable.js';
import { assertExplorersSucceeded } from '../src/explore/run.js';
afterEach(() => vi.unstubAllEnvs());
describe('Codex CLI discovery and startup failures', () => {
  it('finds the desktop CLI with a GUI PATH, and prefers a PATH executable', () => {
    vi.stubEnv('BUGBASH_CODEX_BIN', '');
    const dir = mkdtempSync(join(tmpdir(), 'bb-codex-bin-')); const bundled = join(dir, 'bundled');
    writeFileSync(bundled, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    expect(resolveCodexExecutable({ path: '/usr/bin:/bin', bundledPaths: [bundled] })).toBe(bundled);
    const cli = join(dir, 'codex'); writeFileSync(cli, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    expect(resolveCodexExecutable({ path: dir, bundledPaths: [bundled] })).toBe(cli);
    expect(resolveCodexExecutable({ override: bundled, path: dir })).toBe(bundled);
  });
  it('reports missing/non-executable binaries explicitly', () => {
    vi.stubEnv('BUGBASH_CODEX_BIN', '');
    expect(() => resolveCodexExecutable({ path: '', bundledPaths: [] })).toThrow('Codex CLI was not found');
    expect(() => resolveCodexExecutable({ override: '/missing/codex' })).toThrow('BUGBASH_CODEX_BIN');
  });
  it('preserves ENOENT instead of reporting undefined exit code and empty stderr', () => {
    expect(codexProcessError({ code: 'ENOENT', originalMessage: 'spawn codex ENOENT', stderr: '' })).toBe('Codex ENOENT: spawn codex ENOENT');
    expect(codexProcessError({ exitCode: 2, stderr: 'unrecognized argument' })).toContain('unrecognized argument');
    expect(codexProcessError({ signal: 'SIGTERM' })).toContain('SIGTERM');
  });
});
describe('failed exploration status', () => {
  it('fails when all agents failed, while allowing a completed no-finding session', () => {
    const failed = { id: 's-001', status: 'failed' as const, result: { ok: false, toolCalls: 0, durationMs: 1, error: 'Codex ENOENT', summary: '' } };
    expect(() => assertExplorersSucceeded([])).toThrow('No explorer sessions completed');
    expect(() => assertExplorersSucceeded([failed])).toThrow('All 1 explorer sessions failed');
    expect(() => assertExplorersSucceeded([failed, { ...failed, id: 's-002', status: 'done' }])).not.toThrow();
  });
  it('reports the CLI job as failed and skips triage when every explorer exits before using tools', async () => {
    const { execa } = await import('execa');
    const dir = mkdtempSync(join(tmpdir(), 'bb-failed-run-'));
    const cli = join(dir, 'codex');
    writeFileSync(cli, `#!${process.execPath}\nprocess.stderr.write('startup blocked'); process.exit(2);`, { mode: 0o755 });
    const config = join(dir, 'config.json');
    writeFileSync(config, JSON.stringify({ provider: 'codex', lead: false, codeIntel: false, budgetSessions: 1, personas: ['everyday-user'], personaSessions: {}, browsers: ['chromium'], retrospective: false }));
    const out = join(dir, 'workspace');
    const r = await execa(process.execPath, ['bin/bugbash.js', 'explore', 'fixtures/buggy-site', '--out', out, '--config', config, '--then-triage'], { cwd: process.cwd(), reject: false, env: { BUGBASH_CODEX_BIN: cli, BUGBASH_HOME: join(dir, 'home'), BUGBASH_JOB_DIR: join(dir, 'jobs'), BUGBASH_PROVIDER: '', BUGBASH_MODEL: '', BUGBASH_MODEL_SELECTION: '', BUGBASH_INBOX: '' }, timeout: 30000 });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('All 1 explorer sessions failed');
    expect(r.stderr).toContain('startup blocked');
    const job = readdirSync(join(dir, 'jobs')).find(name => name.startsWith('explore-'))!;
    expect(JSON.parse(readFileSync(join(dir, 'jobs', job, 'status.json'), 'utf8'))).toMatchObject({ state: 'failed', error: expect.stringContaining('startup blocked') });
    const run = readdirSync(join(out, 'runs'))[0];
    expect(readdirSync(join(out, 'runs', run))).not.toContain('findings.json');
  }, 40000);

});
