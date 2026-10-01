import { readInbox, markRead, readSettings, writeSettings, notify, SLACK_WEBHOOK, type Settings } from '../../src/notify/notify.ts';
import { HttpError } from './workspaces.ts';

/** Settings as the browser sees them: the Slack webhook is a secret, so only a masked hint leaves the server. */
export function publicSettings() {
  const s = readSettings();
  const w = s.slack_webhook;
  return { ...s, slack_webhook: null, slack_webhook_set: !!w, slack_webhook_hint: w ? `${w.slice(0, 34)}…${w.slice(-4)}` : null };
}

export function saveSettings(b: Partial<Settings> & { slack_webhook?: string | null }) {
  const cur = readSettings();
  const next: Settings = {
    channels: { ...cur.channels, ...(b.channels ?? {}) },
    events: { ...cur.events, ...(b.events ?? {}) },
    web_url: b.web_url ?? cur.web_url,
    // undefined = keep the stored webhook, '' or null = remove it.
    slack_webhook: b.slack_webhook === undefined ? cur.slack_webhook : b.slack_webhook ? b.slack_webhook.trim() : null,
  };
  if (next.slack_webhook && !SLACK_WEBHOOK.test(next.slack_webhook)) throw new HttpError(400, 'That is not a Slack incoming-webhook URL (https://hooks.slack.com/services/…)');
  if (!/^https?:\/\/[^\s]+$/.test(next.web_url)) throw new HttpError(400, 'Web app URL must start with http:// or https://');
  for (const v of [...Object.values(next.channels), ...Object.values(next.events)]) if (typeof v !== 'boolean') throw new HttpError(400, 'Toggles must be true or false');
  writeSettings(next);
  return publicSettings();
}

export function inbox() {
  const items = readInbox(100);
  return { items, unread: items.filter((x) => !x.read).length };
}

export function readMany(b: { ids?: string[]; all?: boolean }) {
  return { marked: markRead(b.all ? 'all' : (b.ids ?? []).filter((x) => typeof x === 'string')) };
}

export async function sendTest(channel: string) {
  if (!['macos', 'inbox', 'slack'].includes(channel)) throw new HttpError(400, 'channel must be macos, inbox or slack');
  const r = await notify({ event: 'run', level: 'info', title: 'Test notification', body: `This is a test from TurboBrocolli settings (${channel}).`, path: '/settings' }, { only: [channel as 'macos' | 'inbox' | 'slack'], force: true });
  return { channel, result: r.muted ? 'muted (tests)' : r.result[channel] };
}
