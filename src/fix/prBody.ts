import type { Finding, RootCauseGroup } from '../store/schema.js';
import type { VerifyResult } from './verify.js';

export function prBody(d: { selected: Finding[]; groups: RootCauseGroup[]; alsoFixed: string[]; before: VerifyResult[]; after: VerifyResult[]; regressions: string[]; verified: boolean; technical: { summary: string; technical: string }; runId: string; images: Map<string, string> | null; attempts: number; flags: string[]; manualOverride?: boolean; manualVerified?: boolean; evidenceAt?: Record<string, string> }) {
  const lines: string[] = [];
  const fullyVerified = d.verified && d.flags.length === 0;
  lines.push(`## Summary`, '', d.technical.summary, '');
  lines.push(`## Changes`, '', d.technical.technical, '');
  lines.push(`## Findings fixed`, '');
  for (const f of d.selected) {
    const b = d.before.find((x) => x.id === f.id);
    const a = d.after.find((x) => x.id === f.id);
    lines.push(`### ${f.id} — ${f.title}`, `- ${f.type}, ${f.severity}, on \`${f.page}\` (${f.browsers.join(', ')}; ${f.viewports.map((v) => v.width).join(', ')}px)`, `- Expected: ${f.reproduction.expected}`, `- Actual (before): ${f.reproduction.actual}`);
    const afterText = a?.present === null || !a ? "**couldn't confirm automatically** (please compare the pictures)" : a.present ? 'automated check reported a remaining issue (see automated verification results below)' : a.method === 'visual-review' ? `fixed (visual review, ${Math.round((a.review?.confidence ?? 0) * 100)}% confident)` : 'fixed (detector checks)';
    lines.push(`- Verification: before ${!b ? 'not recorded' : b.present === null ? 'visual-only' : b?.present ? 'present' : 'absent'} → after ${afterText}${a?.checks.length ? ` (${a.checks.map((c) => `${c.browser} ${c.width}px ${c.present === null ? '?' : c.present ? '✗' : '✓'}`).join(', ')})` : ''}`);
    if (a?.review) lines.push(`- Visual review: ${a.review.reasoning}`);
    if (d.evidenceAt?.[f.id]) lines.push(`- Evidence captured: ${d.evidenceAt[f.id]}`);
    if (f.fix?.manual_after) lines.push(`- ${MANUAL_TAG} After screenshot chosen manually from a reproduction (${f.fix.manual_after.at}); the automatic results are unchanged.`);
    lines.push('', '<details><summary>Reproduction steps</summary>', '', ...f.reproduction.steps_human.map((s, i) => `${i + 1}. ${s}`), '', '</details>', '');
    const img = (name: string) => d.images?.get(name);
    const beforeImg = img(`${f.id}-before.gif`) ?? img(`${f.id}-before.png`);
    const afterImg = img(`${f.id}-after.png`);
    if (beforeImg || afterImg) lines.push(`| Before | After |`, `|---|---|`, `| ${beforeImg ? `<img src="${beforeImg}" width="420" alt="${f.id} before">` : '—'} | ${afterImg ? `<img src="${afterImg}" width="420" alt="${f.id} after">` : '—'} |`, '');
  }
  if (d.alsoFixed.length) lines.push(`## Also resolved (same root cause)`, '', d.alsoFixed.map((x) => `- ${x}`).join('\n'), '');
  const g = d.groups.map((x) => `- ${x.id}: ${x.summary}${x.fix_plan ? ` — plan: ${x.fix_plan}` : ''}`).join('\n');
  lines.push(`## Root-cause group`, '', g, '');
  lines.push(...verificationSection(d, fullyVerified));
  lines.push(`Found and fixed by bugbash (run \`${d.runId}\`).`, '', '🤖 Generated with [Claude Code](https://claude.com/claude-code)');
  return lines.join('\n');
}

/** The tags every PR body uses, whichever way it was written (fix job, re-verification, publish anyway, body update). */
export const AUTO_TAG = '🤖';
export const MANUAL_TAG = '👤';

/**
 * The Verification section, always in this shape: automatic results first, then (when the person confirmed it) their
 * manual verification, then (when it applies) the note that publishing was manually approved despite incomplete checks.
 */
export function verificationSection(d: { verified: boolean; flags: string[]; regressions: string[]; attempts: number; manualVerified?: boolean; manualOverride?: boolean }, fullyVerified = d.verified && d.flags.length === 0): string[] {
  const out = ['## Verification', '', `### ${AUTO_TAG} Automated verification`, ''];
  if (fullyVerified) out.push(`✅ Every bug checked out as fixed (detector replays at each affected size and browser, or a visual before/after review where noted), and the touched pages have no new layout defects ${d.attempts > 0 ? `(${d.attempts} attempt${d.attempts > 1 ? 's' : ''})` : '(latest saved verification)'}.`, '');
  else {
    out.push('⚠️ Automatic verification was not fully complete. Please see the results below.', '');
    if (d.regressions.length) out.push('New layout candidates on touched pages:', ...d.regressions.map((r) => `- ${r}`), '');
    if (d.flags.length) out.push('<details><summary>View automated verification results</summary>', '', ...d.flags.map((flag) => `- ${flag}`), '', '</details>', '');
  }
  if (d.manualVerified || d.manualOverride) {
    out.push(`### ${MANUAL_TAG} Manual verification`, '');
    if (d.manualVerified) out.push('✅ The user reports manually verifying the fix (they reviewed the before/after) and approved noting it here.', '');
    if (d.manualOverride) out.push('⚠️ Published despite incomplete automatic verification, with the user\'s explicit approval.', '');
  }
  return out;
}
