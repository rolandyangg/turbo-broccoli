import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { api, useApi } from '../lib/api.ts';
import type { JobView } from '../lib/types.ts';
import { Chamfer, Chip, Dialog, useToast } from './ui.tsx';

interface Catalog {
  personas: { id: string; summary: string; toolset: string; device?: string; enabledByDefault: boolean }[];
  devices: { id: string; label: string; kind: 'phone' | 'tablet' | 'desktop'; viewport: { width: number; height: number } }[];
  strategies: { id: string; label: string; group: string }[];
  browsers: string[];
  defaults: { denylist: string };
}
interface Preset {
  id: string;
  name: string;
  description: string;
  builtin: boolean;
  config: Partial<Form>;
}

/** The launcher's editable settings (a subset of the agent Config, with the same field names). */
interface Form {
  personas: string[];
  personaSessions: Record<string, number>;
  browsers: string[];
  devices: string[];
  focusPaths: string[];
  strategies: { include: string[]; exclude: string[] };
  guardrails: { denylist: string; allowMutations: boolean; sameOriginOnly: boolean; extraAllowedOrigins: string[] };
  triage: { video: boolean; review: boolean };
  retrospective: boolean;
  lead: boolean;
  codeIntel: boolean;
  provider: 'claude' | 'codex' | null;
  model: string | null;
  budgetSessions: number;
  parallel: number;
  maxToolCallsPerSession: number;
  timeLimitMs: number;
}

const BASE: Form = {
  personas: [],
  personaSessions: {},
  browsers: ['chromium', 'webkit'],
  devices: [],
  focusPaths: [],
  strategies: { include: [], exclude: [] },
  guardrails: { denylist: '', allowMutations: false, sameOriginOnly: true, extraAllowedOrigins: [] },
  triage: { video: true, review: true },
  retrospective: true,
  lead: true,
  codeIntel: true,
  provider: null,
  model: null,
  budgetSessions: 6,
  parallel: 3,
  maxToolCallsPerSession: 120,
  timeLimitMs: 2 * 60 * 60_000,
};

function fromPreset(p: Preset | undefined, cat: Catalog): Form {
  const c = (p?.config ?? {}) as Partial<Form>;
  const enabled = cat.personas.filter((x) => x.enabledByDefault).map((x) => x.id);
  return {
    ...BASE,
    ...c,
    provider: c.provider ?? (c.model ? 'claude' : null),
    personas: c.personas?.length ? c.personas : enabled,
    personaSessions: { ...(c.personaSessions ?? {}) },
    devices: c.devices?.length ? c.devices : cat.devices.map((d) => d.id),
    strategies: { include: [], exclude: [...(c.strategies?.exclude ?? [])], ...(c.strategies?.include?.length ? { include: c.strategies.include } : {}) },
    guardrails: { ...BASE.guardrails, denylist: cat.defaults.denylist, ...(c.guardrails ?? {}) },
    triage: { ...BASE.triage, ...(c.triage ?? {}) },
  };
}

/** What gets sent: the full form as explicit settings (layered over the chosen preset by the CLI). */
function toConfig(f: Form, cat: Catalog) {
  const allDevices = cat.devices.length === f.devices.length;
  return {
    ...f,
    devices: allDevices ? [] : f.devices,
    personaSessions: Object.fromEntries(Object.entries(f.personaSessions).filter(([p, n]) => f.personas.includes(p) && n > 0)),
    disabledPersonas: cat.personas.filter((p) => !f.personas.includes(p.id)).map((p) => p.id),
  };
}

const GROUPS: Record<string, string> = { size: 'Sizes & devices', content: 'Content & text', chaos: 'Interaction chaos', nav: 'Navigation', env: 'Environment', data: 'Data states' };

