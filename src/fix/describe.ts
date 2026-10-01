import { runClaude } from '../llm/claude.js';
import type { Finding, RootCauseGroup } from '../store/schema.js';

/** A reviewer-facing explanation of a fix, written from the actual diff. */
export interface ChangeExplanation {
  /** Conventional-commit subject about the code change, e.g. "fix(sponsor-us): keep carousel arrows inside the viewport". */
  commit_subject: string;
  summary: string;
  root_cause: string;
  changes: { file: string; what: string; why: string }[];
  notes: string[];
}

export interface FileStat {
  file: string;
  added: number;
  removed: number;
}

const SCHEMA = {
  type: 'object',
  properties: {
    commit_subject: { type: 'string', description: 'Conventional commit subject describing the CODE change (not the bug report): "fix(<area>): <imperative summary>", at most 72 characters, e.g. "fix(sponsor-us): start desktop carousel layout at 1025px"' },
    summary: { type: 'string', description: '1-3 sentences: what the PR does for the user-visible bug(s)' },
    root_cause: { type: 'string', description: 'The technical cause in the code (rule/markup/logic and file), in 1-3 sentences' },
    changes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          what: { type: 'string', description: 'What changed in this file, concretely (properties, selectors, values, components)' },
          why: { type: 'string', description: 'Why this change fixes the bug at every affected size/browser, and why this approach' },
        },
        required: ['file', 'what', 'why'],
      },
    },
    notes: { type: 'array', items: { type: 'string' }, description: 'Risks, side effects, or things a reviewer should check (may be empty)' },
  },
  required: ['commit_subject', 'summary', 'root_cause', 'changes', 'notes'],
};

const SYSTEM = `You write the "Changes" section of a pull request that fixes UI bugs found by an automated bug bash.
Explain the change for a code reviewer: the root cause in the code, then for each changed file what was changed and why it fixes the bug.
Be concrete (CSS properties, selectors, values, components, breakpoints). Only describe what the diff actually does; don't invent changes or tests. Keep each item short. Mention real risks only.`;

/**
 * Explains a committed fix from its diff (one small model call, no tools). Returns null if it can't, so callers
 * fall back to file stats and the fix agent's own summary.
 */
export async function explainChanges(d: { diff: string; stats: FileStat[]; findings: Finding[]; groups: RootCauseGroup[]; agentSummary: string; model?: string | null; transcriptPath?: string }): Promise<ChangeExplanation | null> {
  if (!d.diff.trim()) return null;
  const prompt = [
    `# Bugs this fixes\n${JSON.stringify(
      d.findings.map((f) => ({ id: f.id, title: f.title, type: f.type, page: f.page, widths: [...new Set(f.viewports.map((v) => v.width))], browsers: f.browsers, expected: f.reproduction.expected, actual: f.reproduction.actual, likely_cause: f.likely_cause })),
      null,
      1,
    )}`,
    `# Root-cause notes from triage\n${d.groups.map((g) => `- ${g.id}: ${g.summary}${g.css_rule ? ` (rule: ${g.css_rule})` : ''}${g.fix_plan ? ` — plan: ${g.fix_plan}` : ''}`).join('\n') || '(none)'}`,
    `# The fix agent's own summary\n${d.agentSummary.slice(0, 3000) || '(none)'}`,
    `# Changed files\n${d.stats.map((s) => `- ${s.file} (+${s.added} −${s.removed})`).join('\n')}`,
    `# Diff\n${d.diff.slice(0, 24_000)}${d.diff.length > 24_000 ? '\n… (diff truncated)' : ''}`,
  ].join('\n\n');
  const r = await runClaude({ prompt, systemPrompt: SYSTEM, tools: [], jsonSchema: SCHEMA, model: d.model ?? null, timeoutMs: 3 * 60_000, transcriptPath: d.transcriptPath }).catch(() => null);
  const out = r?.ok ? (r.structured as ChangeExplanation | null) : null;
  if (!out || !Array.isArray(out.changes) || !out.summary) return null;
  return { commit_subject: String(out.commit_subject ?? ''), summary: String(out.summary), root_cause: String(out.root_cause ?? ''), changes: out.changes.filter((c) => c && c.file).map((c) => ({ file: String(c.file), what: String(c.what ?? ''), why: String(c.why ?? '') })), notes: (out.notes ?? []).map(String).filter(Boolean) };
}

