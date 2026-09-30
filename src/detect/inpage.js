// In-page UI defect detectors. Plain browser JS: injected as a string (see detect/index.ts),
// installs window.__bugbash with detect(), selectorFor(), overlay helpers and layout-shift tracking.
(() => {
  if (window.__bugbash && window.__bugbash.version === 1) return;

  const MAX_ELEMENTS = 4000;
  const MAX_CANDIDATES = 150;
  const INTERACTIVE = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [role=switch], [tabindex]:not([tabindex="-1"])';

  // ---------- helpers ----------
  const cs = (el) => getComputedStyle(el);
  const rectOf = (el) => el.getBoundingClientRect();
  const r2 = (r) => ({ x: Math.round(r.x), y: Math.round(r.y + scrollY), width: Math.round(r.width), height: Math.round(r.height) });

  function isVisible(el) {
    if (!(el instanceof Element)) return false;
    if (el.closest('[data-bugbash-overlay]')) return false;
    const s = cs(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse' || Number(s.opacity) === 0) return false;
    const r = rectOf(el);
    if (r.width < 1 || r.height < 1) return false;
    // sr-only pattern
    if (r.width <= 1 && r.height <= 1) return false;
    if (s.clip === 'rect(0px, 0px, 0px, 0px)' || s.clipPath === 'inset(50%)') return false;
    let p = el.parentElement;
    while (p && p !== document.body) {
      const ps = cs(p);
      if (ps.display === 'none' || ps.visibility === 'hidden' || Number(ps.opacity) === 0) return false;
      p = p.parentElement;
    }
    return true;
  }

  function directText(el) {
    let t = '';
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.textContent;
    return t.replace(/\s+/g, ' ').trim();
  }
  const textOf = (el) => (el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('alt') || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 140);

  function textRect(el) {
    // Bounding rect of the element's rendered text (union of text nodes), or null.
    const range = document.createRange();
    let box = null;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      if (!n.textContent.trim()) continue;
      if (n.parentElement && !isVisible(n.parentElement)) continue;
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) {
        if (r.width < 0.5 || r.height < 0.5) continue;
        box = box ? union(box, r) : { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      }
    }
    return box && { x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top, left: box.left, top: box.top, right: box.right, bottom: box.bottom };
  }
  const union = (a, r) => ({ left: Math.min(a.left, r.left), top: Math.min(a.top, r.top), right: Math.max(a.right, r.right), bottom: Math.max(a.bottom, r.bottom) });

  function intersect(a, b) {
    const left = Math.max(a.left, b.left), right = Math.min(a.right, b.right);
    const top = Math.max(a.top, b.top), bottom = Math.min(a.bottom, b.bottom);
    if (right <= left || bottom <= top) return null;
    return { left, right, top, bottom, width: right - left, height: bottom - top };
  }

  const isHashy = (c) => /\d{3,}|^[a-z]{1,3}-[a-zA-Z0-9_-]{5,}$|^css-|^sc-|^_|__[a-zA-Z0-9]{5}$/.test(c);
  function selectorFor(el) {
    if (!(el instanceof Element)) return null;
    if (el.id && !isHashy(el.id) && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) return '#' + CSS.escape(el.id);
    for (const attr of ['data-testid', 'data-test', 'data-cy', 'data-qa']) {
      const v = el.getAttribute(attr);
      if (v) {
        const sel = `[${attr}="${CSS.escape(v)}"]`;
        if (document.querySelectorAll(sel).length === 1) return sel;
      }
    }
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
      let part = cur.tagName.toLowerCase();
      if (cur.id && !isHashy(cur.id)) {
        parts.unshift('#' + CSS.escape(cur.id));
        break;
      }
      const classes = [...cur.classList].filter((c) => !isHashy(c)).slice(0, 2);
      if (classes.length) part += '.' + classes.map((c) => CSS.escape(c)).join('.');
      const parent = cur.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === cur.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
      }
      parts.unshift(part);
      const sel = parts.join(' > ');
      try {
        if (document.querySelectorAll(sel).length === 1) return sel;
      } catch {}
      cur = parent;
    }
    return parts.join(' > ');
  }

  // Structural signature: same for every instance of a component (used for sibling hunting).
  function signatureOf(el) {
    const own = (e) => e.tagName.toLowerCase() + [...e.classList].filter((c) => !isHashy(c)).slice(0, 2).map((c) => '.' + c).join('');
    const chain = [];
    let cur = el;
    for (let i = 0; i < 3 && cur && cur !== document.body; i++, cur = cur.parentElement) chain.unshift(own(cur));
    return chain.join(' > ');
  }

  function hasSurface(el) {
    const s = cs(el);
    const bg = s.backgroundColor;
    const hasBg = bg && bg !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(bg);
    const hasBorder = ['Top', 'Right', 'Bottom', 'Left'].some((d) => parseFloat(s['border' + d + 'Width']) > 0 && s['border' + d + 'Style'] !== 'none');
    return { hasBg: !!hasBg, hasBorder, any: !!hasBg || hasBorder || s.backgroundImage !== 'none' };
  }

  function isOpaqueBg(el) {
    const s = cs(el);
    const bg = s.backgroundColor;
    if (s.backgroundImage !== 'none') return true;
    const m = bg.match(/rgba?\(([^)]+)\)/);
    if (!m) return false;
    const parts = m[1].split(',').map((x) => parseFloat(x));
    return parts.length < 4 || parts[3] > 0.6;
  }

  function allElements() {
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let n;
    while ((n = walker.nextNode()) && out.length < MAX_ELEMENTS) {
      const tag = n.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE' || n.hasAttribute('data-bugbash-overlay')) continue;
      out.push(n);
    }
    return out;
  }

  function scrollContainerOf(el) {
    let p = el.parentElement;
    while (p && p !== document.body && p !== document.documentElement) {
      const s = cs(p);
      if (/(auto|scroll)/.test(s.overflowX + s.overflowY)) return p;
      p = p.parentElement;
    }
    return null;
  }

  function cand(type, el, confidence, message, metrics = {}, related = null) {
    return {
      type,
      selector: selectorFor(el),
      text: textOf(el),
      bbox: r2(rectOf(el)),
      signature: signatureOf(el),
      confidence: Math.max(0, Math.min(1, Math.round(confidence * 100) / 100)),
      message,
      metrics,
      related: related ? { selector: selectorFor(related), text: textOf(related), bbox: r2(rectOf(related)) } : null,
    };
  }

  // ---------- detectors ----------
  function detectTextOverflow(els) {
    const out = [];
    for (const el of els) {
      if (!isVisible(el)) continue;
      const s = cs(el);
      const clipsX = /(hidden|clip)/.test(s.overflowX);
      const clipsY = /(hidden|clip)/.test(s.overflowY);
      if (!clipsX && !clipsY) continue;
      if (!textOf(el)) continue;
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') continue;
      const ox = clipsX ? el.scrollWidth - el.clientWidth : 0;
      const oy = clipsY ? el.scrollHeight - el.clientHeight : 0;
      if (ox <= 1 && oy <= 2) continue;
      // Ignore containers whose overflow is from non-text (e.g. carousels): require clipped text.
      const tr = textRect(el);
      const r = rectOf(el);
      if (!tr) continue;
      const textClipped = tr.right > r.right - parseFloat(s.borderRightWidth) + 1 || tr.bottom > r.bottom - parseFloat(s.borderBottomWidth) + 1 || ox > 1;
      if (!textClipped) continue;
      const ellipsis = s.textOverflow === 'ellipsis' || (s.webkitLineClamp && s.webkitLineClamp !== 'none');
      const px = Math.max(ox, oy);
      if (ellipsis) {
        out.push(cand('text-overflow', el, 0.3, `Text truncated with ellipsis/line-clamp (${px}px hidden). May be intentional.`, { overflow_px: px, truncated_by_design: true, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
      } else {
        out.push(cand('text-overflow', el, Math.min(0.95, 0.55 + px / 40), `Text clipped by overflow:${clipsX ? s.overflowX : s.overflowY}; ${ox > 1 ? ox + 'px horizontally' : ''}${ox > 1 && oy > 2 ? ', ' : ''}${oy > 2 ? oy + 'px vertically' : ''} hidden.`, { overflow_px: px, overflow_x_px: ox, overflow_y_px: oy, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, height: s.height, whiteSpace: s.whiteSpace }));
      }
    }
    return out;
  }

  function detectSpillOut(els) {
    // Text escaping a visibly bounded box (background or border) whose overflow is visible.
    const out = [];
    for (const el of els) {
      if (!isVisible(el)) continue;
      const s = cs(el);
      if (/(hidden|clip)/.test(s.overflowX) && /(hidden|clip)/.test(s.overflowY)) continue;
      if (!directText(el) && !['BUTTON', 'A'].includes(el.tagName)) continue;
      const surf = hasSurface(el);
      if (!surf.any) continue;
      const r = rectOf(el);
      const tr = textRect(el);
      if (!tr) continue;
      // Centered text overflows on both sides, so also compare total extents.
      const dx = Math.max(0, tr.right - r.right, r.left - tr.left, Math.max(0, tr.right - r.right) + Math.max(0, r.left - tr.left));
      const dy = Math.max(0, tr.bottom - r.bottom, r.top - tr.top, Math.max(0, tr.bottom - r.bottom) + Math.max(0, r.top - tr.top));
      const px = Math.round(Math.max(dx, dy));
      if (px < 2) continue;
      out.push(cand('spill-out', el, Math.min(0.95, 0.6 + px / 30), `Text spills ${px}px outside its ${surf.hasBg ? 'background' : 'border'} box.`, { spill_px: px, spill_x_px: Math.round(dx), spill_y_px: Math.round(dy), box_width: Math.round(r.width), text_width: Math.round(tr.width), width: s.width, whiteSpace: s.whiteSpace }));
    }
    return out;
  }

  function contentBoxes(els) {
    // Leaf-ish visible content: elements with direct text, media, form controls.
    const items = [];
    for (const el of els) {
      const tag = el.tagName;
      const isMedia = tag === 'IMG' || tag === 'SVG' || tag === 'VIDEO' || tag === 'CANVAS' || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
      const dt = directText(el);
      if (!isMedia && !dt) continue;
      if (!isVisible(el)) continue;
      const box = isMedia ? rectOf(el) : textRect(el);
      if (!box || box.width < 2 || box.height < 2) continue;
      items.push({ el, box: { left: box.left, top: box.top, right: box.left + box.width, bottom: box.top + box.height, width: box.width, height: box.height } });
    }
    return items;
  }

  function coveringSurface(topEl, other) {
    // Walk up from the topmost element to the first ancestor that is not also an ancestor of `other`;
    // return the first opaque surface on that path, if any.
    let cur = topEl;
    while (cur && cur !== document.body && !cur.contains(other)) {
      if (isOpaqueBg(cur)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  function detectOverlap(els) {
    const out = [];
    const items = contentBoxes(els).slice(0, 800);
    const seen = new Set();
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i], b = items[j];
        if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
        const ix = intersect(a.box, b.box);
        if (!ix || ix.width < 3 || ix.height < 3) continue;
        const minArea = Math.min(a.box.width * a.box.height, b.box.width * b.box.height);
        if ((ix.width * ix.height) / minArea < 0.08) continue;
        const cx = ix.left + ix.width / 2, cy = ix.top + ix.height / 2;
        if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) {
          // Off-screen: can't use elementFromPoint reliably; skip unless both have no surface.
          continue;
        }
        const top = document.elementFromPoint(cx, cy);
        if (!top) continue;
        const aTop = a.el.contains(top) || top.contains(a.el) && !top.contains(b.el);
        const bTop = b.el.contains(top) || top.contains(b.el) && !top.contains(a.el);
        if (!aTop && !bTop) continue; // occluded by something else (e.g. a modal backdrop)
        const [upper, lower] = aTop ? [a, b] : [b, a];
        const cover = coveringSurface(top, lower.el);
        let confidence, message;
        if (!cover) {
          confidence = 0.85;
          message = 'Content overlaps: both elements are visible on top of each other (text collision).';
        } else {
          const cr = rectOf(cover);
          const ratio = (cr.width * cr.height) / (ix.width * ix.height);
          const role = cover.getAttribute('role') || '';
          // A control (button/link/input) sitting on top of text is a collision; a large surface (menu, card,
          // popover, dialog) covering content is usually intentional layering.
          const isControl = cover.matches('button, a[href], input, select, textarea, [role=button]') || !!cover.closest('button, a[href], [role=button]');
          if (!isControl && (ratio > 2.5 || /menu|listbox|dialog|tooltip/.test(role) || cover.matches('[popover], dialog'))) continue;
          confidence = isControl ? 0.75 : 0.7;
          message = isControl ? 'A control is drawn on top of other content, hiding part of it.' : 'Element partially hides other content underneath it.';
        }
        const key = [selectorFor(upper.el), selectorFor(lower.el)].sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(cand('overlap', lower.el, confidence, message, { overlap_px: [Math.round(ix.width), Math.round(ix.height)], overlap_ratio: Math.round(((ix.width * ix.height) / minArea) * 100) / 100 }, upper.el));
        if (out.length > 40) return out;
      }
    }
    // Box overlap between in-flow sibling surfaces (e.g. cards pushed over each other by negative margins).
    for (const el of els) {
      if (!isVisible(el) || !hasSurface(el).any) continue;
      const s = cs(el);
      if (s.position === 'absolute' || s.position === 'fixed' || s.position === 'sticky') continue;
      let sib = el.nextElementSibling;
      let k = 0;
      while (sib && k++ < 6) {
        if (isVisible(sib) && hasSurface(sib).any && !/(absolute|fixed|sticky)/.test(cs(sib).position)) {
          const ix = intersect(rectOf(el), rectOf(sib));
          if (ix && ix.width > 4 && ix.height > 4) {
            const key = [selectorFor(el), selectorFor(sib)].sort().join('|') + '|box';
            if (!seen.has(key)) {
              seen.add(key);
              out.push(cand('overlap', el, Math.min(0.9, 0.6 + Math.min(ix.width, ix.height) / 60), `Boxes overlap by ${Math.round(ix.width)}×${Math.round(ix.height)}px.`, { overlap_px: [Math.round(ix.width), Math.round(ix.height)], box_overlap: true }, sib));
            }
          }
        }
        sib = sib.nextElementSibling;
      }
    }
    return out;
  }

  function detectSpacing(els, opts) {
    const out = [];
    const inter = els.filter((e) => e.matches(INTERACTIVE) && isVisible(e)).slice(0, 400);
    const boxes = inter.map((el) => ({ el, r: rectOf(el) }));
    const seen = new Set();
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
        const vOverlap = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
        const hOverlap = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
        let gap = null;
        if (vOverlap > 2) gap = Math.max(a.r.left, b.r.left) - Math.min(a.r.right, b.r.right);
        else if (hOverlap > 2) gap = Math.max(a.r.top, b.r.top) - Math.min(a.r.bottom, b.r.bottom);
        if (gap === null || gap < 0 || gap >= opts.minGapPx) continue;
        // Inline links inside running text are exempt.
        if (a.el.tagName === 'A' && b.el.tagName === 'A' && a.el.parentElement === b.el.parentElement && directText(a.el.parentElement)) continue;
        // Spacing matters for undersized targets (WCAG 2.5.8); big adjacent targets are only crowded.
        const small = Math.min(a.r.width, a.r.height, b.r.width, b.r.height) < opts.minTapTargetPx;
        if (!small && gap >= 1) continue;
        const key = [selectorFor(a.el), selectorFor(b.el)].sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(cand('too-close', a.el, small ? 0.75 : 0.4, `Interactive elements only ${Math.round(gap * 10) / 10}px apart (min ${opts.minGapPx}px); easy to mis-tap.`, { gap_px: Math.round(gap * 10) / 10 }, b.el));
        if (out.length > 30) return out;
      }
    }
    // Text touching the edge of its bounded container.
    for (const el of els) {
      if (!isVisible(el) || !directText(el)) continue;
      const surf = hasSurface(el);
      if (!surf.hasBorder && !surf.hasBg) continue;
      const r = rectOf(el), tr = textRect(el);
      if (!tr) continue;
      const s = cs(el);
      const inner = { left: r.left + parseFloat(s.borderLeftWidth), right: r.right - parseFloat(s.borderRightWidth) };
      const pad = Math.min(tr.left - inner.left, inner.right - tr.right);
      if (pad >= 0 && pad < opts.edgePaddingPx && r.width > 20 && s.textAlign !== 'center') {
        out.push(cand('too-close', el, 0.45, `Text sits ${Math.round(pad * 10) / 10}px from its container edge.`, { edge_padding_px: Math.round(pad * 10) / 10 }));
      }
    }
    return out;
  }

  function detectViewportOverflow(els) {
    const out = [];
    const docW = document.documentElement.scrollWidth;
    const vw = document.documentElement.clientWidth;
    const culprits = [];
    for (const el of els) {
      if (!isVisible(el)) continue;
      if (scrollContainerOf(el)) continue;
      const r = rectOf(el);
      const s = cs(el);
      if (s.position === 'fixed' && r.right <= vw + 1) continue;
      if (r.right > vw + 1 || r.left < -1) culprits.push({ el, r });
    }
    // Keep the outermost culprits (their descendants overflow because of them).
    const outer = culprits.filter((c) => !culprits.some((o) => o !== c && o.el.contains(c.el) && o.r.right >= c.r.right - 1));
    const pageScrolls = docW > vw + 1;
    for (const c of outer.slice(0, 5)) {
      const px = Math.round(Math.max(c.r.right - vw, -c.r.left));
      const offLeft = c.r.left < -1;
      out.push(cand('viewport-overflow', c.el, pageScrolls ? Math.min(0.95, 0.7 + px / 100) : 0.55, offLeft ? `Element extends ${px}px past the left edge of the viewport (cut off).` : pageScrolls ? `Element is ${px}px wider than the viewport, causing horizontal page scroll.` : `Element extends ${px}px past the right edge (clipped by the page).`, { overflow_px: px, document_scroll_width: docW, viewport_width: vw, page_scrolls: pageScrolls }));
    }
    return out;
  }

  function detectTapTargets(els, opts) {
    const out = [];
    for (const el of els) {
      if (!el.matches(INTERACTIVE) || !isVisible(el)) continue;
      if (el.tagName === 'A' && el.parentElement && directText(el.parentElement)) continue; // inline link in text
      if (el.matches('input[type=checkbox], input[type=radio]') && el.labels && el.labels.length) continue;
      const r = rectOf(el);
      if (r.width >= opts.minTapTargetPx && r.height >= opts.minTapTargetPx) continue;
      const mobile = innerWidth <= 820;
      out.push(cand('small-tap-target', el, mobile ? 0.7 : 0.5, `Tap target is ${Math.round(r.width)}×${Math.round(r.height)}px (min ${opts.minTapTargetPx}×${opts.minTapTargetPx}).`, { width: Math.round(r.width), height: Math.round(r.height), mobile }));
    }
    return out.slice(0, 30);
  }

  function detectMisc(els) {
    const out = [];
    for (const el of els) {
      if (el.tagName === 'IMG' && el.complete && el.naturalWidth === 0 && isVisible(el)) {
        out.push(cand('broken-image', el, 0.9, `Image failed to load: ${el.currentSrc || el.src}`, { src: el.currentSrc || el.src }));
      }
    }
    return out;
  }

  // ---------- layout shift tracking ----------
  // Chromium: PerformanceObserver layout-shift entries. Only pointer input discounts a shift (a Tab keypress
  // near a timer-driven shift must not hide it). WebKit/Firefox: sample element positions for the first seconds.
  const shifts = [];
  let lastPointerAt = -1e9;
  let lastScrollAt = -1e9;
  addEventListener('pointerdown', () => (lastPointerAt = performance.now()), true);
  addEventListener('scroll', () => (lastScrollAt = performance.now()), true);
  const supportsLS = typeof PerformanceObserver !== 'undefined' && (PerformanceObserver.supportedEntryTypes || []).includes('layout-shift');
  if (supportsLS) {
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (e.hadRecentInput && e.startTime - lastPointerAt < 600) continue;
          shifts.push({
            value: Math.round(e.value * 1000) / 1000,
            at: Math.round(e.startTime),
            sources: (e.sources || []).map((s) => (s.node && s.node.nodeType === 1 ? { selector: selectorFor(s.node), text: textOf(s.node) } : null)).filter(Boolean).slice(0, 5),
          });
        }
      }).observe({ type: 'layout-shift', buffered: true });
    } catch {}
  } else {
    const SAMPLE_MS = 150, DURATION_MS = 8000;
    let prev = null;
    const snap = () => {
      const out = new Map();
      if (!document.body) return out;
      const els = document.body.querySelectorAll('h1,h2,h3,h4,p,button,a,img,li,input,label');
      let i = 0;
      for (const el of els) {
        if (i++ > 200) break;
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.top > innerHeight) continue;
        out.set(el, { top: r.top + scrollY, left: r.left + scrollX, w: r.width, h: r.height });
      }
      return out;
    };
    const tick = () => {
      const now = performance.now();
      const cur = snap();
      if (prev && now - lastPointerAt > 600 && now - lastScrollAt > 300) {
        // Chromium-style score: impact region (union of before/after boxes of moved elements, clipped to the
        // viewport) × distance fraction (largest move / largest viewport dimension).
        let maxDist = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        const moved = [];
        for (const [el, p] of cur) {
          const q = prev.get(el);
          if (!q) continue;
          const d = Math.max(Math.abs(p.top - q.top), Math.abs(p.left - q.left));
          if (d >= 10 && Math.abs(p.w - q.w) < 2) {
            moved.push(el);
            maxDist = Math.max(maxDist, d);
            for (const b of [p, q]) {
              x0 = Math.min(x0, b.left - scrollX); y0 = Math.min(y0, b.top - scrollY);
              x1 = Math.max(x1, b.left - scrollX + b.w); y1 = Math.max(y1, b.top - scrollY + b.h);
            }
          }
        }
        if (moved.length >= 2) {
          const w = Math.max(0, Math.min(innerWidth, x1) - Math.max(0, x0));
          const h = Math.max(0, Math.min(innerHeight, y1) - Math.max(0, y0));
          const value = Math.min(1, ((w * h) / (innerWidth * innerHeight)) * (maxDist / Math.max(innerWidth, innerHeight)));
          if (value > 0.001) shifts.push({ value: Math.round(value * 1000) / 1000, at: Math.round(now), sampled: true, sources: moved.slice(0, 5).map((e) => ({ selector: selectorFor(e), text: textOf(e) })) });
        }
      }
      prev = cur;
      if (now < DURATION_MS) setTimeout(tick, SAMPLE_MS);
    };
    if (document.readyState === 'loading') addEventListener('DOMContentLoaded', tick, { once: true });
    else tick();
  }

  function detectLayoutShift() {
    const sig = shifts.filter((s) => s.value >= 0.02);
    if (!sig.length) return [];
    const total = Math.round(shifts.reduce((a, s) => a + s.value, 0) * 1000) / 1000;
    const worst = sig.reduce((a, s) => (s.value > a.value ? s : a));
    const src = worst.sources[0];
    const el = src && document.querySelector(src.selector);
    const c = cand('layout-shift', el || document.body, Math.min(0.9, 0.5 + total * 2), `Layout shift of ${worst.value} at ${worst.at}ms (cumulative ${total}). Content moved without user input.`, { cls: total, worst_shift: worst.value, at_ms: worst.at, sources: worst.sources });
    return [c];
  }

  // ---------- overlay (annotations) ----------
  function clearOverlay() {
    document.querySelectorAll('[data-bugbash-overlay]').forEach((n) => n.remove());
  }
  function drawBox(bboxOrSelector, label, color = '#ff1744') {
    let r;
    if (typeof bboxOrSelector === 'string') {
      const el = document.querySelector(bboxOrSelector);
      if (!el) return false;
      const b = el.getBoundingClientRect();
      r = { x: b.x + scrollX, y: b.y + scrollY, width: b.width, height: b.height };
    } else r = bboxOrSelector;
    const d = document.createElement('div');
    d.setAttribute('data-bugbash-overlay', '');
    Object.assign(d.style, { position: 'absolute', left: r.x - 3 + 'px', top: r.y - 3 + 'px', width: r.width + 6 + 'px', height: r.height + 6 + 'px', border: `3px solid ${color}`, borderRadius: '4px', boxShadow: '0 0 0 2px rgba(255,255,255,.8)', zIndex: 2147483646, pointerEvents: 'none' });
    if (label) {
      const l = document.createElement('div');
      l.textContent = label;
      Object.assign(l.style, { position: 'absolute', left: '-3px', top: r.y > 26 ? '-26px' : 'calc(100% + 4px)', background: color, color: '#fff', font: '600 12px/1.6 system-ui, sans-serif', padding: '1px 6px', borderRadius: '3px', whiteSpace: 'nowrap', maxWidth: '90vw', overflow: 'hidden', textOverflow: 'ellipsis' });
      d.appendChild(l);
    }
    document.body.appendChild(d);
    return true;
  }
  function caption(text) {
    let c = document.querySelector('[data-bugbash-overlay="caption"]');
    if (!c) {
      c = document.createElement('div');
      c.setAttribute('data-bugbash-overlay', 'caption');
      Object.assign(c.style, { position: 'fixed', left: '8px', right: '8px', bottom: '8px', zIndex: 2147483647, background: 'rgba(17,17,17,.88)', color: '#fff', font: '600 14px/1.4 system-ui, sans-serif', padding: '8px 12px', borderRadius: '8px', pointerEvents: 'none' });
      document.body.appendChild(c);
    }
    c.textContent = text;
  }
  function ring(selector) {
    const el = selector && document.querySelector(selector);
    if (!el) return false;
    const b = el.getBoundingClientRect();
    const d = document.createElement('div');
    d.setAttribute('data-bugbash-overlay', 'ring');
    Object.assign(d.style, { position: 'absolute', left: b.x + scrollX - 6 + 'px', top: b.y + scrollY - 6 + 'px', width: b.width + 12 + 'px', height: b.height + 12 + 'px', border: '3px dashed #2979ff', borderRadius: '8px', zIndex: 2147483645, pointerEvents: 'none' });
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 900);
    return true;
  }

  // ---------- public API ----------
  function detect(opts = {}) {
    const o = Object.assign({ minGapPx: 4, minTapTargetPx: 24, edgePaddingPx: 2, only: null, scope: null }, opts);
    clearOverlay();
    const root = o.scope ? document.querySelector(o.scope) : null;
    let els = allElements();
    if (root) els = els.filter((e) => root.contains(e));
    const run = (name, fn) => (!o.only || o.only.includes(name) ? fn() : []);
    const all = [
      ...run('text-overflow', () => detectTextOverflow(els)),
      ...run('spill-out', () => detectSpillOut(els)),
      ...run('overlap', () => detectOverlap(els)),
      ...run('too-close', () => detectSpacing(els, o)),
      ...run('viewport-overflow', () => detectViewportOverflow(els)),
      ...run('small-tap-target', () => detectTapTargets(els, o)),
      ...run('broken-image', () => detectMisc(els)),
      ...run('layout-shift', () => detectLayoutShift()),
    ];
    // Dedupe by type+selector, keep highest confidence.
    const best = new Map();
    for (const c of all) {
      const k = c.type + '|' + c.selector;
      if (!best.has(k) || best.get(k).confidence < c.confidence) best.set(k, c);
    }
    return [...best.values()].sort((a, b) => b.confidence - a.confidence).slice(0, MAX_CANDIDATES);
  }

  function interactives(limit = 200) {
    const els = [...document.querySelectorAll(INTERACTIVE)].filter(isVisible).slice(0, limit);
    return els.map((el) => ({ selector: selectorFor(el), text: textOf(el), tag: el.tagName.toLowerCase(), role: el.getAttribute('role'), href: el.getAttribute('href'), type: el.getAttribute('type'), bbox: r2(rectOf(el)), signature: signatureOf(el) }));
  }

  function domHash() {
    // Structure-only hash of visible elements: tag + classes + child count (ignores text).
    let h = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let n, i = 0;
    while ((n = walker.nextNode()) && i++ < 3000) {
      if (n.hasAttribute('data-bugbash-overlay')) continue;
      const s = cs(n);
      if (s.display === 'none' || s.visibility === 'hidden') continue;
      const str = n.tagName + '.' + [...n.classList].filter((c) => !isHashy(c)).join('.') + ':' + n.childElementCount;
      for (let k = 0; k < str.length; k++) h = (h * 31 + str.charCodeAt(k)) | 0;
    }
    return (h >>> 0).toString(16);
  }

  function elementInfo(selector) {
    const el = document.querySelector(selector);
    if (!el) return null;
    return { selector: selectorFor(el), text: textOf(el), bbox: r2(rectOf(el)), signature: signatureOf(el) };
  }

  function findBySignature(signature) {
    return allElements().filter((e) => isVisible(e) && signatureOf(e) === signature).slice(0, 50).map((e) => ({ selector: selectorFor(e), text: textOf(e), bbox: r2(rectOf(e)) }));
  }

  window.__bugbash = { version: 1, detect, selectorFor, signatureOf, interactives, domHash, elementInfo, findBySignature, drawBox, caption, ring, clearOverlay, shifts, resetShifts: () => (shifts.length = 0) };
})();
