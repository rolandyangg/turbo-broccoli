import { runClaude, tryParseJson } from '../llm/claude.js';
import type { Finding } from '../store/schema.js';
import { FindingType, Severity } from '../store/schema.js';

export interface ReviewVerdict {
  is_defect: boolean;
  type: string;
  severity: string;
  confidence: number;
  title: string;
  description: string;
  expected: string;
  actual: string;
  likely_cause: string;
  fix_hint: string;
  needs_video: boolean;
  reasoning: string;
}

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    is_defect: { type: 'boolean' },
    type: { type: 'string', enum: FindingType.options },
    severity: { type: 'string', enum: Severity.options },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    title: { type: 'string' },
    description: { type: 'string' },
    expected: { type: 'string' },
    actual: { type: 'string' },
    likely_cause: { type: 'string' },
    fix_hint: { type: 'string' },
    needs_video: { type: 'boolean' },
    reasoning: { type: 'string' },
  },
  required: ['is_defect', 'type', 'severity', 'confidence', 'title', 'description', 'expected', 'actual', 'likely_cause', 'fix_hint', 'needs_video', 'reasoning'],
};

const REVIEWER_SYSTEM = `You are an independent UI QA reviewer. Another agent reported a possible UI defect. You did not see its reasoning.
Judge ONLY from the evidence: the annotated screenshots (red box = reported element, orange = related element), the reproduction steps, and the measured metrics.
Be skeptical: intentional ellipsis truncation with a tooltip/title, decorative overlaps, off-canvas menus, and content scrolled inside its own container are usually NOT defects. A real defect is something a user would notice as broken or that makes content unreadable/unreachable.
Severity: critical (blocks a task or makes key content unreadable/unreachable), major (clearly broken, most users notice), minor (noticeable polish issue), cosmetic (tiny).
needs_video: true if the defect is about change over time (flicker, layout shift, a transition, hover/timing/race behaviour) so a still image can't show it.
Write expected/actual as one sentence each. fix_hint: the most likely CSS/markup change. Output JSON only.`;

export async function reviewFinding(f: Finding, o: { runDir: string; model?: string | null; images: string[]; replayNote: string }): Promise<ReviewVerdict | null> {
  const prompt = [
    `Reported defect ${f.id}`,
    `type: ${f.type}  severity (reporter): ${f.severity}  reporter confidence: ${f.confidence_breakdown.explorer}`,
    `title: ${f.title}`,
    `description: ${f.description}`,
    `page: ${f.page}  browser(s): ${f.browsers.join(', ')}  viewport(s): ${f.viewports.map((v) => `${v.width}x${v.height}`).join(', ')}  variant: ${JSON.stringify(f.reproduction.environment.variant)}`,
    `element: ${f.element.selector} text=${JSON.stringify(f.element.text)}`,
    `metrics: ${JSON.stringify(f.metrics).slice(0, 1200)}`,
    `reproduction steps:\n${f.reproduction.steps_human.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}`,
    `replay: ${o.replayNote}`,
    `\nView these images with the Read tool before deciding:\n${o.images.map((i) => `- ${i}`).join('\n')}`,
  ].join('\n');
  const r = await runClaude({ prompt, systemPrompt: REVIEWER_SYSTEM, tools: ['Read'], allowedTools: ['Read'], addDirs: [o.runDir], cwd: o.runDir, jsonSchema: REVIEW_SCHEMA, model: o.model, timeoutMs: 5 * 60_000 });
  const v = (r.structured ?? tryParseJson(r.text)) as ReviewVerdict | null;
  if (!v || typeof v.is_defect !== 'boolean') return null;
  return { ...v, confidence: clamp(v.confidence) };
}

