import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { api, useApi } from '../lib/api.ts';
import type { RunSummary } from '../lib/types.ts';
import { ago, dateTime, targetName } from '../lib/format.ts';
import { Chamfer, Chip, ErrorBox, Loading, useToast } from '../components/ui.tsx';

interface ScheduleView {
  id: string;
  name: string;
  target: string;
  preset: string;
  cron: string;
  repo: string | null;
  enabled: boolean;
  created_at: string;
  describe: string;
  next_run: string | null;
  loaded: boolean;
  last: { state: 'running' | 'succeeded' | 'failed'; at: string; ended_at: string | null; error: string | null; run: { ws: string; run: string } | null } | null;
}
const DAYS = [
  { n: 1, l: 'Mon' },
  { n: 2, l: 'Tue' },
  { n: 3, l: 'Wed' },
  { n: 4, l: 'Thu' },
  { n: 5, l: 'Fri' },
  { n: 6, l: 'Sat' },
  { n: 0, l: 'Sun' },
];

/** "in 5h 20m" for a future time. */
function inTime(iso: string) {
  const m = Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 60000));
  return m < 60 ? `in ${m}m` : m < 48 * 60 ? `in ${Math.floor(m / 60)}h ${m % 60}m` : `in ${Math.round(m / 1440)} days`;
}

/** time + days → cron ("30 2 * * 1-5"). */
function toCron(time: string, days: number[]) {
  const [h, m] = time.split(':').map(Number);
  const set = [...new Set(days)].sort((a, b) => a - b);
  const dow = set.length === 7 || !set.length ? '*' : set.join(',') === '1,2,3,4,5' ? '1-5' : set.join(',');
  return `${m || 0} ${h || 0} * * ${dow}`;
}

export function Schedules() {
  const { data, error, reload } = useApi<{ items: ScheduleView[]; platform: string }>('/schedules', { pollMs: 10000 });
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading what="Loading schedules" />;
  return (
    <>
      <div className="run-head">
        <div className="label">
          <Link to="/runs">Runs</Link> / Schedules
        </div>
        <h1 className="page-title">Schedules</h1>
        <p className="muted" style={{ maxWidth: 780, margin: '6px 0 0' }}>
          Scheduled bug bashes run through macOS launchd as your user: explore with the chosen preset, then triage (and the retrospective, if the preset has it on). They only run while this Mac is awake and you're logged in; a time missed while asleep runs once when it wakes. You get the usual notifications.
        </p>
      </div>
      {data.platform !== 'darwin' && <div className="empty" style={{ marginTop: 16, color: 'var(--warn)' }}>Schedules need macOS (launchd).</div>}
      <div className="dash-grid" style={{ marginTop: 20 }}>
        <div className="span-2 stack" style={{ ['--gap' as string]: '14px' }}>
          {!data.items.length && <div className="empty">No schedules yet. Add one on the right.</div>}
          {data.items.map((s) => (
            <ScheduleCard key={s.id} s={s} reload={reload} />
          ))}
        </div>
        <NewScheduleForm onCreated={reload} />
      </div>
    </>
  );
}

