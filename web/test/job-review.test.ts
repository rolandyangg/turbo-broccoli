import { afterEach, beforeEach, expect, it, vi } from 'vitest';
let { completionKey, dismissJobs, jobsAwaitingReview, markJobReviewed, parseReviews } = await import('../src/lib/jobReview.ts');
beforeEach(async () => {
  vi.resetModules();
  ({ completionKey, dismissJobs, jobsAwaitingReview, markJobReviewed, parseReviews } = await import('../src/lib/jobReview.ts'));
});
import type { JobView } from '../src/lib/types.ts';
const job = { id: 'fix-one', started_at: 'start', ended_at: 'end', state: 'succeeded', alive: false } as JobView;
afterEach(() => vi.unstubAllGlobals());

it('retains finished, failed and cancelled jobs until results are reviewed', () => {
  const jobs = [job, { ...job, id: 'failed', state: 'failed' as const }, { ...job, id: 'cancelled', state: 'cancelled' as const }];
  expect(jobsAwaitingReview(jobs, {})).toHaveLength(3);
  expect(jobsAwaitingReview(jobs, { [job.id]: completionKey(job)! })).toHaveLength(2);
});
it('a running visit cannot acknowledge a future completion', () => {
  const running = { ...job, state: 'running' as const, ended_at: null, alive: true };
  expect(completionKey(running)).toBeNull();
  expect(jobsAwaitingReview([running], {})).toEqual([]);
  expect(jobsAwaitingReview([job], {})).toEqual([job]);
});
it('persists review state across board remounts and notifies other mounted boards', () => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  const dispatchEvent = vi.fn();
  vi.stubGlobal('window', { dispatchEvent });
  markJobReviewed({ ...job, state: 'running' });
  expect(storage.size).toBe(0);
  markJobReviewed(job);
  markJobReviewed(job);
  const reviewed = parseReviews([...storage.values()][0]);
  expect(jobsAwaitingReview([job], reviewed)).toEqual([]);
  expect(dispatchEvent).toHaveBeenCalledTimes(1);
  expect(jobsAwaitingReview([{ ...job, ended_at: 'later' }], reviewed)).toHaveLength(1);
});
it('tolerates malformed saved reviews', () => {
  for (const raw of ['broken', 'null', '[]']) expect(parseReviews(raw)).toEqual({});
  expect(parseReviews('{"ok":"key","bad":4}')).toEqual({ ok: 'key' });
});

it('bulk dismissal only clears supplied finished jobs, preserving running and future completions', () => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  vi.stubGlobal('window', { dispatchEvent: vi.fn() });
  const running = { ...job, id: 'live', state: 'running' as const, ended_at: null };
  const other = { ...job, id: 'other' };
  dismissJobs([job, running]);
  const reviewed = parseReviews([...storage.values()][0]);
  expect(jobsAwaitingReview([job, other, running], reviewed)).toEqual([other]);
  expect(reviewed.live).toBeUndefined();
  expect(jobsAwaitingReview([{ ...running, state: 'succeeded', ended_at: 'later' }], reviewed)).toHaveLength(1);
});
