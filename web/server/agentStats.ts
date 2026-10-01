import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readRun, readFindings, allFindings } from '../../src/store/store.ts';
import { mergeAll } from '../../src/explore/coverage.ts';
import { fingerprintOf } from '../../src/triage/cluster.ts';
import { deviceById } from '../../src/explore/devices.ts';
import type { Finding, RawFinding } from '../../src/store/schema.ts';
import { listAllRuns } from './runs.ts';
import { listJobs, readEvents, REPO_ROOT } from './jobs.ts';
import { HttpError, readJsonSafe } from './workspaces.ts';

/**
 * Agent observability: cost, effort, effectiveness, discovery, coverage, reliability and quality, computed from
 * what every run already writes to disk (transcripts, session logs, raw/final findings, coverage, jobs).
 */
const SURVIVED = new Set(['new', 'confirmed', 'fixing', 'fixed']);
type Tokens = { input: number; cache_read: number; cache_write: number; output: number; thinking: number };
const zeroTokens = (): Tokens => ({ input: 0, cache_read: 0, cache_write: 0, output: 0, thinking: 0 });
const addTokens = (a: Tokens, b: Tokens) => ({ input: a.input + b.input, cache_read: a.cache_read + b.cache_read, cache_write: a.cache_write + b.cache_write, output: a.output + b.output, thinking: a.thinking + b.thinking });
export const tokenTotal = (t: Tokens) => t.input + t.cache_read + t.cache_write + t.output;

interface TranscriptSummary {
  model: string | null;
  cost_usd: number;
  ms: number;
  api_ms: number;
  turns: number;
  tokens: Tokens;
  tool_calls: number;
  tool_errors: number;
  tools: Record<string, number>;
  ok: boolean | null;
  result: string | null;
}

function readLines<T = any>(file: string): T[] {
  if (!existsSync(file)) return [];
  const out: T[] = [];
  for (const l of readFileSync(file, 'utf8').split('\n')) {
    if (!l) continue;
    try {
      out.push(JSON.parse(l));
    } catch {}
  }
  return out;
}

