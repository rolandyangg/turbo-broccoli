import { z } from 'zod';

export const SCHEMA_VERSION = 1;

export const FindingType = z.enum([
  'text-overflow',
  'spill-out',
  'overlap',
  'too-close',
  'viewport-overflow',
  'small-tap-target',
  'misalignment',
  'layout-shift',
  'hidden-by-sticky',
  'focus-invisible',
  'broken-image',
  'console-error',
  'broken-state',
  'focus-obscured',
  'focus-escape',
  'overlay-overflow',
  'hover-only',
  'scroll-trap',
  'low-contrast',
  'distorted-image',
  'truncated-no-tooltip',
  'other',
]);
export type FindingType = z.infer<typeof FindingType>;

/** layout = visual/UI defects (the main counts); ux-functional = behaviour bugs (broken flows, errors), kept separate. */
export const FindingCategory = z.enum(['layout', 'ux-functional']);
export type FindingCategory = z.infer<typeof FindingCategory>;
export const FUNCTIONAL_TYPES: ReadonlySet<string> = new Set(['broken-state', 'console-error']);
export const categoryOf = (type: string): FindingCategory => (FUNCTIONAL_TYPES.has(type) ? 'ux-functional' : 'layout');

export const Severity = z.enum(['critical', 'major', 'minor', 'cosmetic']);
export type Severity = z.infer<typeof Severity>;

export const FindingStatus = z.enum([
  'new',
  'low_confidence',
  'flaky',
  'suppressed',
  'false_positive',
  'confirmed',
  'fixing',
  'fixed',
]);
export type FindingStatus = z.infer<typeof FindingStatus>;

export const BrowserName = z.enum(['chromium', 'webkit', 'firefox']);
export type BrowserName = z.infer<typeof BrowserName>;

export const Viewport = z.object({ width: z.number().int(), height: z.number().int() });
export type Viewport = z.infer<typeof Viewport>;

export const Variant = z.object({
  colorScheme: z.enum(['light', 'dark']).default('light'),
  fontScale: z.number().default(1),
  dpr: z.number().default(1),
  reducedMotion: z.boolean().default(false),
  zoom: z.number().default(1),
  network: z.enum(['online', 'offline', 'slow-3g']).default('online'),
  blocked: z.array(z.string()).default([]),
  /** Real device emulation profile id (touch, mobile UA, DPR, meta viewport); null = desktop window. */
  device: z.string().nullable().default(null),
});
export type Variant = z.infer<typeof Variant>;

export const BBox = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });
export type BBox = z.infer<typeof BBox>;

/** One replayable step. Selectors are stable CSS selectors computed at record time. */
export const Step = z.discriminatedUnion('action', [
  z.object({ action: z.literal('goto'), url: z.string() }),
  z.object({ action: z.literal('back') }),
  z.object({ action: z.literal('forward') }),
  z.object({ action: z.literal('reload') }),
  z.object({ action: z.literal('resize'), width: z.number(), height: z.number() }),
  z.object({ action: z.literal('variant'), variant: Variant.partial() }),
  z.object({ action: z.literal('click'), selector: z.string(), text: z.string().optional(), count: z.number().optional() }),
  z.object({ action: z.literal('hover'), selector: z.string(), text: z.string().optional() }),
  z.object({ action: z.literal('fill'), selector: z.string(), value: z.string() }),
  z.object({ action: z.literal('select'), selector: z.string(), value: z.string() }),
  z.object({ action: z.literal('press'), key: z.string() }),
  z.object({ action: z.literal('scroll'), x: z.number(), y: z.number() }),
  z.object({ action: z.literal('mutate_text'), selector: z.string(), text: z.string() }),
  z.object({ action: z.literal('wait'), ms: z.number() }),
]);
export type Step = z.infer<typeof Step>;

export const Environment = z.object({
  browser: BrowserName,
  viewport: Viewport,
  variant: Variant,
  persona: z.string().optional(),
});
export type Environment = z.infer<typeof Environment>;

export const Reproduction = z.object({
  rate: z.string().nullable().default(null), // "3/3"
  environment: Environment,
  steps_human: z.array(z.string()).default([]),
  expected: z.string().default(''),
  actual: z.string().default(''),
  steps_minimal: z.array(Step).default([]),
  steps_original: z.array(Step).default([]),
  spec: z.string().nullable().default(null),
});
export type Reproduction = z.infer<typeof Reproduction>;

export const ConfidenceBreakdown = z.object({
  explorer: z.number().nullable().default(null),
  reviewer: z.number().nullable().default(null),
  detector: z.number().nullable().default(null),
  repro: z.number().nullable().default(null),
  raw: z.number().nullable().default(null),
  calibrated: z.number().nullable().default(null),
  calibration_bucket: z.string().nullable().default(null),
  notes: z.array(z.string()).default([]),
});

