import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { runAgent } from '../llm/runner.js';
import { readRun, readFindings, findById } from '../store/store.js';
import { RawFinding } from '../store/schema.js';
import { fingerprintOf } from '../triage/cluster.js';
import { JobReporter, newJobId, describeAgentEvent } from '../jobs/events.js';
import { addProposals, type NewProposal } from './proposals.js';
import { PROPOSAL_ITEM } from './retro.js';
import { notifyProposals } from '../notify/events.js';

/**
 * A person reports something wrong with a finding (not a real bug, something missed nearby, a misleading picture,
 * wrong severity, a fix that didn't work…). An agent investigates the finding's whole trail and works out which
 * stage went wrong, then files improvement proposals for the person to approve. Nothing is changed automatically.
 *   <workspace>/improvements/reports.json   the reports, their status and diagnosis
 */
export const REPORT_CATEGORIES = {
  'not-a-bug': 'It isn’t a real bug (false positive)',
  missed: 'It missed something more important nearby',
  evidence: 'The screenshot, highlight or video is wrong or misleading',
  classification: 'Wrong severity, type or grouping',
  fix: 'The fix didn’t work, or its verification is wrong',
  other: 'Something else',
} as const;
export type ReportCategory = keyof typeof REPORT_CATEGORIES;

export interface BugReport {
  id: string;
  at: string;
  run: string;
  bug: string;
  category: ReportCategory;
  text: string;
  status: 'investigating' | 'done' | 'failed';
  job_id: string | null;
  diagnosis: { stage: string; summary: string; is_real_bug: boolean | null; recommended_action: string } | null;
  proposals: string[];
  error: string | null;
}

const file = (ws: string) => join(ws, 'improvements', 'reports.json');
export function readReports(ws: string): BugReport[] {
  try {
    return existsSync(file(ws)) ? (JSON.parse(readFileSync(file(ws), 'utf8')) as BugReport[]) : [];
  } catch {
    return [];
  }
}
function saveReports(ws: string, list: BugReport[]) {
  mkdirSync(join(ws, 'improvements'), { recursive: true });
  writeFileSync(file(ws), JSON.stringify(list, null, 2) + '\n');
}
export function addReport(ws: string, r: Pick<BugReport, 'run' | 'bug' | 'category' | 'text'>): BugReport {
  const report: BugReport = { id: `R-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`, at: new Date().toISOString(), ...r, text: r.text.trim().slice(0, 4000), status: 'investigating', job_id: null, diagnosis: null, proposals: [], error: null };
  saveReports(ws, [...readReports(ws), report]);
  return report;
}
function updateReport(ws: string, id: string, patch: Partial<BugReport>) {
  const list = readReports(ws);
  const r = list.find((x) => x.id === id);
  if (r) Object.assign(r, patch);
  saveReports(ws, list);
  return r;
}

const SCHEMA = {
  type: 'object',
  properties: {
    stage: { type: 'string', enum: ['explorer', 'detector', 'triage-replay', 'triage-review', 'grouping', 'annotation', 'video', 'fix-agent', 'fix-verification', 'none'], description: 'Which part of bugbash went wrong (none = the report is mistaken)' },
    summary: { type: 'string', description: 'What happened and why, in 2-5 sentences, citing evidence (files, metrics, transcript lines)' },
    is_real_bug: { type: ['boolean', 'null'], description: 'Is the finding a real, user-visible defect? null = can’t tell' },
    recommended_action: { type: 'string', description: 'What the person should do with this finding now (e.g. label false positive, change severity to major, retry verification, report the missed bug)' },
    proposals: { type: 'array', items: PROPOSAL_ITEM, maxItems: 5 },
  },
  required: ['stage', 'summary', 'is_real_bug', 'recommended_action', 'proposals'],
};

const SYSTEM = `You investigate a problem a person reported with a finding from "bugbash", an automated UI bug-bash tool (explorer agents drive browsers and record findings; in-page detectors measure layout; triage replays, minimizes, reviews, groups and annotates them with screenshots/videos; fix agents fix them on a branch and verification checks the result).
Find out which stage went wrong and why, using the evidence files (Read them; look at the images). Be concrete and honest: if the person is right, say what bugbash did wrong; if the report is mistaken, say so.
Then propose improvements (0-5) for a person to approve: detector changes (include a detection sketch), prompt/config tweaks, triage or verification changes, or lessons for this site. Each must be specific and cite the evidence. Never propose anything that would hide real bugs.`;

