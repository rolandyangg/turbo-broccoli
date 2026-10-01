import { readFindings, allFindings, readRun } from '../../src/store/store.ts';
import type { Finding, RootCauseGroup } from '../../src/store/schema.ts';
import { runDirOf, HttpError } from './workspaces.ts';
import { cachedRunStats } from './agentStats.ts';
import { isFunctional } from './runs.ts';

const ACTIVE = new Set(['new', 'confirmed', 'fixing']);
const SEV = ['critical', 'major', 'minor', 'cosmetic'];

export type DiffKind = 'new' | 'regressed' | 'still-open' | 'fixed' | 'not-found' | 'not-tested';

interface Brief {
  id: string;
  title: string;
  type: string;
  page: string;
  severity: string;
  status: string;
  functional: boolean;
  shot: string | null;
  widths: number[];
  browsers: string[];
}
const brief = (f: Finding): Brief => ({
  id: f.id,
  title: f.title,
  type: f.type,
  page: f.page,
  severity: f.severity,
  status: f.status,
  functional: isFunctional(f),
  shot: f.screenshots.annotated ?? f.screenshots.crop ?? f.screenshots.explorer ?? null,
  widths: [...new Set(f.viewports.map((v) => v.width))].sort((a, b) => a - b),
  browsers: f.browsers,
});

function side(spec: string) {
  const [ws, ...rest] = spec.split('/');
  const run = rest.join('/');
  if (!ws || !run) throw new HttpError(400, `Bad run "${spec}" (expected ws/run)`);
  const dir = runDirOf(ws, run);
  const info = readRun(dir);
  const ff = readFindings(dir);
  if (!ff) throw new HttpError(409, `Run ${info.name ?? run} hasn't been triaged yet`);
  const groupOf = new Map<string, RootCauseGroup>();
  for (const g of ff.groups) for (const f of g.findings) groupOf.set(f.fingerprint, g);
  // Only findings that count (active or fixed); dismissed ones (false positive, flaky, …) don't take part.
  const findings = allFindings(ff).filter((f) => (ACTIVE.has(f.status) || f.status === 'fixed') && !f.workflow?.archived);
  return { ws, run, dir, info, findings, groupOf, stats: cachedRunStats(dir) };
}

/**
 * Diff two triaged runs by finding fingerprint:
 * new in B · regressed (fixed in A or marked regressed, back in B) · still open (severity changes noted) ·
 * fixed (B or A marked it fixed) · not found in B (page was re-tested) · not re-tested (B never visited the page).
 */
export function compareRuns(aSpec: string, bSpec: string) {
  const A = side(aSpec);
  const B = side(bSpec);
  const aBy = new Map(A.findings.map((f) => [f.fingerprint, f]));
  const bBy = new Map(B.findings.map((f) => [f.fingerprint, f]));
  const bPages = new Set(B.stats.coverage.pages);
  const entries: { kind: DiffKind; fingerprint: string; group: { id: string; summary: string; side: 'a' | 'b' } | null; a: Brief | null; b: Brief | null; severity_change: { from: string; to: string; direction: 'worse' | 'better' } | null }[] = [];
  const groupRef = (g: RootCauseGroup | undefined, s: 'a' | 'b') => (g ? { id: g.id, summary: g.summary, side: s } : null);

  for (const [fp, b] of bBy) {
    const a = aBy.get(fp);
    const group = groupRef(B.groupOf.get(fp), 'b');
    if (!a) {
      entries.push({ kind: b.status === 'fixed' ? 'fixed' : b.history_tag === 'regressed' ? 'regressed' : 'new', fingerprint: fp, group, a: null, b: brief(b), severity_change: null });
      continue;
    }
    let kind: DiffKind;
    if (b.status === 'fixed') kind = 'fixed';
    else if (a.status === 'fixed') kind = 'regressed';
    else kind = 'still-open';
    const sc = a.severity !== b.severity ? { from: a.severity, to: b.severity, direction: SEV.indexOf(b.severity) < SEV.indexOf(a.severity) ? ('worse' as const) : ('better' as const) } : null;
    entries.push({ kind, fingerprint: fp, group, a: brief(a), b: brief(b), severity_change: sc });
  }
  for (const [fp, a] of aBy) {
    if (bBy.has(fp)) continue;
    const kind: DiffKind = a.status === 'fixed' || a.status === 'fixing' ? 'fixed' : bPages.has(a.page) ? 'not-found' : 'not-tested';
    entries.push({ kind, fingerprint: fp, group: groupRef(A.groupOf.get(fp), 'a'), a: brief(a), b: null, severity_change: null });
  }
  const order: DiffKind[] = ['regressed', 'new', 'still-open', 'fixed', 'not-found', 'not-tested'];
  entries.sort((x, y) => order.indexOf(x.kind) - order.indexOf(y.kind) || SEV.indexOf((x.b ?? x.a)!.severity) - SEV.indexOf((y.b ?? y.a)!.severity));

  const meta = (s: ReturnType<typeof side>) => ({ ws: s.ws, run: s.run, name: s.info.name ?? null, target: s.info.target, started_at: s.info.started_at });
  const metrics = (s: ReturnType<typeof side>) => {
    const k = s.stats.kpis;
    const cells = Object.values(s.stats.coverage.cells).flatMap((row) => Object.values(row));
    return {
      cost_usd: k.cost_usd,
      tokens: k.tokens,
      sessions: k.sessions,
      wall_ms: k.wall_ms,
      raw: s.stats.triage.raw,
      real_bugs: k.real_bugs,
      precision: k.precision,
      cost_per_real_bug: k.cost_per_real_bug,
      tool_error_rate: k.tool_error_rate,
      pages: s.stats.coverage.pages.length,
      tested_cells: cells.filter((c) => c.tested).length,
      total_cells: cells.length,
    };
  };
  const counts = Object.fromEntries(order.map((k) => [k, entries.filter((e) => e.kind === k).length])) as Record<DiffKind, number>;
  return {
    a: meta(A),
    b: meta(B),
    same_target: A.info.target === B.info.target,
    counts,
    entries,
    metrics: { a: metrics(A), b: metrics(B) },
    discovery: {
      a: { points: A.stats.discovery.points.map((p) => ({ x: p.t_ms, y: p.unique, label: p.title })), stop_ms: A.stats.discovery.stop_ms },
      b: { points: B.stats.discovery.points.map((p) => ({ x: p.t_ms, y: p.unique, label: p.title })), stop_ms: B.stats.discovery.stop_ms },
    },
  };
}
