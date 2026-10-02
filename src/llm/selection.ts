import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export const Selection = z.object({ provider: z.enum(['claude', 'codex']), model: z.string().trim().min(1).max(200).nullable().default(null) });
export type Selection = z.infer<typeof Selection>;
export const selectionFile = () => join(process.env.BUGBASH_HOME ?? join(homedir(), '.bugbash'), 'models.json');
export function readSelection(file: string): Selection | null {
  if (!existsSync(file)) return null;
  return Selection.parse(JSON.parse(readFileSync(file, 'utf8')));
}
export function saveSelection(file: string, input: unknown): Selection {
  const value = Selection.parse(input);
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2));
  renameSync(temp, file);
  return value;
}
export function resolveSelection(o: { provider?: Selection['provider'] | null; model?: string | null }): Selection {
  const jobFile = process.env.BUGBASH_MODEL_SELECTION;
  const job = jobFile ? readSelection(jobFile) : null;
  if (job) return job;
  const cli = process.env.BUGBASH_PROVIDER as Selection['provider'] | undefined;
  const cliModel = process.env.BUGBASH_MODEL;
  if (cli) return Selection.parse({ provider: cli, model: cliModel || null });
  if (cliModel) return Selection.parse({ provider: o.provider ?? readSelection(selectionFile())?.provider ?? 'claude', model: cliModel });
  if (o.provider) return Selection.parse({ provider: o.provider, model: o.model ?? null });
  if (o.model) return { provider: 'claude', model: o.model };
  return readSelection(selectionFile()) ?? { provider: 'claude', model: null };
}
