import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';

// Never touches the real ~/Library/LaunchAgents or launchd: temp dirs and a no-op launchctl.
beforeAll(() => {
  const root = mkdtempSync(join(tmpdir(), 'bb-sched-'));
  process.env.BUGBASH_HOME = join(root, 'home');
  process.env.BUGBASH_LAUNCH_AGENTS = join(root, 'LaunchAgents');
  process.env.BUGBASH_LAUNCHCTL = 'true';
});

describe('cron → launchd', () => {
  it('expands numbers, lists and ranges into StartCalendarInterval entries', async () => {
    const { cronToCalendar } = await import('../src/schedule/schedule.js');
    expect(cronToCalendar('0 2 * * *')).toEqual([{ Minute: 0, Hour: 2 }]);
    expect(cronToCalendar('30 9 * * 1-5')).toHaveLength(5);
    expect(cronToCalendar('15 8,20 * * 0,7')).toEqual([
      { Minute: 15, Hour: 8, Weekday: 0 },
      { Minute: 15, Hour: 20, Weekday: 0 },
    ]);
    expect(cronToCalendar('@daily')).toEqual([{ Minute: 0, Hour: 0 }]);
    expect(cronToCalendar('0 * * * *')).toEqual([{ Minute: 0 }]);
  });

  it('rejects forms launchd cannot express, with a reason', async () => {
    const { cronToCalendar } = await import('../src/schedule/schedule.js');
    expect(() => cronToCalendar('*/15 * * * *')).toThrow(/steps/);
    expect(() => cronToCalendar('* 2 * * *')).toThrow(/Minute must be a number/);
    expect(() => cronToCalendar('0 25 * * *')).toThrow(/Hour must be between/);
    expect(() => cronToCalendar('0 2 * *')).toThrow(/5 fields/);
    expect(() => cronToCalendar('0 2 * * MON')).toThrow(/names/);
  });

  it('computes the next run and describes it', async () => {
    const { nextRun, describeCron } = await import('../src/schedule/schedule.js');
    const from = new Date(2026, 9, 2, 10, 0); // Fri 2 Oct 2026 10:00 local
    expect(nextRun('0 2 * * *', from)?.toString()).toBe(new Date(2026, 9, 3, 2, 0).toString());
    expect(nextRun('30 9 * * 1-5', from)?.toString()).toBe(new Date(2026, 9, 5, 9, 30).toString()); // Monday
    expect(describeCron('0 2 * * 1-5')).toBe('Weekdays at 02:00');
    expect(describeCron('30 9 * * *')).toBe('Every day at 09:30');
  });
});

describe('LaunchAgent lifecycle', () => {
  it('writes a valid plist, toggles and removes it, and keeps the schedule store in sync', async () => {
    const S = await import('../src/schedule/schedule.js');
    const s = await S.addSchedule({ target: 'fixtures/buggy-site', cron: '0 2 * * 1-5', preset: 'quick', name: 'Nightly <fixture> & co' });
    expect(existsSync(S.plistPath(s.id))).toBe(true);
    expect((await execa('plutil', ['-lint', S.plistPath(s.id)], { reject: false })).exitCode).toBe(0);
    const plist = readFileSync(S.plistPath(s.id), 'utf8');
    expect(plist).toContain(`<string>${S.labelOf(s.id)}</string>`);
    expect(plist).toContain('<string>--then-triage</string>');
    expect(plist).toContain('Nightly &lt;fixture&gt; &amp; co (scheduled)');
    expect(plist).toContain(`<string>${join(process.cwd(), 'fixtures/buggy-site')}</string>`); // made absolute
    expect(plist.match(/<key>Weekday<\/key>/g)).toHaveLength(5);

    await S.setEnabled(s.id, false);
    expect(existsSync(S.plistPath(s.id))).toBe(false);
    expect(S.getSchedule(s.id).enabled).toBe(false);
    await S.setEnabled(s.id, true);
    expect(existsSync(S.plistPath(s.id))).toBe(true);

    await S.removeSchedule(s.id);
    expect(existsSync(S.plistPath(s.id))).toBe(false);
    expect(S.listSchedules()).toHaveLength(0);
    await expect(S.addSchedule({ target: 'x', cron: '*/5 * * * *', preset: 'quick' })).rejects.toThrow(/steps/);
    await expect(S.addSchedule({ target: 'x', cron: '0 1 * * *', preset: '../evil' })).rejects.toThrow(/preset/);
  });
});

describe('last result', () => {
  it('reports a run whose process died without finishing as interrupted, and names months', async () => {
    const S = await import('../src/schedule/schedule.js');
    S.recordLast('cafebabe', { state: 'running', at: new Date().toISOString(), ended_at: null, run_dir: null, error: null, pid: 999999 });
    expect(S.lastResult('cafebabe')).toMatchObject({ state: 'failed', error: /Interrupted/ });
    S.recordLast('cafebabe', { state: 'running', at: new Date().toISOString(), ended_at: null, run_dir: null, error: null });
    expect(S.lastResult('cafebabe')?.state).toBe('running'); // this process is alive
    expect(S.describeCron('0 4 1 1 *')).toBe('Day 1 of the month in Jan at 04:00');
  });
});
