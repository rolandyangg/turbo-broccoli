import { manualReviewValid } from '../../../src/fix/manualReview.ts';
import type { Finding, JobStatus } from './types.ts';

/** The fields needed from the run's PR list, including bugs linked by fix jobs. */
export interface BugPr {
  url: string;
  number: number | null;
  bugs: { id: string }[];
  status: { state: 'OPEN' | 'MERGED' | 'CLOSED'; isDraft: boolean } | null;
}

export type BugFixJob = Pick<JobStatus, 'id' | 'state'> & Partial<Pick<JobStatus, 'kind' | 'finding_ids' | 'scope'>> & { alive?: boolean };

export interface BugFixStatus {
  kind: 'fixing' | 'unverified' | 'review' | 'draft' | 'raised' | 'merged' | 'closed';
  label: string;
  detail: string;
  number?: number | null;
  url?: string;
}

export function bugFixStatus(f: Finding, prs: readonly BugPr[] = [], jobs: readonly BugFixJob[] = []): BugFixStatus | null {
  const running = jobs.some((job) => job.state === 'running' && job.alive !== false &&
    (job.kind === undefined || job.kind === 'fix' || job.kind === 'publish') &&
    (job.id === f.fix?.job_id || job.finding_ids?.includes(f.id) ||
      (!!f.root_cause_id && job.scope?.split(/[+,]/).includes(f.root_cause_id))));
  const manuallyVerified = !!f.fix?.manual_review && manualReviewValid(f, f.fix.manual_review.head_commit);
  if (running || (f.workflow?.state === 'in_progress' && !manuallyVerified)) {
    return { kind: 'fixing', label: 'Being Fixed', detail: running ? 'A fix job is running for this bug.' : 'This bug is marked in progress.' };
  }
  // A finding's current fix takes precedence over PRs from earlier fix jobs.
  const currentUrl = f.fix?.pr_url;
  const pr = currentUrl
    ? prs.find((p) => p.url === currentUrl)
    : prs.find((p) => p.bugs.some((b) => b.id === f.id));
  const url = currentUrl ?? pr?.url;
  if (url) {
    const number = pr?.number ?? (Number(url.match(/\/pull\/(\d+)/)?.[1]) || null);
    if (pr?.status?.state === 'MERGED') return { kind: 'merged', label: 'Merged', detail: 'The related fix has been merged.', number, url };
    if (pr?.status?.state === 'CLOSED') return { kind: 'closed', label: 'PR closed', detail: 'The related PR was closed without merging.', number, url };
    if (pr?.status?.isDraft) return { kind: 'draft', label: 'Drafted PR', detail: 'Draft pull request; not ready for review yet.', number, url };
    let detail = 'GitHub status unavailable.';
    if (pr?.status) detail = 'Pull request open for review.';
    return { kind: 'raised', label: 'PR raised', number, detail, url };
  }
  const fix = f.fix;
  if (fix?.branch && manuallyVerified) return { kind: 'review', label: 'Ready for PR', detail: 'Manually verified; candidate warnings reviewed. Ready to open a PR.' };
  if (fix?.branch && fix.verified && fix.verification?.result === 'fixed' && !fix.flags?.length && !fix.blocked) {
    return { kind: 'review', label: 'Ready for Review', detail: 'Verified on a fix branch. Review the fix and open a PR.' };
  }
  const job = jobs.find((job) => job.id === fix?.job_id);
  // A cancelled/failed continuation can retain evidence from a completed fix.
  // Keep that fix reviewable without treating a running attempt as completed.
  const completed = job?.state === 'succeeded' || (job && job.state !== 'running' && !!fix?.verification);
  if (fix?.branch && completed) {
    return { kind: 'unverified', label: 'Needs Verification', detail: 'The fix has saved results, but verification is incomplete or unsuccessful. Review the fix and verify it before publishing.' };
  }
  return null;
}
