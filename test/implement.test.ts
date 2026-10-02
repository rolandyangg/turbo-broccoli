import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { implementBacklogItems } from '../src/learn/implement.js';
import { backlog } from '../src/learn/proposals.js';

const git = (cwd: string, ...args: string[]) => execa('git', args, { cwd });

/** A throwaway repo on main, a workspace with backlog items B-1..B-n, and a scripted agent. */
async function setup(n: number) {
  const root = mkdtempSync(join(tmpdir(), 'bb-improve-'));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  await git(repo, 'init', '-q', '-b', 'main');
  await git(repo, 'config', 'user.email', 't@example.com');
  await git(repo, 'config', 'user.name', 'test');
  writeFileSync(join(repo, 'list.txt'), 'start\n');
  writeFileSync(join(repo, 'notes.txt'), 'notes\n');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-qm', 'init');
  const ws = join(root, 'ws');
  mkdirSync(join(ws, 'improvements'), { recursive: true });
  const items = Array.from({ length: n }, (_, i) => ({ id: `B-${i + 1}`, proposal_id: `P-${i + 1}`, run: 'run', kind: 'tweak', title: `Item ${i + 1}`, body: 'b', detector: null, tweak: { target: 'config', change: 'y' }, status: 'open', branch: null, job_id: null, pr_url: null, error: null, created_at: 'now' }));
  writeFileSync(join(ws, 'improvements', 'backlog.json'), JSON.stringify(items));
  return { repo, ws };
}

describe('implementing improvements', () => {
  it('runs items in parallel, merges each into main, and has the agent resolve conflicts', async () => {
    const { repo, ws } = await setup(3);
    let running = 0;
    let peak = 0;
    const r = await implementBacklogItems({
      ws,
      ids: ['B-1', 'B-2', 'B-3'],
      repoRoot: repo,
      parallel: 3,
      pr: false,
      maxAttempts: 1,
      keepWorktree: false,
      log: () => {},
      // Every item appends a line to the same file, so the second and third to merge conflict.
      checks: [['node', '-e', "process.exit(require('fs').readFileSync('list.txt','utf8').includes('<<<') ? 1 : 0)"]],
      agent: async ({ prompt, cwd }) => {
        const id = prompt.match(/backlog item (B-\d+)/)![1];
        if (prompt.includes('# Resolve merge conflicts')) {
          const lines = readFileSync(join(cwd, 'list.txt'), 'utf8').split('\n').filter((l) => l && !/^(<<<<<<<|=======|>>>>>>>)/.test(l));
          writeFileSync(join(cwd, 'list.txt'), [...new Set(lines)].join('\n') + '\n');
          return { ok: true, text: 'resolved' };
        }
        running++;
        peak = Math.max(peak, running);
        await new Promise((res) => setTimeout(res, 300));
        writeFileSync(join(cwd, 'list.txt'), `start\n${id}\n`);
        running--;
        return { ok: true, text: `added ${id}` };
      },
    });
    expect(peak).toBe(3);
    expect(r.merged.map((x) => x.id).sort()).toEqual(['B-1', 'B-2', 'B-3']);
    const list = readFileSync(join(repo, 'list.txt'), 'utf8');
    for (const id of ['B-1', 'B-2', 'B-3']) expect(list).toContain(id);
    expect(list).not.toContain('<<<');
    expect((await git(repo, 'log', '--format=%s', 'main')).stdout.split('\n')).toHaveLength(4); // init + one commit per item
    expect((await git(repo, 'branch', '--list', 'improve/*')).stdout.trim()).toBe(''); // merged branches are tidied up
    expect(backlog(ws).map((b) => b.status)).toEqual(['merged', 'merged', 'merged']);
  }, 60_000);

  it('drops an item whose checks fail and keeps one on its branch when your edits are in the way', async () => {
    const { repo, ws } = await setup(2);
    writeFileSync(join(repo, 'notes.txt'), 'my uncommitted edit\n'); // B-2 changes this file
    const r = await implementBacklogItems({
      ws,
      ids: ['B-1', 'B-2'],
      repoRoot: repo,
      parallel: 2,
      pr: false,
      maxAttempts: 1,
      keepWorktree: false,
      log: () => {},
      checks: [['node', '-e', "process.exit(require('fs').existsSync('broken') ? 1 : 0)"]],
      agent: async ({ prompt, cwd }) => {
        if (prompt.includes('B-1')) writeFileSync(join(cwd, 'broken'), 'x');
        else writeFileSync(join(cwd, 'notes.txt'), 'changed by B-2\n');
        return { ok: true, text: 'done' };
      },
    });
    const byId = Object.fromEntries(r.results.map((x) => [x.id, x]));
    expect(byId['B-1'].outcome).toBe('failed');
    expect(byId['B-2'].outcome).toBe('branch');
    expect(byId['B-2'].issue).toMatch(/uncommitted edits/);
    expect(readFileSync(join(repo, 'notes.txt'), 'utf8')).toBe('my uncommitted edit\n'); // your file is untouched
    expect((await git(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${byId['B-2'].branch}`)).exitCode).toBe(0);
    const items = backlog(ws);
    expect(items.find((b) => b.id === 'B-1')!.status).toBe('failed');
    expect(items.find((b) => b.id === 'B-2')!).toMatchObject({ status: 'implemented', error: expect.stringContaining('Not merged') });
    expect(existsSync(join(repo, 'broken'))).toBe(false);
  }, 60_000);
});
