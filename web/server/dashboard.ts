import { join } from 'node:path';
import { readFindings, allFindings } from '../../src/store/store.ts';
import type { Finding } from '../../src/store/schema.ts';
import { listAllRuns, type RunSummary } from './runs.ts';
import { listJobs } from './jobs.ts';
import { HttpError } from './workspaces.ts';

const ACTIVE = new Set(['new', 'confirmed', 'fixing']);
const SEV = ['critical', 'major', 'minor', 'cosmetic'] as const;

export interface Dashboard {
  kpis: { active: number; critical: number; major: number; fixing: number; fixed: number; false_positive: number; targets: number; runs: number; running_jobs: number; with_video: number };
  severity: { key: string; count: number }[];
  pipeline: { key: string; count: number }[];
  by_type: { key: string; count: number }[];
  by_page: { key: string; count: number }[];
  by_browser: { key: string; count: number }[];
  trend: { run: string; ws: string; target: string; at: string; active: number; critical: number; major: number; minor: number; cosmetic: number; triaged: boolean }[];
  attention: { id: string; ws: string; run: string; target: string; title: string; severity: string; status: string; type: string; page: string; confidence: number; thumb: string | null; widths: number[]; browsers: string[] }[];
  targets: { target: string; latest: RunSummary; runs: number; active: number; critical: number; major: number }[];
  jobs: ReturnType<typeof listJobs>;
  /** null = all targets (latest triaged run of each); otherwise the single run the numbers come from. */
  scope: { ws: string; run: string; target: string; started_at: string; triaged: boolean } | null;
  /** Every run, for the run filter. */
  runs: { ws: string; run: string; target: string; target_key: string; started_at: string; triaged: boolean; active: number }[];
}

function tally<T>(xs: T[], key: (x: T) => string | string[], top = 8) {
  const m = new Map<string, number>();
  for (const x of xs) for (const k of ([] as string[]).concat(key(x))) m.set(k, (m.get(k) ?? 0) + 1);
  return [...m.entries()].map(([k, count]) => ({ key: k, count })).sort((a, b) => b.count - a.count).slice(0, top);
}

/**
 * "Current state" = the latest triaged run of every target (re-runs of the same site don't double count);
 * the trend uses every run.
 */
export function dashboard(only: { ws: string; run: string } | null = null): Dashboard {
  const runs = listAllRuns();
  const scoped = only ? runs.find((r) => r.ws === only.ws && r.run === only.run) : null;
  if (only && !scoped) throw new HttpError(404, `Unknown run ${only.run}`);
  const byTarget = new Map<string, RunSummary[]>();
  for (const r of runs) byTarget.set(r.target_key, [...(byTarget.get(r.target_key) ?? []), r]);
  // With a run selected, only its target matters and that run stands in for "latest".
  if (scoped) for (const k of [...byTarget.keys()]) if (k !== scoped.target_key) byTarget.delete(k);

  const current: { f: Finding; r: RunSummary }[] = [];
  const targets: Dashboard['targets'] = [];
  for (const [target, rs] of byTarget) {
    const latest = scoped ?? rs.find((r) => r.triaged) ?? rs[0];
    const ff = latest.triaged ? readFindings(join(latest.ws_path, 'runs', latest.run)) : null;
    const fs = ff ? allFindings(ff) : [];
    for (const f of fs) current.push({ f, r: latest });
    const act = fs.filter((f) => ACTIVE.has(f.status));
    targets.push({ target, latest, runs: rs.length, active: act.length, critical: act.filter((f) => f.severity === 'critical').length, major: act.filter((f) => f.severity === 'major').length });
  }
  const multiTarget = byTarget.size > 1;
  const active = current.filter(({ f }) => ACTIVE.has(f.status));
  const jobs = scoped ? listJobs({ runDir: join(scoped.ws_path, 'runs', scoped.run) }) : listJobs();
  const sevRank = (s: string) => SEV.indexOf(s as (typeof SEV)[number]);

  return {
    kpis: {
      active: active.length,
      critical: active.filter(({ f }) => f.severity === 'critical').length,
      major: active.filter(({ f }) => f.severity === 'major').length,
      fixing: current.filter(({ f }) => f.status === 'fixing').length,
      fixed: current.filter(({ f }) => f.status === 'fixed').length,
      false_positive: current.filter(({ f }) => f.status === 'false_positive' || f.status === 'suppressed').length,
      targets: byTarget.size,
      runs: scoped ? (byTarget.get(scoped.target_key)?.length ?? 1) : runs.length,
      running_jobs: jobs.filter((j) => j.state === 'running' && j.alive).length,
      with_video: active.filter(({ f }) => f.video).length,
    },
    severity: SEV.map((s) => ({ key: s, count: active.filter(({ f }) => f.severity === s).length })),
    pipeline: ['new', 'confirmed', 'fixing', 'fixed', 'low_confidence', 'flaky', 'false_positive', 'suppressed'].map((s) => ({ key: s, count: current.filter(({ f }) => f.status === s).length })),
    by_type: tally(active, ({ f }) => f.type),
    by_page: tally(active, ({ f, r }) => (multiTarget ? `${r.target_key.split('/').pop()}${f.page}` : f.page)),
    by_browser: tally(active, ({ f }) => f.browsers, 3),
    trend: [...runs]
      .filter((r) => !scoped || r.target_key === scoped.target_key)
      .reverse()
      .map((r) => ({ run: r.run, ws: r.ws, target: r.target, at: r.started_at, active: r.counts.active, critical: r.counts.by_severity.critical ?? 0, major: r.counts.by_severity.major ?? 0, minor: r.counts.by_severity.minor ?? 0, cosmetic: r.counts.by_severity.cosmetic ?? 0, triaged: r.triaged })),
    attention: active
      .sort((a, b) => sevRank(a.f.severity) - sevRank(b.f.severity) || b.f.confidence - a.f.confidence)
      .slice(0, 8)
      .map(({ f, r }) => ({ id: f.id, ws: r.ws, run: r.run, target: r.target, title: f.title, severity: f.severity, status: f.status, type: f.type, page: f.page, confidence: f.confidence, thumb: f.screenshots.crop ?? f.screenshots.annotated, widths: [...new Set(f.viewports.map((v) => v.width))].sort((a, b) => a - b), browsers: f.browsers })),
    targets: targets.sort((a, b) => b.latest.started_at.localeCompare(a.latest.started_at)),
    jobs: jobs.slice(0, 8),
    scope: scoped ? { ws: scoped.ws, run: scoped.run, target: scoped.target, started_at: scoped.started_at, triaged: scoped.triaged } : null,
    runs: runs.map((r) => ({ ws: r.ws, run: r.run, target: r.target, target_key: r.target_key, started_at: r.started_at, triaged: r.triaged, active: r.counts.active })),
  };
}
