import { listSchedules, addSchedule, setEnabled, removeSchedule, runNow, nextRun, describeCron, lastResult, isLoaded, cronToCalendar, type NewSchedule } from '../../src/schedule/schedule.ts';
import { getPreset } from '../../src/presets.ts';
import { HttpError, locateRunDir } from './workspaces.ts';

const ID = /^[0-9a-f]{8}$/;
const wrap = async <T>(fn: () => Promise<T> | T): Promise<T> => {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof HttpError) throw e;
    const msg = (e as Error).message;
    throw new HttpError(/No schedule/.test(msg) ? 404 : 400, msg);
  }
};

export async function schedulesOverview() {
  const items = await Promise.all(
    listSchedules().map(async (s) => {
      const last = lastResult(s.id);
      return { ...s, describe: describeCron(s.cron), next_run: s.enabled ? (nextRun(s.cron)?.toISOString() ?? null) : null, loaded: s.enabled ? await isLoaded(s.id) : false, last: last ? { ...last, run: locateRunDir(last.run_dir) } : null };
    }),
  );
  return { items, platform: process.platform };
}

export function previewCron(cron: string) {
  try {
    cronToCalendar(cron);
    return { ok: true, describe: describeCron(cron), next_run: nextRun(cron)?.toISOString() ?? null };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export const createSchedule = (b: NewSchedule) =>
  wrap(async () => {
    if (process.platform !== 'darwin') throw new HttpError(409, 'Schedules use macOS launchd');
    if (!getPreset(b.preset)) throw new HttpError(400, `Unknown preset "${b.preset}"`);
    return addSchedule(b);
  });
export const toggleSchedule = (id: string, enabled: boolean) => wrap(() => (ID.test(id) ? setEnabled(id, enabled) : Promise.reject(new HttpError(400, 'Bad id'))));
export const deleteSchedule = (id: string) => wrap(() => (ID.test(id) ? removeSchedule(id) : Promise.reject(new HttpError(400, 'Bad id'))));
export const runScheduleNow = (id: string) => wrap(() => (ID.test(id) ? runNow(id) : Promise.reject(new HttpError(400, 'Bad id'))));
