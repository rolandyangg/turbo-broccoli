import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Memory } from '../memory/siteMemory.js';

/**
 * Improvement proposals: what the retrospective (and the lead) want the agents to learn. Nothing here changes an
 * agent until a person approves it on the Improvements page (or with the CLI):
 *   <workspace>/improvements/<run>.json   proposals per run (pending / approved / rejected)
 *   <workspace>/improvements/rejected.json fingerprints never to propose again
 *   <workspace>/improvements/backlog.json  approved detector suggestions and prompt/config tweaks (code changes)
 *   <workspace>/memory/lessons.md          approved lessons (read by future leads and explorers)
 *   <workspace>/memory/priors.json         approved strategy priors
 */
export const ProposalKind = z.enum(['lesson', 'prior', 'detector', 'tweak']);
export type ProposalKind = z.infer<typeof ProposalKind>;

export const Proposal = z.object({
  id: z.string(), // P-<run short>-<n>
  run: z.string(),
  source: z.enum(['retro', 'lead', 'report']),
  kind: ProposalKind,
  scope: z.enum(['site', 'general']).default('site'),
  title: z.string(),
  body: z.string(),
  prior: z
    .object({
      strategy: z.string(),
      persona: z.string().nullable().default(null),
      page_kind: z.string().nullable().default(null),
      effect: z.enum(['prefer', 'avoid']),
    })
    .nullable()
    .default(null),
  detector: z.object({ finding_type: z.string(), sketch: z.string() }).nullable().default(null),
  tweak: z.object({ target: z.enum(['explorer-prompt', 'lead-prompt', 'triage', 'config']), change: z.string() }).nullable().default(null),
  evidence: z
    .object({
      finding_ids: z.array(z.string()).default([]),
      numbers: z.array(z.string()).default([]),
      transcripts: z.array(z.string()).default([]),
    })
    .default(() => ({ finding_ids: [], numbers: [], transcripts: [] })),
  status: z.enum(['pending', 'approved', 'rejected']).default('pending'),
  edited: z.boolean().default(false),
  decision_note: z.string().nullable().default(null),
  decided_at: z.string().nullable().default(null),
  fingerprint: z.string(),
  created_at: z.string(),
});
export type Proposal = z.infer<typeof Proposal>;

export const ImprovementsFile = z.object({
  run: z.string(),
  updated_at: z.string(),
  retro: z
    .object({ ok: z.boolean(), at: z.string(), error: z.string().nullable().default(null), summary: z.string().default(''), job_id: z.string().nullable().default(null) })
    .nullable()
    .default(null),
  proposals: z.array(Proposal).default([]),
});
export type ImprovementsFile = z.infer<typeof ImprovementsFile>;

export const BacklogItem = z.object({
  id: z.string(), // B-<n>
  proposal_id: z.string(),
  run: z.string(),
  kind: z.enum(['detector', 'tweak']),
  title: z.string(),
  body: z.string(),
  detector: Proposal.shape.detector,
  tweak: Proposal.shape.tweak,
  status: z.enum(['open', 'implementing', 'implemented', 'merged', 'failed', 'closed']).default('open'),
  branch: z.string().nullable().default(null),
  job_id: z.string().nullable().default(null),
  pr_url: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
  created_at: z.string(),
});
export type BacklogItem = z.infer<typeof BacklogItem>;

export const Prior = z.object({
  id: z.string(),
  strategy: z.string(),
  persona: z.string().nullable(),
  page_kind: z.string().nullable(),
  effect: z.enum(['prefer', 'avoid']),
  reason: z.string(),
  proposal_id: z.string(),
  approved_at: z.string(),
});
export type Prior = z.infer<typeof Prior>;

/** What a proposer supplies (ids, status and fingerprints are filled in here). */
export type NewProposal = Pick<Proposal, 'kind' | 'title' | 'body'> & Partial<Pick<Proposal, 'scope' | 'prior' | 'detector' | 'tweak'>> & { evidence?: Partial<Proposal['evidence']> };

