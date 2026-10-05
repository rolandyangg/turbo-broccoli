import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ attachment: vi.fn(), launch: vi.fn() }));
vi.mock('../server/attach.ts', () => ({ attachment: mocks.attachment, launchAttachment: mocks.launch }));
vi.mock('../server/workspaces.ts', async importOriginal => ({ ...await importOriginal<typeof import('../server/workspaces.ts')>(), runDirOf: () => '/test/run' }));
import { app } from '../server/app.ts';
const path = '/api/runs/ws/run/bugs/BB-001/attach';
const commands = 'reviewed commands';
beforeEach(() => {
  vi.clearAllMocks();
  mocks.attachment.mockResolvedValue({ branch: 'bugbash/test', commands, can_launch: true });
  mocks.launch.mockResolvedValue(undefined);
});
const post = (origin?: string, text = commands) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify({ commands: text }) });
describe('attach API', () => {
  it('previews commands without opening a terminal', async () => {
    expect((await app.request(path)).status).toBe(200);
    expect(mocks.launch).not.toHaveBeenCalled();
  });
  it('rejects non-local and missing browser origins', async () => {
    expect((await post('https://example.com')).status).toBe(403);
    expect((await post()).status).toBe(403);
    expect(mocks.launch).not.toHaveBeenCalled();
  });
  it('rejects stale or client-supplied commands', async () => {
    expect((await post('http://localhost:4317', 'other commands')).status).toBe(409);
    expect(mocks.launch).not.toHaveBeenCalled();
  });
  it('launches only the recomputed commands after local review', async () => {
    expect((await post('http://127.0.0.1:4317')).status).toBe(200);
    expect(mocks.launch).toHaveBeenCalledExactlyOnceWith(commands);
  });
});