export function LauncherDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const nav = useNavigate();
  const { data: cat } = useApi<Catalog>(open ? '/catalog' : null);
  const { data: presetData, reload: reloadPresets } = useApi<{ presets: Preset[]; default: string }>(open ? '/presets' : null);
  const [presetId, setPresetId] = useState('standard');
  const [form, setForm] = useState<Form | null>(null);
  const [target, setTarget] = useState('');
  const [repo, setRepo] = useState('');
  const [name, setName] = useState('');
  const [thenTriage, setThenTriage] = useState(true);
  const [busy, setBusy] = useState(false);
  const [saveAs, setSaveAs] = useState('');
  const presets = presetData?.presets ?? [];
  const preset = presets.find((p) => p.id === presetId);

  useEffect(() => {
    if (cat && presetData && !form) {
      setPresetId(presetData.default);
      setForm(fromPreset(presetData.presets.find((p) => p.id === presetData.default), cat));
    }
  }, [cat, presetData, form]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));
  const toggle = (list: string[], id: string, on: boolean) => (on ? [...new Set([...list, id])] : list.filter((x) => x !== id));
  const summary = useMemo(() => {
    if (!form || !cat) return '';
    const required = Object.entries(form.personaSessions).filter(([p, n]) => form.personas.includes(p) && n > 0);
    return `${form.personas.length} persona${form.personas.length === 1 ? '' : 's'} · ${form.devices.length} device profile${form.devices.length === 1 ? '' : 's'} · ${form.browsers.join(' + ') || 'no browser'} · up to ${form.budgetSessions} sessions (${form.parallel} parallel)${required.length ? ` · required: ${required.map(([p, n]) => `${n}× ${p}`).join(', ')}` : ''} · ${form.lead ? 'lead agent' : 'fixed plan'}${form.strategies.exclude.length ? ` · ${form.strategies.exclude.length} strategies off` : ''}`;
  }, [form, cat]);

  if (!open) return null;
  const close = () => {
    onClose();
  };

  const start = async () => {
    if (!form || !cat) return;
    setBusy(true);
    try {
      const job = await api<JobView>('/explore', { json: { target, repo: repo.trim() || undefined, name: name.trim() || undefined, preset: presetId, config: toConfig(form, cat), thenTriage } });
      toast('Bug bash started');
      close();
      nav(`/jobs/${job.id}`);
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };

  const savePreset = async (asNew: boolean) => {
    if (!form || !cat) return;
    const nm = asNew ? saveAs.trim() : preset?.name ?? '';
    if (!nm) return toast('Give the preset a name', true);
    try {
      const p = await api<Preset>('/presets', { json: { id: asNew ? undefined : preset?.id, name: nm, description: asNew ? `Saved from the launcher` : preset?.description, config: toConfig(form, cat) } });
      await reloadPresets();
      setPresetId(p.id);
      setSaveAs('');
      toast(`Preset “${p.name}” saved`);
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const devicesBy = (kind: string) => cat?.devices.filter((d) => d.kind === kind) ?? [];
  const strategyGroups = cat ? Object.entries(cat.strategies.reduce<Record<string, Catalog['strategies']>>((a, s) => ((a[s.group] ??= []).push(s), a), {})) : [];

  return (
    <Dialog
      open={open}
      onClose={close}
      title="New bug bash"
      wide
      footer={
        <>
          <span className="small muted launcher-summary">{summary}</span>
          <button className="btn-link" onClick={close}>
            Cancel
          </button>
          <Chamfer tone="green" disabled={busy || !target.trim() || !form} onClick={start}>
            {busy ? 'Starting…' : 'Start bug bash'}
          </Chamfer>
        </>
      }
    >
      {!cat || !form ? (
        <p className="muted">Loading options…</p>
      ) : (
        <div className="launcher">
          <div className="grid-2" style={{ gap: 12 }}>
            <label className="field">
              <span className="label">Target: URL, local folder or repo</span>
              <input className="input" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="http://localhost:3000 or /path/to/app" autoFocus />
            </label>
            <label className="field">
              <span className="label">Run name (optional)</span>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Pricing redesign check" maxLength={80} />
            </label>
            <label className="field">
              <span className="label">Source repo (for URL targets)</span>
              <input className="input" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="/path/to/repo: code intel, source hints, fixing" />
            </label>
            <label className="field">
              <span className="label">Preset</span>
              <select
                className="select"
                value={presetId}
                onChange={(e) => {
                  setPresetId(e.target.value);
                  setForm(fromPreset(presets.find((p) => p.id === e.target.value), cat));
                }}
              >
                {presets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.builtin ? '' : ' (yours)'}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {preset && <p className="small muted" style={{ margin: '4px 0 0' }}>{preset.description}</p>}

          <details className="launch-sec" open>
            <summary>
              <span className="label">Personas</span> <Chip>{form.personas.length} selected</Chip>
            </summary>
            <p className="small muted">The lead may only use these. Set a minimum to require that many sessions (strict).</p>
            <table className="t">
              <tbody>
                {cat.personas.map((p) => {
                  const on = form.personas.includes(p.id);
                  return (
                    <tr key={p.id}>
                      <td style={{ width: 28 }}>
                        <input type="checkbox" checked={on} onChange={(e) => set('personas', toggle(form.personas, p.id, e.target.checked))} aria-label={p.id} />
                      </td>
                      <td>
                        <b className="mono small">{p.id}</b> <span className="small muted">{p.summary}</span> {p.toolset === 'everyday' && <Chip tone="mint">no page edits</Chip>}
                      </td>
                      <td style={{ width: 200, whiteSpace: 'nowrap' }}>
                        <label className="row small" style={{ gap: 6, opacity: on ? 1 : 0.4 }}>
                          min
                          <input className="input" type="number" min={0} max={20} style={{ width: 64, padding: '4px 6px' }} disabled={!on} value={form.personaSessions[p.id] ?? 0} onChange={(e) => set('personaSessions', { ...form.personaSessions, [p.id]: Math.max(0, Number(e.target.value)) })} />
                          sessions
                        </label>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </details>

          <details className="launch-sec" open>
            <summary>
              <span className="label">Devices, sizes & browsers</span> <Chip>{form.devices.length} devices</Chip> <Chip>{form.browsers.join(', ') || 'no browser'}</Chip>
            </summary>
            <div className="row" style={{ gap: 14, margin: '8px 0' }}>
              {cat.browsers.map((b) => (
                <label key={b} className="check">
                  <input type="checkbox" checked={form.browsers.includes(b)} onChange={(e) => set('browsers', toggle(form.browsers, b, e.target.checked))} /> {b}
                </label>
              ))}
            </div>
            <div className="grid-3">
              {(['phone', 'tablet', 'desktop'] as const).map((kind) => (
                <div key={kind}>
                  <div className="spread">
                    <span className="label">{kind === 'desktop' ? 'Desktop sizes' : kind + 's'}</span>
                    <button className="btn-link" onClick={() => set('devices', devicesBy(kind).every((d) => form.devices.includes(d.id)) ? form.devices.filter((x) => !devicesBy(kind).some((d) => d.id === x)) : [...new Set([...form.devices, ...devicesBy(kind).map((d) => d.id)])])}>
                      toggle all
                    </button>
                  </div>
                  {devicesBy(kind).map((d) => (
                    <label key={d.id} className="check small" style={{ display: 'flex', margin: '4px 0' }}>
                      <input type="checkbox" checked={form.devices.includes(d.id)} onChange={(e) => set('devices', toggle(form.devices, d.id, e.target.checked))} /> {d.label} <span className="muted mono">{d.viewport.width}×{d.viewport.height}</span>
                    </label>
                  ))}
                </div>
              ))}
            </div>
          </details>

          <details className="launch-sec">
            <summary>
              <span className="label">Pages & strategies</span> <Chip>{cat.strategies.length - form.strategies.exclude.length}/{cat.strategies.length} strategies</Chip>
              {form.focusPaths.length > 0 && <Chip>{form.focusPaths.length} focus pages</Chip>}
            </summary>
            <label className="field" style={{ margin: '8px 0' }}>
              <span className="label">Pages to cover (one per line; the lead must cover these)</span>
              <textarea className="input" rows={2} value={form.focusPaths.join('\n')} onChange={(e) => set('focusPaths', e.target.value.split(/[\n,]/).map((x) => x.trim()).filter(Boolean))} placeholder="/pricing&#10;/checkout" />
            </label>
            <div className="grid-3">
              {strategyGroups.map(([g, list]) => (
                <div key={g}>
                  <span className="label">{GROUPS[g] ?? g}</span>
                  {list.map((s) => (
                    <label key={s.id} className="check small" style={{ display: 'flex', margin: '4px 0' }} title={s.id}>
                      <input
                        type="checkbox"
                        checked={!form.strategies.exclude.includes(s.id)}
                        onChange={(e) => set('strategies', { include: [], exclude: e.target.checked ? form.strategies.exclude.filter((x) => x !== s.id) : [...form.strategies.exclude, s.id] })}
                      />
                      {s.label}
                    </label>
                  ))}
                </div>
              ))}
            </div>
          </details>

          <details className="launch-sec">
            <summary>
              <span className="label">Agents, safety & triage</span> <Chip>{form.lead ? 'lead' : 'fixed plan'}</Chip> {form.guardrails.allowMutations && <Chip tone="sev-major dot">writes allowed</Chip>}
            </summary>
            <div className="grid-2" style={{ gap: 12, marginTop: 8 }}>
              <div className="stack" style={{ ['--gap' as string]: '6px' }}>
                <label className="check">
                  <input type="checkbox" checked={form.lead} onChange={(e) => set('lead', e.target.checked)} /> Lead agent plans and re-plans (off = fixed plan from your selections)
                </label>
                <label className="check">
                  <input type="checkbox" checked={form.codeIntel} onChange={(e) => set('codeIntel', e.target.checked)} /> Read the source code first
                </label>
                <label className="check">
                  <input type="checkbox" checked={thenTriage} onChange={(e) => setThenTriage(e.target.checked)} /> Triage right after exploring
                </label>
                <label className="check">
                  <input type="checkbox" checked={form.triage.video} onChange={(e) => set('triage', { ...form.triage, video: e.target.checked })} /> Record videos for timing bugs
                </label>
                <label className="check">
                  <input type="checkbox" checked={form.triage.review} onChange={(e) => set('triage', { ...form.triage, review: e.target.checked })} /> Independent reviewer + root-cause grouping
                </label>
                <label className="check">
                  <input type="checkbox" checked={form.retrospective} onChange={(e) => set('retrospective', e.target.checked)} /> Retrospective proposals after triage
                </label>
                <label className="field">
                  <span className="label">Agent provider</span>
                  <select className="select" value={form.provider ?? ''} onChange={(e) => setForm({ ...form, provider: (e.target.value || null) as Form['provider'], model: null })}>
                    <option value="">Use Settings default</option>
                    <option value="claude">Claude Code</option>
                    <option value="codex">Codex</option>
                  </select>
                </label>
                <label className="field">
                  <span className="label">Model name (optional)</span>
                  <input className="input" value={form.model ?? ''} disabled={!form.provider} placeholder="Provider default" maxLength={200} onChange={(e) => set('model', e.target.value.trim() || null)} />
                </label>
              </div>
              <div className="stack" style={{ ['--gap' as string]: '6px' }}>
                <label className="field">
                  <span className="label">Never click elements matching (regex)</span>
                  <input className="input mono" value={form.guardrails.denylist} onChange={(e) => set('guardrails', { ...form.guardrails, denylist: e.target.value })} />
                </label>
                <label className="check">
                  <input type="checkbox" checked={form.guardrails.sameOriginOnly} onChange={(e) => set('guardrails', { ...form.guardrails, sameOriginOnly: e.target.checked })} /> Stay on the same site
                </label>
                <label className="check" style={{ color: form.guardrails.allowMutations ? 'var(--sev-major)' : undefined }}>
                  <input type="checkbox" checked={form.guardrails.allowMutations} onChange={(e) => set('guardrails', { ...form.guardrails, allowMutations: e.target.checked })} /> Allow data-changing requests (POST/PUT/DELETE). Only for test environments.
                </label>
              </div>
            </div>
          </details>

          <details className="launch-sec">
            <summary>
              <span className="label">Budgets</span> <Chip>{form.budgetSessions} sessions</Chip>
            </summary>
            <div className="grid-4" style={{ marginTop: 8 }}>
              {(
                [
                  ['budgetSessions', 'Max sessions', 1],
                  ['parallel', 'In parallel', 1],
                  ['maxToolCallsPerSession', 'Tool calls / session', 10],
                ] as const
              ).map(([k, l, min]) => (
                <label key={k} className="field">
                  <span className="label">{l}</span>
                  <input className="input" type="number" min={min} value={form[k]} onChange={(e) => set(k, Math.max(min, Number(e.target.value)))} />
                </label>
              ))}
              <label className="field">
                <span className="label">Time limit (min)</span>
                <input className="input" type="number" min={5} value={Math.round(form.timeLimitMs / 60000)} onChange={(e) => set('timeLimitMs', Math.max(5, Number(e.target.value)) * 60000)} />
              </label>
            </div>
          </details>

          <div className="row launch-presets">
            <input className="input" placeholder="Save these settings as a preset…" value={saveAs} onChange={(e) => setSaveAs(e.target.value)} style={{ flex: '1 1 220px' }} />
            <button className="btn-ghost" onClick={() => savePreset(true)} disabled={!saveAs.trim()}>
              Save as new preset
            </button>
            {preset && !preset.builtin && (
              <>
                <button className="btn-ghost" onClick={() => savePreset(false)}>
                  Update “{preset.name}”
                </button>
                <button
                  className="btn-ghost"
                  onClick={async () => {
                    await api(`/presets/${preset.id}`, { method: 'DELETE' });
                    await reloadPresets();
                    setPresetId('standard');
                    setForm(fromPreset(presets.find((p) => p.id === 'standard'), cat));
                    toast('Preset deleted');
                  }}
                >
                  Delete preset
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}