const dirOf = (ws: string) => join(ws, 'improvements');
const runFile = (ws: string, run: string) => join(dirOf(ws), `${run}.json`);
const readJson = <T>(f: string, fallback: T): T => {
  if (!existsSync(f)) return fallback;
  try {
    return JSON.parse(readFileSync(f, 'utf8')) as T;
  } catch {
    return fallback;
  }
};
const writeJson = (f: string, v: unknown) => {
  mkdirSync(join(f, '..'), { recursive: true });
  writeFileSync(f, JSON.stringify(v, null, 2) + '\n');
};
const now = () => new Date().toISOString();

/** Same idea → same fingerprint, so a rejected idea is not proposed again in other words of the same shape. */
export function fingerprintOf(p: NewProposal): string {
  const words = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .filter((w) => w.length > 2 && !STOP.has(w));
  const key =
    p.kind === 'prior' && p.prior
      ? `prior|${p.prior.strategy}|${p.prior.effect}|${p.prior.persona ?? ''}|${p.prior.page_kind ?? ''}`
      : p.kind === 'detector' && p.detector
        ? `detector|${p.detector.finding_type}|${[...new Set(words(p.title))].sort().join(' ')}`
        : `${p.kind}|${[...new Set(words(p.title))].sort().join(' ')}`;
  return createHash('sha1').update(key).digest('hex').slice(0, 12);
}
const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'when', 'from', 'into', 'are', 'not', 'use', 'should']);

export function readImprovements(ws: string, run: string): ImprovementsFile {
  const raw = readJson<unknown>(runFile(ws, run), null);
  const parsed = raw ? ImprovementsFile.safeParse(raw) : null;
  return parsed?.success ? parsed.data : { run, updated_at: now(), retro: null, proposals: [] };
}
function writeImprovements(ws: string, f: ImprovementsFile) {
  writeJson(runFile(ws, f.run), { ...f, updated_at: now() });
}

export function listImprovementRuns(ws: string): ImprovementsFile[] {
  const d = dirOf(ws);
  if (!existsSync(d)) return [];
  return readdirSync(d)
    .filter((f) => f.endsWith('.json') && !['rejected.json', 'backlog.json'].includes(f))
    .map((f) => readImprovements(ws, f.replace(/\.json$/, '')))
    .sort((a, b) => b.run.localeCompare(a.run));
}

export const rejected = (ws: string) => readJson<{ fingerprint: string; title: string; kind: string; at: string; note: string | null }[]>(join(dirOf(ws), 'rejected.json'), []);
export const backlog = (ws: string) => readJson<unknown[]>(join(dirOf(ws), 'backlog.json'), []).map((x) => BacklogItem.parse(x));
const saveBacklog = (ws: string, items: BacklogItem[]) => writeJson(join(dirOf(ws), 'backlog.json'), items);
export const priors = (ws: string) => readJson<Prior[]>(join(ws, 'memory', 'priors.json'), []);

/**
 * Adds proposals for a run, skipping anything already rejected, already approved, or already pending (same
 * fingerprint anywhere in the workspace). Returns what was added and what was skipped and why.
 */
export function addProposals(ws: string, run: string, source: Proposal['source'], items: NewProposal[]) {
  const f = readImprovements(ws, run);
  const rej = new Set(rejected(ws).map((r) => r.fingerprint));
  const seen = new Map<string, Proposal['status']>();
  for (const other of listImprovementRuns(ws)) for (const p of other.proposals) if (!seen.has(p.fingerprint) || p.status !== 'pending') seen.set(p.fingerprint, p.status);
  const added: Proposal[] = [];
  const skipped: { title: string; reason: string }[] = [];
  const short = run.replace(/[^0-9]/g, '').slice(-6) || run.slice(0, 6);
  let n = f.proposals.length;
  for (const it of items) {
    const fp = fingerprintOf(it);
    if (rej.has(fp)) {
      skipped.push({ title: it.title, reason: 'rejected before' });
      continue;
    }
    if (seen.has(fp)) {
      skipped.push({ title: it.title, reason: `already ${seen.get(fp)}` });
      continue;
    }
    const p = Proposal.parse({
      ...it,
      id: `P-${short}-${String(++n).padStart(2, '0')}`,
      run,
      source,
      evidence: { finding_ids: [], numbers: [], transcripts: [], ...(it.evidence ?? {}) },
      fingerprint: fp,
      created_at: now(),
    });
    seen.set(fp, 'pending');
    added.push(p);
  }
  f.proposals.push(...added);
  writeImprovements(ws, f);
  return { added, skipped };
}

