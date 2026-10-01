import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.ts';
import { useToast } from './ui.tsx';

/** Inline-editable run display name (the run id never changes). */
export function RunName({ ws, run, name, fallback, onSaved, className = '', as: Tag = 'span' }: { ws: string; run: string; name: string | null | undefined; fallback: string; onSaved?: (name: string | null) => void; className?: string; as?: 'span' | 'h1' }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name ?? '');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const toast = useToast();
  useEffect(() => setValue(name ?? ''), [name]);
  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);
  const save = async () => {
    setBusy(true);
    try {
      const r = await api<{ name: string | null }>(`/runs/${ws}/${encodeURIComponent(run)}/rename`, { json: { name: value.trim() || null } });
      setEditing(false);
      onSaved?.(r.name);
      toast(r.name ? `Renamed to “${r.name}”` : 'Name cleared');
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  if (editing)
    return (
      <form
        className="row run-name-edit"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <input ref={input} className="input" value={value} maxLength={80} placeholder={fallback} aria-label="Run name" onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setEditing(false)} disabled={busy} />
        <button className="btn-ghost on" type="submit" disabled={busy}>
          Save
        </button>
        <button className="btn-ghost" type="button" onClick={() => setEditing(false)}>
          Cancel
        </button>
      </form>
    );
  return (
    <Tag className={`run-name ${className}`}>
      {name || fallback}
      <button
        className="run-name-pencil"
        title="Rename run"
        aria-label="Rename run"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setEditing(true);
        }}
      >
        ✎
      </button>
    </Tag>
  );
}
