import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readRun, readFindings, allFindings, type RunInfo } from '../../src/store/store.ts';
import { mergeAll, summarize } from '../../src/explore/coverage.ts';
import { Config } from '../../src/config.ts';
import { categoryOf, type Finding, type FindingsFile } from '../../src/store/schema.ts';
import { workspaces, readJsonSafe, mtime, HttpError, runDirOf, workspaceById, samePath } from './workspaces.ts';
import { jobRoots, listJobs } from './jobs.ts';

/** Delete only run-owned artifacts; shared memory and source repositories stay intact. */
export function deleteRun(ws: string, run: string) {
  if (run === '.' || run === '..') throw new HttpError(400, 'Bad run id');
  const dir = runDirOf(ws, run);
  const workspace = workspaceById(ws);
  if (lstatSync(dir).isSymbolicLink() || dirname(realpathSync(dir)) !== realpathSync(join(workspace.path, 'runs'))) {
    throw new HttpError(403, 'Run directory is outside this workspace');
  }
  if (isLive(dir, listJobs({ runDir: dir }))) {
    throw new HttpError(409, 'Stop all active jobs for this run before deleting it.');
  }
  // Scan every record, including duplicate job IDs in different job roots.
  const histories = jobRoots().flatMap((root) => readdirSync(root).flatMap((id) => {
    const path = join(root, id);
    const status = readJsonSafe<{ run_dir?: string; state?: string; pid?: number } | null>(join(path, 'status.json'), null);
    if (!samePath(status?.run_dir, dir)) return [];
    if (status?.state === 'running' && status.pid) {
      let alive = false;
      try { process.kill(status.pid, 0); alive = true; } catch {}
      if (alive) throw new HttpError(409, 'Stop all active jobs for this run before deleting it.');
    }
    return [path];
  }));
  for (const history of histories) rmSync(history, { recursive: true, force: true });
  const proposals = join(workspace.path, 'improvements', `${run}.json`);
  if (readJsonSafe<{ run?: string } | null>(proposals, null)?.run === run) rmSync(proposals);
  rmSync(dir, { recursive: true });
}

export const isFunctional = (f: Pick<Finding, 'type' | 'category'>) => (f.category ?? categoryOf(f.type)) === 'ux-functional';

const ACTIVE = new Set(['new', 'confirmed', 'fixing']);

export interface RunSummary {
  ws: string;
  ws_path: string;
  run: string;
  name: string | null;
  target: string;
  /** Stable grouping key: the source path for local targets, the URL otherwise. */
  target_key: string;
  base_url: string;
  target_kind: string;
  repo_path: string | null;
  started_at: string;
  ended_at: string | null;
  stop_reason: string | null;
  sessions: number;
  triaged: boolean;
  live: boolean;
  counts: { total: number; active: number; functional: number; archived: number; groups: number; by_severity: Record<string, number>; by_status: Record<string, number>; with_video: number };
  raw_findings: number;
}

function countLines(file: string) {
  if (!existsSync(file)) return 0;
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
}

function isLive(runDir: string, jobsForRun: { kind?: string; state: string; alive: boolean }[]) {
  if (jobsForRun.some((j) => j.alive)) return true;
  // Cancelled/crashed explorers can leave a fresh "running" campaign behind.
  // Tracked explorer processes are authoritative; keep the timestamp fallback
  // only for campaigns without an explorer job record (e.g. older CLI runs).
  if (jobsForRun.some((j) => j.kind === 'explore')) return false;
  const c = readJsonSafe<{ phase?: string } | null>(join(runDir, 'campaign.json'), null);
  return c?.phase === 'running' && Date.now() - mtime(join(runDir, 'campaign.json')) < 30 * 60_000;
}

