import { expect, it, vi } from 'vitest';
vi.mock('../server/runs.ts', () => ({ listAllRuns: () => [], isFunctional: () => false }));
vi.mock('../server/jobs.ts', () => ({ listJobs: () => Array.from({ length: 12 }, (_, i) => ({ id: `job-${i}`, state: 'running', alive: true })) }));
import { dashboard } from '../server/dashboard.ts';
it('includes every active job even before a first run exists', () => {
  const data = dashboard();
  expect(data.jobs).toHaveLength(8);
  expect(data.activity_jobs).toHaveLength(12);
  expect(data.kpis.running_jobs).toBe(12);
  expect(data.activity_runs).toEqual([]);
});
