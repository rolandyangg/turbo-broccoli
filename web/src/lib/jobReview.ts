import { useEffect, useSyncExternalStore } from 'react';
import type { JobView } from './types.ts';

const STORAGE_KEY = 'bugbash:reviewed-jobs:v1';
const CHANGE_EVENT = 'bugbash:job-reviewed';
let fallback = '{}';

// Include completion state so an earlier visit while running never hides new results.
export function completionKey(job: JobView): string | null {
  if (job.state === 'running') return null;
  return JSON.stringify([job.id, job.started_at, job.state, job.ended_at]);
}

export function parseReviews(raw: string): Record<string, string> {
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const reviewed: Record<string, string> = {};
    for (const [id, key] of Object.entries(value)) {
      if (typeof key === 'string') reviewed[id] = key;
    }
    return reviewed;
  } catch { return {}; }
}

function snapshot() {
  try { return localStorage.getItem(STORAGE_KEY) ?? fallback; }
  catch { return fallback; }
}

function subscribe(notify: () => void) {
  window.addEventListener('storage', notify);
  window.addEventListener(CHANGE_EVENT, notify);
  return () => {
    window.removeEventListener('storage', notify);
    window.removeEventListener(CHANGE_EVENT, notify);
  };
}

export function useJobReviews() {
  return parseReviews(useSyncExternalStore(subscribe, snapshot, () => '{}'));
}

export function jobsAwaitingReview(jobs: JobView[], reviewed: Record<string, string>) {
  return jobs.filter((job) => {
    const key = completionKey(job);
    return key !== null && reviewed[job.id] !== key;
  });
}

export function markJobReviewed(job: JobView) {
  dismissJobs([job]);
}

/** Dismiss only the completions currently displayed; running and future work stays visible. */
export function dismissJobs(jobs: JobView[]) {
  const reviewed = parseReviews(snapshot());
  let changed = false;
  for (const job of jobs) {
    const key = completionKey(job);
    if (!key || reviewed[job.id] === key) continue;
    reviewed[job.id] = key;
    changed = true;
  }
  if (!changed) return;
  fallback = JSON.stringify(reviewed);
  try { localStorage.setItem(STORAGE_KEY, fallback); } catch { /* Retain state in memory if storage is unavailable. */ }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** A successful final detail fetch means the user has opened the actual results. */
export function useReviewJobResults(job: JobView | null, expectedId: string, error: string | null) {
  useEffect(() => {
    if (job && job.id === expectedId && !error) markJobReviewed(job);
  }, [job, expectedId, error]);
}