/** Markdown for the PR body: summary + "Changes" (root cause, per-file what/why with line counts, notes). */
export function technicalSection(x: ChangeExplanation | null, stats: FileStat[], agentSummary: string): { summary: string; technical: string } {
  const statOf = (file: string) => stats.find((s) => s.file === file || s.file.endsWith(`/${file}`) || file.endsWith(`/${s.file}`));
  const counts = (s: FileStat | undefined) => (s ? ` (+${s.added} −${s.removed})` : '');
  if (!x) {
    // Fallback: what we know for sure (the files) plus the agent's own words.
    const files = stats.map((s) => `- \`${s.file}\`${counts(s)}`).join('\n');
    return { summary: agentSummary.trim().slice(0, 3000) || '(no summary)', technical: `${files || '(no file changes)'}` };
  }
  const lines: string[] = [];
  if (x.root_cause) lines.push(`**Root cause.** ${x.root_cause}`, '');
  // One entry per file (the explanation may describe a file in several parts).
  const byFile = new Map<string, { stat: FileStat | undefined; parts: { what: string; why: string }[] }>();
  for (const c of x.changes) {
    const st = statOf(c.file);
    const key = st?.file ?? c.file;
    const e = byFile.get(key) ?? { stat: st, parts: [] };
    e.parts.push({ what: c.what, why: c.why });
    byFile.set(key, e);
  }
  const seen = new Set<string>();
  for (const [file, e] of byFile) {
    if (e.stat) seen.add(e.stat.file);
    lines.push(`- \`${file}\`${counts(e.stat)}`);
    for (const p of e.parts) lines.push(`  - **What:** ${p.what}`, `    **Why:** ${p.why}`);
  }
  // Files the explanation skipped still get listed, so the section never hides a change.
  for (const s of stats.filter((s) => !seen.has(s.file))) lines.push(`- \`${s.file}\`${counts(s)}`);
  if (x.notes.length) lines.push('', '**Notes for review**', ...x.notes.map((n) => `- ${n}`));
  return { summary: x.summary, technical: lines.join('\n') };
}

/**
 * Commit message about the change itself: a conventional subject describing what the code now does, the root cause,
 * then what changed in each file and why. The bug report only appears as a trailing reference.
 */
export function commitMessage(x: ChangeExplanation | null, stats: FileStat[], o: { fallbackTitle: string; refs: string[]; runId: string; verified: boolean }) {
  const clean = (t: string) => t.replace(/\s+/g, ' ').trim();
  let subject = clean(x?.commit_subject ?? '');
  if (!/^[a-z]+(\([\w./-]+\))?!?: \S/.test(subject)) subject = subject ? `fix(ui): ${subject.replace(/^[^:]*:\s*/, '')}` : '';
  if (!subject) {
    const files = stats.map((s) => s.file.split('/').pop()).slice(0, 2).join(', ');
    subject = `fix(ui): ${files ? `adjust ${files} for ` : ''}${o.fallbackTitle.toLowerCase()}`;
  }
  if (subject.length > 72) subject = subject.slice(0, 71).replace(/\s+\S*$/, '') + '…';
  const body: string[] = [];
  if (x?.root_cause) body.push(wrap(clean(x.root_cause)), '');
  if (x?.changes.length) {
    for (const c of x.changes) body.push(wrap(`- ${c.file.split('/').pop()}: ${clean(c.what)} ${clean(c.why)}`, '  '));
    body.push('');
  } else if (stats.length) body.push(...stats.map((s) => `- ${s.file} (+${s.added} -${s.removed})`), '');
  if (!o.verified) body.push('Not fully verified: see the PR description.', '');
  body.push(`Refs: ${[...new Set(o.refs)].join(', ')} (bugbash run ${o.runId})`, '', 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>');
  return `${subject}\n\n${body.join('\n')}\n`;
}

/** Wraps prose at 72 columns (continuation lines get `indent`). */
function wrap(text: string, indent = '') {
  const out: string[] = [];
  let line = '';
  for (const w of text.split(' ')) {
    if (line && (line + ' ' + w).length > 72) {
      out.push(line);
      line = indent + w;
    } else line = line ? `${line} ${w}` : w;
  }
  if (line) out.push(line);
  return out.join('\n');
}
