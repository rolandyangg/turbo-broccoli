import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api, useApi } from '../lib/api.ts';
import type { JobEvent, JobView } from '../lib/types.ts';
import { ago } from '../lib/format.ts';
import { useToast } from './ui.tsx';

interface Messages {
  messages: { id: string; at: string; text: string }[];
  deliveries: { id: string; agent: string; at: string }[];
}

/**
 * Talk to the agents working in a running job. Messages reach each agent at its next tool call (usually seconds);
 * replies show up in the job's feed (and, for bug bashes, in each explorer's live session).
 */
export function AgentChat({ job, events }: { job: JobView; events: JobEvent[] }) {
  const running = job.state === 'running' && job.alive;
  const { data, reload } = useApi<Messages>(`/jobs/${job.id}/messages`, { pollMs: running ? 3000 : undefined });
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [pr, setPr] = useState(false);
  const [confirmPush, setConfirmPush] = useState(false);
  const toast = useToast();
  const nav = useNavigate();
  const msgs = data?.messages ?? [];
  // Finished fix / bug bash / improvement jobs can be started again with new instructions.
  const canFollow = !running && ['fix', 'explore', 'improve'].includes(job.kind);
  if (!running && !msgs.length && !canFollow) return null;
  const send = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      if (running) {
        await api(`/jobs/${job.id}/messages`, { json: { text } });
        setText('');
        reload();
      } else {
        const next = await api<JobView>(`/jobs/${job.id}/followup`, { json: { text, pr, confirmPush: pr ? confirmPush : undefined } });
        toast('Started again with your instructions');
        nav(`/jobs/${next.id}`);
      }
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  // Agent text written after the first message, as a reply thread (bug bash explorers reply in their sessions).
  const firstAt = msgs[0]?.at;
  const replies = firstAt ? events.filter((e) => e.level === 'agent' && (e.data as { text?: boolean } | undefined)?.text && e.t >= firstAt).slice(-6) : [];
  return (
    <section className="box agent-chat" aria-labelledby="chat-h">
      <div className="box-head">
        <div className="path" id="chat-h">
          {running ? 'Talk to the agent' : 'Send a follow-up'}
        </div>
        {running ? <span className="small muted">delivered at its next step</span> : canFollow ? <span className="small muted">starts it again with your instructions</span> : null}
      </div>
      <div className="box-body stack" style={{ ['--gap' as string]: '10px' }}>
        {msgs.length > 0 && (
          <ol className="chat-list">
            {msgs.map((m) => {
              const got = (data?.deliveries ?? []).filter((d) => d.id === m.id);
              return (
                <li key={m.id} className="chat-msg you">
                  <div>{m.text}</div>
                  <div className="small muted">
                    {ago(m.at)} · {got.length ? `received by ${[...new Set(got.map((d) => d.agent))].join(', ')}` : running ? 'waiting for the agent’s next step…' : 'not delivered (the agent had finished)'}
                  </div>
                </li>
              );
            })}
            {replies.map((r, i) => (
              <li key={`r${i}`} className="chat-msg agent">
                <div>{r.msg}</div>
                <div className="small muted">agent · {ago(r.t)}</div>
              </li>
            ))}
          </ol>
        )}
        {running || canFollow ? (
          <>
            <label className="sr-only" htmlFor={`chat-${job.id}`}>
              Message to the agent
            </label>
            <textarea
              id={`chat-${job.id}`}
              className="input"
              rows={2}
              placeholder={
                running
                  ? job.kind === 'explore'
                    ? 'e.g. "Focus on the pricing page on phones" — every explorer and the lead get it'
                    : 'e.g. "Don’t touch the header; fix it in the card component instead"'
                  : job.kind === 'fix'
                    ? 'e.g. "Keep the 1024px breakpoint and fix it inside the carousel instead" — continues this fix on its branch'
                    : job.kind === 'explore'
                      ? 'e.g. "Now go deeper on the checkout flow on phones" — starts a follow-up bug bash'
                      : 'e.g. "Use a smaller threshold and add a negative test" — re-runs these items'
              }
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <div className="spread">
              <span className="small muted">Enter to send · Shift+Enter for a new line. Agents follow it within their task and safety rules.</span>
              <button className="btn-ghost" disabled={busy || !text.trim() || (pr && !confirmPush)} onClick={() => void send()}>
                {running ? 'Send' : 'Send & start'}
              </button>
            </div>
            {!running && (job.kind === 'fix' || job.kind === 'improve') && (
              <div className="stack" style={{ ['--gap' as string]: '6px' }}>
                <label className="check small">
                  <input type="checkbox" checked={pr} onChange={(e) => setPr(e.target.checked)} /> <span>Push and open (or update) the pull request when done</span>
                </label>
                {pr && (
                  <label className="check small" style={{ color: 'var(--sev-major)', paddingLeft: 24 }}>
                    <input type="checkbox" checked={confirmPush} onChange={(e) => setConfirmPush(e.target.checked)} /> <span>I understand this pushes to GitHub</span>
                  </label>
                )}
              </div>
            )}
          </>
        ) : (
          <p className="small muted" style={{ margin: 0 }}>
            The job has finished.
          </p>
        )}
      </div>
    </section>
  );
}