/** Cost, tokens, time and tool usage from one `claude -p` stream-json transcript. */
export function summarizeTranscript(file: string): TranscriptSummary | null {
  if (!existsSync(file)) return null;
  const s: TranscriptSummary = { model: null, cost_usd: 0, ms: 0, api_ms: 0, turns: 0, tokens: zeroTokens(), tool_calls: 0, tool_errors: 0, tools: {}, ok: null, result: null };
  for (const e of readLines(file)) {
    if (e.type === 'system' && e.subtype === 'init') s.model = e.model ?? s.model;
    if (e.type === 'assistant')
      for (const c of e.message?.content ?? [])
        if (c.type === 'tool_use') {
          s.tool_calls++;
          const n = String(c.name).replace(/^mcp__\w+__/, '');
          s.tools[n] = (s.tools[n] ?? 0) + 1;
        }
    if (e.type === 'user') for (const c of e.message?.content ?? []) if (c?.type === 'tool_result' && c.is_error) s.tool_errors++;
    if (e.type === 'result') {
      const u = e.usage ?? {};
      s.cost_usd = Number(e.total_cost_usd ?? 0);
      s.ms = Number(e.duration_ms ?? 0);
      s.api_ms = Number(e.duration_api_ms ?? 0);
      s.turns = Number(e.num_turns ?? 0);
      s.tokens = { input: u.input_tokens ?? 0, cache_read: u.cache_read_input_tokens ?? 0, cache_write: u.cache_creation_input_tokens ?? 0, output: u.output_tokens ?? 0, thinking: u.output_tokens_details?.thinking_tokens ?? 0 };
      s.ok = !e.is_error;
      s.result = typeof e.result === 'string' ? e.result.slice(0, 300) : null;
    }
  }
  return s;
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

interface ExplorerRow {
  id: string;
  persona: string | null;
  browser: string;
  device: string | null;
  device_kind: string;
  goal: string;
  status: string;
  model: string | null;
  ms: number;
  api_ms: number;
  turns: number;
  cost_usd: number;
  tokens: Tokens;
  tool_calls: number;
  tool_errors: number;
  blocked: number;
  raw: number;
  survived: number;
  flaky: number;
  low_confidence: number;
  false_positive: number;
  unique_new: number;
  first_finding_ms: number | null;
  bugs_per_10_calls: number | null;
  hypotheses: { confirmed: number; refuted: number; inconclusive: number };
  observes: number;
  new_states: number;
  recoveries: number;
  error: string | null;
}

function campaignJobs(dir: string): any[] {
  const c = readJsonSafe<{ jobs?: any[] } | null>(join(dir, 'campaign.json'), null);
  if (c?.jobs?.length) return c.jobs.map((j) => ({ ...j, startedAt: j.started_at ? Date.parse(j.started_at) : null, endedAt: j.ended_at ? Date.parse(j.ended_at) : null, toolCalls: j.tool_calls }));
  try {
    return ((readRun(dir).jobs ?? []) as any[]).map((j) => ({ ...j, toolCalls: j.result?.toolCalls, error: j.result?.error }));
  } catch {
    return [];
  }
}

export function runAgentStats(dir: string) {
  const info = readRun(dir);
  const runStart = Date.parse(info.started_at);
  const ff = existsSync(join(dir, 'findings.json')) ? readFindings(dir) : null;
  const finals: Finding[] = ff ? allFindings(ff) : [];
  const finalByFp = new Map(finals.map((f) => [f.fingerprint, f]));
  const raw = readLines<RawFinding>(join(dir, 'agent-findings.jsonl'));
  const hyps = readLines<{ session: string; outcome: string; strategy: string | null }>(join(dir, 'hypotheses.jsonl'));
  const jobs = campaignJobs(dir);

  // Which session first found each fingerprint (unique contribution), in time order.
  const firstBy = new Map<string, { session: string; at: number; title: string }>();
  for (const r of [...raw].sort((a, b) => a.at.localeCompare(b.at))) {
    const fp = fingerprintOf(r);
    if (!firstBy.has(fp)) firstBy.set(fp, { session: r.session, at: Date.parse(r.at), title: r.title });
  }
  const statusOfRaw = (r: RawFinding) => finalByFp.get(fingerprintOf(r))?.status ?? (ff ? 'merged' : 'untriaged');

  // ---- explorers ----
  const sessionIds = [...new Set([...jobs.map((j) => j.id), ...raw.map((r) => r.session)])].filter((s) => /^[\w.-]+$/.test(s));
  const explorers: ExplorerRow[] = sessionIds.sort().map((id) => {
    const job = jobs.find((j) => j.id === id) ?? {};
    const t = summarizeTranscript(join(dir, 'transcripts', `${id}.jsonl`));
    const log = readLines(join(dir, 'sessions', `${id}.jsonl`));
    const mine = raw.filter((r) => r.session === id);
    const statuses = mine.map(statusOfRaw);
    const toolLog = log.filter((e) => e.kind === 'tool');
    const firstVariantDevice = log.find((e) => e.kind === 'step' && e.step?.action === 'variant' && e.step.variant?.device)?.step.variant.device ?? null;
    const device = job.device ?? firstVariantDevice ?? mine[0]?.environment?.variant?.device ?? null;
    const startMs = job.startedAt ?? (log[0]?.at ? Date.parse(log[0].at) : null);
    const firstFinding = mine.length ? Math.min(...mine.map((r) => Date.parse(r.at))) : null;
    const calls = t?.tool_calls ?? job.toolCalls ?? toolLog.length;
    const survived = statuses.filter((x) => SURVIVED.has(x)).length;
    return {
      id,
      persona: job.persona ?? mine[0]?.persona ?? null,
      browser: job.browser ?? mine[0]?.environment.browser ?? 'chromium',
      device,
      device_kind: deviceById(device)?.kind ?? (mine[0] && mine[0].environment.viewport.width <= 500 ? 'narrow desktop' : 'desktop'),
      goal: job.goal ?? '',
      status: job.status ?? (t?.ok === false ? 'failed' : 'done'),
      model: t?.model ?? null,
      ms: t?.ms ?? (job.startedAt && job.endedAt ? job.endedAt - job.startedAt : 0),
      api_ms: t?.api_ms ?? 0,
      turns: t?.turns ?? 0,
      cost_usd: t?.cost_usd ?? 0,
      tokens: t?.tokens ?? zeroTokens(),
      tool_calls: calls,
      tool_errors: toolLog.length ? toolLog.filter((e) => !e.ok && !e.blocked).length : t?.tool_errors ?? 0,
      blocked: toolLog.filter((e) => e.blocked && e.blocked !== 'budget').length,
      raw: mine.length,
      survived,
      flaky: statuses.filter((x) => x === 'flaky').length,
      low_confidence: statuses.filter((x) => x === 'low_confidence').length,
      false_positive: statuses.filter((x) => x === 'false_positive' || x === 'suppressed').length,
      unique_new: [...firstBy.values()].filter((v) => v.session === id).length,
      first_finding_ms: firstFinding && startMs ? Math.max(0, firstFinding - startMs) : null,
      bugs_per_10_calls: calls ? Math.round((survived / calls) * 100) / 10 : null,
      hypotheses: { confirmed: hyps.filter((h) => h.session === id && h.outcome === 'confirmed').length, refuted: hyps.filter((h) => h.session === id && h.outcome === 'refuted').length, inconclusive: hyps.filter((h) => h.session === id && h.outcome === 'inconclusive').length },
      observes: log.filter((e) => e.kind === 'observe').length,
      new_states: log.filter((e) => e.kind === 'observe' && e.isNew).length,
      recoveries: log.filter((e) => e.kind === 'recovered').length,
      error: job.error ?? (t?.ok === false ? t.result : null),
    };
  });

  // ---- phases ----
  const lead = summarizeTranscript(join(dir, 'transcripts', 'lead.jsonl'));
  const triageDir = join(dir, 'transcripts', 'triage');
  const triageT = existsSync(triageDir) ? readdirSync(triageDir).filter((f) => f.endsWith('.jsonl')).map((f) => summarizeTranscript(join(triageDir, f))!).filter(Boolean) : [];
  const fixJobs = listJobs({ runDir: dir }).filter((j) => j.kind === 'fix');
  const fixes = fixJobs.map((j) => {
    const events = readEvents(j.dir).events;
    const attempts = new Set(events.filter((e) => /^attempt:\d+$/.test(e.stage)).map((e) => e.stage)).size;
    const lastVerify = [...events].reverse().find((e) => /^verify:\d+$/.test(e.stage));
    const fdir = j.branch ? join(dir, 'fixes', j.branch.replace(/\//g, '__')) : null;
    const ts = fdir && existsSync(fdir) ? readdirSync(fdir).filter((f) => /^agent-attempt-\d+\.jsonl$/.test(f)).map((f) => summarizeTranscript(join(fdir, f))!).filter(Boolean) : [];
    return {
      job: j.id,
      findings: j.finding_ids,
      state: j.state,
      attempts,
      verified: j.verified,
      regressions: Array.isArray(lastVerify?.data?.regressions) ? (lastVerify!.data!.regressions as unknown[]).length : 0,
      ms: j.ended_at ? Date.parse(j.ended_at) - Date.parse(j.started_at) : Date.now() - Date.parse(j.started_at),
      cost_usd: ts.reduce((a, t) => a + t.cost_usd, 0),
      tokens: ts.reduce((a, t) => addTokens(a, t.tokens), zeroTokens()),
      branch: j.branch,
      pr_url: j.pr_url,
      error: j.error,
    };
  });
  const sumT = (ts: (TranscriptSummary | null)[]) => ts.filter(Boolean).reduce((a, t) => ({ cost_usd: a.cost_usd + t!.cost_usd, tokens: addTokens(a.tokens, t!.tokens), ms: a.ms + t!.ms, api_ms: a.api_ms + t!.api_ms, agents: a.agents + 1 }), { cost_usd: 0, tokens: zeroTokens(), ms: 0, api_ms: 0, agents: 0 });
  const exploreSum = explorers.reduce((a, e) => ({ cost_usd: a.cost_usd + e.cost_usd, tokens: addTokens(a.tokens, e.tokens), ms: a.ms + e.ms, api_ms: a.api_ms + e.api_ms, agents: a.agents + 1 }), { cost_usd: 0, tokens: zeroTokens(), ms: 0, api_ms: 0, agents: 0 });
  const fixSum = fixes.reduce((a, f) => ({ cost_usd: a.cost_usd + f.cost_usd, tokens: addTokens(a.tokens, f.tokens), ms: a.ms + f.ms, api_ms: a.api_ms, agents: a.agents + 1 }), { cost_usd: 0, tokens: zeroTokens(), ms: 0, api_ms: 0, agents: 0 });
  const phases = [
    { phase: 'lead', ...sumT([lead]) },
    { phase: 'explore', ...exploreSum },
    { phase: 'triage', ...sumT(triageT) },
    { phase: 'fix', ...fixSum },
  ];

  // ---- breakdowns ----
  const by = (key: (e: ExplorerRow) => string) => {
    const m = new Map<string, { key: string; sessions: number; raw: number; survived: number; cost_usd: number; tool_calls: number }>();
    for (const e of explorers) {
      const k = key(e);
      const r = m.get(k) ?? { key: k, sessions: 0, raw: 0, survived: 0, cost_usd: 0, tool_calls: 0 };
      r.sessions++;
      r.raw += e.raw;
      r.survived += e.survived;
      r.cost_usd += e.cost_usd;
      r.tool_calls += e.tool_calls;
      m.set(k, r);
    }
    return [...m.values()].map((r) => ({ ...r, precision: r.raw ? r.survived / r.raw : null })).sort((a, b) => b.survived - a.survived);
  };

  // ---- discovery curve ----
  const points = [...firstBy.values()].sort((a, b) => a.at - b.at).map((v, i) => ({ t_ms: v.at - runStart, unique: i + 1, session: v.session, title: v.title }));
  const discovery = {
    points,
    sessions: jobs.filter((j) => j.startedAt).map((j) => ({ id: j.id, start_ms: j.startedAt - runStart, end_ms: j.endedAt ? j.endedAt - runStart : null, persona: j.persona ?? null })),
    stop_ms: info.ended_at ? Date.parse(info.ended_at) - runStart : null,
    stop_reason: info.stop_reason,
  };

  // ---- coverage matrix: pages × devices / desktop viewports ----
  const cov = mergeAll(dir);
  const devCols = new Set<string>();
  const vpCols = new Set<string>();
  for (const pc of Object.values(cov)) {
    for (const d of pc.devices ?? []) devCols.add(d);
    for (const v of pc.viewports ?? []) vpCols.add(v);
  }
  const devVps = new Set([...devCols].map((d) => deviceById(d)).filter(Boolean).map((d) => `${d!.viewport.width}x${d!.viewport.height}`));
  const desktopVps = [...vpCols].filter((v) => !devVps.has(v)).sort((a, b) => parseInt(a) - parseInt(b));
  // Older runs only recorded widths: fall back to width columns.
  const widthsOnly = !devCols.size && !vpCols.size;
  const allWidths = [...new Set(Object.values(cov).flatMap((pc) => pc.widths ?? []))].sort((a, b) => a - b);
  const columns = widthsOnly
    ? allWidths.slice(0, 20).map((w) => ({ id: `w:${w}`, label: `${w}px`, kind: 'width' }))
    : [
        ...[...devCols].map((d) => ({ id: `device:${d}`, label: deviceById(d)?.label ?? d, kind: deviceById(d)?.kind ?? 'device' })),
        ...desktopVps.slice(-16).map((v) => ({ id: `vp:${v}`, label: v.replace('x', '×'), kind: 'window' })),
      ];
  const active = finals.filter((f) => SURVIVED.has(f.status));
  const pages = Object.keys(cov).filter((p) => p !== 'blank').sort();
  const cells: Record<string, Record<string, { tested: boolean; bugs: number }>> = {};
  for (const p of pages) {
    cells[p] = {};
    for (const c of columns) {
      const w = c.id.startsWith('w:') ? Number(c.id.slice(2)) : null;
      const tested = w !== null ? (cov[p].widths ?? []).includes(w) : c.id.startsWith('device:') ? (cov[p].devices ?? []).includes(c.id.slice(7)) : (cov[p].viewports ?? []).includes(c.id.slice(3));
      const bugs = active.filter((f) => f.page === p && (w !== null ? f.viewports.some((v) => v.width === w) : c.id.startsWith('device:') ? f.reproduction.environment.variant.device === c.id.slice(7) : !f.reproduction.environment.variant.device && f.viewports.some((v) => `${v.width}x${v.height}` === c.id.slice(3)))).length;
      cells[p][c.id] = { tested, bugs };
    }
  }

  // ---- strategies ----
  const stratIds = new Set<string>([...Object.values(cov).flatMap((pc) => pc.strategies ?? []), ...raw.map((r) => r.strategy).filter(Boolean) as string[], ...hyps.map((h) => h.strategy).filter(Boolean) as string[]]);
  const strategies = [...stratIds]
    .map((id) => ({
      id,
      pages: Object.values(cov).filter((pc) => (pc.strategies ?? []).includes(id)).length,
      hypotheses: hyps.filter((h) => h.strategy === id).length,
      raw: raw.filter((r) => r.strategy === id).length,
      survived: raw.filter((r) => r.strategy === id && SURVIVED.has(statusOfRaw(r))).length,
    }))
    .sort((a, b) => b.survived - a.survived || b.raw - a.raw);

  // ---- tools ----
  const toolEntries = sessionIds.flatMap((id) => readLines(join(dir, 'sessions', `${id}.jsonl`)).filter((e) => e.kind === 'tool'));
  const timed = toolEntries.length > 0;
  const toolNames = new Set<string>([...toolEntries.map((e) => e.name), ...explorers.flatMap((e) => Object.keys(summarizeTranscript(join(dir, 'transcripts', `${e.id}.jsonl`))?.tools ?? {}))]);
  const tools = [...toolNames]
    .map((name) => {
      const es = toolEntries.filter((e) => e.name === name);
      const counted = timed ? es.length : explorers.reduce((a, e) => a + (summarizeTranscript(join(dir, 'transcripts', `${e.id}.jsonl`))?.tools[name] ?? 0), 0);
      const ms = es.map((e) => e.ms as number);
      return { name, calls: counted, errors: es.filter((e) => !e.ok && !e.blocked).length, blocked: es.filter((e) => e.blocked && e.blocked !== 'budget').length, p50_ms: pct(ms, 50), p95_ms: pct(ms, 95) };
    })
    .sort((a, b) => b.calls - a.calls);

  // ---- triage quality ----
  const ts = readJsonSafe<any>(join(dir, 'triage-stats.json'), null);
  const rateDist: Record<string, number> = {};
  for (const f of finals) rateDist[f.reproduction.rate ?? 'n/a'] = (rateDist[f.reproduction.rate ?? 'n/a'] ?? 0) + 1;
  const reviewerFromNotes = { defect: 0, not_defect: 0, unavailable: 0, skipped: 0 };
  for (const f of finals) {
    const n = f.confidence_breakdown.notes.find((x) => x.startsWith('reviewer'));
    if (!n) reviewerFromNotes.skipped++;
    else if (/unavailable/.test(n)) reviewerFromNotes.unavailable++;
    else if (/NOT a defect/.test(n)) reviewerFromNotes.not_defect++;
    else reviewerFromNotes.defect++;
  }
  const minRatios = finals.filter((f) => f.reproduction.steps_original.length).map((f) => f.reproduction.steps_minimal.length / f.reproduction.steps_original.length);
  const triage = {
    triaged: !!ff,
    ms: ts?.ms ?? null,
    cost_usd: phases[2].cost_usd,
    raw: raw.length,
    clusters: finals.length,
    duplicate_rate: raw.length ? 1 - finals.length / raw.length : null,
    verifiable_pct: finals.length ? finals.filter((f) => f.reproduction.rate && f.reproduction.rate !== '0/1').length / finals.length : null,
    rate_dist: rateDist,
    minimization_avg: minRatios.length ? minRatios.reduce((a, b) => a + b, 0) / minRatios.length : null,
    reviewer: ts?.findings ? { defect: ts.findings.filter((x: any) => x.reviewer === 'defect').length, not_defect: ts.findings.filter((x: any) => x.reviewer === 'not_defect').length, unavailable: ts.findings.filter((x: any) => x.reviewer === 'unavailable').length, skipped: ts.findings.filter((x: any) => x.reviewer === 'skipped').length } : reviewerFromNotes,
    videos: finals.filter((f) => f.video).length,
    rerecorded: ts?.findings ? ts.findings.filter((x: any) => x.video_rerecorded).length : null,
    grouping: ts?.grouping ?? null,
    statuses: finals.reduce<Record<string, number>>((a, f) => ((a[f.status] = (a[f.status] ?? 0) + 1), a), {}),
  };

  // ---- reliability ----
  const blockedOf = (k: string) => toolEntries.filter((e) => e.blocked === k).length;
  const reliability = {
    failed_sessions: explorers.filter((e) => e.status === 'failed').length,
    limit_stops: explorers.filter((e) => /usage limit|session limit/i.test(e.error ?? '')).length + (/usage limit/i.test(info.stop_reason ?? '') ? 1 : 0),
    recoveries: explorers.reduce((a, e) => a + e.recoveries, 0),
    tool_errors: explorers.reduce((a, e) => a + e.tool_errors, 0),
    guardrail_blocks: blockedOf('guardrail'),
    persona_refusals: blockedOf('persona'),
    selection_refusals: blockedOf('selection'),
    hypothesis_checkins: blockedOf('process'),
    budget_exhausted: explorers.filter((e) => readLines(join(dir, 'sessions', `${e.id}.jsonl`)).some((x) => x.kind === 'tool' && x.blocked === 'budget')).length,
    reviewer_unavailable: triage.reviewer.unavailable,
    tool_logging: timed,
  };

  const realBugs = active.length;
  const totalCost = phases.reduce((a, p) => a + p.cost_usd, 0);
  const totalTokens = phases.reduce((a, p) => addTokens(a, p.tokens), zeroTokens());
  const totalCalls = explorers.reduce((a, e) => a + e.tool_calls, 0);
  return {
    run: { run: info.run_id, name: info.name ?? null, target: info.target, started_at: info.started_at, ended_at: info.ended_at, stop_reason: info.stop_reason },
    kpis: {
      cost_usd: totalCost,
      tokens: tokenTotal(totalTokens),
      tokens_detail: totalTokens,
      wall_ms: info.ended_at ? Date.parse(info.ended_at) - runStart : null,
      agent_ms: phases.reduce((a, p) => a + p.ms, 0),
      sessions: explorers.length,
      real_bugs: realBugs,
      cost_per_real_bug: realBugs ? totalCost / realBugs : null,
      precision: raw.length && ff ? explorers.reduce((a, e) => a + e.survived, 0) / raw.length : null,
      tool_error_rate: totalCalls ? reliability.tool_errors / totalCalls : null,
    },
    phases,
    explorers,
    lead: lead ? { ...lead, decisions: (readJsonSafe<any>(join(dir, 'campaign.json'), null)?.decisions ?? info.lead_decisions ?? []).length } : null,
    by: { persona: by((e) => e.persona ?? 'general'), browser: by((e) => e.browser), device_kind: by((e) => e.device_kind) },
    discovery,
    coverage: { pages, columns, cells },
    strategies,
    tools,
    tools_timed: timed,
    triage,
    reliability,
    fixes,
  };
}

// ---------------- accuracy (workspace / repo level) ----------------
/** Labels are merged across the given workspaces; calibration comes from the first workspace that has one. */
export function accuracy(wsPaths: string[]) {
  const labels = wsPaths.flatMap((w) => readLines<{ type: string; label: string }>(join(w, 'memory', 'labels.jsonl')));
  const byType = new Map<string, { type: string; confirmed: number; false_positive: number }>();
  for (const l of labels) {
    const r = byType.get(l.type) ?? { type: l.type, confirmed: 0, false_positive: 0 };
    if (l.label === 'confirmed') r.confirmed++;
    else r.false_positive++;
    byType.set(l.type, r);
  }
  const calibration = wsPaths.map((w) => readJsonSafe<{ table?: unknown[] } | null>(join(w, 'memory', 'calibration.json'), null)).find((c) => c?.table) ?? null;
  const benchDir = join(REPO_ROOT, 'bench', 'results');
  const bench = existsSync(benchDir)
    ? readdirSync(benchDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => readJsonSafe<any>(join(benchDir, f), null))
        .filter(Boolean)
        .map((b) => ({ run: b.run, recall: b.recall, precision: b.precision_vs_manifest, recall_by_kind: b.recall_by_kind, sessions: b.sessions, version: b.agent_version ?? null }))
        .sort((a, b) => String(a.run).localeCompare(String(b.run)))
    : [];
  return {
    labels: labels.length,
    precision_by_type: [...byType.values()].map((r) => ({ ...r, precision: r.confirmed + r.false_positive ? r.confirmed / (r.confirmed + r.false_positive) : null })).sort((a, b) => b.confirmed + b.false_positive - (a.confirmed + a.false_positive)),
    calibration: calibration?.table ?? null,
    bench,
  };
}

// ---------------- cache + entry points ----------------
const cache = new Map<string, { key: string; at: number; value: ReturnType<typeof runAgentStats> }>();
const stamp = (dir: string) =>
  ['run.json', 'findings.json', 'campaign.json', 'agent-findings.jsonl', 'triage-stats.json', 'hypotheses.jsonl', 'sessions', 'transcripts', 'jobs']
    .map((f) => {
      try {
        return statSync(join(dir, f)).mtimeMs;
      } catch {
        return 0;
      }
    })
    .join('|');

export function cachedRunStats(dir: string) {
  const key = stamp(dir);
  const hit = cache.get(dir);
  // Live runs append to files without touching directory mtimes: also expire after a few seconds.
  if (hit && hit.key === key && Date.now() - hit.at < 5000) return hit.value;
  const value = runAgentStats(dir);
  cache.set(dir, { key, at: Date.now(), value });
  return value;
}

export function agentsOverview(scope: { ws: string; run: string } | null) {
  const runs = listAllRuns();
  if (scope) {
    const r = runs.find((x) => x.ws === scope.ws && x.run === scope.run);
    if (!r) throw new HttpError(404, `Unknown run ${scope.run}`);
    return { scope: 'run' as const, stats: cachedRunStats(join(r.ws_path, 'runs', r.run)), accuracy: accuracy([r.ws_path]) };
  }
  const rows = runs.map((r) => {
    const s = cachedRunStats(join(r.ws_path, 'runs', r.run));
    return {
      ws: r.ws,
      run: r.run,
      name: r.name,
      target: r.target,
      started_at: r.started_at,
      triaged: r.triaged,
      cost_usd: s.kpis.cost_usd,
      tokens: s.kpis.tokens,
      phases: Object.fromEntries(s.phases.map((p) => [p.phase, p.cost_usd])),
      sessions: s.kpis.sessions,
      raw: s.triage.raw,
      real_bugs: s.kpis.real_bugs,
      precision: s.kpis.precision,
      cost_per_real_bug: s.kpis.cost_per_real_bug,
      wall_ms: s.kpis.wall_ms,
      tool_error_rate: s.kpis.tool_error_rate,
      failed_sessions: s.reliability.failed_sessions,
      reviewer_unavailable: s.reliability.reviewer_unavailable,
    };
  });
  const sum = (k: 'cost_usd' | 'tokens' | 'sessions' | 'raw' | 'real_bugs') => rows.reduce((a, r) => a + (r[k] ?? 0), 0);
  const ws = [...new Set(runs.map((r) => r.ws_path))];
  return {
    scope: 'all' as const,
    runs: rows.sort((a, b) => a.started_at.localeCompare(b.started_at)),
    totals: { cost_usd: sum('cost_usd'), tokens: sum('tokens'), sessions: sum('sessions'), raw: sum('raw'), real_bugs: sum('real_bugs'), runs: rows.length },
    accuracy: ws.length ? accuracy(ws) : null,
  };
}
