import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFindings, allFindings } from '../../src/store/store.ts';
import { listAllRuns, type RunSummary } from './runs.ts';
import { listJobs } from './jobs.ts';

const exec = promisify(execFile);

export interface PrStatus {
  number: number;
  title: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  isDraft: boolean;
  mergedAt: string | null;
  closedAt: string | null;
  updatedAt: string | null;
  reviewDecision: string | null;
  headRefName: string;
  baseRefName: string;
  additions: number;
  deletions: number;
  checks: { name: string; state: string }[];
  /** MERGEABLE | CONFLICTING | UNKNOWN */
  mergeable: string | null;
  /** CLEAN, BLOCKED, BEHIND, DIRTY, UNSTABLE, DRAFT… */
  mergeStateStatus: string | null;
  commits: number;
}

export interface PrRow {
  url: string;
  repo: string;
  number: number | null;
  branch: string | null;
  run: { ws: string; run: string; name: string | null; target: string };
  bugs: { id: string; title: string; severity: string; status: string; side_effect: boolean; verified: boolean; flags: string[] }[];
  jobs: { id: string; state: string; started_at: string; verified: boolean | null }[];
  opened_at: string | null;
  status: PrStatus | null;
  status_error: string | null;
}

// Live PR state comes from GitHub (gh); cache it briefly so lists stay fast.
const cache = new Map<string, { at: number; status: PrStatus | null; error: string | null }>();
const TTL = 60_000;

export async function prStatus(url: string, fresh: boolean): Promise<{ status: PrStatus | null; error: string | null }> {
  const hit = cache.get(url);
  if (!fresh && hit && Date.now() - hit.at < TTL) return hit;
  let out: { status: PrStatus | null; error: string | null };
  try {
    const { stdout } = await exec('gh', ['pr', 'view', url, '--json', 'number,title,state,isDraft,mergedAt,closedAt,updatedAt,reviewDecision,headRefName,baseRefName,additions,deletions,statusCheckRollup,mergeable,mergeStateStatus,commits'], { timeout: 20_000 });
    const j = JSON.parse(stdout);
    out = {
      status: {
        number: j.number,
        title: j.title,
        state: j.state,
        isDraft: !!j.isDraft,
        mergedAt: j.mergedAt || null,
        closedAt: j.closedAt || null,
        updatedAt: j.updatedAt || null,
        reviewDecision: j.reviewDecision || null,
        headRefName: j.headRefName,
        baseRefName: j.baseRefName,
        additions: j.additions ?? 0,
        deletions: j.deletions ?? 0,
        mergeable: j.mergeable || null,
        mergeStateStatus: j.mergeStateStatus || null,
        commits: (j.commits ?? []).length,
        checks: (j.statusCheckRollup ?? []).map((c: { name?: string; context?: string; conclusion?: string; state?: string; status?: string }) => ({ name: c.name ?? c.context ?? 'check', state: c.conclusion || c.state || c.status || 'PENDING' })),
      },
      error: null,
    };
  } catch (e) {
    out = { status: null, error: String((e as { stderr?: string }).stderr || (e as Error).message).split('\n')[0].slice(0, 200) };
  }
  cache.set(url, { at: Date.now(), ...out });
  return out;
}

const repoOf = (url: string) => url.match(/github\.com\/([^/]+\/[^/]+)\/pull\//)?.[1] ?? '';

/**
 * Every pull request bugbash opened, from the findings' fix records and from fix jobs, with the bugs and jobs behind
 * each and its live state on GitHub. Optionally limited to one run.
 */
export async function listPRs(scope: { ws: string; run: string } | null, fresh = false) {
  const runs: RunSummary[] = listAllRuns().filter((r) => !scope || (r.ws === scope.ws && r.run === scope.run));
  const rows = new Map<string, PrRow>();
  for (const r of runs) {
    const dir = join(r.ws_path, 'runs', r.run);
    const ff = r.triaged ? readFindings(dir) : null;
    const fs = ff ? allFindings(ff) : [];
    const jobs = listJobs({ runDir: dir }).filter((j) => j.kind === 'fix');
    const row = (url: string, branch: string | null): PrRow => {
      let e = rows.get(url);
      if (!e) {
        e = { url, repo: repoOf(url), number: Number(url.match(/\/pull\/(\d+)/)?.[1]) || null, branch, run: { ws: r.ws, run: r.run, name: r.name, target: r.target }, bugs: [], jobs: [], opened_at: null, status: null, status_error: null };
        rows.set(url, e);
      }
      if (!e.branch && branch) e.branch = branch;
      return e;
    };
    for (const f of fs) {
      if (!f.fix?.pr_url) continue;
      const e = row(f.fix.pr_url, f.fix.branch);
      if (!e.bugs.some((b) => b.id === f.id)) e.bugs.push({ id: f.id, title: f.title, severity: f.severity, status: f.status, side_effect: /side effect/.test(f.fix.fixed_by ?? ''), verified: !!f.fix.verified && !!f.fix.verification && !(f.fix.flags ?? []).length, flags: f.fix.flags ?? (f.fix.verification ? [] : ['checked before the stricter verification']) });
      if (!e.opened_at || f.fix.at < e.opened_at) e.opened_at = f.fix.at;
    }
    for (const j of jobs) {
      // A job belongs to a PR if it opened it, or worked on the same branch (earlier attempts, continues).
      const urls = new Set<string>();
      if (j.pr_url) urls.add(j.pr_url);
      for (const e of rows.values()) if (e.run.run === r.run && e.run.ws === r.ws && j.branch && e.branch === j.branch) urls.add(e.url);
      for (const url of urls) {
        const e = row(url, j.branch);
        if (!e.jobs.some((x) => x.id === j.id)) e.jobs.push({ id: j.id, state: j.state, started_at: j.started_at, verified: j.verified });
        for (const id of j.finding_ids) if (!e.bugs.some((b) => b.id === id)) {
          const f = fs.find((x) => x.id === id);
          if (f) e.bugs.push({ id, title: f.title, severity: f.severity, status: f.status, side_effect: false, verified: !!f.fix?.verified && !!f.fix?.verification && !(f.fix?.flags ?? []).length, flags: f.fix?.flags ?? [] });
        }
      }
    }
  }
  const list = [...rows.values()];
  // Look up live state, a few at a time.
  for (let i = 0; i < list.length; i += 6)
    await Promise.all(
      list.slice(i, i + 6).map(async (row) => {
        const s = await prStatus(row.url, fresh);
        row.status = s.status;
        row.status_error = s.error;
      }),
    );
  for (const row of list) row.jobs.sort((a, b) => b.started_at.localeCompare(a.started_at));
  list.sort((a, b) => String(b.status?.updatedAt ?? b.opened_at ?? '').localeCompare(String(a.status?.updatedAt ?? a.opened_at ?? '')));
  const count = (st: string) => list.filter((x) => (st === 'DRAFT' ? x.status?.state === 'OPEN' && x.status.isDraft : st === 'OPEN' ? x.status?.state === 'OPEN' && !x.status.isDraft : x.status?.state === st)).length;
  return { prs: list, counts: { total: list.length, draft: count('DRAFT'), open: count('OPEN'), merged: count('MERGED'), closed: count('CLOSED'), unknown: list.filter((x) => !x.status).length } };
}

