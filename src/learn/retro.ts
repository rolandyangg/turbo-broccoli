import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runClaude } from '../llm/claude.js';
import { readRun, readFindings, allFindings } from '../store/store.js';
import { RawFinding, Hypothesis, FindingType, categoryOf, type Finding } from '../store/schema.js';
import { fingerprintOf as rawFingerprint } from '../triage/cluster.js';
import { DETECTABLE } from '../triage/replay.js';
import { STRATEGY_IDS } from '../explore/strategies.js';
import { Memory } from '../memory/siteMemory.js';
import { JobReporter, newJobId, describeAgentEvent } from '../jobs/events.js';
import { notifyProposals } from '../notify/events.js';
import { addProposals, listImprovementRuns, rejected, priorsText, setRetroResult, type NewProposal } from './proposals.js';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const SURVIVED = new Set(['new', 'confirmed', 'fixing', 'fixed']);

const readLines = <T>(file: string, parse: (x: unknown) => T): T[] => {
  if (!existsSync(file)) return [];
  const out: T[] = [];
  for (const l of readFileSync(file, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    try {
      out.push(parse(JSON.parse(l)));
    } catch {}
  }
  return out;
};
const readJson = <T>(f: string): T | null => {
  try {
    return JSON.parse(readFileSync(f, 'utf8')) as T;
  } catch {
    return null;
  }
};
const tally = <T>(xs: T[], key: (x: T) => string | null | undefined) => xs.reduce<Record<string, number>>((a, x) => ((a[key(x) ?? 'none'] = (a[key(x) ?? 'none'] ?? 0) + 1), a), {});

/** The evidence the retrospective reasons over: compact numbers, not whole transcripts (it may Read those itself). */
export function retroInput(runDir: string) {
  const info = readRun(runDir);
  const ff = readFindings(runDir);
  const findings: Finding[] = ff ? allFindings(ff) : [];
  const raw = readLines(join(runDir, 'agent-findings.jsonl'), (x) => RawFinding.parse(x));
  const hyps = readLines(join(runDir, 'hypotheses.jsonl'), (x) => Hypothesis.parse(x));
  const byFp = new Map(findings.map((f) => [f.fingerprint, f]));
  const statusOfRaw = (r: RawFinding) => byFp.get(rawFingerprint(r))?.status ?? 'unknown';
  const campaign = readJson<{ jobs?: { id: string; persona: string | null; browser: string; pages: string[]; status: string; tool_calls: number | null; new_findings: number | null; error: string | null }[]; stop_reason?: string; decisions?: string[] }>(join(runDir, 'campaign.json'));
  const triage = readJson<{ findings?: { id: string; type: string; presence: string; reviewer: string; rate: string | null }[]; raw_findings?: number; clusters?: number }>(join(runDir, 'triage-stats.json'));
  const memory = new Memory(info.workspace);
  const labels = memory.labels().filter((l) => l.run === info.run_id);
  const bench = readJson<{ recall: number; per_bug: { id: string; kind: string; found: boolean }[]; unmatched_active: string[]; precision_vs_manifest: number | null }>(join(ROOT, 'bench', 'results', `${info.run_id}.json`));

  // Tool usage and refusals from the per-session logs.
  const sessDir = join(runDir, 'sessions');
  const toolLog = existsSync(sessDir) ? readdirSync(sessDir).filter((f) => f.endsWith('.jsonl')).flatMap((f) => readLines(join(sessDir, f), (x) => x as { kind?: string; name?: string; ok?: boolean; blocked?: string })) : [];
  const tools = toolLog.filter((e) => e.kind === 'tool');

  const sessions = (campaign?.jobs ?? []).map((j) => {
    const mine = raw.filter((r) => r.session === j.id);
    return { id: j.id, persona: j.persona, browser: j.browser, pages: j.pages, status: j.status, tool_calls: j.tool_calls, error: j.error?.slice(0, 160) ?? null, raw: mine.length, survived: mine.filter((r) => SURVIVED.has(statusOfRaw(r))).length, transcript: `transcripts/${j.id}.jsonl` };
  });
  const strategies = STRATEGY_IDS.map((id) => {
    const h = hyps.filter((x) => x.strategy === id);
    const r = raw.filter((x) => x.strategy === id);
    return { id, hypotheses: h.length, confirmed: h.filter((x) => x.outcome === 'confirmed').length, raw: r.length, survived: r.filter((x) => SURVIVED.has(statusOfRaw(x))).length };
  }).filter((s) => s.hypotheses || s.raw);

  // Types reported visually with no detector behind them (detector-suggestion signal).
  const noDetector = raw.filter((r) => !r.detector);
  const undetectable = tally(
    noDetector.filter((r) => !DETECTABLE.has(r.type) || !r.detector),
    (r) => r.type,
  );

  return {
    run: { id: info.run_id, name: info.name ?? null, target: info.target, started_at: info.started_at, stop_reason: info.stop_reason },
    totals: { raw: raw.length, unique: findings.length, duplicate_rate: raw.length ? Math.round((1 - findings.length / raw.length) * 100) / 100 : null, survived: findings.filter((f) => SURVIVED.has(f.status)).length },
    findings: findings.map((f) => ({ id: f.id, type: f.type, category: f.category ?? categoryOf(f.type), status: f.status, severity: f.severity, page: f.page, title: f.title.slice(0, 120), strategy: f.found_by.strategy, persona: f.found_by.persona, sessions: f.found_by.session, rate: f.reproduction.rate })),
    by_status: tally(findings, (f) => f.status),
    by_type: tally(findings, (f) => f.type),
    sessions,
    strategies,
    hypotheses: { total: hyps.length, by_outcome: tally(hyps, (h) => h.outcome), without_strategy: hyps.filter((h) => !h.strategy).length },
    raw_without_detector: { count: noDetector.length, by_type: undetectable, examples: noDetector.slice(0, 12).map((r) => ({ session: r.session, type: r.type, page: r.page, title: r.title.slice(0, 120), status: statusOfRaw(r) })) },
    triage: triage ? { presence: tally(triage.findings ?? [], (x) => x.presence), reviewer: tally(triage.findings ?? [], (x) => x.reviewer) } : null,
    tools: { by_name: tally(tools, (t) => t.name), errors: tools.filter((t) => t.ok === false && !t.blocked).length, refused: tally(tools.filter((t) => t.blocked), (t) => t.blocked) },
    lead: { decisions: (campaign?.decisions ?? info.lead_decisions ?? []).slice(0, 30), transcript: 'transcripts/lead.jsonl' },
    labels: { total: labels.length, false_positive_by_type: tally(labels.filter((l) => l.label === 'false_positive'), (l) => l.type), confirmed_by_type: tally(labels.filter((l) => l.label === 'confirmed'), (l) => l.type) },
    bench: bench ? { recall: bench.recall, precision_vs_manifest: bench.precision_vs_manifest, missed: bench.per_bug.filter((b) => !b.found).map((b) => `${b.id} (${b.kind})`), unmatched_active: bench.unmatched_active.slice(0, 15) } : null,
    memory: { lessons_tail: memory.lessons().slice(-2000), priors: priorsText(info.workspace) },
    // So it doesn't suggest detectors or personas that already exist / are switched off on purpose.
    detectors_available: [...DETECTABLE],
    personas: { used: [...new Set(sessions.map((x) => x.persona).filter(Boolean))], disabled: ((info.config as { disabledPersonas?: string[] })?.disabledPersonas ?? []) },
  };
}

export const PROPOSAL_ITEM = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['lesson', 'prior', 'detector', 'tweak'] },
    scope: { type: 'string', enum: ['site', 'general'] },
    title: { type: 'string', description: 'One line: the change, stated as an instruction' },
    body: { type: 'string', description: 'Why, in 1-4 sentences, citing the numbers / finding ids' },
    prior: {
      type: 'object',
      properties: { strategy: { type: 'string', enum: STRATEGY_IDS }, persona: { type: ['string', 'null'] }, page_kind: { type: ['string', 'null'] }, effect: { type: 'string', enum: ['prefer', 'avoid'] } },
      required: ['strategy', 'effect'],
    },
    detector: { type: 'object', properties: { finding_type: { type: 'string', enum: FindingType.options }, sketch: { type: 'string', description: 'How an in-page check could detect it (DOM/CSS measurements)' } }, required: ['finding_type', 'sketch'] },
    tweak: { type: 'object', properties: { target: { type: 'string', enum: ['explorer-prompt', 'lead-prompt', 'triage', 'config'] }, change: { type: 'string' } }, required: ['target', 'change'] },
    evidence: {
      type: 'object',
      properties: { finding_ids: { type: 'array', items: { type: 'string' } }, numbers: { type: 'array', items: { type: 'string' } }, transcripts: { type: 'array', items: { type: 'string' } } },
    },
  },
  required: ['kind', 'title', 'body', 'evidence'],
};
export const RETRO_SCHEMA = {
  type: 'object',
  properties: { summary: { type: 'string', description: '2-4 sentences: how the run went and the main lesson' }, proposals: { type: 'array', items: PROPOSAL_ITEM, maxItems: 8 } },
  required: ['summary', 'proposals'],
};