export function summarizeRun(wsIdV: string, wsPath: string, run: string): RunSummary | null {
  const dir = join(wsPath, 'runs', run);
  let info: RunInfo;
  try {
    info = readRun(dir);
  } catch {
    return null;
  }
  const ff = safeFindings(dir);
  const fs = ff ? allFindings(ff) : [];
  const by = (k: (f: Finding) => string, pool = fs) => pool.reduce<Record<string, number>>((a, f) => ((a[k(f)] = (a[k(f)] ?? 0) + 1), a), {});
  // Functional (behaviour) bugs are tracked separately and left out of the main layout-bug counts.
  // Archived findings are kept but count as neither active nor functional.
  const active = fs.filter((f) => ACTIVE.has(f.status) && !isFunctional(f) && !f.workflow?.archived);
  const functional = fs.filter((f) => ACTIVE.has(f.status) && isFunctional(f) && !f.workflow?.archived).length;
  const archived = fs.filter((f) => f.workflow?.archived).length;
  const jobs = listJobs({ runDir: dir });
  return {
    ws: wsIdV,
    ws_path: wsPath,
    run,
    name: info.name ?? null,
    target: info.target,
    target_key: info.target_kind === 'url' ? info.target.replace(/\/+$/, '') : (info.repo_path ?? info.target),
    base_url: info.base_url,
    target_kind: info.target_kind,
    repo_path: info.repo_path,
    started_at: info.started_at,
    ended_at: info.ended_at,
    stop_reason: info.stop_reason,
    sessions: (info.jobs as unknown[])?.length || readJsonSafe<{ jobs?: unknown[] }>(join(dir, 'campaign.json'), {}).jobs?.length || 0,
    triaged: !!ff,
    live: isLive(dir, jobs),
    counts: { total: fs.length, active: active.length, functional, archived, groups: ff?.groups.length ?? 0, by_severity: by((f) => f.severity, active), by_status: by((f) => f.status), with_video: fs.filter((f) => f.video).length },
    raw_findings: countLines(join(dir, 'agent-findings.jsonl')),
  };
}

function safeFindings(dir: string): FindingsFile | null {
  try {
    return readFindings(dir);
  } catch {
    return null;
  }
}

export function listAllRuns(): RunSummary[] {
  const out: RunSummary[] = [];
  for (const w of workspaces()) for (const r of w.runs) {
    const s = summarizeRun(w.id, w.path, r);
    if (s) out.push(s);
  }
  return out.sort((a, b) => b.started_at.localeCompare(a.started_at));
}

export function runDetail(wsIdV: string, wsPath: string, run: string) {
  const dir = join(wsPath, 'runs', run);
  const info = readRun(dir);
  const findings = safeFindings(dir);
  let coverage: ReturnType<typeof summarize> = [];
  try {
    const cfg = Config.parse(info.config);
    coverage = summarize(mergeAll(dir), cfg.viewports.widths, cfg.browsers);
  } catch {}
  const hypotheses = existsSync(join(dir, 'hypotheses.jsonl'))
    ? readFileSync(join(dir, 'hypotheses.jsonl'), 'utf8').split('\n').filter(Boolean).flatMap((l) => {
        try {
          return [JSON.parse(l)];
        } catch {
          return [];
        }
      })
    : [];
  const intel = readJsonSafe<Record<string, unknown> | null>(join(dir, 'code-intel.json'), null);
  const raw = existsSync(join(dir, 'agent-findings.jsonl'))
    ? readFileSync(join(dir, 'agent-findings.jsonl'), 'utf8').split('\n').filter(Boolean).flatMap((l) => {
        try {
          const f = JSON.parse(l);
          return [{ session: f.session, type: f.type, title: f.title, page: f.page, severity: f.severity, confidence: f.confidence, browser: f.environment?.browser, at: f.at }];
        } catch {
          return [];
        }
      })
    : [];
  return {
    summary: summarizeRun(wsIdV, wsPath, run),
    run: info,
    findings,
    campaign: readJsonSafe(join(dir, 'campaign.json'), null),
    coverage,
    hypotheses,
    raw_findings: raw,
    code_intel: intel
      ? { framework: intel.framework, breakpoints: intel.breakpoints, routes: intel.routes, components: intel.components, changedFiles: intel.changedFiles, hypotheses: intel.hypotheses, risky: (intel.risky as unknown[] | undefined)?.slice(0, 80) }
      : null,
    notes: existsSync(join(dir, 'notes.md')) ? readFileSync(join(dir, 'notes.md'), 'utf8') : '',
    jobs: listJobs({ runDir: dir }),
  };
}

