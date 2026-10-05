import type { LayoutRegression } from '../store/schema.js';

/** Older runs stored only detector messages in the job log. */
export function parseRegression(message: string): LayoutRegression | null {
  const match = message.match(/^(.*?) @(\d+)px: new ([\w-]+) on (.*?) — (.*)$/s);
  if (!match) return null;
  return { page: match[1], width: Number(match[2]), type: match[3], selector: match[4] === 'null' ? null : match[4], message: match[5], text: '', preview: null };
}

export function regressionTitle(r: LayoutRegression): string {
  const selector = r.selector ?? '';
  const subject = /slide-quote-text/.test(selector) ? 'Quote text' : /slide-project-description/.test(selector) ? 'Project description' : /carouselCaption/.test(selector) ? 'Gallery caption' : r.text.trim().slice(0, 45) || 'Content';
  if (r.type === 'low-contrast') return `${subject}: low contrast`;
  if (r.type === 'overlap') {
    if (/control is drawn/i.test(r.message)) return `${subject}: covered by control`;
    if (/text collision/i.test(r.message)) return `${subject}: text overlaps`;
    return `${subject}: obscured`;
  }
  return `${subject}: ${r.type.replaceAll('-', ' ')}`;
}
