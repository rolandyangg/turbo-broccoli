import { useState } from 'react';
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
export function AgentChat({ job, events, onFollowup }: { job: JobView; events: JobEvent[]; onFollowup: (job: JobView) => void }) {
  const running = job.state === 'running' && job.alive;
  const { data, reload } = useApi<Messages>(`/jobs/${job.id}/messages`, { pollMs: running ? 3000 : undefined });
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const msgs = data?.messages ?? [];
  // Finished jobs keep the same identity when the conversation resumes.
  const canFollow = !running && job.kind !== 'connect';
  if (!running && !msgs.length && !canFollow) return null;
  const send = async () => {
    if (busy || !text.trim()) return;
    setBusy(true);
    try {
      if (running) {
        await api(`/jobs/${job.id}/messages`, { json: { text } });
        setText('');
        reload();
      } else {
        const next = await api<JobView>(`/jobs/${job.id}/followup`, { json: { text } });
        toast('Follow-up sent');
        setText('');
        onFollowup(next);
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
          Talk to the agent
        </div>
        {running ? <span className="small muted">delivered at its next step</span> : canFollow ? <span className="small muted">continue the conversation here</span> : null}
      </div>
      <div className="box-body stack" style={{ ['--gap' as string]: '10px' }}>
        {(msgs.length > 0 || replies.length > 0) && (
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
              placeholder="Ask a question or send more instructions to this agent"
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
              <button className="btn-ghost" disabled={busy || !text.trim()} onClick={() => void send()}>
                Send
              </button>
            </div>

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
