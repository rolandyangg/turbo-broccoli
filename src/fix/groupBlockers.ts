import type { Finding } from '../store/schema.js';
import { candidateKey, manualReviewValid } from './manualReview.js';

export interface GroupFixBlocker { id: string; title: string; reasons: string[] }

/** Only findings on this fix branch can block its publication. */
export function groupFixBlockers(current: Finding, findings: Finding[], head?: string): GroupFixBlocker[] {
  if (!current.fix?.branch) return [];
  return findings.flatMap((f) => {
    if (f.id === current.id || f.fix?.branch !== current.fix?.branch || /side effect/.test(f.fix?.fixed_by ?? '')) return [];
    if (head && manualReviewValid(f, head)) return [];
    const v = f.fix?.verification;
    const reasons: string[] = [];
    if (!v || v.result === 'inconclusive') reasons.push('Fix could not be confirmed');
    else if (v.result === 'present') reasons.push('Bug is still present');
    const review = f.fix?.manual_review;
    const dismissed = head && review?.head_commit === head && review.evidence_at === v?.at ? review.dismissed : [];
    if (v?.regressions?.some((r) => !dismissed.includes(candidateKey(r)))) reasons.push('Layout candidates need review');
    return reasons.length ? [{ id: f.id, title: f.title, reasons }] : [];
  });
}