export function setRetroResult(ws: string, run: string, retro: NonNullable<ImprovementsFile['retro']>) {
  const f = readImprovements(ws, run);
  f.retro = retro;
  writeImprovements(ws, f);
}

export interface Decision {
  action: 'approve' | 'reject';
  /** Edited text (approve after edit). */
  title?: string;
  body?: string;
  note?: string | null;
}

/**
 * Applies a person's decision. Approve: lessons → memory/lessons.md, priors → memory/priors.json, detector/tweak →
 * backlog.json (code changes are only ever made later, on a branch). Reject: remembered so it isn't proposed again.
 */
export function decide(ws: string, run: string, id: string, d: Decision) {
  const f = readImprovements(ws, run);
  const p = f.proposals.find((x) => x.id === id);
  if (!p) throw new Error(`No proposal ${id} in run ${run}`);
  if (p.status !== 'pending') throw new Error(`${id} is already ${p.status}`);
  if (d.title?.trim() && d.title.trim() !== p.title) {
    p.title = d.title.trim();
    p.edited = true;
  }
  if (d.body?.trim() && d.body.trim() !== p.body) {
    p.body = d.body.trim();
    p.edited = true;
  }
  p.decision_note = d.note?.trim() || null;
  p.decided_at = now();
  let applied: string;
  if (d.action === 'reject') {
    p.status = 'rejected';
    const list = rejected(ws);
    if (!list.some((r) => r.fingerprint === p.fingerprint)) list.push({ fingerprint: p.fingerprint, title: p.title, kind: p.kind, at: p.decided_at, note: p.decision_note });
    writeJson(join(dirOf(ws), 'rejected.json'), list);
    applied = 'Rejected; it will not be proposed again.';
  } else {
    p.status = 'approved';
    if (p.kind === 'lesson') {
      new Memory(ws).appendLessons(`${run} · ${p.id}${p.scope === 'general' ? ' · general' : ''}`, `${p.title}\n${p.body}`);
      applied = 'Added to lessons (memory/lessons.md); future leads and explorers read it.';
    } else if (p.kind === 'prior') {
      if (!p.prior) throw new Error(`${id} has no prior details`);
      const list = priors(ws);
      list.push({ id: `PR-${list.length + 1}`, ...p.prior, reason: p.body, proposal_id: p.id, approved_at: p.decided_at });
      writeJson(join(ws, 'memory', 'priors.json'), list);
      applied = 'Added to strategy priors (memory/priors.json); the lead uses them when planning.';
    } else {
      const items = backlog(ws);
      const item = BacklogItem.parse({ id: `B-${items.length + 1}`, proposal_id: p.id, run, kind: p.kind, title: p.title, body: p.body, detector: p.detector, tweak: p.tweak, created_at: p.decided_at });
      items.push(item);
      saveBacklog(ws, items);
      applied = `Added to the backlog as ${item.id}. Nothing changes until you implement it on a branch and merge it.`;
    }
  }
  writeImprovements(ws, f);
  return { proposal: p, applied };
}

export function updateBacklogItem(ws: string, id: string, patch: Partial<BacklogItem>) {
  const items = backlog(ws);
  const it = items.find((x) => x.id === id);
  if (!it) throw new Error(`No backlog item ${id}`);
  Object.assign(it, patch);
  saveBacklog(ws, items);
  return it;
}

/** Approved priors as text for agent prompts. */
export function priorsText(ws: string): string {
  const ps = priors(ws);
  if (!ps.length) return '';
  return ps.map((p) => `- ${p.effect === 'prefer' ? 'Prefer' : 'Avoid'} ${p.strategy}${p.persona ? ` for ${p.persona}` : ''}${p.page_kind ? ` on ${p.page_kind} pages` : ''}: ${p.reason}`).join('\n');
}
