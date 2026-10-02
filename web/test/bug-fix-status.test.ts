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
  it('distinguishes drafted PRs from PRs ready for review', () => {
    const draft = { ...pr(), status: { state: 'OPEN' as const, isDraft: true } };
    expect(bugFixStatus(finding(), [draft])).toMatchObject({ kind: 'draft', label: 'PR drafted', number: 12, url: draft.url });
    expect(bugFixStatus(finding(), [pr()])).toMatchObject({ kind: 'raised' });
    expect(bugFixStatus(finding(), [{ ...draft, status: { state: 'MERGED', isDraft: true } }])).toMatchObject({ kind: 'merged' });
  });
  it('labels verified local fixes awaiting review, but not incomplete or manually done bugs', () => {
    const fix = { branch: 'fix/bug', verified: true, verification: { result: 'fixed' } as NonNullable<Finding['fix']>['verification'] };
    expect(bugFixStatus(finding(fix))).toMatchObject({ kind: 'review', label: 'Fixed · awaiting review' });
    expect(bugFixStatus(finding({ ...fix, flags: ['incomplete'] }))).toBeNull();
    expect(bugFixStatus(finding({ ...fix, blocked: true }))).toBeNull();
    expect(bugFixStatus(finding({ ...fix, verification: null }))).toBeNull();
    expect(bugFixStatus({ ...finding(), status: 'fixed' })).toBeNull();
  });
  it('labels a raised PR even before live state is available', () => {
    expect(bugFixStatus(finding({ pr_url: pr().url }))).toMatchObject({ kind: 'raised', label: 'PR raised', number: 12 });
    expect(bugFixStatus(finding(), [pr()])).toMatchObject({ kind: 'raised' });
    expect(bugFixStatus(finding(), [{ ...pr(), status: null }])).toMatchObject({ kind: 'raised' });
  });
  it('uses merged and closed state for all related bugs, including job-only associations', () => {
    expect(bugFixStatus(finding(), [pr('MERGED')])).toMatchObject({ kind: 'merged', label: 'PR merged' });
    expect(bugFixStatus({ ...finding(), id: 'BB-002' }, [pr('MERGED')])).toMatchObject({ kind: 'merged' });
    expect(bugFixStatus(finding(), [pr('CLOSED')])).toMatchObject({ kind: 'closed', label: 'PR closed' });
    expect(bugFixStatus({ ...finding(), id: 'BB-003' }, [pr('MERGED')])).toBeNull();
  });
  it('prefers the current fix PR over older attempts', () => {
    const current = { ...pr(), url: 'https://github.com/example/repo/pull/13', number: 13 };
    expect(bugFixStatus(finding({ pr_url: current.url }), [pr('MERGED'), current])).toMatchObject({ kind: 'raised', number: 13 });
  });
});
