import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ runs: vi.fn(), jobs: vi.fn(), read: vi.fn(), workflow: vi.fn(), exec: vi.fn() }));
vi.mock('../server/runs.ts', () => ({ listAllRuns: mocks.runs }));
vi.mock('../server/jobs.ts', () => ({ listJobs: mocks.jobs }));
vi.mock('../../src/store/store.ts', () => ({ readFindings: mocks.read, allFindings: (f: unknown[]) => f }));
vi.mock('../../src/store/workflow.ts', () => ({ setWorkflow: mocks.workflow }));
vi.mock('node:child_process', () => ({ execFile: mocks.exec }));
vi.mock('node:util', () => ({ promisify: () => mocks.exec }));
import { listPRs } from '../server/prs.ts';

const url = 'https://github.com/example/repo/pull/12';
const bug = (id: string, pr = false, state: string | null = null) => ({
  id, title: id, severity: 'major', status: 'fixing', workflow: { state },
  fix: pr ? { pr_url: url, branch: 'fix/nav', at: 'now' } : null,
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.runs.mockReturnValue([{ ws: 'ws', ws_path: '/workspace', run: 'run', triaged: true }]);
  mocks.read.mockReturnValue([bug('BB-001', true), bug('BB-002'), bug('BB-003')]);
  mocks.jobs.mockReturnValue([{ id: 'job', kind: 'fix', branch: 'fix/nav', pr_url: url, finding_ids: ['BB-002'], started_at: 'now' }]);
});
const status = (state: string) => mocks.exec.mockResolvedValue({ stdout: JSON.stringify({ state, number: 12 }) });

describe('merged PR workflow reconciliation', () => {
  it('marks direct and job-only bugs Done, leaving unrelated bugs alone', async () => {
    status('MERGED');
    const result = await listPRs(null, true);
    expect(mocks.workflow).toHaveBeenCalledExactlyOnceWith('/workspace/runs/run', ['BB-001', 'BB-002'], { state: 'done' });
    expect(result.prs[0].bugs.map((b) => b.status)).toEqual(['fixed', 'fixed']);
  });
  it.each(['OPEN', 'CLOSED'])('does not mark bugs Done for %s PRs', async (state) => {
    status(state);
    await listPRs(null, true);
    expect(mocks.workflow).not.toHaveBeenCalled();
  });
  it('does not mark bugs Done when GitHub status is unavailable', async () => {
    mocks.exec.mockRejectedValue(new Error('offline'));
    await listPRs(null, true);
    expect(mocks.workflow).not.toHaveBeenCalled();
  });
  it('avoids rewriting bugs already Done', async () => {
    status('MERGED');
    mocks.read.mockReturnValue([bug('BB-001', true, 'done'), bug('BB-002', false, 'done')]);
    await listPRs(null, true);
    expect(mocks.workflow).not.toHaveBeenCalled();
  });
  it('updates each associated run even when their bug IDs are identical', async () => {
    status('MERGED');
    mocks.runs.mockReturnValue(['one', 'two'].map((run) => ({ ws: 'ws', ws_path: '/workspace', run, triaged: true })));
    await listPRs(null, true);
    expect(mocks.workflow).toHaveBeenCalledWith('/workspace/runs/one', ['BB-001', 'BB-002'], { state: 'done' });
    expect(mocks.workflow).toHaveBeenCalledWith('/workspace/runs/two', ['BB-001', 'BB-002'], { state: 'done' });
  });
});