const RETRO_SYSTEM = `You are the post-mortem reviewer for an automated UI bug-bash run (a lead agent planning explorer agents that drive browsers to find layout/UI defects; triage replays and dedupes them).
Your output is PROPOSALS for a person to approve one by one. Nothing you write changes the agents unless approved, so be specific, evidence-backed and few (0-8). Prefer no proposal over a weak one.

Kinds:
- lesson: a durable, concrete note future leads/explorers on this site should know (scope "site"), or a general bug-bashing lesson (scope "general"). E.g. "The pricing modal needs 'Compare plans' clicked first; check it on phones in landscape".
- prior: a strategy that clearly paid off (prefer) or clearly wasted calls (avoid), optionally for a persona / page kind. Needs numbers (hypotheses, raw → surviving findings).
- detector: a defect type explorers reported visually several times with no detector evidence, so triage couldn't verify it. Give a concrete in-page detection sketch. Check "detectors_available" first: improving an existing detector is a tweak, not a new detector.
- tweak: a change to the explorer prompt, lead prompt, triage, or config (e.g. "explorers re-recorded known bugs: show known findings in the brief").

Rules:
- Don't build proposals around disabled personas ("personas.disabled").
- Cite evidence: finding ids, the numbers you used, and transcript paths (relative to the run dir) when you read one.
- Don't propose anything in the "already decided" lists (approved, pending or rejected) again, even reworded.
- Don't propose lessons that just restate a bug that was found; lessons are about how to find bugs here.
- You may Read files in the run directory (transcripts/*.jsonl, sessions/*.jsonl, findings.json) to check a hunch; stay brief.`;

