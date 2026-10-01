import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { api, useApi } from '../lib/api.ts';
import { ago } from '../lib/format.ts';

interface Note {
  id: string;
  at: string;
  event: 'run' | 'fix' | 'failure' | 'proposals';
  level: 'info' | 'success' | 'warn' | 'error';
  title: string;
  body: string;
  path: string | null;
  read: boolean;
}
const LEVEL_MARK: Record<Note['level'], string> = { info: 'i', success: '✓', warn: '!', error: '×' };

/** Nav bell with the unread count and a panel of recent notifications (runs, fixes, failures, proposals). */
export function Inbox() {
  const { data, reload } = useApi<{ items: Note[]; unread: number }>('/notifications', { pollMs: 10000 });
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', close);
    };
  }, [open]);
  const read = async (body: { ids?: string[]; all?: boolean }) => {
    await api('/notifications/read', { json: body }).catch(() => {});
    reload();
  };
  const unread = data?.unread ?? 0;
  return (
    <div className="inbox" ref={ref}>
      <button className="btn-ghost inbox-btn" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="dialog" aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {unread > 0 && <span className="nav-count">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="inbox-panel box" role="dialog" aria-label="Notifications">
          <div className="box-head">
            <div className="path">Notifications</div>
            <div className="row" style={{ gap: 10 }}>
              {unread > 0 && (
                <button className="btn-link small" onClick={() => read({ all: true })}>
                  Mark all read
                </button>
              )}
              <Link className="btn-link small" to="/settings" onClick={() => setOpen(false)}>
                Settings
              </Link>
            </div>
          </div>
          <div className="inbox-list">
            {!data?.items.length && <p className="muted small" style={{ padding: 16, margin: 0 }}>Nothing yet. You'll get a note when runs, triage and fixes finish, when something fails, and when proposals are waiting.</p>}
            {data?.items.slice(0, 40).map((n) => {
              const body = (
                <>
                  <span className={`inbox-mark ${n.level}`} aria-hidden>
                    {LEVEL_MARK[n.level]}
                  </span>
                  <span className="inbox-text">
                    <b>{n.title}</b>
                    <span className="small muted inbox-body">{n.body}</span>
                    <span className="small faint">
                      {n.event} · {ago(n.at)}
                    </span>
                  </span>
                </>
              );
              return n.path ? (
                <Link
                  key={n.id}
                  to={n.path}
                  className={`inbox-item ${n.read ? '' : 'unread'}`}
                  onClick={() => {
                    setOpen(false);
                    if (!n.read) void read({ ids: [n.id] });
                  }}
                >
                  {body}
                </Link>
              ) : (
                <button key={n.id} className={`inbox-item ${n.read ? '' : 'unread'}`} onClick={() => !n.read && read({ ids: [n.id] })}>
                  {body}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