/** Investigates a report and files proposals (pending approval). */
export async function investigateReport(o: { ws: string; reportId: string; runDir: string; provider?: 'claude' | 'codex' | null; model?: string | null; jobId?: string | null; log?: (m: string) => void }) {
  const log = o.log ?? (() => {});
  const report = readReports(o.ws).find((r) => r.id === o.reportId);
  if (!report) throw new Error(`No report ${o.reportId}`);
  const info = readRun(o.runDir);
  const rep = new JobReporter(join(o.runDir, 'jobs'), o.jobId ?? newJobId('investigate'), 'investigate', { run_dir: o.runDir, finding_ids: [report.bug], scope: `${report.bug}: ${REPORT_CATEGORIES[report.category]}`, options: { report_id: report.id, ws: o.ws } });
  updateReport(o.ws, report.id, { job_id: rep.status.id, status: 'investigating' });
  try {
    const ff = readFindings(o.runDir);
    const hit = ff && findById(ff, report.bug);
    if (!hit) throw new Error(`Unknown finding ${report.bug}`);
    const f = hit.finding;
    // The explorer findings that became this bug, and where their sessions' transcripts are.
    const raw = existsSync(join(o.runDir, 'agent-findings.jsonl'))
      ? readFileSync(join(o.runDir, 'agent-findings.jsonl'), 'utf8')
          .split('\n')
          .filter(Boolean)
          .flatMap((l) => {
            try {
              const r = RawFinding.parse(JSON.parse(l));
              return fingerprintOf(r) === f.fingerprint ? [r] : [];
            } catch {
              return [];
            }
          })
      : [];
    const triageStat = (() => {
      try {
        return (JSON.parse(readFileSync(join(o.runDir, 'triage-stats.json'), 'utf8')).findings ?? []).find((x: { id: string }) => x.id === f.id) ?? null;
      } catch {
        return null;
      }
    })();
    const files = [f.screenshots.annotated, f.screenshots.crop, f.screenshots.full, f.screenshots.explorer, f.video?.filmstrip, f.fix?.verification?.after?.annotated, f.fix?.verification?.after?.crop, f.fix?.verification?.after_video?.filmstrip].filter(Boolean).map((p) => join(o.runDir, p!));
    const transcripts = [...new Set(raw.map((r) => join(o.runDir, 'transcripts', `${r.session}.jsonl`)))].filter((p) => existsSync(p));
    const prompt = [
      `# Report from the person (${REPORT_CATEGORIES[report.category]})\n${report.text || '(no details)'}`,
      `# The finding\n${JSON.stringify({ ...f, video: f.video ? { ...f.video, chapters: undefined } : null }, null, 1).slice(0, 12000)}`,
      `# Its root-cause group\n${JSON.stringify({ id: hit.group.id, summary: hit.group.summary, css_rule: hit.group.css_rule, members: hit.group.findings.map((x) => `${x.id} ${x.title}`) }, null, 1)}`,
      `# Triage stats for it\n${JSON.stringify(triageStat)}`,
      `# The explorer findings that became it\n${JSON.stringify(raw.map((r) => ({ session: r.session, persona: r.persona, type: r.type, title: r.title, description: r.description, hypothesis: r.hypothesis, strategy: r.strategy, environment: r.environment, detector: r.detector })), null, 1).slice(0, 8000)}`,
      `# Evidence files (Read them)\n${files.join('\n') || '(none)'}`,
      `# Explorer session transcripts (search them with Grep for the page/element)\n${transcripts.join('\n') || '(none)'}`,
      `Site: ${info.target} (${info.base_url}). Return your diagnosis and proposals.`,
    ].join('\n\n');
    rep.event('investigate', `Investigating ${f.id}: ${REPORT_CATEGORIES[report.category]}`);
    log(`Investigating ${f.id}…`);
    const r = await runAgent({
      prompt,
      systemPrompt: SYSTEM,
      tools: ['Read', 'Grep', 'Glob'],
      allowedTools: ['Read', 'Grep', 'Glob'],
      cwd: o.runDir,
      addDirs: [o.runDir],
      provider: o.provider, model: o.model ?? null,
      jsonSchema: SCHEMA,
      timeoutMs: 12 * 60_000,
      transcriptPath: join(o.runDir, 'transcripts', `investigate-${report.id}.jsonl`),
      agentName: 'investigator',
      onEvent: (e) => {
        for (const d of describeAgentEvent(e)) rep.event('investigate', d.msg, 'agent', d.data);
      },
    });
    const out = r.structured as { stage?: string; summary?: string; is_real_bug?: boolean | null; recommended_action?: string; proposals?: NewProposal[] } | null;
    if (!r.ok || !out?.summary) throw new Error(r.error ?? 'The investigation returned no diagnosis');
    const { added } = addProposals(o.ws, info.run_id, 'report', (out.proposals ?? []).map((p) => ({ ...p, evidence: { ...(p.evidence ?? {}), finding_ids: [...new Set([f.id, ...(p.evidence?.finding_ids ?? [])])] } })));
    const diagnosis = { stage: String(out.stage ?? 'none'), summary: String(out.summary), is_real_bug: out.is_real_bug ?? null, recommended_action: String(out.recommended_action ?? '') };
    updateReport(o.ws, report.id, { status: 'done', diagnosis, proposals: added.map((p) => p.id), error: null });
    rep.event('investigate', `Diagnosis (${diagnosis.stage}): ${diagnosis.summary}`, 'success');
    if (diagnosis.recommended_action) rep.event('investigate', `Recommended: ${diagnosis.recommended_action}`, 'info');
    notifyProposals(added.length, `From your report on ${f.id}: ${diagnosis.summary}`);
    rep.finish('succeeded', { summary: `${diagnosis.stage}: ${added.length} proposal(s) for review` });
    return { diagnosis, proposals: added };
  } catch (e) {
    updateReport(o.ws, report.id, { status: 'failed', error: (e as Error).message.slice(0, 500) });
    rep.finish('failed', { error: (e as Error).message });
    throw e;
  }
}