export interface RetroOptions {
  runDir: string;
  model?: string | null;
  log?: (m: string) => void;
  jobId?: string | null;
}

/** Runs the retrospective for a triaged run and stores its proposals (pending approval). */
export async function runRetro(o: RetroOptions) {
  const log = o.log ?? (() => {});
  const info = readRun(o.runDir);
  const rep = new JobReporter(join(o.runDir, 'jobs'), o.jobId ?? newJobId('retro'), 'retro', { run_dir: o.runDir, scope: info.run_id });
  try {
    if (!readFindings(o.runDir)) throw new Error('Run has no findings.json (triage it first).');
    rep.event('collect', 'Collecting run metrics');
    const input = retroInput(o.runDir);
    const decided = listImprovementRuns(info.workspace).flatMap((f) => f.proposals.map((p) => `${p.status}: [${p.kind}] ${p.title}`));
    const rej = rejected(info.workspace).map((r) => `rejected: [${r.kind}] ${r.title}`);
    const prompt = [
      `# Run metrics\n${JSON.stringify(input, null, 1)}`,
      `# Already decided or pending (do not propose again)\n${[...decided, ...rej].slice(-80).join('\n') || '(none)'}`,
      `Return your summary and proposals.`,
    ].join('\n\n');
    rep.event('agent', 'Retrospective agent reviewing the run');
    log('Retrospective agent reviewing the run…');
    const r = await runClaude({
      prompt,
      systemPrompt: RETRO_SYSTEM,
      tools: ['Read', 'Grep', 'Glob'],
      allowedTools: ['Read', 'Grep', 'Glob'],
      cwd: o.runDir,
      model: o.model ?? null,
      jsonSchema: RETRO_SCHEMA,
      timeoutMs: 10 * 60_000,
      transcriptPath: join(o.runDir, 'transcripts', 'retro.jsonl'),
      onEvent: (e) => {
        for (const d of describeAgentEvent(e)) rep.event('agent', d.msg, 'agent', d.data);
      },
    });
    const out = r.structured as { summary?: string; proposals?: NewProposal[] } | null;
    if (!r.ok || !out || !Array.isArray(out.proposals)) throw new Error(r.error ?? 'Retrospective returned no proposals');
    const { added, skipped } = addProposals(info.workspace, info.run_id, 'retro', out.proposals);
    setRetroResult(info.workspace, info.run_id, { ok: true, at: new Date().toISOString(), error: null, summary: String(out.summary ?? '').slice(0, 2000), job_id: rep.status.id });
    const msg = `${added.length} proposal(s) waiting for review${skipped.length ? `, ${skipped.length} skipped (${skipped.map((s) => s.reason).join(', ')})` : ''}`;
    log(msg);
    rep.finish('succeeded', { summary: msg });
    notifyProposals(added.length, String(out.summary ?? ''));
    return { added, skipped, summary: out.summary ?? '' };
  } catch (e) {
    const msg = (e as Error).message;
    setRetroResult(info.workspace, info.run_id, { ok: false, at: new Date().toISOString(), error: msg.slice(0, 500), summary: '', job_id: rep.status.id });
    rep.finish('failed', { error: msg });
    throw e;
  }
}
