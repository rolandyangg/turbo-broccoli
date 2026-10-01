import type { Step, Variant } from '../store/schema.js';
import { deviceById } from '../explore/devices.js';

/** Plain-English description of a step (deterministic, so repro steps are always accurate). */
export function describeStep(s: Step): string {
  switch (s.action) {
    case 'goto':
      return `Open ${s.url}`;
    case 'back':
      return 'Press the browser Back button';
    case 'forward':
      return 'Press the browser Forward button';
    case 'reload':
      return 'Reload the page';
    case 'resize':
      return `Resize the browser window to ${s.width}×${s.height}px`;
    case 'variant':
      return describeVariant(s.variant);
    case 'click':
      return `${s.count && s.count > 1 ? `Click ${s.count} times rapidly on` : 'Click'} ${label(s.text, s.selector)}`;
    case 'hover':
      return `Hover over ${label(s.text, s.selector)}`;
    case 'fill':
      return s.value ? `Type ${quote(s.value)} into ${label(null, s.selector)}` : `Clear ${label(null, s.selector)}`;
    case 'select':
      return `Choose "${s.value}" in ${label(null, s.selector)}`;
    case 'press':
      return `Press ${s.key}`;
    case 'scroll':
      return `Scroll to x=${Math.round(s.x)}, y=${Math.round(s.y)}`;
    case 'mutate_text':
      return `Change the text of ${label(null, s.selector)} to ${quote(s.text)} (simulates a longer translation/label)`;
    case 'wait':
      return `Wait ${s.ms}ms`;
  }
}

function describeVariant(v: Partial<Variant>): string {
  if (v.device !== undefined) {
    const d = deviceById(v.device);
    return d ? `Switch to device ${d.label} (${d.viewport.width}×${d.viewport.height}${d.playwright ? ', touch, mobile browser' : ''})` : 'Switch back to a desktop browser window';
  }
  const parts: string[] = [];
  if (v.colorScheme) parts.push(`${v.colorScheme} mode`);
  if (v.fontScale != null) parts.push(`text size ${Math.round(v.fontScale * 100)}%`);
  if (v.zoom != null) parts.push(`browser zoom ${Math.round(v.zoom * 100)}%`);
  if (v.dpr != null) parts.push(`device pixel ratio ${v.dpr}`);
  if (v.reducedMotion != null) parts.push(`reduced motion ${v.reducedMotion ? 'on' : 'off'}`);
  if (v.network) parts.push(`network ${v.network}`);
  if (v.blocked?.length) parts.push(`block ${v.blocked.join('/')} loading`);
  return `Set ${parts.join(', ')}`;
}

function label(text: string | null | undefined, selector: string) {
  return text ? `"${text.slice(0, 60)}" (\`${selector}\`)` : `\`${selector}\``;
}
function quote(v: string) {
  return v.length > 80 ? `"${v.slice(0, 77)}…" (${v.length} characters)` : JSON.stringify(v);
}

/** Collapse redundant steps: consecutive resizes/scrolls keep the last; waits dropped. */
export function normalizeSteps(steps: Step[]): Step[] {
  const out: Step[] = [];
  for (const s of steps) {
    if (s.action === 'wait') continue;
    const prev = out[out.length - 1];
    if (prev && ((prev.action === 'resize' && s.action === 'resize') || (prev.action === 'scroll' && s.action === 'scroll'))) {
      out[out.length - 1] = s;
      continue;
    }
    out.push(s);
  }
  return out;
}

/** Environment-only steps from the start of a trace plus everything from the last goto. */
export function suffixFromLastGoto(steps: Step[]): Step[] {
  let last = -1;
  steps.forEach((s, i) => s.action === 'goto' && (last = i));
  if (last <= 0) return steps;
  const env = steps.slice(0, last).filter((s) => s.action === 'resize' || s.action === 'variant');
  return normalizeSteps([...env, ...steps.slice(last)]);
}

/** Final environment implied by a trace (viewport/variant at the end). */
export function finalEnvironment(steps: Step[], init: { width: number; height: number }) {
  let vp = init;
  let variant: Partial<Variant> = {};
  for (const s of steps) {
    if (s.action === 'resize') vp = { width: s.width, height: s.height };
    if (s.action === 'variant') variant = { ...variant, ...s.variant };
  }
  return { viewport: vp, variant };
}