function ScheduleCard({ s, reload }: { s: ScheduleView; reload: () => void }) {
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast(ok);
      reload();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const lastTone = s.last?.state === 'failed' ? 'sev-critical dot' : s.last?.state === 'running' ? 'green live' : 'mint';
  return (
    <article className="box" aria-labelledby={`s-${s.id}`}>
      <div className="box-head">
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <span className="mono small">{s.id}</span>
          {s.enabled ? <Chip tone={s.loaded ? 'green' : 'sev-major dot'}>{s.loaded ? 'on' : 'on, not loaded'}</Chip> : <Chip tone="outline">off</Chip>}
          <Chip tone="outline">{s.preset}</Chip>
        </div>
        <label className="check small">
          <input type="checkbox" checked={s.enabled} disabled={busy} onChange={(e) => act(() => api(`/schedules/${s.id}/${e.target.checked ? 'enable' : 'disable'}`, { json: {} }), e.target.checked ? 'Schedule turned on' : 'Schedule turned off')} /> Enabled
        </label>
      </div>
      <div className="box-body stack" style={{ ['--gap' as string]: '8px' }}>
        <h3 id={`s-${s.id}`} className="proposal-title">
          {s.name}
        </h3>
        <dl className="kv">
          <dt>When</dt>
          <dd>
            {s.describe} <span className="mono small muted">({s.cron})</span>
          </dd>
          <dt>Next run</dt>
          <dd>{s.next_run ? `${dateTime(s.next_run)} (${inTime(s.next_run)})` : '—'}</dd>
          <dt>Target</dt>
          <dd className="mono small" style={{ wordBreak: 'break-all' }}>
            {s.target}
          </dd>
          <dt>Last run</dt>
          <dd>
            {s.last ? (
              <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <Chip tone={lastTone}>{s.last.state}</Chip>
                <span className="small">{ago(s.last.at)}</span>
                {s.last.run && <Link to={`/runs/${s.last.run.ws}/${encodeURIComponent(s.last.run.run)}`}>Open run →</Link>}
                {s.last.error && <span className="small" style={{ color: 'var(--err)' }}>{s.last.error.slice(0, 160)}</span>}
              </span>
            ) : (
              'never'
            )}
          </dd>
        </dl>
        {s.enabled && !s.loaded && <p className="small" style={{ margin: 0, color: 'var(--warn)' }}>launchd doesn't have this agent loaded. Turn it off and on again to reinstall it.</p>}
        <div className="row" style={{ gap: 8 }}>
          <button className="btn-ghost" disabled={busy || s.last?.state === 'running'} onClick={() => act(() => api(`/schedules/${s.id}/run`, { json: {} }), 'Started; it shows up under Runs in a few seconds')}>
            Run now
          </button>
          {confirm ? (
            <>
              <button className="btn-ghost" style={{ color: 'var(--err)' }} disabled={busy} onClick={() => act(() => api(`/schedules/${s.id}`, { method: 'DELETE' }), 'Schedule removed')}>
                Confirm remove
              </button>
              <button className="btn-ghost" onClick={() => setConfirm(false)}>
                Keep
              </button>
            </>
          ) : (
            <button className="btn-ghost" onClick={() => setConfirm(true)}>
              Remove
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

function NewScheduleForm({ onCreated }: { onCreated: () => void }) {
  const toast = useToast();
  const { data: runs } = useApi<RunSummary[]>('/runs');
  const { data: presets } = useApi<{ presets: { id: string; name: string }[] }>('/presets');
  const targets = useMemo(() => [...new Set((runs ?? []).map((r) => r.target))], [runs]);
  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const [preset, setPreset] = useState('standard');
  const [time, setTime] = useState('02:00');
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [advanced, setAdvanced] = useState(false);
  const [cronText, setCronText] = useState('0 2 * * 1-5');
  const cron = advanced ? cronText : toCron(time, days);
  const { data: preview } = useApi<{ ok: boolean; describe?: string; next_run?: string | null; error?: string }>(`/schedules/preview?cron=${encodeURIComponent(cron)}`);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!target && targets[0]) setTarget(targets[0]);
  }, [targets, target]);
  const create = async () => {
    setBusy(true);
    try {
      await api('/schedules', { json: { name: name.trim() || null, target: target.trim(), preset, cron } });
      toast('Schedule added and installed');
      setName('');
      onCreated();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="box" aria-labelledby="new-s">
      <div className="box-head">
        <div className="path" id="new-s">
          New schedule
        </div>
      </div>
      <div className="box-body stack" style={{ ['--gap' as string]: '12px' }}>
        <label className="field">
          <span className="label">Name</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={`Nightly ${targetName(target) || 'bug bash'}`} />
        </label>
        <label className="field">
          <span className="label">Target (URL, folder or repo)</span>
          <input className="input" list="sched-targets" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="https://… or ./path" />
          <datalist id="sched-targets">
            {targets.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </label>
        <label className="field">
          <span className="label">Preset</span>
          <select className="select" value={preset} onChange={(e) => setPreset(e.target.value)}>
            {(presets?.presets ?? [{ id: 'standard', name: 'Standard' }]).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        {advanced ? (
          <label className="field">
            <span className="label">Cron (minute hour day month weekday)</span>
            <input className="input mono" value={cronText} onChange={(e) => setCronText(e.target.value)} />
            <span className="small muted">Numbers, lists (1,3,5) and ranges (1-5). No steps like */15 (launchd can't do them).</span>
          </label>
        ) : (
          <>
            <label className="field">
              <span className="label">Time</span>
              <input className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            </label>
            <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className="label">Days</legend>
              <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                {DAYS.map((d) => (
                  <label key={d.n} className={`day-pill ${days.includes(d.n) ? 'on' : ''}`}>
                    <input type="checkbox" checked={days.includes(d.n)} onChange={(e) => setDays(e.target.checked ? [...days, d.n] : days.filter((x) => x !== d.n))} />
                    {d.l}
                  </label>
                ))}
              </div>
              <div className="row small" style={{ gap: 12, marginTop: 6 }}>
                <button className="btn-link" onClick={() => setDays([1, 2, 3, 4, 5])}>
                  Weekdays
                </button>
                <button className="btn-link" onClick={() => setDays([0, 1, 2, 3, 4, 5, 6])}>
                  Every day
                </button>
              </div>
            </fieldset>
          </>
        )}
        <button className="btn-link small" style={{ alignSelf: 'flex-start' }} onClick={() => (setAdvanced(!advanced), setCronText(cron))}>
          {advanced ? 'Use time and days' : 'Use a cron expression'}
        </button>
        <p className="small" style={{ margin: 0, color: preview && !preview.ok ? 'var(--err)' : undefined }} aria-live="polite">
          {preview ? (preview.ok ? `${preview.describe}. Next: ${preview.next_run ? dateTime(preview.next_run) : '—'}` : preview.error) : ' '}
        </p>
        <Chamfer tone="green" disabled={busy || !target.trim() || !preview?.ok || (!advanced && !days.length)} onClick={create}>
          {busy ? 'Adding…' : 'Add schedule'}
        </Chamfer>
      </div>
    </section>
  );
}
