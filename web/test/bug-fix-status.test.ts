import { describe, expect, it } from 'vitest';
import type { Finding } from '../src/lib/types.ts';
import { bugFixStatus, type BugPr } from '../src/lib/bugFixStatus.ts';

const finding = (fix: Partial<NonNullable<Finding['fix']>> | null = null) => ({
  id: 'BB-001', status: 'fixing', fix,
}) as Finding;
const pr = (state: 'OPEN' | 'MERGED' | 'CLOSED' = 'OPEN'): BugPr => ({
  url: 'https://github.com/example/repo/pull/12', number: 12,
  bugs: [{ id: 'BB-001' }, { id: 'BB-002' }], status: { state, isDraft: false },
});

describe('bug fix annotations', () => {
  it('shows active fix work ahead of previous PR results', () => {
    const jobs = [{ id: 'new-fix', state: 'running' as const, kind: 'fix' as const, finding_ids: ['BB-001'] }];
    expect(bugFixStatus(finding(), [pr('MERGED')], jobs)).toMatchObject({ kind: 'fixing', label: 'Being Fixed' });
    expect(bugFixStatus(finding(), [], [{ ...jobs[0], alive: false }])).toBeNull();
    expect(bugFixStatus(finding(), [], [{ ...jobs[0], kind: 'triage' }])).toBeNull();
    expect(bugFixStatus({ ...finding(), root_cause_id: 'RC-003' }, [], [{ ...jobs[0], finding_ids: [], scope: 'RC-003' }])).toMatchObject({ kind: 'fixing' });
    expect(bugFixStatus({ ...finding(), workflow: { state: 'in_progress' } as Finding['workflow'] })).toMatchObject({ kind: 'fixing' });
  });
  it('distinguishes drafted PRs from PRs ready for review', () => {
    const draft = { ...pr(), status: { state: 'OPEN' as const, isDraft: true } };
    expect(bugFixStatus(finding(), [draft])).toMatchObject({ kind: 'draft', label: 'Drafted PR', number: 12, url: draft.url });
    expect(bugFixStatus(finding(), [pr()])).toMatchObject({ kind: 'raised' });
    expect(bugFixStatus(finding(), [{ ...draft, status: { state: 'MERGED', isDraft: true } }])).toMatchObject({ kind: 'merged' });
  });
  it('labels verified local fixes awaiting review, but not incomplete or manually done bugs', () => {
    const fix = { branch: 'fix/bug', verified: true, verification: { result: 'fixed' } as NonNullable<Finding['fix']>['verification'] };
    expect(bugFixStatus(finding(fix))).toMatchObject({ kind: 'review', label: 'Ready for Review' });
    expect(bugFixStatus(finding({ ...fix, flags: ['incomplete'] }))).toBeNull();
    expect(bugFixStatus(finding({ ...fix, blocked: true }))).toBeNull();
    expect(bugFixStatus(finding({ ...fix, verification: null }))).toBeNull();
    expect(bugFixStatus({ ...finding(), status: 'fixed' })).toBeNull();
  });
  it('marks completed fixes needing verification, but not running or failed jobs', () => {
    const fix = { branch: 'fix/bug', job_id: 'fix-1', verified: false };
    const jobs = [{ id: 'fix-1', state: 'succeeded' as const }];
    expect(bugFixStatus(finding(fix), [], jobs)).toMatchObject({ kind: 'unverified', label: 'Needs Verification' });
    expect(bugFixStatus(finding(fix), [], [{ id: 'fix-1', state: 'running' }])).toMatchObject({ kind: 'fixing' });
    expect(bugFixStatus(finding(fix), [], [{ id: 'fix-1', state: 'failed' }])).toBeNull();
    expect(bugFixStatus(finding(fix), [], [{ id: 'other', state: 'succeeded' }])).toBeNull();
    expect(bugFixStatus(finding(fix))).toBeNull();
    expect(bugFixStatus(finding({ ...fix, verified: true, flags: ['incomplete'] }), [], jobs)).toMatchObject({ kind: 'unverified' });
    expect(bugFixStatus(finding({ ...fix, pr_url: pr().url }), [pr('MERGED')], jobs)).toMatchObject({ kind: 'merged' });
  });
  it('retains the review overlay when a continuation is cancelled with earlier evidence (BB-0078)', () => {
    const fix = { branch: 'fix/bug', job_id: 'continuation', verified: false,
      flags: ['BB-0078: the bug is still present'],
      verification: { result: 'present' } as NonNullable<Finding['fix']>['verification'],
    };
    expect(bugFixStatus(finding(fix), [], [{ id: 'continuation', state: 'cancelled' }]))
      .toMatchObject({ kind: 'unverified', label: 'Needs Verification' });
    expect(bugFixStatus(finding(fix), [], [{ id: 'continuation', state: 'failed' }]))
      .toMatchObject({ kind: 'unverified' });
    expect(bugFixStatus(finding(fix), [], [{ id: 'continuation', state: 'running' }])).toMatchObject({ kind: 'fixing' });
  });
  it('labels a raised PR even before live state is available', () => {
    expect(bugFixStatus(finding({ pr_url: pr().url }))).toMatchObject({ kind: 'raised', label: 'PR raised', number: 12 });
    expect(bugFixStatus(finding(), [pr()])).toMatchObject({ kind: 'raised' });
    expect(bugFixStatus(finding(), [{ ...pr(), status: null }])).toMatchObject({ kind: 'raised' });
  });
  it('uses merged and closed state for all related bugs, including job-only associations', () => {
    expect(bugFixStatus(finding(), [pr('MERGED')])).toMatchObject({ kind: 'merged', label: 'Merged' });
    expect(bugFixStatus({ ...finding(), id: 'BB-002' }, [pr('MERGED')])).toMatchObject({ kind: 'merged' });
    expect(bugFixStatus(finding(), [pr('CLOSED')])).toMatchObject({ kind: 'closed', label: 'PR closed' });
    expect(bugFixStatus({ ...finding(), id: 'BB-003' }, [pr('MERGED')])).toBeNull();
  });
  it('prefers the current fix PR over older attempts', () => {
    const current = { ...pr(), url: 'https://github.com/example/repo/pull/13', number: 13 };
    expect(bugFixStatus(finding({ pr_url: current.url }), [pr('MERGED'), current])).toMatchObject({ kind: 'raised', number: 13 });
  });
});
