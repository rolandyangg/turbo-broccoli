import { useEffect, useState } from 'react';
import { api, useApi } from '../lib/api.ts';
import { Box, useToast } from './ui.tsx';
type Selection = { provider: 'claude' | 'codex'; model: string | null };
export function ModelPicker({ jobId }: { jobId?: string }) {
  const path = jobId ? `/jobs/${jobId}/models` : '/models';
  const { data, error, reload } = useApi<Selection>(path, { pollMs: jobId ? 2000 : undefined });
  const [form, setForm] = useState<Selection | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  useEffect(() => { if (data) setForm(data); }, [data?.provider, data?.model]);
  const save = async () => {
    if (!form) return;
    setBusy(true);
    try { await api(path, { method: 'PUT', json: form }); toast(jobId ? 'Active agents are handing off to the selected provider' : 'Default provider saved'); void reload(); }
    catch (e) { toast((e as Error).message, true); }
    finally { setBusy(false); }
  };
  return <Box head={jobId ? 'Agent provider' : 'Default agent provider'}>
    {error && <p role="alert">{error}</p>}
    {!form ? <p className="muted">Loading model selection…</p> : <form className="stack" action={`/api${path}`} method="post" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <label className="field"><span className="label">Provider</span>
        <select name="provider" className="select" disabled={busy} value={form.provider} onChange={(e) => setForm({ provider: e.target.value as Selection['provider'], model: null })}>
          <option value="claude">Claude Code</option><option value="codex">Codex</option>
        </select>
      </label>
      <label className="field"><span className="label">Model name (optional)</span>
        <input name="model" maxLength={200} className="input" disabled={busy} placeholder="Provider default" value={form.model ?? ''} onChange={(e) => setForm({ ...form, model: e.target.value.trim() || null })} />
      </label>
      <p className="small muted">{jobId ? 'Switching interrupts active agents and continues their task with recorded progress, existing browser sessions, and files.' : 'Used for all agent work unless a run or job has an explicit selection. Install and sign in to the selected CLI first: claude or codex login.'}</p>
      <button className="btn" disabled={busy || !data || JSON.stringify(form) === JSON.stringify(data)} type="submit">{busy ? 'Saving…' : jobId ? 'Switch active agents' : 'Save provider'}</button>
    </form>}
  </Box>;
}