export const Finding = z.object({
  id: z.string(), // BB-0007
  root_cause_id: z.string().nullable().default(null),
  fingerprint: z.string(),
  type: FindingType,
  category: FindingCategory.optional(),
  title: z.string(),
  description: z.string().default(''),
  severity: Severity.default('minor'),
  confidence: z.number().min(0).max(1),
  confidence_breakdown: ConfidenceBreakdown.default(() => ConfidenceBreakdown.parse({})),
  status: FindingStatus.default('new'),
  history_tag: z.enum(['new', 'recurring', 'regressed']).default('new'),
  found_by: z
    .object({
      persona: z.string().nullable().default(null),
      strategy: z.string().nullable().default(null),
      hypothesis: z.string().nullable().default(null),
      session: z.string().nullable().default(null),
      seeded_by_code_intel: z.boolean().default(false),
    })
    .default(() => ({ persona: null, strategy: null, hypothesis: null, session: null, seeded_by_code_intel: false })),
  page: z.string(),
  browsers: z.array(BrowserName).default([]),
  viewports: z.array(Viewport).default([]),
  element: z
    .object({
      selector: z.string().nullable(),
      text: z.string().nullable().default(null),
      bbox: BBox.nullable().default(null),
      signature: z.string().nullable().default(null), // DOM structure signature for sibling hunting
    })
    .default(() => ({ selector: null, text: null, bbox: null, signature: null })),
  metrics: z.record(z.string(), z.unknown()).default({}),
  reproduction: Reproduction,
  evidence_kind: z.enum(['static', 'temporal']).default('static'),
  screenshots: z
    .object({
      annotated: z.string().nullable().default(null),
      crop: z.string().nullable().default(null),
      full: z.string().nullable().default(null),
      /** The explorer agent's own annotated screenshot from the moment it recorded the finding. */
      explorer: z.string().nullable().default(null),
    })
    .default(() => ({ annotated: null, crop: null, full: null, explorer: null })),
  video: z
    .object({
      mp4: z.string().nullable(),
      gif: z.string().nullable(),
      webm: z.string().nullable(),
      filmstrip: z.string().nullable(),
      trace: z.string().nullable(),
      bug_at_ms: z.number().nullable(),
      /** Timeline annotations: one per repro step plus the bug moment (ms from video start). */
      chapters: z.array(z.object({ t_ms: z.number(), step_index: z.number().nullable(), label: z.string(), kind: z.enum(['step', 'bug', 'load']).default('step') })).default([]),
    })
    .nullable()
    .default(null),
  source_hints: z
    .array(z.object({ file: z.string(), line: z.number().nullable().default(null), reason: z.string() }))
    .default([]),
  siblings: z.array(z.string()).default([]),
  fix_hint: z.string().default(''),
  likely_cause: z.string().default(''),
  label_note: z.string().nullable().default(null),
  /** The person's own sorting while going through bugs (separate from what the agents decide). */
  workflow: z
    .object({
      state: z.enum(['todo', 'in_progress', 'done']).nullable().default(null),
      archived: z.boolean().default(false),
      archived_at: z.string().nullable().default(null),
      /** Status before the person marked it done (restored if they move it back). */
      prev_status: z.string().nullable().default(null),
      updated_at: z.string().nullable().default(null),
    })
    .default(() => ({ state: null, archived: false, archived_at: null, prev_status: null, updated_at: null })),
  fix: z
    .object({
      branch: z.string(),
      base: z.string().nullable().default(null),
      pr_url: z.string().nullable(),
      verified: z.boolean(),
      fixed_by: z.string().nullable().default(null), // finding/group id whose fix resolved this
      job_id: z.string().nullable().default(null),
      at: z.string(),
    })
    .nullable()
    .default(null),
});
export type Finding = z.infer<typeof Finding>;
export type WorkflowState = 'unsorted' | 'todo' | 'in_progress' | 'done';

/** Where a finding sits on the person's board: their own choice, else derived from fix progress. */
export function workflowStateOf(f: Pick<Finding, 'status'> & { workflow?: Finding['workflow'] }): WorkflowState {
  if (f.workflow?.state) return f.workflow.state;
  return f.status === 'fixed' ? 'done' : f.status === 'fixing' ? 'in_progress' : 'unsorted';
}
export const isArchived = (f: { workflow?: Finding['workflow'] }) => !!f.workflow?.archived;

export const RootCauseGroup = z.object({
  id: z.string(), // RC-002
  summary: z.string(),
  component: z.string().nullable().default(null),
  css_rule: z.string().nullable().default(null),
  files: z.array(z.string()).default([]),
  fix_plan: z.string().default(''),
  confidence: z.number().min(0).max(1).default(0.5),
  status_rollup: z.record(z.string(), z.number()).default({}),
  findings: z.array(Finding),
});
export type RootCauseGroup = z.infer<typeof RootCauseGroup>;

export const FindingsFile = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  run_id: z.string(),
  target: z.string(),
  generated_at: z.string(),
  groups: z.array(RootCauseGroup),
});
export type FindingsFile = z.infer<typeof FindingsFile>;

/** What an explorer records in the field, before triage enriches it. */
export const RawFinding = z.object({
  session: z.string(),
  persona: z.string().nullable(),
  type: FindingType,
  category: FindingCategory.optional(),
  title: z.string(),
  description: z.string(),
  severity: Severity,
  confidence: z.number().min(0).max(1),
  hypothesis: z.string().nullable(),
  strategy: z.string().nullable(),
  seeded_by_code_intel: z.boolean().default(false),
  page: z.string(),
  url: z.string(),
  environment: Environment,
  element: z.object({
    selector: z.string().nullable(),
    text: z.string().nullable(),
    bbox: BBox.nullable(),
    signature: z.string().nullable(),
  }),
  detector: z
    .object({ type: z.string(), confidence: z.number(), metrics: z.record(z.string(), z.unknown()) })
    .nullable(),
  temporal_signals: z.array(z.string()).default([]),
  trace: z.array(Step),
  screenshot: z.string().nullable(),
  at: z.string(),
});
export type RawFinding = z.infer<typeof RawFinding>;

export const Hypothesis = z.object({
  session: z.string(),
  page: z.string(),
  hypothesis: z.string(),
  strategy: z.string().nullable(),
  outcome: z.enum(['confirmed', 'refuted', 'inconclusive']),
  note: z.string().default(''),
  at: z.string(),
});
export type Hypothesis = z.infer<typeof Hypothesis>;
