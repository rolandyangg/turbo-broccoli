import type { GroupFixBlocker } from '../../../src/fix/groupBlockers.ts';
import { Link } from 'react-router';
import { regressionTitle } from '../../../src/fix/regressions.ts';
import type { LayoutRegression } from '../../../src/store/schema.ts';
import { useState } from 'react';
import { candidateKey, reviewBlockers } from '../../../src/fix/manualReview.ts';
import { fileUrl, api } from '../lib/api.ts';
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
export function FixVerification({ groupBlockers = [], manuallyVerified = false, onUpdated, regressions = [], f, ws, run, branch, afterShot, running, prUrl, reproducing, onReproduceStarted }: { groupBlockers?: GroupFixBlocker[]; manuallyVerified?: boolean; onUpdated?: () => Promise<void>; regressions?: LayoutRegression[]; f: Finding; ws: string; run: string; branch: string | null; afterShot: string | null; running: boolean; prUrl: string | null; reproducing: boolean; onReproduceStarted: (job: JobView) => void }) {
  const [dialog, setDialog] = useState<'verify' | 'continue' | 'publish-anyway' | null>(null);
  const [compare, setCompare] = useState(false);
  const [reviewConfirmed, setReviewConfirmed] = useState(false);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [repro, setRepro] = useState(false);
  const fix = f.fix;
  if (!fix && !branch) return null;
  const v = fix?.verification ?? null;
  const flags = fix?.flags?.length ? fix.flags : v ? [] : fix ? ['This fix was checked before the stricter verification existed: retry verification to get a trustworthy result.'] : [];
  const visibleFlags = flags.filter((x) => !regressions.length || !/^\d+ new layout problem/.test(x));
  const review = fix?.manual_review;
  const dismissed = review && review.evidence_at === v?.at ? review.dismissed : [];
  const blockers = reviewBlockers(f, regressions, dismissed);
  const saveReview = async (body: object) => {
    setReviewBusy(true);
    setReviewError(null);
    try {
      await api(`/runs/${ws}/${encodeURIComponent(run)}/bugs/${f.id}/manual-review`, { json: { ...body, evidenceAt: v?.at } });
      setReviewConfirmed(false);
      await onUpdated?.();
    } catch (e) { setReviewError((e as Error).message); }
    finally { setReviewBusy(false); }
  };
  const verified = !!fix?.verified && !!v && v.result === 'fixed' && !fix.flags?.length;
  let status = { label: 'not fully verified', tone: 'sev-major dot' };
  if (groupBlockers.length && fix?.blocked) status = { label: 'group fix blocked', tone: 'sev-major dot' };
  else if (manuallyVerified) status = { label: 'manually verified · ready for PR', tone: 'mint' };
  else if (!fix) status = { label: 'not recorded yet', tone: 'outline' };
  else if (fix.blocked) status = { label: 'blocked: not published', tone: 'sev-critical dot' };
  else if (verified) status = { label: v?.method === 'visual-review' ? 'verified (visual review)' : 'verified', tone: 'mint' };
  const before = f.screenshots.annotated;
  const after = fix?.manual_after?.path ?? v?.after?.annotated ?? afterShot;
  const beforeVideo = f.video?.mp4 ?? null;
  const afterVideo = v?.after_video?.mp4 ?? null;
  const env = f.reproduction.environment;
  return (
    <Box head="Fix verification" chip={<Chip tone={status.tone}>{status.label}</Chip>}>
      <div className="stack" style={{ ['--gap' as string]: '14px' }}>
        {(visibleFlags.length > 0 || regressions.length > 0 || groupBlockers.length > 0) && (
          <div className="fix-flags" role="status">
            {groupBlockers.length > 0 && <div>
              <b className="small">Other bugs blocking this group fix ({groupBlockers.length}):</b>
              {v?.result === 'fixed' && <p className="small">{f.id} passed its check{v.review ? ` (visual review, ${Math.round(v.review.confidence * 100)}% confidence; threshold 60%)` : ''}. The shared branch still has unresolved bugs.</p>}
              <ul>{groupBlockers.map((bug) => <li key={bug.id} className="small">
                <Link to={`/runs/${ws}/${encodeURIComponent(run)}/bugs/${bug.id}`}>{bug.id} — {bug.title}</Link>
                <span className="muted"> · {bug.reasons.join('; ')}</span>
              </li>)}</ul>
              <p className="small muted">Resolve or re-verify these bugs, then retry verification for the whole group to refresh the publishing status.</p>
            </div>}
            <b className="small">{groupBlockers.length ? 'This bug’s verification notes:' : manuallyVerified ? 'Reviewed warnings:' : fix?.blocked ? 'Publishing is blocked until this is resolved:' : 'Flags:'}</b>
            {visibleFlags.length > 0 && <ul>
              {visibleFlags.map((x, i) => (
                <li key={i} className="small">
                  {x.replace(/^BB-\d+: /, '')}{/verified only by a visual review/.test(x) ? ' (nonblocking for manual approval)' : ''}
                </li>
              ))}
            </ul>}
            {regressions.length > 0 && <div className="regression-list">
              <b className="small">New layout candidates ({regressions.length})</b>
              {regressions.map((r, i) => <details className="regression-item" key={`${r.page}-${r.width}-${r.selector}-${i}`}>
                <summary><span>{regressionTitle(r)}{dismissed.includes(candidateKey(r)) ? ' · dismissed' : ''}</span><span className="mono small muted">{r.page} · {r.width}px</span></summary>
                <div className="regression-body">
                  <p className="small">{r.message}</p>
                  {r.preview ? <a href={fileUrl(ws, run, r.preview)} target="_blank" rel="noreferrer"><img src={fileUrl(ws, run, r.preview)} alt={`${regressionTitle(r)} on ${r.page} at ${r.width}px; highlighted detector candidate`} loading="lazy" /></a>
                    : <p className="small muted">No preview saved for this check. Retry verification to capture previews for newly detected candidates.</p>}
                  <button className="btn-ghost" disabled={running || reviewBusy || !v} onClick={() => void saveReview({ candidate: candidateKey(r), dismissed: !dismissed.includes(candidateKey(r)) })}>
                    {dismissed.includes(candidateKey(r)) ? 'Reopen candidate' : 'Dismiss candidate warning'}
                  </button>
                  {r.selector && <code className="small regression-selector">{r.selector}</code>}
                </div>
              </details>)}
              <p className="small muted">Detected after the change; not yet confirmed as a regression.</p>
            </div>}
          </div>
        )}
        {v && !running && !manuallyVerified && <div className="stack" style={{ ['--gap' as string]: '8px' }}>
          <p className="small muted" style={{ margin: 0 }}>Visual-review-only warnings are nonblocking for manual approval.</p>
          {blockers.length > 0 && <p className="small muted" style={{ margin: 0 }}>{blockers.join(' ')}</p>}
          <label className="check"><input type="checkbox" checked={reviewConfirmed} disabled={reviewBusy || blockers.length > 0} onChange={(e) => setReviewConfirmed(e.target.checked)} /> I reviewed the before/after and manually verified this fix.</label>
          <div><button className="btn-ghost" disabled={!reviewConfirmed || reviewBusy || blockers.length > 0} onClick={() => void saveReview({ confirm: true })}>{reviewBusy ? 'Saving…' : 'Record manual verification'}</button></div>
        </div>}
        {reviewError && <p className="small" role="alert">{reviewError}</p>}
        {manuallyVerified && <p className="small">Manually verified {review?.verified_at ? ago(review.verified_at) : ''}. Candidate warnings were reviewed; automatic results are preserved.</p>}
        {v && (
          <dl className="kv">
            {fix?.manual_after && <><dt>After screenshot</dt><dd>Chosen manually {ago(fix.manual_after.at)}</dd></>}
            <dt>Result</dt>
            <dd>{v.result === 'fixed' ? 'bug gone' : v.result === 'present' ? 'bug still present' : "couldn't tell"}</dd>
            <dt>How</dt>
            <dd>{v.method === 'detector' ? (v.checks.some((c) => c.gesture) ? 'replays with a real swipe over the element (and detectors), at each affected size and browser' : 'detector replays at each affected size and browser') : v.method === 'visual-review' ? 'visual before/after review (AI), no detector could decide' : 'no automatic check could decide'}</dd>
            <dt>Checked</dt>
            <dd>{ago(v.at)}</dd>
          </dl>
        )}
        {v?.checks.length ? (
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            {v.checks.map((c, i) => (
              <Chip key={i} tone={c.present === null ? 'outline' : c.present ? 'sev-critical dot' : 'mint'}>
                {c.browser}{f.reproduction.environment.variant.device ? '' : ` ${c.width}px`}: {c.present === null ? `inconclusive${c.error ? ` (${c.error.slice(0, 40)})` : ''}` : c.present ? 'still there' : 'gone'}
              </Chip>
            ))}
          </div>
        ) : null}
        {v?.checks.some((c) => c.gesture?.reason) && (
          <p className="small" style={{ margin: 0 }}>
            <b>Scroll check (a real swipe over the open menu/overlay):</b> {[...new Set(v.checks.map((c) => c.gesture?.reason).filter(Boolean))].join(' ')}
          </p>
        )}
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
          {branch && !running && !prUrl && manuallyVerified && <Chamfer small tone="green" onClick={() => setDialog('publish-anyway')}>Create PR</Chamfer>}
          {branch && !running && !verified && !manuallyVerified && !prUrl && (
            <Chamfer small tone="danger" onClick={() => setDialog('publish-anyway')}>
              Publish anyway…
            </Chamfer>
          )}
        </div>
      </div>
      {dialog && branch && <FixRunDialog manualPublish={manuallyVerified} ws={ws} run={run} ids={[f.id]} mode={dialog} branch={branch} defaults={{ pr: false, draft: true }} onClose={() => setDialog(null)} />}
      {compare && before && after && <SyncedViewer title={`${f.id}: before / after the fix`} left={{ src: fileUrl(ws, run, before), label: 'Before' }} right={{ src: fileUrl(ws, run, after), label: 'After the fix' }} onClose={() => setCompare(false)} />}
      <ReproduceDialog open={repro} onClose={() => setRepro(false)} ws={ws} run={run} id={f.id} branch={branch} env={{ browser: env.browser, viewport: env.viewport, device: env.variant.device ?? null }} onStarted={onReproduceStarted} />
    </Box>
  );
}
