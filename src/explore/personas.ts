/**
 * Explorer personas. Each has a prompt (prompts/personas/<id>.md), a tool set, and a start environment.
 * Tool sets are enforced by the browser MCP server (not just the prompt), so an "everyday" explorer
 * physically cannot rewrite page text or tamper with the environment.
 */
export type Toolset = 'everyday' | 'full';

export interface Persona {
  id: string;
  summary: string;
  toolset: Toolset;
  /** Start on this device profile (see devices.ts) unless the lead assigns a viewport. */
  device?: string;
}

export const PERSONA_REGISTRY: Persona[] = [
  { id: 'everyday-user', summary: 'Normal desktop/laptop user: mouse + keyboard, realistic input, no page edits; covers common desktop sizes', toolset: 'everyday', device: 'laptop' },
  { id: 'phone-user', summary: 'Real phone emulation (touch, no hover, mobile UA, DPR): normal taps/typing, portrait + landscape', toolset: 'everyday', device: 'iphone-15' },
  { id: 'keyboard-user', summary: 'Keyboard-only navigation: focus order, visibility, traps', toolset: 'everyday' },
  { id: 'german-user', summary: 'Long translated labels and compound words (rewrites visible text)', toolset: 'full' },
  { id: 'impatient-user', summary: 'Rapid clicks, back mid-flow, slow/offline network', toolset: 'full' },
  { id: 'power-user', summary: 'Large monitors, zoom, many panels, long real data', toolset: 'full' },
  { id: 'low-vision-user', summary: '200% text, 300% zoom, reduced motion', toolset: 'full' },
];

export const PERSONA_IDS = PERSONA_REGISTRY.map((p) => p.id);

/** Tools an "everyday" explorer may use: navigation, pointer/keyboard input, observation, sizes/devices, recording. */
export const EVERYDAY_TOOLS = [
  'observe',
  'screenshot',
  'goto',
  'back',
  'forward',
  'reload',
  'click',
  'hover',
  'type',
  'select',
  'press',
  'check_focus',
  'scroll',
  'resize',
  'set_device',
  'run_detectors',
  'sweep_viewports',
  'sweep_devices',
  'find_similar',
  'record_finding',
  'log_hypothesis',
  'coverage',
  'strategy_coverage',
  'notes',
];

export function personaById(id: string | null | undefined) {
  return PERSONA_REGISTRY.find((p) => p.id === id) ?? null;
}

/** Personas the lead may use: config.personas (if set) minus config.disabledPersonas. */
export function enabledPersonas(cfg: { personas: string[]; disabledPersonas: string[] }): Persona[] {
  const base = cfg.personas.length ? PERSONA_REGISTRY.filter((p) => cfg.personas.includes(p.id)) : PERSONA_REGISTRY;
  return base.filter((p) => !cfg.disabledPersonas.includes(p.id));
}
