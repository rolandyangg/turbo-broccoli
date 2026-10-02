/** Publishing an existing fix branch remains part of its fix history. */
export function isFixJob(job: { kind: string }): boolean {
  return job.kind === 'fix' || job.kind === 'publish';
}

export function fixJobKind(options: { mode?: string; pr?: boolean }): 'fix' | 'publish' {
  return options.mode === 'continue' && options.pr ? 'publish' : 'fix';
}
