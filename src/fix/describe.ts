import { runClaude } from '../llm/claude.js';
import type { Finding, RootCauseGroup } from '../store/schema.js';

/** A reviewer-facing explanation of a fix, written from the actual diff. */
export interface ChangeExplanation {
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
  required: ['summary', 'root_cause', 'changes', 'notes'],
};

const SYSTEM = `You write the "Technical changes" section of a pull request that fixes UI bugs found by an automated bug bash.
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
  return { summary: String(out.summary), root_cause: String(out.root_cause ?? ''), changes: out.changes.filter((c) => c && c.file).map((c) => ({ file: String(c.file), what: String(c.what ?? ''), why: String(c.why ?? '') })), notes: (out.notes ?? []).map(String).filter(Boolean) };
}

/** Markdown for the PR body: summary + "Technical changes" (root cause, per-file what/why with line counts, notes). */
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
