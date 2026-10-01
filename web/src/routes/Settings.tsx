import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api, useApi } from '../lib/api.ts';
import { Chamfer, Chip, ErrorBox, Loading, useToast } from '../components/ui.tsx';

type Channel = 'macos' | 'inbox' | 'slack';
type Event = 'run' | 'fix' | 'failure' | 'proposals';
interface SettingsView {
  channels: Record<Channel, boolean>;
  events: Record<Event, boolean>;
  web_url: string;
  slack_webhook_set: boolean;
  slack_webhook_hint: string | null;
}

const CHANNELS: { id: Channel; label: string; help: string }[] = [
  { id: 'macos', label: 'macOS notifications', help: 'Shown by Notification Center. Install terminal-notifier (brew install terminal-notifier) to make clicking one open the page here.' },
  { id: 'inbox', label: 'In-app inbox', help: 'The bell in the top bar. Kept in ~/.bugbash/notifications.jsonl.' },
  { id: 'slack', label: 'Slack', help: 'Posts to a Slack incoming webhook. The URL is stored only on this machine (~/.bugbash/settings.json) and never shown again in full.' },
];
const EVENTS: { id: Event; label: string; help: string }[] = [
  { id: 'run', label: 'Runs and triage finished', help: 'Counts, new critical/major bugs and regressions.' },
  { id: 'fix', label: 'Fixes finished', help: 'Verified or not, the branch and PR link. Also implemented improvements.' },
  { id: 'failure', label: 'Failures and limits', help: 'Crashed or failed jobs, Claude usage limits, reviewer unavailable during triage, benchmark recall regressions.' },
  { id: 'proposals', label: 'New improvement proposals', help: 'When a retrospective leaves proposals for you to review.' },
];

