import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

/**
 * Messages from the person watching a job to the agents working in it. Stored with the job:
 *   <jobDir>/messages.jsonl    what the person wrote
 *   <jobDir>/deliveries.jsonl  which agent received which message, and when
 * Agents get new messages at their next tool call through a PostToolUse hook (inboxHook.mjs), which every
 * runClaude call in a process with BUGBASH_INBOX set installs.
 */
export interface InboxMessage {
  id: string;
  at: string;
  text: string;
}
export interface Delivery {
  id: string;
  agent: string;
  at: string;
}

const HOOK = join(dirname(fileURLToPath(import.meta.url)), 'inboxHook.mjs');
const readLines = <T>(f: string): T[] =>
  existsSync(f)
    ? readFileSync(f, 'utf8')
        .split('\n')
        .filter(Boolean)
        .flatMap((l) => {
          try {
            return [JSON.parse(l) as T];
          } catch {
            return [];
          }
        })
    : [];

export const inboxFile = (jobDir: string) => join(jobDir, 'messages.jsonl');

export function postMessage(jobDir: string, text: string): InboxMessage {
  const m: InboxMessage = { id: `M-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`, at: new Date().toISOString(), text: text.trim().slice(0, 4000) };
  mkdirSync(jobDir, { recursive: true });
  appendFileSync(inboxFile(jobDir), JSON.stringify(m) + '\n');
  return m;
}

export function readMessages(jobDir: string) {
  return { messages: readLines<InboxMessage>(inboxFile(jobDir)), deliveries: readLines<Delivery>(join(jobDir, 'deliveries.jsonl')) };
}

/** Writes the Claude Code settings file that installs the delivery hook, and returns its path. */
export function inboxSettings(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'inbox-hook-settings.json');
  writeFileSync(file, JSON.stringify({ hooks: { PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `"${process.execPath}" "${HOOK}"`, timeout: 10 }] }] } }));
  return file;
}
