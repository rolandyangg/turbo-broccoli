import type { Finding, LayoutRegression } from '../store/schema.js';

export function candidateKey(r: LayoutRegression): string {
  return JSON.stringify([r.page, r.width, r.type, r.selector, r.message]);
}
export function reviewBlockers(f: Finding, candidates: LayoutRegression[], dismissed: string[]): string[] {
  const v = f.fix?.verification;
  const blockers = (f.fix?.flags ?? []).filter((flag) => !/verified only by a visual review/.test(flag) && !/^\d+ new layout problem/.test(flag) && !(v?.result === 'fixed' && /some checks were inconclusive/.test(flag)));
  if (!v || v.result !== 'fixed') blockers.push('The original bug must be confirmed fixed.');
  if (!(f.fix?.manual_after?.path ?? v?.after?.annotated)) blockers.push('An after-fix screenshot is required.');
  if (candidates.some((r) => !dismissed.includes(candidateKey(r)))) blockers.push('Review and dismiss every layout candidate first.');
  if (!candidates.length && (f.fix?.flags ?? []).some((flag) => /^\d+ new layout problem/.test(flag))) blockers.push('Layout candidate details are unavailable; retry verification first.');
  return [...new Set(blockers)];
}
export function manualReviewValid(f: Finding, head: string): boolean {
  const review = f.fix?.manual_review;
  return !!review?.verified_at && review.head_commit === head && review.evidence_at === f.fix?.verification?.at
    && reviewBlockers(f, f.fix?.verification?.regressions ?? [], review.dismissed).length === 0;
}
