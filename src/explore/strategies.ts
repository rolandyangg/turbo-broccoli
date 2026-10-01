/** Attack strategy catalog. Tools tag coverage automatically; agents may also cite ids in log_hypothesis/record_finding. */
export const STRATEGIES = {
  'size.sweep': 'Sweep desktop window widths (sweep_viewports)',
  'size.devices': 'Real phone/tablet emulation: touch, no hover, mobile UA, DPR, meta viewport (set_device / sweep_devices)',
  'size.desktop-sizes': 'Common desktop/laptop sizes incl. short heights (1280×720, 1366×768, 1440×900, 1920×1080, 2560×1440)',
  'size.breakpoint-edges': 'Resize to N-1/N/N+1 around CSS breakpoints',
  'size.resize-with-overlay': 'Resize while a modal/menu/popover is open',
  'size.orientation': 'Flip phone portrait <-> landscape',
  'content.long-word': 'Long unbroken word in inputs',
  'content.long-text': 'Long sentence in inputs',
  'content.huge-paste': '5k-char paste',
  'content.intl': 'Emoji / CJK / RTL / zalgo input',
  'content.empty': 'Empty or whitespace-only input, submit',
  'content.label-mutation': 'Longer labels via mutate_text (translation stress)',
  'content.font-scale': '200% text size',
  'content.zoom': 'Browser zoom 50%-300%',
  'chaos.rapid-click': 'Rapid double/triple clicks',
  'chaos.click-while-loading': 'Click while content is loading',
  'chaos.multi-open': 'Open several menus/popovers at once',
  'chaos.hover-transition': 'Hover during transitions / move pointer across gaps',
  'chaos.scroll-extremes': 'Scroll to top/bottom/far edges',
  'chaos.keyboard': 'Keyboard-only: Tab/Shift-Tab/Enter/Escape, focus visibility & traps',
  'nav.back-forward': 'Back/forward in the middle of a flow',
  'nav.reload-mid-flow': 'Reload mid-form / mid-flow',
  'nav.deep-link': 'Deep-link straight to an inner route',
  'nav.repeat-flow': 'Run the same flow twice',
  'env.offline': 'Go offline / slow 3G',
  'env.block-resources': 'Block fonts/images (fallback reflow)',
  'env.dark-mode': 'Dark color scheme',
  'env.reduced-motion': 'Reduced motion',
  'env.dpr': 'Device pixel ratio 1/2/3',
  'data.empty-state': 'Empty lists / no results',
  'data.many-items': 'Many items (add until crowded)',
  'data.error-state': 'Error states (blocked mutations return 503)',
} as const;
export type StrategyId = keyof typeof STRATEGIES;
export const STRATEGY_IDS = Object.keys(STRATEGIES) as StrategyId[];

/** Which strategies a browser tool call exercises (used to refuse calls for strategies turned off in a run). */
export function strategiesOfCall(tool: string, args: Record<string, unknown>, deviceKind: (id: string) => string | null): StrategyId[] {
  switch (tool) {
    case 'mutate_text':
      return ['content.label-mutation'];
    case 'rapid_click':
      return ['chaos.rapid-click'];
    case 'sweep_viewports':
      return ['size.sweep'];
    case 'back':
    case 'forward':
      return ['nav.back-forward'];
    case 'reload':
      return ['nav.reload-mid-flow'];
    case 'stress_fill': {
      const k = String(args.kind ?? '');
      const map: Record<string, StrategyId> = { 'long-word': 'content.long-word', german: 'content.long-word', 'long-text': 'content.long-text', 'huge-paste': 'content.huge-paste', emoji: 'content.intl', cjk: 'content.intl', rtl: 'content.intl', zalgo: 'content.intl', empty: 'content.empty', whitespace: 'content.empty' };
      return map[k] ? [map[k]] : [];
    }
    case 'set_variant': {
      const out: StrategyId[] = [];
      if (args.network && args.network !== 'online') out.push('env.offline');
      if (Array.isArray(args.blocked) && args.blocked.length) out.push('env.block-resources');
      if (args.colorScheme === 'dark') out.push('env.dark-mode');
      if (typeof args.fontScale === 'number' && args.fontScale !== 1) out.push('content.font-scale');
      if (typeof args.zoom === 'number' && args.zoom !== 1) out.push('content.zoom');
      if (typeof args.dpr === 'number' && args.dpr !== 1) out.push('env.dpr');
      if (args.reducedMotion === true) out.push('env.reduced-motion');
      return out;
    }
    case 'set_device': {
      const kind = deviceKind(String(args.device ?? ''));
      return kind === 'desktop' ? ['size.desktop-sizes'] : kind ? ['size.devices'] : [];
    }
    case 'sweep_devices':
      return ['size.devices'];
    case 'press':
      return /^(Tab|Shift\+Tab|Escape)$/.test(String(args.key ?? '')) ? ['chaos.keyboard'] : [];
    default:
      return [];
  }
}