export function Settings() {
  const { data, error, reload } = useApi<SettingsView>('/settings');
  const toast = useToast();
  const [form, setForm] = useState<SettingsView | null>(null);
  const [webhook, setWebhook] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (data) setForm(data);
  }, [data]);
  if (error) return <ErrorBox error={error} />;
  if (!data || !form) return <Loading what="Loading settings" />;

  const save = async (extra: { slack_webhook?: string | null } = {}) => {
    setBusy(true);
    try {
      await api('/settings', { method: 'PUT', json: { channels: form.channels, events: form.events, web_url: form.web_url, ...extra } });
      setWebhook('');
      toast('Settings saved');
      reload();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const test = async (channel: Channel) => {
    try {
      const r = await api<{ result: string }>('/settings/test', { json: { channel } });
      toast(r.result === 'sent' ? `Test sent to ${channel}` : `${channel}: ${r.result}`, r.result !== 'sent');
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  const dirty = JSON.stringify({ c: form.channels, e: form.events, u: form.web_url }) !== JSON.stringify({ c: data.channels, e: data.events, u: data.web_url }) || !!webhook.trim();

  return (
    <>
      <div className="run-head">
        <div className="label">
          <Link to="/">Dashboard</Link> / Settings
        </div>
        <h1 className="page-title">Settings</h1>
      </div>
      <div className="dash-grid" style={{ marginTop: 20 }}>
        <section className="box span-2" aria-labelledby="ch-h">
          <div className="box-head">
            <div className="path" id="ch-h">
              Notification channels
            </div>
          </div>
          <div className="box-body stack" style={{ ['--gap' as string]: '18px' }}>
            {CHANNELS.map((c) => (
              <div key={c.id} className="setting-row">
                <label className="check">
                  <input type="checkbox" checked={form.channels[c.id]} onChange={(e) => setForm({ ...form, channels: { ...form.channels, [c.id]: e.target.checked } })} /> <b>{c.label}</b>
                </label>
                <p className="small muted" style={{ margin: '4px 0 0 24px' }}>
                  {c.help}
                </p>
                {c.id === 'slack' && (
                  <div className="stack" style={{ ['--gap' as string]: '8px', margin: '10px 0 0 24px' }}>
                    <label className="field">
                      <span className="label">Incoming webhook URL</span>
                      <input
                        className="input"
                        type="password"
                        autoComplete="off"
                        spellCheck={false}
                        placeholder={data.slack_webhook_set ? `Saved: ${data.slack_webhook_hint}` : 'https://hooks.slack.com/services/…'}
                        value={webhook}
                        onChange={(e) => setWebhook(e.target.value)}
                      />
                    </label>
                    {data.slack_webhook_set && (
                      <div>
                        <button className="btn-link small" disabled={busy} onClick={() => save({ slack_webhook: null })}>
                          Remove saved webhook
                        </button>
                      </div>
                    )}
                  </div>
                )}
                <div style={{ margin: '8px 0 0 24px' }}>
                  <button className="btn-ghost" onClick={() => test(c.id)} disabled={c.id === 'slack' && !data.slack_webhook_set}>
                    Send a test
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
        <section className="box" aria-labelledby="ev-h">
          <div className="box-head">
            <div className="path" id="ev-h">
              Notify me about
            </div>
          </div>
          <div className="box-body stack" style={{ ['--gap' as string]: '14px' }}>
            {EVENTS.map((ev) => (
              <div key={ev.id}>
                <label className="check">
                  <input type="checkbox" checked={form.events[ev.id]} onChange={(e) => setForm({ ...form, events: { ...form.events, [ev.id]: e.target.checked } })} /> <b>{ev.label}</b>
                </label>
                <p className="small muted" style={{ margin: '4px 0 0 24px' }}>
                  {ev.help}
                </p>
              </div>
            ))}
            <label className="field">
              <span className="label">Web app URL (for links)</span>
              <input className="input" value={form.web_url} onChange={(e) => setForm({ ...form, web_url: e.target.value })} />
            </label>
          </div>
        </section>
      </div>
      <GitHubConnection />
      <div className="row" style={{ marginTop: 20, gap: 10 }}>
        <Chamfer tone="green" disabled={busy || !dirty} onClick={() => save(webhook.trim() ? { slack_webhook: webhook.trim() } : {})}>
          {busy ? 'Saving…' : 'Save settings'}
        </Chamfer>
        {dirty && (
          <button className="btn-ghost" onClick={() => (setForm(data), setWebhook(''))}>
            Discard changes
          </button>
        )}
      </div>
    </>
  );
}

/** GitHub session used to host before/after pictures in fix PRs (GitHub's own image hosting; nothing committed). */
function GitHubConnection() {
  const { data, reload } = useApi<{ login: string | null; connected: boolean; connecting: string | null }>('/github', { pollMs: 5000 });
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const act = async (path: string, msg: string) => {
    setBusy(true);
    try {
      await api(path, { json: {} });
      toast(msg);
      reload();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="box" style={{ marginTop: 20 }} aria-labelledby="gh-h">
      <div className="box-head">
        <div className="path" id="gh-h">
          GitHub: pictures in fix PRs
        </div>
      </div>
      <div className="box-body stack" style={{ ['--gap' as string]: '10px' }}>
        <p className="small muted" style={{ margin: 0, maxWidth: 820 }}>
          Fix PRs can show before/after pictures hosted by GitHub itself, the same as dragging an image into a PR. Nothing is committed to your repo, and only people who can see the repo can see the pictures. GitHub has no API for this, so bugbash uploads through a browser signed in to your account. Sign in once; the session stays in a private browser profile in <code>~/.bugbash/github-session</code> on this machine.
        </p>
        {!data ? (
          <span className="small muted">Checking…</span>
        ) : data.connecting ? (
          <span className="small">
            A sign-in window is open: sign in to GitHub there. <Link to={`/jobs/${data.connecting}`}>Watch</Link>
          </span>
        ) : data.connected ? (
          <div className="row" style={{ gap: 10 }}>
            <Chip tone="green">connected as {data.login}</Chip>
            <button className="btn-ghost" disabled={busy} onClick={() => act('/github/disconnect', 'Disconnected from GitHub')}>
              Disconnect
            </button>
          </div>
        ) : (
          <div className="row" style={{ gap: 10 }}>
            <Chip tone="outline">not connected</Chip>
            <Chamfer small disabled={busy} onClick={() => act('/github/connect', 'A browser window is opening: sign in to GitHub there')}>
              Connect GitHub
            </Chamfer>
          </div>
        )}
      </div>
    </section>
  );
}
