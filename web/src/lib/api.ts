import { useCallback, useEffect, useRef, useState } from 'react';
import type { JobEvent, JobView } from './types.ts';

export class ApiError extends Error {
  constructor(
    public status: number,
    msg: string,
  ) {
    super(msg);
  }
}

export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    method: init?.method ?? (init?.json !== undefined ? 'POST' : 'GET'),
    headers: { ...(init?.json !== undefined ? { 'content-type': 'application/json' } : {}), ...init?.headers },
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? res.statusText);
  return data as T;
}

/** URL of a file inside a run folder (screenshots, videos, traces…). */
export const fileUrl = (ws: string, run: string, rel: string | null | undefined, download = false) =>
  rel ? `/api/runs/${ws}/${encodeURIComponent(run)}/files/${rel.split('/').map(encodeURIComponent).join('/')}${download ? '?download=1' : ''}` : '';

/** Fetch + reload + optional polling. */
export function useApi<T>(path: string | null, opts: { pollMs?: number } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!path);
  const pathRef = useRef(path);
  pathRef.current = path;
  const load = useCallback(async () => {
    if (!pathRef.current) return;
    try {
      const d = await api<T>(pathRef.current);
      setData(d);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    setLoading(!!path);
    setData(null);
    void load();
  }, [path, load]);
  useEffect(() => {
    if (!opts.pollMs || !path) return;
    const t = setInterval(() => void load(), opts.pollMs);
    return () => clearInterval(t);
  }, [opts.pollMs, path, load]);
  return { data, error, loading, reload: load, setData };
}

/** Live job stream over SSE: status snapshots + the full event log. */
export function useJobStream(jobId: string | null) {
  const [status, setStatus] = useState<JobView | null>(null);
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [ended, setEnded] = useState(false);
  useEffect(() => {
    if (!jobId) return;
    setEvents([]);
    setEnded(false);
    const es = new EventSource(`/api/jobs/${jobId}/events`);
    es.addEventListener('event', (m) => setEvents((xs) => [...xs, JSON.parse((m as MessageEvent).data)]));
    es.addEventListener('status', (m) => setStatus(JSON.parse((m as MessageEvent).data)));
    es.addEventListener('end', () => {
      setEnded(true);
      es.close();
    });
    es.onerror = () => {
      // The server ends the stream when the job is done; EventSource would otherwise reconnect forever.
      if (es.readyState === EventSource.CLOSED) setEnded(true);
    };
    return () => es.close();
  }, [jobId]);
  return { status, events, ended };
}
