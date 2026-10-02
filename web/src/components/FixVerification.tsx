import { useState } from 'react';
import { fileUrl } from '../lib/api.ts';
import type { Finding, JobView } from '../lib/types.ts';
import { ago } from '../lib/format.ts';
import { Box, Chamfer, Chip } from './ui.tsx';
import { FixRunDialog, ReproduceDialog } from './Actions.tsx';
import { SyncedViewer } from './SyncedViewer.tsx';

/**
 * How a fix was verified, and the evidence to judge it yourself: the verdict and its flags, per-check results,
 * the visual review's reasoning, before/after pictures (and videos for behaviour bugs) side by side, plus Retry
 * verification, Send instructions, Publish anyway and Reproduce on the fixed version.
 */
export function FixVerification({ f, ws, run, branch, afterShot, running, prUrl, reproducing, onReproduceStarted }: { f: Finding; ws: string; run: string; branch: string | null; afterShot: string | null; running: boolean; prUrl: string | null; reproducing: boolean; onReproduceStarted: (job: JobView) => void }) {
  const [dialog, setDialog] = useState<'verify' | 'continue' | 'publish-anyway' | null>(null);
  const [compare, setCompare] = useState(false);
  const [repro, setRepro] = useState(false);
  const fix = f.fix;
  if (!fix && !branch) return null;
  const v = fix?.verification ?? null;
  const flags = fix?.flags?.length ? fix.flags : v ? [] : fix ? ['This fix was checked before the stricter verification existed: retry verification to get a trustworthy result.'] : [];
  const verified = !!fix?.verified && !!v && v.result === 'fixed' && !fix.flags?.length;
  const status = !fix ? { label: 'not recorded yet', tone: 'outline' } : fix.blocked ? { label: 'blocked: not published', tone: 'sev-critical dot' } : verified ? { label: v?.method === 'visual-review' ? 'verified (visual review)' : 'verified', tone: 'mint' } : { label: 'not fully verified', tone: 'sev-major dot' };
  const before = f.screenshots.annotated;
  const after = fix?.manual_after?.path ?? v?.after?.annotated ?? afterShot;
  const beforeVideo = f.video?.mp4 ?? null;
  const afterVideo = v?.after_video?.mp4 ?? null;
  const env = f.reproduction.environment;
  return (
    <Box head="Fix verification" chip={<Chip tone={status.tone}>{status.label}</Chip>}>
      <div className="stack" style={{ ['--gap' as string]: '14px' }}>
        {flags.length > 0 && (
          <div className="fix-flags" role="status">
            <b className="small">{fix?.blocked ? 'Publishing is blocked until this is resolved:' : 'Flags:'}</b>
            <ul>
              {flags.map((x, i) => (
                <li key={i} className="small">
                  {x.replace(/^BB-\d+: /, '')}
                </li>
              ))}
            </ul>
          </div>
        )}
        {v && (
          <dl className="kv">
            {fix?.manual_after && <><dt>After screenshot</dt><dd>Chosen manually {ago(fix.manual_after.at)}</dd></>}
            <dt>Result</dt>
            <dd>{v.result === 'fixed' ? 'bug gone' : v.result === 'present' ? 'bug still present' : "couldn't tell"}</dd>
            <dt>How</dt>
            <dd>{v.method === 'detector' ? 'detector replays at each affected size and browser' : v.method === 'visual-review' ? 'visual before/after review (AI), no detector could decide' : 'no automatic check could decide'}</dd>
            <dt>Checked</dt>
            <dd>{ago(v.at)}</dd>
          </dl>
        )}
        {v?.checks.length ? (
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            {v.checks.map((c, i) => (
              <Chip key={i} tone={c.present === null ? 'outline' : c.present ? 'sev-critical dot' : 'mint'}>
                {c.browser} {c.width}px: {c.present === null ? `inconclusive${c.error ? ` (${c.error.slice(0, 40)})` : ''}` : c.present ? 'still there' : 'gone'}
              </Chip>
            ))}
          </div>
        ) : null}
        {v?.review && (
          <p className="small" style={{ margin: 0 }}>
            <b>Visual review ({Math.round(v.review.confidence * 100)}% confident):</b> {v.review.reasoning}
          </p>
        )}
        {(before || after) && (
          <div className="ba-grid">
            <figure>
              <figcaption className="label">Before (red: the bug)</figcaption>
              {before ? <img src={fileUrl(ws, run, before)} alt={`${f.id} before`} loading="lazy" onClick={() => setCompare(true)} /> : <div className="ba-missing small muted">no picture</div>}
            </figure>
            <figure>
              <figcaption className="label">After the fix (green: same element{v?.after && !v.after.element_found ? '; blue: element gone, old position' : ''})</figcaption>
              {after ? <img src={fileUrl(ws, run, after)} alt={`${f.id} after fix`} loading="lazy" onClick={() => setCompare(true)} /> : <div className="ba-missing small muted">no after picture yet</div>}
            </figure>
          </div>
        )}
        {(beforeVideo || afterVideo) && (
          <div className="ba-grid">
            <figure>
              <figcaption className="label">Before (video)</figcaption>
              {beforeVideo ? <video src={fileUrl(ws, run, beforeVideo)} controls preload="metadata" /> : <div className="ba-missing small muted">no video</div>}
            </figure>
            <figure>
              <figcaption className="label">After the fix (video)</figcaption>
              {afterVideo ? <video src={fileUrl(ws, run, afterVideo)} controls preload="metadata" /> : <div className="ba-missing small muted">no after video{fix ? ' (retry verification to record one)' : ''}</div>}
            </figure>
          </div>
        )}
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {before && after && (
            <button className="btn-ghost" onClick={() => setCompare(true)}>
              Compare side by side
            </button>
          )}
          {branch && (
            <button className="btn-ghost" disabled={reproducing} onClick={() => setRepro(true)}>
              {reproducing ? 'Reproduction window open' : 'Reproduce on the fixed version'}
            </button>
          )}
          {branch && !running && (
            <button className="btn-ghost" onClick={() => setDialog('verify')}>
              Retry verification
            </button>
          )}
          {branch && !running && (
            <button className="btn-ghost" onClick={() => setDialog('continue')}>
              Send instructions…
            </button>
          )}
          {branch && !running && !verified && !prUrl && (
            <Chamfer small tone="danger" onClick={() => setDialog('publish-anyway')}>
              Publish anyway…
            </Chamfer>
          )}
        </div>
      </div>
      {dialog && branch && <FixRunDialog ws={ws} run={run} ids={[f.id]} mode={dialog} branch={branch} defaults={{ pr: false, draft: true }} onClose={() => setDialog(null)} />}
      {compare && before && after && <SyncedViewer title={`${f.id}: before / after the fix`} left={{ src: fileUrl(ws, run, before), label: 'Before' }} right={{ src: fileUrl(ws, run, after), label: 'After the fix' }} onClose={() => setCompare(false)} />}
      <ReproduceDialog open={repro} onClose={() => setRepro(false)} ws={ws} run={run} id={f.id} branch={branch} env={{ browser: env.browser, viewport: env.viewport, device: env.variant.device ?? null }} onStarted={onReproduceStarted} />
    </Box>
  );
}
