import { Link } from 'react-router';
import { PrList } from '../components/PrList.tsx';

/** Every pull request opened by fixes, across all runs and targets. */
export function Prs() {
  return (
    <>
      <div className="run-head">
        <div className="label">
          <Link to="/">Dashboard</Link> / Pull requests
        </div>
        <h1 className="page-title">Pull requests</h1>
        <p className="muted" style={{ maxWidth: 760, margin: '6px 0 0' }}>
          Every pull request opened by a bugbash fix, with its state on GitHub, the bugs it fixes and the jobs that worked on it. Each run also has a PRs tab.
        </p>
      </div>
      <PrList scope={null} />
    </>
  );
}
