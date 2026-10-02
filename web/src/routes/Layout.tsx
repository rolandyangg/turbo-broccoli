import { useState } from 'react';
import { NavLink, Outlet, Link } from 'react-router';
import { Logo, Chamfer, ThemeToggle } from '../components/ui.tsx';
import { LauncherDialog } from '../components/Launcher.tsx';
import { Inbox } from '../components/Inbox.tsx';
import { useApi } from '../lib/api.ts';
import type { JobView } from '../lib/types.ts';

export function Layout() {
  const [launch, setLaunch] = useState(false);
  const { data: jobs } = useApi<JobView[]>('/jobs', { pollMs: 5000 });
  const running = jobs?.filter((j) => j.state === 'running' && j.alive) ?? [];
  const { data: imp } = useApi<{ pending: number }>('/improvements', { pollMs: 20000 });
  return (
    <>
      {running.length > 0 && (
        <div className="announce">
          {running.length} job{running.length > 1 ? 's' : ''} running: {running.map((j) => `${j.kind} ${j.finding_ids.join(', ') || ''}`.trim()).join(' · ')}.{' '}
          <Link to={running.length === 1 ? `/jobs/${running[0].id}` : '/jobs'}>Watch live</Link> →
        </div>
      )}
      <header className="nav">
        <div className="nav-inner">
          <Link to="/" className="brand">
            <Logo /> TurboBrocolli
          </Link>
          <nav className="nav-links">
            <NavLink to="/" end>
              Dashboard
            </NavLink>
            <NavLink to="/runs">Runs</NavLink>
            <NavLink to="/jobs">Jobs</NavLink>
            <NavLink to="/prs">PRs</NavLink>
            <NavLink to="/improvements" aria-label={imp?.pending ? `Improvements, ${imp.pending} waiting for review` : undefined}>
              Improvements
              {imp?.pending ? <span className="nav-count">{imp.pending}</span> : null}
            </NavLink>
          </nav>
          <Inbox />
          <NavLink to="/settings" className={({ isActive }) => `btn-ghost nav-icon ${isActive ? 'on' : ''}`} aria-label="Settings" title="Settings (notifications, GitHub connection)">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </NavLink>
          <ThemeToggle />
          <div className="chamfer-group">
            <Chamfer onClick={() => setLaunch(true)}>New bug bash</Chamfer>
          </div>
        </div>
      </header>
      <main className="page">
        <Outlet />
      </main>
      <LauncherDialog open={launch} onClose={() => setLaunch(false)} />
    </>
  );
}
