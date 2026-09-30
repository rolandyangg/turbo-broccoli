import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
async function sh(cmd: string, args: string[], cwd: string, maxBuffer = 8 * 1024 * 1024) {
  try {
    const r = await run(cmd, args, { cwd, maxBuffer, timeout: 20_000 });
    return { ok: true, out: r.stdout };
  } catch (e: any) {
    return { ok: false, out: String(e.stdout ?? ''), err: String(e.stderr ?? e.message) };
  }
}

export interface BranchInfo {
  exists: boolean;
  branch: string;
  base: string | null;
  git_root: string | null;
  head: string | null;
  ahead: number | null;
  behind: number | null;
  commits: { sha: string; subject: string; author: string; date: string }[];
  diff_stat: string;
  files: { file: string; added: number; removed: number }[];
  patch: string;
  patch_truncated: boolean;
  worktree: string | null;
  pr: { number: number; url: string; state: string; isDraft: boolean; title: string; reviewDecision: string | null; checks: { name: string; state: string }[] } | null;
}

const PATCH_LIMIT = 250_000;

export async function branchInfo(repo: string, branch: string, base: string | null): Promise<BranchInfo> {
  const root = (await sh('git', ['rev-parse', '--show-toplevel'], repo)).out.trim() || null;
  const empty: BranchInfo = { exists: false, branch, base, git_root: root, head: null, ahead: null, behind: null, commits: [], diff_stat: '', files: [], patch: '', patch_truncated: false, worktree: null, pr: null };
  if (!root) return empty;
  const head = await sh('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], root);
  if (!head.ok) return empty;
  let b = base;
  if (!b || !(await sh('git', ['rev-parse', '--verify', '--quiet', b], root)).ok) {
    b = (await sh('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], root)).out.trim().replace(/^origin\//, '') || null;
    if (!b || !(await sh('git', ['rev-parse', '--verify', '--quiet', b], root)).ok) b = (await sh('git', ['rev-parse', '--verify', '--quiet', 'main'], root)).ok ? 'main' : 'master';
  }
  const [counts, log, stat, numstat, patch, wts] = await Promise.all([
    sh('git', ['rev-list', '--left-right', '--count', `${b}...${branch}`], root),
    sh('git', ['log', '--format=%H%x1f%s%x1f%an%x1f%aI', `${b}..${branch}`], root),
    sh('git', ['diff', '--stat', `${b}...${branch}`], root),
    sh('git', ['diff', '--numstat', `${b}...${branch}`], root),
    sh('git', ['diff', `${b}...${branch}`], root, 32 * 1024 * 1024),
    sh('git', ['worktree', 'list', '--porcelain'], root),
  ]);
  const [behind, ahead] = counts.out.trim().split(/\s+/).map(Number);
  let worktree: string | null = null;
  let cur: string | null = null;
  for (const l of wts.out.split('\n')) {
    if (l.startsWith('worktree ')) cur = l.slice(9);
    if (l === `branch refs/heads/${branch}`) worktree = cur;
  }
  let pr: BranchInfo['pr'] = null;
  const prv = await sh('gh', ['pr', 'view', branch, '--json', 'number,url,state,isDraft,title,reviewDecision,statusCheckRollup'], root);
  if (prv.ok) {
    try {
      const j = JSON.parse(prv.out);
      pr = { number: j.number, url: j.url, state: j.state, isDraft: j.isDraft, title: j.title, reviewDecision: j.reviewDecision || null, checks: (j.statusCheckRollup ?? []).map((c: any) => ({ name: c.name ?? c.context, state: c.conclusion || c.state || c.status })) };
    } catch {}
  }
  return {
    exists: true,
    branch,
    base: b,
    git_root: root,
    head: head.out.trim(),
    ahead: Number.isFinite(ahead) ? ahead : null,
    behind: Number.isFinite(behind) ? behind : null,
    commits: log.out
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [sha, subject, author, date] = l.split('\x1f');
        return { sha, subject, author, date };
      }),
    diff_stat: stat.out.trim(),
    files: numstat.out
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [a, r, file] = l.split('\t');
        return { file, added: Number(a) || 0, removed: Number(r) || 0 };
      }),
    patch: patch.out.slice(0, PATCH_LIMIT),
    patch_truncated: patch.out.length > PATCH_LIMIT,
    worktree,
    pr,
  };
}
