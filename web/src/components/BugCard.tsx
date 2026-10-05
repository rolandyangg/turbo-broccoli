import { Link } from 'react-router';
import type { Finding } from '../lib/types.ts';
import { fileUrl } from '../lib/api.ts';
import { widthRange } from '../lib/format.ts';
import { Arrow, BugGlyph, Chip, ConfidenceBar, FileIcon, SevChip, StatusChip } from './ui.tsx';
import { WorkflowControls } from './Workflow.tsx';
import { bugFixStatus, type BugPr, type BugFixJob } from '../lib/bugFixStatus.ts';

/** Greptile-style square card: mono header strip + tag chip, badge row + title, gray footer bar. */
export function BugCard({ f, ws, run, prs, jobs, selected, onSelect, onWorkflow }: { f: Finding; ws: string; run: string; prs?: readonly BugPr[]; jobs?: readonly BugFixJob[]; selected?: boolean; onSelect?: (on: boolean) => void; onWorkflow?: () => void }) {
  const href = `/runs/${ws}/${encodeURIComponent(run)}/bugs/${f.id}`;
  const thumb = f.screenshots.crop ?? f.screenshots.annotated;
  const fixStatus = bugFixStatus(f, prs, jobs);
  let fixIcon = '↗';
  if (fixStatus?.kind === 'merged') fixIcon = '✓';
  if (fixStatus?.kind === 'closed') fixIcon = '×';
  return (
    <div className={`box bug-card ${selected ? 'selected' : ''} ${fixStatus ? `bug-fix-${fixStatus.kind}` : ''}`}>
      <div className="box-head">
        {onSelect && <input type="checkbox" checked={!!selected} onChange={(e) => onSelect(e.target.checked)} aria-label={`Select ${f.id}`} style={{ accentColor: 'var(--ink)' }} />}
        <div className="path">
          <FileIcon />
          {f.page} · {f.browsers.join(', ')} · {widthRange(f)}
        </div>
        <Chip>{f.type}</Chip>
      </div>
      <div className="bug-card-body">
        {(thumb || fixStatus) && (
          <div className={thumb ? 'thumb' : 'bug-fix-preview'}>
            {thumb && <Link to={href} className="bug-preview-link" aria-label={`View bug ${f.id}`}><img loading="lazy" src={fileUrl(ws, run, thumb)} alt="" /></Link>}
            {fixStatus && (
              <div className="bug-fix-ribbon" title={fixStatus.detail}>
                <span aria-hidden="true">{fixIcon}</span>
                <strong>{fixStatus.label}</strong>
                {fixStatus.number && fixStatus.url && <a className="bug-pr-link mono small" href={fixStatus.url} target="_blank" rel="noreferrer" aria-label={`Open pull request #${fixStatus.number}`}>#{fixStatus.number} ↗</a>}
              </div>
            )}
            {thumb && f.video && <span className="chip ink thumb-badge">▶ video</span>}
          </div>
        )}
        <Link to={href} className="box-body bug-card-content">
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
        </Link>
      </div>
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
