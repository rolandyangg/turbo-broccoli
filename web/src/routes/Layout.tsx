import { useState } from 'react';
import { NavLink, Outlet, Link } from 'react-router';
import { Logo, Chamfer, ThemeToggle } from '../components/ui.tsx';
import { LauncherDialog } from '../components/Launcher.tsx';
import { useApi } from '../lib/api.ts';
import type { JobView } from '../lib/types.ts';

export function Layout() {
  const [launch, setLaunch] = useState(false);
  const { data: jobs } = useApi<JobView[]>('/jobs', { pollMs: 5000 });
  const running = jobs?.filter((j) => j.state === 'running' && j.alive) ?? [];
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
          </nav>
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
