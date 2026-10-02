import type { Finding } from './types.ts';

/** The fields needed from the run's PR list, including bugs linked by fix jobs. */
export interface BugPr {
  url: string;
  number: number | null;
  bugs: { id: string }[];
  status: { state: 'OPEN' | 'MERGED' | 'CLOSED'; isDraft: boolean } | null;
}

export interface BugFixStatus {
  kind: 'review' | 'draft' | 'raised' | 'merged' | 'closed';
  label: string;
  detail: string;
  number?: number | null;
  url?: string;
}

export function bugFixStatus(f: Finding, prs: readonly BugPr[] = []): BugFixStatus | null {
  // A finding's current fix takes precedence over PRs from earlier fix jobs.
  const currentUrl = f.fix?.pr_url;
  const pr = currentUrl
    ? prs.find((p) => p.url === currentUrl)
    : prs.find((p) => p.bugs.some((b) => b.id === f.id));
  const url = currentUrl ?? pr?.url;
  if (url) {
    const number = pr?.number ?? (Number(url.match(/\/pull\/(\d+)/)?.[1]) || null);
    if (pr?.status?.state === 'MERGED') return { kind: 'merged', label: 'PR merged', detail: 'The related fix has been merged.', number, url };
    if (pr?.status?.state === 'CLOSED') return { kind: 'closed', label: 'PR closed', detail: 'The related PR was closed without merging.', number, url };
    if (pr?.status?.isDraft) return { kind: 'draft', label: 'PR drafted', detail: 'Draft pull request; not ready for review yet.', number, url };
    let detail = 'GitHub status unavailable.';
    if (pr?.status) detail = 'Pull request open for review.';
    return { kind: 'raised', label: 'PR raised', number, detail, url };
  }
  const fix = f.fix;
  if (fix?.branch && fix.verified && fix.verification?.result === 'fixed' && !fix.flags?.length && !fix.blocked) {
    return { kind: 'review', label: 'Fixed · awaiting review', detail: 'Verified on a fix branch. Review the fix and open a PR.' };
  }
  return null;
}
