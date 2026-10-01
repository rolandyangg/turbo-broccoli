import { Link } from 'react-router';
import type { Finding } from '../lib/types.ts';
import { fileUrl } from '../lib/api.ts';
import { widthRange } from '../lib/format.ts';
import { Arrow, BugGlyph, Chip, ConfidenceBar, FileIcon, SevChip, StatusChip } from './ui.tsx';
import { WorkflowControls } from './Workflow.tsx';

/** Greptile-style square card: mono header strip + tag chip, badge row + title, gray footer bar. */
export function BugCard({ f, ws, run, selected, onSelect, onWorkflow }: { f: Finding; ws: string; run: string; selected?: boolean; onSelect?: (on: boolean) => void; onWorkflow?: () => void }) {
  const href = `/runs/${ws}/${encodeURIComponent(run)}/bugs/${f.id}`;
  const thumb = f.screenshots.crop ?? f.screenshots.annotated;
  return (
    <div className={`box bug-card ${selected ? 'selected' : ''}`}>
      <div className="box-head">
        {onSelect && <input type="checkbox" checked={!!selected} onChange={(e) => onSelect(e.target.checked)} aria-label={`Select ${f.id}`} style={{ accentColor: 'var(--ink)' }} />}
        <div className="path">
          <FileIcon />
          {f.page} · {f.browsers.join(', ')} · {widthRange(f)}
        </div>
        <Chip>{f.type}</Chip>
      </div>
      <Link to={href} className="bug-card-body">
        {thumb && (
          <div className="thumb">
            <img loading="lazy" src={fileUrl(ws, run, thumb)} alt="" />
            {f.video && <span className="chip ink thumb-badge">▶ video</span>}
          </div>
        )}
        <div className="box-body">
          <div className="badge-row">
            <span className="badge-sq">
              <BugGlyph />
            </span>
            <span className="mono small">{f.id}</span>
            <SevChip sev={f.severity} />
            <StatusChip status={f.status} />
            {f.history_tag !== 'new' && <Chip tone="outline">{f.history_tag}</Chip>}
            {f.workflow?.archived && <Chip tone="outline">archived</Chip>}
          </div>
          <h3 className="h3" style={{ marginTop: 10 }}>
            {f.title}
          </h3>
          <div className="spread" style={{ marginTop: 10 }}>
            <ConfidenceBar value={f.confidence} />
            <span className="mono small muted">{f.reproduction.rate ? `repro ${f.reproduction.rate}` : 'visual'}</span>
          </div>
        </div>
      </Link>
      {onWorkflow && (
        <div className="bug-card-wf">
          <WorkflowControls ws={ws} run={run} f={f} onChanged={onWorkflow} compact />
        </div>
      )}
      <Link to={href} className="box-foot">
        {f.status === 'fixing' ? 'View fix ' : 'View bug '}
        <Arrow />
      </Link>
    </div>
  );
}