export interface TranscriptItem {
  kind: 'text' | 'tool' | 'result';
  id?: string;
  name?: string;
  text?: string;
  input?: unknown;
  is_error?: boolean;
  image?: boolean;
}

/**
 * The explorer's reasoning and tool calls that led to a finding: the session transcript up to (and including)
 * the record_finding call whose title matches, trimmed to the last ~N items.
 */
export function transcriptFor(runDir: string, f: Finding, limit = 80): { session: string | null; items: TranscriptItem[]; total: number } {
  const session = f.found_by.session?.split(',')[0] ?? null;
  if (!session || !/^[\w.-]+$/.test(session)) return { session, items: [], total: 0 };
  const file = join(runDir, 'transcripts', `${session}.jsonl`);
  if (!existsSync(file)) return { session, items: [], total: 0 };
  const items: TranscriptItem[] = [];
  let cut = -1;
  let cutId: string | null = null;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === 'assistant') {
      for (const c of e.message?.content ?? []) {
        if (c.type === 'text' && c.text?.trim()) items.push({ kind: 'text', text: c.text.trim() });
        if (c.type === 'tool_use') {
          const name = String(c.name).replace(/^mcp__\w+__/, '');
          items.push({ kind: 'tool', name, input: c.input, id: c.id });
          if (!cutId && name === 'record_finding' && (c.input?.title === f.title || (f.element.selector && c.input?.ref && String(c.input.ref).includes(f.element.selector)))) cutId = c.id;
        }
      }
    } else if (e.type === 'user') {
      for (const c of e.message?.content ?? []) {
        if (c?.type !== 'tool_result') continue;
        const parts = Array.isArray(c.content) ? c.content : [{ type: 'text', text: String(c.content ?? '') }];
        const text = parts.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n');
        items.push({ kind: 'result', id: c.tool_use_id, text: text.slice(0, 1500), is_error: !!c.is_error, image: parts.some((p: any) => p.type === 'image') });
        if (cutId && c.tool_use_id === cutId && cut < 0) cut = items.length;
      }
    }
  }
  const end = cut > 0 ? cut : items.length;
  return { session, items: items.slice(Math.max(0, end - limit), end), total: items.length };
}

export function findFinding(runDir: string, id: string): Finding {
  const ff = safeFindings(runDir);
  const f = ff && allFindings(ff).find((x) => x.id === id);
  if (!f) throw new HttpError(404, `Unknown finding ${id}`);
  return f;
}

/** Last few actions of an explorer session (live while it runs), from its transcript. */
export function sessionTail(runDir: string, session: string, n = 12): { session: string; items: TranscriptItem[]; total: number } {
  if (!/^[\w.-]+$/.test(session)) throw new HttpError(400, 'Bad session');
  const file = join(runDir, 'transcripts', `${session}.jsonl`);
  if (!existsSync(file)) return { session, items: [], total: 0 };
  const items: TranscriptItem[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type !== 'assistant') continue;
    for (const c of e.message?.content ?? []) {
      if (c.type === 'text' && c.text?.trim()) items.push({ kind: 'text', text: c.text.trim().slice(0, 300) });
      if (c.type === 'tool_use') items.push({ kind: 'tool', name: String(c.name).replace(/^mcp__\w+__/, ''), input: c.input });
    }
  }
  return { session, items: items.slice(-n), total: items.length };
}
