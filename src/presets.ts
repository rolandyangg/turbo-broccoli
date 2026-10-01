import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Config } from './config.js';

/**
 * Run setup presets. Built-ins encode what we usually run; user presets live in ~/.bugbash/presets.json.
 * A preset is a partial Config layered between the repo config and explicit overrides.
 */
export interface Preset {
  id: string;
  name: string;
  description: string;
  builtin: boolean;
  config: Partial<Config>;
}

const PHONES = ['iphone-se', 'galaxy-s24', 'iphone-15', 'pixel-7', 'iphone-15-pro-max', 'iphone-15-landscape'];
const TABLETS = ['ipad-mini', 'ipad-pro-11', 'ipad-mini-landscape'];
const DESKTOPS = ['laptop-small', 'laptop', 'laptop-hidpi', 'desktop-fhd', 'desktop-qhd'];

export const BUILTIN_PRESETS: Preset[] = [
  {
    id: 'standard',
    name: 'Standard',
    description: 'What we usually run: everyday desktop users and real phones, Chromium + WebKit, lead agent, triage with video, retrospective.',
    builtin: true,
    config: { personas: ['everyday-user', 'phone-user'], personaSessions: { 'everyday-user': 3, 'phone-user': 3 }, browsers: ['chromium', 'webkit'], devices: [...PHONES, 'laptop-small', 'laptop', 'laptop-hidpi', 'desktop-fhd'], budgetSessions: 6, parallel: 3, lead: true, triage: { video: true, review: true }, retrospective: true },
  },
  {
    id: 'quick',
    name: 'Quick',
    description: 'Fast smoke check: Chromium only, one desktop and one phone session, no video or retrospective.',
    builtin: true,
    config: { personas: ['everyday-user', 'phone-user'], personaSessions: { 'everyday-user': 1, 'phone-user': 1 }, browsers: ['chromium'], devices: ['iphone-15', 'laptop'], budgetSessions: 2, parallel: 2, maxToolCallsPerSession: 60, lead: false, triage: { video: false, review: true }, retrospective: false },
  },
  {
    id: 'mobile',
    name: 'Mobile only',
    description: 'Phones and tablets via real device emulation (touch, mobile UA, DPR), Chromium + WebKit.',
    builtin: true,
    config: { personas: ['phone-user'], personaSessions: { 'phone-user': 4 }, browsers: ['chromium', 'webkit'], devices: [...PHONES, ...TABLETS], budgetSessions: 4, parallel: 2, lead: true, triage: { video: true, review: true }, retrospective: true },
  },
  {
    id: 'desktop',
    name: 'Desktop only',
    description: 'Everyday mouse + keyboard use across desktop/laptop sizes 1280×720 … 2560×1440, all three browsers.',
    builtin: true,
    config: { personas: ['everyday-user'], personaSessions: { 'everyday-user': 4 }, browsers: ['chromium', 'webkit', 'firefox'], devices: DESKTOPS, budgetSessions: 4, parallel: 2, lead: true, triage: { video: true, review: true }, retrospective: true },
  },
  {
    id: 'deep',
    name: 'Deep',
    description: 'Every enabled persona, all browsers, all devices and strategies, larger budget.',
    builtin: true,
    config: { personas: [], personaSessions: {}, browsers: ['chromium', 'webkit', 'firefox'], devices: [], strategies: { include: [], exclude: [] }, budgetSessions: 12, parallel: 3, lead: true, triage: { video: true, review: true }, retrospective: true },
  },
];

export const DEFAULT_PRESET = 'standard';
const file = () => process.env.BUGBASH_PRESETS_FILE || join(homedir(), '.bugbash', 'presets.json');

function readUser(): Preset[] {
  try {
    return existsSync(file()) ? (JSON.parse(readFileSync(file(), 'utf8')) as Preset[]).map((p) => ({ ...p, builtin: false })) : [];
  } catch {
    return [];
  }
}

export function listPresets(): Preset[] {
  return [...BUILTIN_PRESETS, ...readUser()];
}

export function getPreset(id: string): Preset | null {
  return listPresets().find((p) => p.id === id) ?? null;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'preset';

/** Create or update a user preset (built-ins are read-only: saving under a built-in id makes a copy). */
export function savePreset(p: { id?: string; name: string; description?: string; config: Partial<Config> }): Preset {
  const users = readUser();
  let id = p.id && !BUILTIN_PRESETS.some((b) => b.id === p.id) ? p.id : slug(p.name);
  if (!p.id || BUILTIN_PRESETS.some((b) => b.id === p.id)) while (listPresets().some((x) => x.id === id)) id = `${id}-2`;
  const preset: Preset = { id, name: p.name.trim().slice(0, 60) || id, description: (p.description ?? '').slice(0, 300), builtin: false, config: p.config };
  const next = [...users.filter((u) => u.id !== id), preset];
  mkdirSync(dirname(file()), { recursive: true });
  writeFileSync(file(), JSON.stringify(next, null, 2));
  return preset;
}

export function deletePreset(id: string): boolean {
  if (BUILTIN_PRESETS.some((b) => b.id === id)) throw new Error('Built-in presets cannot be deleted');
  const users = readUser();
  if (!users.some((u) => u.id === id)) return false;
  writeFileSync(file(), JSON.stringify(users.filter((u) => u.id !== id), null, 2));
  return true;
}
