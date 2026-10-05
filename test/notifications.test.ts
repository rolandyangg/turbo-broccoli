import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../src/notify/macos.js', () => ({ sendMacNotification: vi.fn(async () => 'sent') }));
import { notify, Settings, writeSettings } from '../src/notify/notify.js';
import { sendMacNotification } from '../src/notify/macos.js';

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'broccoli-notify-'));
  roots.push(root);
  vi.stubEnv('BUGBASH_HOME', root);
  vi.stubEnv('BUGBASH_NOTIFY_TEST', '1');
  vi.stubEnv('BUGBASH_JOB_ID', '');
  writeSettings(Settings.parse({ web_url: 'http://localhost:4317/' }));
  return root;
}

describe('notification destinations', () => {
  it('opens the owning job for notifications from a web job', async () => {
    const root = setup();
    vi.stubEnv('BUGBASH_JOB_ID', 'fix-job-123');
    const result = await notify({ event: 'fix', title: 'Fix done', body: 'Verified', path: '/runs/ws/run/bugs/BB-1' });
    expect(result.notification?.path).toBe('/jobs/fix-job-123');
    if (process.platform === 'darwin') expect(sendMacNotification).toHaveBeenCalledWith(root, expect.objectContaining({ url: 'http://localhost:4317/jobs/fix-job-123' }));
  });

  it('preserves a CLI notification destination outside a web job', async () => {
    setup();
    const result = await notify({ event: 'run', title: 'Run done', body: '', path: '/runs/ws/run' });
    expect(result.notification?.path).toBe('/runs/ws/run');
  });

  it('uses the jobs page when no destination is supplied', async () => {
    const root = setup();
    await notify({ event: 'failure', title: 'Error', body: '' });
    if (process.platform === 'darwin') expect(sendMacNotification).toHaveBeenCalledWith(root, expect.objectContaining({ url: 'http://localhost:4317/jobs' }));
  });
});
