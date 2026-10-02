import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { backlog, updateBacklogItem, type BacklogItem } from '../../src/learn/proposals.ts';
import { ROOT } from '../../src/learn/implement.ts';
import { workspaces, HttpError } from './workspaces.ts';
import { listJobs } from './jobs.ts';
import { prStatus, type PrStatus } from './prs.ts';

const exec = promisify(execFile);

export interface ImprovementPr {
  url: string;
  repo: string;
  number: number | null;
  branch: string | null;
  items: { ws: string; id: string; title: string; kind: BacklogItem['kind']; status: BacklogItem['status'] }[];
  jobs: { id: string; state: string; started_at: string; summary: string | null }[];
  status: PrStatus | null;
  status_error: string | null;
  /** Commits on the PR beyond one per improvement item: usually local main commits that weren't on GitHub yet. */
  extra_commits: number;
  /** Why it can't be merged from here right now (null = it can). */
  blocked: string | null;
}

const repoOf = (url: string) => url.match(/github\.com\/([^/]+\/[^/]+)\/pull\//)?.[1] ?? '';

/** Pull requests opened by "Implement on a branch" (self-improvements of bugbash), with their backlog items and live state. */
export async function listImprovementPRs(fresh = false) {
  const rows = new Map<string, ImprovementPr>();
  const row = (url: string, branch: string | null) => {
    let r = rows.get(url);
    if (!r) rows.set(url, (r = { url, repo: repoOf(url), number: Number(url.match(/\/pull\/(\d+)/)?.[1]) || null, branch, items: [], jobs: [], status: null, status_error: null, extra_commits: 0, blocked: null }));
    if (!r.branch && branch) r.branch = branch;
    return r;
  };
  for (const w of workspaces())
    for (const b of backlog(w.path)) if (b.pr_url) row(b.pr_url, b.branch).items.push({ ws: w.id, id: b.id, title: b.title, kind: b.kind, status: b.status });
  for (const j of listJobs().filter((j) => j.kind === 'improve' && j.pr_url)) row(j.pr_url!, j.branch).jobs.push({ id: j.id, state: j.state, started_at: j.started_at, summary: j.summary ?? null });
  const list = [...rows.values()];
  await Promise.all(
    list.map(async (r) => {
      const s = await prStatus(r.url, fresh);
      r.status = s.status;
      r.status_error = s.error;
      r.extra_commits = s.status ? Math.max(0, s.status.commits - r.items.length) : 0;
      r.blocked = blockedReason(r);
      // Merged on GitHub directly: the backlog catches up.
      if (s.status?.state === 'MERGED') for (const it of r.items) if (it.status === 'implemented') it.status = setStatus(it, 'merged');
    }),
  );
  for (const r of list) r.jobs.sort((a, b) => b.started_at.localeCompare(a.started_at));
  list.sort((a, b) => String(b.status?.updatedAt ?? b.jobs[0]?.started_at ?? '').localeCompare(String(a.status?.updatedAt ?? a.jobs[0]?.started_at ?? '')));
  const n = (f: (r: ImprovementPr) => boolean) => list.filter(f).length;
  return { prs: list, counts: { total: list.length, open: n((r) => r.status?.state === 'OPEN'), merged: n((r) => r.status?.state === 'MERGED'), closed: n((r) => r.status?.state === 'CLOSED') } };
}

function setStatus(it: { ws: string; id: string }, status: BacklogItem['status']) {
  const w = workspaces().find((x) => x.id === it.ws);
  if (w) updateBacklogItem(w.path, it.id, { status });
  return status;
}

function blockedReason(r: ImprovementPr): string | null {
  const s = r.status;
  if (!s) return r.status_error ? `GitHub didn't answer: ${r.status_error}` : 'Unknown state';
  if (s.state !== 'OPEN') return `Already ${s.state.toLowerCase()}`;
  if (s.mergeable === 'CONFLICTING' || s.mergeStateStatus === 'DIRTY') return 'It conflicts with the base branch: resolve the conflicts first';
  if (s.checks.some((c) => /FAIL|ERROR|CANCELLED|TIMED_OUT/.test(c.state))) return 'Checks are failing';
  if (s.reviewDecision === 'CHANGES_REQUESTED') return 'A reviewer requested changes';
  if (s.mergeStateStatus === 'BLOCKED') return 'GitHub blocks merging (branch protection or required reviews)';
  return null;
}

async function find(url: string) {
  const { prs } = await listImprovementPRs(true);
  const r = prs.find((p) => p.url === url);
  if (!r) throw new HttpError(404, 'Not an improvement pull request opened by bugbash');
  return r;
}

const git = (args: string[]) => exec('git', args, { cwd: ROOT, timeout: 60_000 }).then(
  (r) => ({ ok: true, out: r.stdout.trim() }),
  (e) => ({ ok: false, out: String(e.stderr || e.message).trim() }),
);

/** Removes the improve worktree and the local and remote branch once the PR is merged or closed. */
async function cleanupBranch(branch: string | null, remote: boolean) {
  const notes: string[] = [];
  if (!branch?.startsWith('improve/')) return notes;
  const wt = await git(['worktree', 'list', '--porcelain']);
  const path = wt.out.split('\n\n').find((b) => b.includes(`branch refs/heads/${branch}`))?.match(/^worktree (.+)$/m)?.[1];
  if (path) notes.push((await git(['worktree', 'remove', '--force', path])).ok ? 'Removed its worktree' : `Couldn't remove the worktree at ${path}`);
  const del = await git(['branch', '-D', branch]);
  if (del.ok) notes.push(`Deleted local branch ${branch}`);
  if (remote) notes.push((await git(['push', 'origin', '--delete', branch])).ok ? `Deleted ${branch} on GitHub` : `Couldn't delete ${branch} on GitHub`);
  return notes;
}

/** Merges an improvement PR on GitHub (it must be open, mergeable and not failing), then tidies its branch. */
export async function mergeImprovementPR(b: { url?: string; method?: string; markReady?: boolean; deleteBranch?: boolean; confirm?: boolean; allowExtraCommits?: boolean }) {
  if (!b.url) throw new HttpError(400, 'Pass the pull request url');
  if (!b.confirm) throw new HttpError(400, 'Merging changes the repo on GitHub: confirm must be true');
  const method = b.method ?? 'merge';
  if (!['merge', 'squash', 'rebase'].includes(method)) throw new HttpError(400, 'method must be merge, squash or rebase');
  const r = await find(b.url);
  if (r.blocked) throw new HttpError(409, r.blocked);
  if (r.extra_commits && !b.allowExtraCommits) throw new HttpError(409, `This PR carries ${r.extra_commits} commit(s) besides its improvement items; confirm you want those merged too`);
  if (r.status!.isDraft) {
    if (!b.markReady) throw new HttpError(409, 'It is a draft: mark it ready for review to merge it');
    const ready = await exec('gh', ['pr', 'ready', r.url], { timeout: 30_000 }).catch((e) => e);
    if (ready instanceof Error) throw new HttpError(409, `Couldn't mark it ready: ${String((ready as { stderr?: string }).stderr || ready.message).split('\n')[0]}`);
  }
  const m = await exec('gh', ['pr', 'merge', r.url, `--${method}`], { timeout: 120_000 }).catch((e) => e);
  if (m instanceof Error) throw new HttpError(409, `GitHub refused the merge: ${String((m as { stderr?: string }).stderr || m.message).split('\n')[0].slice(0, 300)}`);
  for (const it of r.items) setStatus(it, 'merged');
  const notes = b.deleteBranch === false ? [] : await cleanupBranch(r.branch, true);
  const fetched = await git(['fetch', 'origin', r.status!.baseRefName]);
  const counts = fetched.ok ? (await git(['rev-list', '--left-right', '--count', `${r.status!.baseRefName}...origin/${r.status!.baseRefName}`])).out.split(/\s+/).map(Number) : null;
  if (counts && counts[1]) notes.push(`Your local ${r.status!.baseRefName} is ${counts[1]} commit(s) behind GitHub: pull to get the merged improvements${counts[0] ? ` (and ${counts[0]} local commit(s) aren't on GitHub)` : ''}`);
  return { ok: true, merged: r.url, items: r.items.map((i) => i.id), notes };
}

/** Closes an improvement PR without merging; its items go back to open on the backlog so they can be tried again. */
export async function closeImprovementPR(b: { url?: string; deleteBranch?: boolean; comment?: string }) {
  if (!b.url) throw new HttpError(400, 'Pass the pull request url');
  const r = await find(b.url);
  if (r.status?.state !== 'OPEN') throw new HttpError(409, `Already ${r.status?.state.toLowerCase() ?? 'unknown'}`);
  const args = ['pr', 'close', r.url, ...(b.comment ? ['--comment', b.comment.slice(0, 2000)] : [])];
  const c = await exec('gh', args, { timeout: 60_000 }).catch((e) => e);
  if (c instanceof Error) throw new HttpError(409, `GitHub refused: ${String((c as { stderr?: string }).stderr || c.message).split('\n')[0]}`);
  for (const it of r.items) {
    const w = workspaces().find((x) => x.id === it.ws);
    if (w) updateBacklogItem(w.path, it.id, { status: 'open', branch: null, pr_url: null, job_id: null, error: null });
  }
  const notes = b.deleteBranch ? await cleanupBranch(r.branch, true) : [];
  return { ok: true, closed: r.url, items: r.items.map((i) => i.id), notes };
}