export async function reviewVideo(o: { runDir: string; title: string; filmstrip: string | null; bugFrame: string | null; model?: string | null }): Promise<{ visible: boolean; paceMs?: number; holdMs?: number; settleMs?: number; note: string } | null> {
  const imgs = [o.filmstrip, o.bugFrame].filter(Boolean) as string[];
  if (!imgs.length) return null;
  const r = await runClaude({
    prompt: `A narrated screen recording was made to show this UI defect: "${o.title}".\nLook at the filmstrip (one still per step, left to right) and the final annotated frame with the Read tool:\n${imgs.map((i) => `- ${i}`).join('\n')}\nIs the defect clearly visible and highlighted in the recording? If not, suggest slower pacing (paceMs per step), a longer hold on the bug (holdMs), or a longer wait before annotating (settleMs, for bugs that appear late). JSON only.`,
    tools: ['Read'],
    allowedTools: ['Read'],
    addDirs: [o.runDir],
    cwd: o.runDir,
    model: o.model,
    timeoutMs: 3 * 60_000,
    jsonSchema: { type: 'object', properties: { visible: { type: 'boolean' }, paceMs: { type: 'number' }, holdMs: { type: 'number' }, settleMs: { type: 'number' }, note: { type: 'string' } }, required: ['visible', 'note'] },
  });
  return (r.structured ?? tryParseJson(r.text)) as never;
}

export interface GroupProposal {
  summary: string;
  component: string | null;
  css_rule: string | null;
  files: string[];
  fix_plan: string;
  confidence: number;
  finding_ids: string[];
}

export async function proposeRootCauses(findings: Finding[], o: { repo: string | null; intelSummary: string; model?: string | null }): Promise<GroupProposal[] | null> {
  const compact = findings.map((f) => ({
    id: f.id,
    type: f.type,
    page: f.page,
    title: f.title,
    selector: f.element.selector,
    signature: f.element.signature,
    widths: f.viewports.map((v) => v.width),
    browsers: f.browsers,
    likely_cause: f.likely_cause,
    source_hints: f.source_hints.slice(0, 3).map((h) => `${h.file}:${h.line ?? '?'} (${h.reason})`),
  }));
  const r = await runClaude({
    prompt: `Group these UI findings by ROOT CAUSE (the same CSS rule/component/layout decision). Findings in one group should be fixable by one change. Every finding id must appear in exactly one group; a finding with no shared cause gets its own group. Do not merge unrelated bugs just because they're on the same page. 'summary' is one neutral sentence naming the shared cause (e.g. "'.plan-card .cta' has a fixed 40px height with overflow:hidden below 400px"); do not judge whether findings are valid — that is decided elsewhere. When you read the code, verify the cascade/specificity actually applies before stating a cause.\n${o.repo ? 'You may use Read/Grep/Glob in the repo to confirm causes (cite files).' : 'No source code is available; infer from selectors/signatures.'}\n\nCode intelligence:\n${o.intelSummary.slice(0, 4000)}\n\nFindings:\n${JSON.stringify(compact, null, 1)}\n\nReturn JSON {"groups":[{"summary","component","css_rule","files","fix_plan","confidence","finding_ids"}]}.`,
    tools: o.repo ? ['Read', 'Grep', 'Glob'] : [],
    allowedTools: o.repo ? ['Read', 'Grep', 'Glob'] : [],
    cwd: o.repo ?? undefined,
    model: o.model,
    timeoutMs: 10 * 60_000,
    jsonSchema: {
      type: 'object',
      properties: {
        groups: {
          type: 'array',
          items: {
            type: 'object',
            properties: { summary: { type: 'string' }, component: { type: ['string', 'null'] }, css_rule: { type: ['string', 'null'] }, files: { type: 'array', items: { type: 'string' } }, fix_plan: { type: 'string' }, confidence: { type: 'number' }, finding_ids: { type: 'array', items: { type: 'string' } } },
            required: ['summary', 'files', 'fix_plan', 'confidence', 'finding_ids'],
          },
        },
      },
      required: ['groups'],
    },
  });
  const v = (r.structured ?? tryParseJson(r.text)) as { groups?: GroupProposal[] } | null;
  return v?.groups ?? null;
}

const clamp = (n: number) => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0.5));
