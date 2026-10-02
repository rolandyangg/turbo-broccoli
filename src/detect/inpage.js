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
    // The hidden side of a flip card (turned away, backface-visibility: hidden) isn't meant to be seen.
    if (hiddenFace(el)) return false;
    return true;
  }

  /** Cumulative 2D/3D transform of an element (translation ignored; enough to tell mirrored / turned away). */
  function cumulativeMatrix(el) {
    let M = new DOMMatrix();
    const chain = [];
    for (let p = el; p && p !== document.documentElement; p = p.parentElement) chain.unshift(p);
    for (const p of chain) {
      const t = cs(p).transform;
      if (t && t !== 'none') {
        try {
          M = M.multiply(new DOMMatrix(t));
        } catch {}
      }
    }
    return M;
  }
  /** The element (or an ancestor) that is a turned-away face with backface-visibility: hidden, if any. */
  function hiddenFace(el) {
    for (let p = el; p && p !== document.body; p = p.parentElement) {
      const s = cs(p);
      const bv = s.backfaceVisibility || s.webkitBackfaceVisibility;
      if (bv === 'hidden' && s.transform !== 'none' && cumulativeMatrix(p).m33 < 0) return p;
    }
    return null;
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
        // Truncation by design is fine when the full text is still available (title / aria-label / tooltip).
        const full = el.closest('[title], [aria-label], [data-tooltip], [data-tip]') || el.querySelector('[title]');
        if (full) out.push(cand('text-overflow', el, 0.3, `Text truncated with ellipsis/line-clamp (${px}px hidden). May be intentional.`, { overflow_px: px, truncated_by_design: true, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
        else out.push(cand('truncated-no-tooltip', el, 0.35, `Text is cut off with an ellipsis (${px}px hidden) and there is no title or tooltip to read the rest. Truncation looks intentional; a problem when the hidden part matters.`, { overflow_px: px, truncated_by_design: true, no_tooltip: true, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
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

  /**
   * Content of one section drawn over a sibling section's text: for each pair of sibling layout blocks, union the
   * rects of one block's painted descendants (skipping decorative, fixed/sticky and overlay content; clipped
   * subtrees count as their clip box) and test it against the other's text. Box-level, so it still catches
   * 3D-transformed content that the point-sampling text checks miss.
   */
  const BLOCK_SEL = 'body > *, main > *, section, article, header, footer, [role=region]';
  function contentUnion(block) {
    let box = null;
    const add = (r) => {
      if (r.width < 1 || r.height < 1) return;
      box = box ? union(box, r) : { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    };
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_ELEMENT, {
      acceptNode(el) {
        if (el.hasAttribute('data-bugbash-overlay') || el.getAttribute('aria-hidden') === 'true') return NodeFilter.FILTER_REJECT;
        const s = cs(el);
        if (s.display === 'none' || Number(s.opacity) === 0 || s.pointerEvents === 'none') return NodeFilter.FILTER_REJECT;
        if (s.position === 'fixed' || s.position === 'sticky') return NodeFilter.FILTER_REJECT;
        if (el.matches('dialog, [popover], [role=dialog], [role=alertdialog], [role=menu], [role=listbox], [role=tooltip]') || OVERLAY_RE.test(typeof el.className === 'string' ? el.className : '')) return NodeFilter.FILTER_REJECT;
        if (s.backgroundImage !== 'none' && !el.textContent.trim() && !el.querySelector('img, svg, video, canvas')) return NodeFilter.FILTER_REJECT;
        if (((s.backfaceVisibility || s.webkitBackfaceVisibility) === 'hidden') && hiddenFace(el)) return NodeFilter.FILTER_REJECT;
        if (s.visibility === 'hidden') return NodeFilter.FILTER_SKIP;
        // A clipping box hides whatever overflows it: count the box, not its children.
        if (/(hidden|clip)/.test(s.overflowX) && /(hidden|clip)/.test(s.overflowY)) {
          add(rectOf(el));
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n;
    let k = 0;
    while ((n = walker.nextNode()) && k++ < 600) add(rectOf(n));
    return box;
  }
  function detectSectionSpill(els) {
    const out = [];
    const groups = new Map();
    for (const el of els) {
      if (!el.matches(BLOCK_SEL) || !el.parentElement) continue;
      const pos = cs(el).position;
      if (pos === 'fixed' || pos === 'sticky' || !isVisible(el)) continue;
      if (!groups.has(el.parentElement)) groups.set(el.parentElement, []);
      groups.get(el.parentElement).push(el);
    }
    for (const blocks of groups.values()) {
      if (blocks.length < 2 || blocks.length > 40) continue;
      const info = blocks.map((b) => ({
        b,
        content: contentUnion(b),
        texts: [...b.querySelectorAll('*')]
          .filter((t) => directText(t).length >= 3 && isVisible(t) && !isFixedLike(t))
          .slice(0, 200)
          .map((t) => ({ t, r: textRect(t) }))
          .filter((x) => x.r),
      }));
      for (const src of info) {
        if (!src.content) continue;
        for (const dst of info) {
          if (dst === src) continue;
          let best = null;
          for (const { t, r } of dst.texts) {
            const ix = intersect(src.content, r);
            if (!ix || ix.width <= 24 || ix.height <= 24) continue;
            if (!best || ix.width * ix.height > best.ix.width * best.ix.height) best = { t, ix };
          }
          if (!best) continue;
          const { ix } = best;
          const from = sectionLabel(src.b);
          const over = sectionLabel(best.t);
          out.push(cand('spill-out', src.b, Math.min(0.9, 0.6 + Math.min(ix.width, ix.height) / 200), `Content of this section spills into the neighbouring section and over its text by ${Math.round(ix.width)}×${Math.round(ix.height)}px${from && over && from !== over ? ` ("${from}" over "${over}")` : ''}.`, { section_spill: true, overlap_px: [Math.round(ix.width), Math.round(ix.height)], overlap_area: Math.round(ix.width * ix.height), spilled_into: selectorFor(dst.b), content_section: from, text_section: over }, best.t));
          if (out.length >= 20) return out;
        }
      }
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

  /** Things that are meant to sit on top of content: menus, dialogs, popovers, tooltips, toasts, fixed/sticky bars. */
  const OVERLAY_RE = /(^|[-_\s])(modal|dialog|drawer|dropdown|menu|popover|popup|tooltip|toast|snackbar|overlay|backdrop|lightbox|sheet|flyout)([-_\s]|$)/i;
  function isOverlayLike(el) {
    for (let p = el; p && p !== document.body; p = p.parentElement) {
      if (p.matches('dialog, [popover], [role=dialog], [role=alertdialog], [role=menu], [role=listbox], [role=tooltip], [aria-modal=true]')) return true;
      const pos = cs(p).position;
      if (pos === 'fixed' || pos === 'sticky') return true;
      if (OVERLAY_RE.test(typeof p.className === 'string' ? p.className : '')) return true;
    }
    return false;
  }
  /** Does `el` (or a non-transparent ancestor up to `stopAt`) actually paint pixels at a point? */
  function paints(el, stopAt) {
    for (let p = el; p && p !== document.body && !(stopAt && p.contains(stopAt)); p = p.parentElement) {
      if (/^(IMG|SVG|svg|CANVAS|VIDEO|PICTURE|INPUT|TEXTAREA|SELECT|BUTTON)$/.test(p.tagName) || directText(p) || isOpaqueBg(p)) return p;
      const s = cs(p);
      if (s.backgroundImage && s.backgroundImage !== 'none') return p;
    }
    return null;
  }
  /** "What we do"-style label for the section an element lives in (its nearest heading). */
  function sectionLabel(el) {
    for (let p = el; p && p !== document.body; p = p.parentElement) {
      const h = p.querySelector && p.querySelector('h1, h2, h3');
      if (h && h.textContent.trim()) return h.textContent.trim().slice(0, 40);
    }
    return null;
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
          // Only real overlays (menus, dialogs, popovers, fixed bars) may cover content. A card or panel drawn over
          // text from elsewhere is a collision, however big it is.
          if (!isControl && (isOverlayLike(cover) || /menu|listbox|dialog|tooltip/.test(role))) continue;
          const big = ratio > 2.5;
          confidence = isControl ? 0.75 : big ? 0.8 : 0.7;
          message = isControl ? 'A control is drawn on top of other content, hiding part of it.' : big ? `A card/panel is drawn over other content, hiding it${sectionLabel(lower.el) && sectionLabel(lower.el) !== sectionLabel(upper.el) ? ` (covers "${sectionLabel(lower.el)}")` : ''}.` : 'Element partially hides other content underneath it.';
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
    // On a real (emulated) phone, mobile browsers widen the layout viewport to fit overflowing content and
    // zoom the page out, so clientWidth grows with the bug. Compare against the device screen instead.
    const client = document.documentElement.clientWidth;
    const touch = navigator.maxTouchPoints > 0 || matchMedia('(pointer: coarse)').matches;
    const zoomedOut = touch && screen.width > 0 && client > screen.width + 1;
    const vw = zoomedOut ? screen.width : client;
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
    const pageScrolls = docW > vw + 1 || zoomedOut;
    for (const c of outer.slice(0, 5)) {
      const px = Math.round(Math.max(c.r.right - vw, -c.r.left));
      const offLeft = c.r.left < -1;
      const msg = offLeft
        ? `Element extends ${px}px past the left edge of the viewport (cut off).`
        : zoomedOut
          ? `Element is ${px}px wider than the ${vw}px phone screen: the browser widens the page to ${client}px and shows it zoomed out (or sideways-scrolling).`
          : pageScrolls
            ? `Element is ${px}px wider than the viewport, causing horizontal page scroll.`
            : `Element extends ${px}px past the right edge (clipped by the page).`;
      out.push(cand('viewport-overflow', c.el, pageScrolls ? Math.min(0.95, 0.7 + px / 100) : 0.55, msg, { overflow_px: px, document_scroll_width: docW, viewport_width: vw, layout_viewport_width: client, zoomed_out: zoomedOut, page_scrolls: pageScrolls }));
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

  // ---------- text hidden under other content ----------
  /**
   * For each block of text in view, sample points across it and ask the browser what is painted on top there.
   * Text covered by another section's content (cards, images, panels) is a collision even when no detector of
   * individual boxes sees it. Real overlays (menus, dialogs, fixed bars) are excused.
   */
  function detectOccludedText(els) {
    const out = [];
    const texts = els.filter((el) => directText(el).length >= 12).slice(0, 700);
    for (const el of texts) {
      if (!isVisible(el)) continue;
      const tr = textRect(el);
      if (!tr || tr.width < 20 || tr.height < 8) continue;
      if (tr.bottom < 0 || tr.top > innerHeight || tr.right < 0 || tr.left > innerWidth) continue;
      const pts = [];
      for (const fx of [0.12, 0.38, 0.62, 0.88]) for (const fy of [0.25, 0.75]) pts.push([tr.left + tr.width * fx, tr.top + tr.height * fy]);
      let inView = 0;
      let covered = 0;
      let by = null;
      for (const [x, y] of pts) {
        if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
        inView++;
        const top = document.elementFromPoint(x, y);
        if (!top || el.contains(top) || top.contains(el) || top.closest('[data-bugbash-overlay]')) continue;
        if (isOverlayLike(top)) continue;
        if (Number(cs(top).opacity) < 0.15) continue;
        const painter = paints(top, el);
        if (!painter) continue; // a transparent wrapper: nothing is drawn over the text
        covered++;
        by = by || painter;
      }
      if (inView < 3 || covered < 2 || !by) continue;
      const share = covered / inView;
      const from = sectionLabel(el);
      const over = sectionLabel(by);
      out.push(cand('overlap', el, Math.min(0.92, 0.55 + share * 0.4), `Text is hidden under other content: ${Math.round(share * 100)}% of it is covered by ${by.tagName.toLowerCase()}${by.className && typeof by.className === 'string' ? '.' + by.className.split(/\s+/)[0] : ''}${from && over && from !== over ? ` (from "${over}", over "${from}")` : ''}.`, { occluded_share: Math.round(share * 100) / 100, occluded_by: selectorFor(by), text_section: from, covering_section: over }, by));
    }
    return out.slice(0, 30);
  }

  /** Background that hides what is under it: an image, or a colour with alpha > 0.9. */
  function solidBg(el) {
    const s = cs(el);
    if (s.backgroundImage && s.backgroundImage !== 'none') return true;
    const m = s.backgroundColor.match(/rgba?\(([^)]+)\)/);
    if (!m) return false;
    const parts = m[1].split(',').map((x) => parseFloat(x));
    return parts.length < 4 || parts[3] > 0.9;
  }
  /**
   * What hides text at (x, y), or null: the topmost painted element when it is not the text's element (or an
   * ancestor/descendant), is opaque (solid background, opacity > 0.9) and is not overlay chrome. Resolved to the
   * nearest positioned or transformed ancestor; inside a 3D context (preserve-3d) to the closest flat ancestor,
   * whose bounding rect must contain the point (3D faces' own rects / hit tests differ between engines).
   */
  function opaqueCoverAt(x, y, el) {
    const top = document.elementsFromPoint(x, y).find((e) => !e.closest('[data-bugbash-overlay]') && !hiddenFace(e));
    if (!top || el.contains(top) || top.contains(el)) return null;
    if (isOverlayLike(top)) return null;
    let opacity = 1;
    let solid = false;
    let owner = null;
    let flat = null;
    for (let p = top; p && p !== document.body && !p.contains(el); p = p.parentElement) {
      const s = cs(p);
      opacity *= Number(s.opacity);
      solid = solid || solidBg(p);
      if (!owner && (s.position !== 'static' || s.transform !== 'none')) owner = p;
      if (s.transformStyle === 'preserve-3d') flat = p.parentElement;
      else if (flat) break;
    }
    if (opacity <= 0.9 || !solid) return null;
    if (flat && !flat.contains(el) && flat !== document.body) {
      const r = rectOf(flat);
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) return null;
      return flat;
    }
    return owner || top;
  }

  /**
   * Text lines hidden under an opaque element: for each text block, sample points along each rendered line and
   * count the line hidden when most samples are covered. Flags blocks with 30%+ of their in-view lines hidden.
   * Complements detectOccludedText (which samples the whole block's box) with a line-by-line, opaque-only check.
   */
  function detectHiddenTextLines(els) {
    const out = [];
    const range = document.createRange();
    const texts = els.filter((el) => directText(el).length >= 12).slice(0, 700);
    for (const el of texts) {
      if (out.length >= 30) break;
      if (!isVisible(el)) continue;
      const lines = [];
      for (const n of el.childNodes) {
        if (n.nodeType !== 3 || !n.textContent.trim()) continue;
        range.selectNodeContents(n);
        for (const r of range.getClientRects()) {
          if (r.width < 4 || r.height < 4) continue;
          const line = lines.find((l) => Math.abs(l.top - r.top) < r.height / 2);
          if (line) Object.assign(line, { left: Math.min(line.left, r.left), right: Math.max(line.right, r.right) });
          else lines.push({ top: r.top, bottom: r.bottom, left: r.left, right: r.right });
        }
      }
      let inView = 0;
      let hidden = 0;
      let by = null;
      for (const l of lines) {
        const y = (l.top + l.bottom) / 2;
        if (y < 0 || y >= innerHeight) continue;
        const xs = [0.1, 0.3, 0.5, 0.7, 0.9].map((f) => l.left + (l.right - l.left) * f).filter((x) => x >= 0 && x < innerWidth);
        if (xs.length < 3) continue;
        inView++;
        let hits = 0;
        let lineBy = null;
        for (const x of xs) {
          const cover = opaqueCoverAt(x, y, el);
          if (!cover) continue;
          hits++;
          lineBy = lineBy || cover;
        }
        if (hits * 2 > xs.length) {
          hidden++;
          by = by || lineBy;
        }
      }
      if (!inView || !hidden || !by) continue;
      const share = hidden / inView;
      if (share < 0.3) continue;
      const pct = Math.round(share * 100);
      const from = sectionLabel(el);
      const over = sectionLabel(by);
      out.push(cand('overlap', el, Math.min(0.95, 0.7 + share * 0.25), `Text is hidden under an opaque ${by.tagName.toLowerCase()}${by.className && typeof by.className === 'string' ? '.' + by.className.split(/\s+/)[0] : ''}: ${pct}% of its lines (${hidden}/${inView}) are covered${from && over && from !== over ? ` (from "${over}", over "${from}")` : ''}.`, { hidden_line_share: Math.round(share * 100) / 100, hidden_lines: hidden, lines_in_view: inView, occluded_by: selectorFor(by), opaque_cover: true, text_section: from, covering_section: over }, by));
    }
    return out;
  }

  /** Turned-away faces (backface-visibility: hidden) in view: candidates for the painted-back-face check. */
  function flipFaces() {
    const out = [];
    for (const el of allElements()) {
      if (out.length >= 8) break;
      const s = cs(el);
      const bv = s.backfaceVisibility || s.webkitBackfaceVisibility;
      if (bv !== 'hidden' || s.transform === 'none' || !directTextDeep(el)) continue;
      if (cumulativeMatrix(el).m33 >= 0) continue;
      const r = rectOf(el);
      if (r.width < 20 || r.height < 20 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
      out.push({ selector: selectorFor(el), text: textOf(el), bbox: { x: Math.max(0, r.x), y: Math.max(0, r.y), width: Math.min(r.width, innerWidth - Math.max(0, r.x)), height: Math.min(r.height, innerHeight - Math.max(0, r.y)) }, signature: signatureOf(el), page_bbox: r2(r) });
    }
    return out;
  }
  const directTextDeep = (el) => (el.textContent || '').trim().length > 3;

  /**
   * Flip cards (transform-style: preserve-3d) read from computed styles, no screenshot: a face with text that is
   * turned so it reads mirrored (negative determinant) without backface-visibility: hidden, or two faces with text
   * both showing in the same spot (e.g. the card is mid-flip or the back was never rotated away).
   */
  function detectFlipCards(els) {
    const out = [];
    for (const card of els) {
      if (out.length >= 10) break;
      if (cs(card).transformStyle !== 'preserve-3d') continue;
      const faces = [...card.children].filter((f) => directTextDeep(f) && isVisible(f));
      const shown = [];
      for (const f of faces) {
        const s = cs(f);
        const bv = s.backfaceVisibility || s.webkitBackfaceVisibility;
        const m = cumulativeMatrix(f);
        const det = m.a * m.d - m.b * m.c;
        if (det < -0.05 && bv !== 'hidden') {
          out.push(cand('broken-state', f, 0.75, `Flip-card face shows its text mirrored: it is turned away (transform ${s.transform}) but backface-visibility isn't hidden, so its back is painted (common in Safari: set -webkit-backface-visibility: hidden).`, { mirrored_face: true, determinant: Math.round(det * 100) / 100, backface_visibility: bv || 'visible' }, card));
          continue;
        }
        shown.push(f);
      }
      for (let i = 0; i < shown.length; i++) {
        for (let j = i + 1; j < shown.length; j++) {
          const a = rectOf(shown[i]);
          const b = rectOf(shown[j]);
          const ix = intersect(a, b);
          if (!ix || ix.width * ix.height < 0.5 * Math.min(a.width * a.height, b.width * b.height)) continue;
          out.push(cand('broken-state', card, 0.7, `Both faces of this flip card are showing in the same spot, so their text is drawn on top of each other (the back face isn't turned away or hidden with backface-visibility: hidden).`, { both_faces_visible: true, faces: [selectorFor(shown[i]), selectorFor(shown[j])] }, shown[j]));
        }
      }
    }
    return out;
  }

  // ---------- focus & keyboard ----------
  const FOCUS_TYPES = ['focus-invisible', 'focus-obscured', 'focus-escape'];
  const OPEN_OVERLAY = 'dialog[open], [role=dialog], [role=alertdialog], [aria-modal=true], [role=menu], [role=listbox], [popover]';
  const isFixedLike = (el) => {
    for (let p = el; p && p !== document.documentElement; p = p.parentElement) {
      const pos = cs(p).position;
      if (pos === 'fixed' || pos === 'sticky') return p;
    }
    return null;
  };
  const FOCUS_PROPS = ['outlineStyle', 'outlineWidth', 'outlineColor', 'boxShadow', 'borderTopColor', 'borderBottomColor', 'borderBottomWidth', 'backgroundColor', 'color', 'textDecorationLine', 'transform'];
  const focusStyle = (el) => {
    const s = cs(el);
    const o = {};
    for (const p of FOCUS_PROPS) o[p] = s[p];
    // A focus ring is often drawn by a pseudo-element or a wrapping element.
    for (const pseudo of ['::before', '::after']) {
      const ps = getComputedStyle(el, pseudo);
      o[pseudo] = ps.content === 'none' ? '' : [ps.content, ps.opacity, ps.borderTopColor, ps.boxShadow, ps.outlineStyle, ps.backgroundColor].join('|');
    }
    if (el.parentElement) o.parent = [cs(el.parentElement).boxShadow, cs(el.parentElement).outlineStyle, cs(el.parentElement).borderTopColor].join('|');
    return o;
  };
  const visibleOverlay = () => [...document.querySelectorAll(OPEN_OVERLAY)].filter((d) => isVisible(d) && (d.matches('dialog[open], [aria-modal=true], [role=dialog], [role=alertdialog]') || (d.matches('[popover]') && d.matches(':popover-open'))));

  /** Checks the currently focused element: visible indicator, not hidden under fixed/sticky bars, not outside an open modal. */
  function detectFocus() {
    const el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement || !isVisible(el)) return [];
    const out = [];
    // Transitions would make the blurred read-back still show the focused values: switch them off while measuring.
    const noAnim = document.createElement('style');
    noAnim.setAttribute('data-bugbash-overlay', 'style');
    noAnim.textContent = '*, *::before, *::after { transition: none !important; }';
    document.head.appendChild(noAnim);
    const focused = focusStyle(el);
    // Compare against the unfocused look, then restore focus (programmatic refocus keeps :focus-visible after keyboard focus).
    // Swallow the focus events at window capture so the page's own blur/focus handlers (e.g. close-on-blur menus) don't run.
    const swallow = (e) => e.stopImmediatePropagation();
    const EVENTS = ['blur', 'focusout', 'focus', 'focusin'];
    for (const t of EVENTS) addEventListener(t, swallow, true);
    let blurred;
    try {
      el.blur();
      blurred = focusStyle(el);
      el.focus({ preventScroll: true });
    } finally {
      for (const t of EVENTS) removeEventListener(t, swallow, true);
      noAnim.remove();
    }
    const changed = Object.keys(focused).filter((k) => focused[k] !== blurred[k] && !(k === 'outlineColor' && focused.outlineStyle === 'none'));
    if (!changed.length) out.push(cand('focus-invisible', el, 0.75, 'Keyboard focus has no visible indicator: no outline, ring, border, colour or underline change when focused.', { compared: FOCUS_PROPS }));
    // Obscured: the element's centre and top are covered by a fixed/sticky element that isn't its ancestor.
    const r = rectOf(el);
    const pts = [
      [r.left + r.width / 2, r.top + r.height / 2],
      [r.left + r.width / 2, r.top + Math.min(4, r.height / 2)],
    ].filter(([x, y]) => x >= 0 && y >= 0 && x < innerWidth && y < innerHeight);
    if (r.bottom < 0 || r.top > innerHeight) out.push(cand('focus-obscured', el, 0.6, 'Focused element is scrolled out of the viewport.', { top: Math.round(r.top) }));
    else if (pts.length) {
      const covers = pts.map(([x, y]) => document.elementFromPoint(x, y)).filter((t) => t && t !== el && !el.contains(t) && !t.contains(el) && !t.closest('[data-bugbash-overlay]'));
      const bar = covers.length === pts.length && isFixedLike(covers[0]);
      if (bar) out.push(cand('focus-obscured', el, 0.8, `Focused element is hidden behind a ${cs(bar).position} element.`, { by: selectorFor(bar) }, bar));
    }
    const modal = visibleOverlay().find((d) => d.matches('dialog[open]:modal, [aria-modal=true], dialog[open]'));
    if (modal && !modal.contains(el) && !el.closest(OPEN_OVERLAY)) out.push(cand('focus-escape', el, 0.75, 'Focus moved outside the open dialog: keyboard users end up behind the overlay.', { dialog: selectorFor(modal) }, modal));
    return out;
  }

  // ---------- overlays that don't fit ----------
  const scrollsY = (el) => /(auto|scroll)/.test(cs(el).overflowY) && el.scrollHeight > el.clientHeight + 1;
  function detectOverlays(els) {
    const out = [];
    const overlays = [...document.querySelectorAll(OPEN_OVERLAY + ', [class*=modal i], [class*=dropdown i], [class*=popover i], [class*=menu i]')].filter((el) => isVisible(el) && cs(el).position !== 'static');
    // Full-screen position:fixed menus (e.g. opened by a hamburger) whatever their role or class name.
    const covers = (el) => {
      const r = rectOf(el);
      return Math.min(r.right, innerWidth) - Math.max(r.left, 0) >= innerWidth * 0.9 && Math.min(r.bottom, innerHeight) - Math.max(r.top, 0) >= innerHeight * 0.9;
    };
    const sheets = els.filter((el) => cs(el).position === 'fixed' && isVisible(el) && covers(el) && el.querySelector(INTERACTIVE));
    const reported = new Set();
    for (const el of sheets) {
      if (sheets.some((o) => o !== el && o.contains(el))) continue;
      const s = cs(el);
      const canScroll = scrollsY(el) || [...el.querySelectorAll('*')].some((c) => scrollsY(c) && rectOf(c).height > 40);
      const clipped = el.scrollHeight > el.clientHeight + 1 && !/(auto|scroll)/.test(s.overflowY);
      const below = canScroll ? [] : [...el.querySelectorAll(INTERACTIVE)].filter((c) => isVisible(c) && rectOf(c).bottom > innerHeight + 2);
      if (clipped || below.length) {
        reported.add(el);
        const why = clipped ? `its content is ${el.scrollHeight - el.clientHeight}px taller than the box and overflow-y is ${s.overflowY}` : `${below.length} item(s) end below the bottom of the screen and it doesn't scroll`;
        out.push(cand('overlay-overflow', el, 0.85, `Full-screen menu/overlay doesn't fit the ${innerWidth}×${innerHeight} viewport: ${why}, so part of it can't be reached.`, { fixed: true, internal_scroll: canScroll, overflow_y: s.overflowY, scroll_height: el.scrollHeight, client_height: el.clientHeight, links_below: below.slice(0, 3).map(selectorFor), viewport: [innerWidth, innerHeight] }, below[0] || null));
      }
      // Body scroll not locked: swipes/wheel on the menu move the page behind it.
      const page = document.scrollingElement || document.documentElement;
      const locked = [document.documentElement, document.body].some((p) => /(hidden|clip)/.test(cs(p).overflowY)) || cs(document.body).position === 'fixed';
      if (page.scrollHeight > innerHeight + 40 && !locked)
        out.push(cand('scroll-trap', el, 0.6, `Page scrolling isn't locked while this full-screen menu/overlay is open: scrolling over it moves the page behind instead.`, { body_scroll_locked: false, page_height: page.scrollHeight, viewport: [innerWidth, innerHeight] }));
    }
    for (const el of overlays) {
      if (reported.has(el)) continue;
      if (overlays.some((o) => o !== el && o.contains(el))) continue; // report the outermost box
      const r = rectOf(el);
      if (r.width < 40 || r.height < 40) continue;
      const fixed = !!isFixedLike(el);
      const offX = Math.max(0, -r.left, r.right - innerWidth);
      // A position:absolute box that runs off the bottom can be reached by scrolling the page; a fixed one can't.
      const offY = fixed ? Math.max(0, -r.top, r.bottom - innerHeight) : Math.max(0, -(r.top + scrollY));
      if (offX <= 2 && offY <= 2) continue;
      const canScroll = scrollsY(el) || [...el.querySelectorAll('*')].some((c) => scrollsY(c) && rectOf(c).height > 40);
      if (offY > 2 && !offX && canScroll && r.top >= 0 && r.bottom <= innerHeight + 2) continue;
      const off = offX > 2 ? `${Math.round(offX)}px off-screen horizontally` : `${Math.round(offY)}px off-screen vertically`;
      out.push(cand('overlay-overflow', el, offY > 2 && fixed && !canScroll ? 0.85 : 0.7, `Overlay doesn't fit the ${innerWidth}×${innerHeight} viewport: ${off}${canScroll ? '' : ' and it has no internal scroll'}, so part of it can't be reached.`, { off_x_px: Math.round(offX), off_y_px: Math.round(offY), fixed, internal_scroll: canScroll, viewport: [innerWidth, innerHeight] }));
    }
    // An anchor target (#hash) hidden behind a fixed/sticky header.
    if (location.hash.length > 1) {
      let target = null;
      try {
        target = document.getElementById(decodeURIComponent(location.hash.slice(1))) || document.querySelector(`[name="${CSS.escape(location.hash.slice(1))}"]`);
      } catch {}
      if (target && isVisible(target)) {
        const r = rectOf(target);
        const x = Math.min(innerWidth - 1, Math.max(0, r.left + Math.min(20, r.width / 2)));
        const y = Math.max(0, r.top + Math.min(6, r.height / 2));
        const top = y < innerHeight ? document.elementFromPoint(x, y) : null;
        const bar = top && !target.contains(top) && !top.contains(target) && isFixedLike(top);
        if (bar && bar !== target) out.push(cand('hidden-by-sticky', target, 0.75, `Anchor target #${location.hash.slice(1)} is hidden under a ${cs(bar).position} header after jumping to it (add scroll-margin-top).`, { by: selectorFor(bar) }, bar));
      }
    }
    return out;
  }

  // ---------- touch-only problems ----------
  const isTouch = () => matchMedia('(hover: none)').matches || matchMedia('(pointer: coarse)').matches;
  function hoverRules() {
    const rules = [];
    const walk = (list) => {
      for (const r of list) {
        if (r.cssRules && !r.selectorText) walk(r.cssRules);
        else if (r.selectorText && r.selectorText.includes(':hover') && r.style) rules.push(r);
      }
    };
    for (const sh of document.styleSheets) {
      try {
        walk(sh.cssRules);
      } catch {} // cross-origin sheet
    }
    return rules;
  }
  function detectTouch(els) {
    if (!isTouch()) return [];
    const out = [];
    // Content only revealed by `X:hover Y { display/visibility/opacity }` with no :focus-within / open-state alternative.
    const rules = hoverRules();
    const allSel = rules.map((r) => r.selectorText).join(' ');
    const seen = new Set();
    for (const r of rules) {
      const reveals = (r.style.display && r.style.display !== 'none') || r.style.visibility === 'visible' || (r.style.opacity && Number(r.style.opacity) > 0) || r.style.maxHeight || r.style.transform;
      if (!reveals) continue;
      for (const part of r.selectorText.split(',')) {
        const m = part.trim().match(/^(.*?):hover\s*([>+~]?\s*.+)$/);
        if (!m || !m[2].trim()) continue;
        const host = m[1].trim() || '*';
        let hosts = [];
        try {
          hosts = [...document.querySelectorAll(host)].filter(isVisible).slice(0, 5);
        } catch {
          continue;
        }
        const alt = /focus-within|:focus|\.open|\.is-open|\.active|\[aria-expanded/.test(allSel) && new RegExp(host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(:focus|\\.open|\\.is-open|\\.active|\\[aria-expanded)').test(allSel);
        let hostSheetAlt = false;
        for (const sh of document.styleSheets) {
          try {
            for (const rr of sh.cssRules) if (rr.selectorText && rr.selectorText.includes(host) && /focus-within|\.open|\.is-open|\.active|aria-expanded/.test(rr.selectorText)) hostSheetAlt = true;
          } catch {}
        }
        if (alt || hostSheetAlt) continue;
        for (const h of hosts) {
          let hidden = [];
          try {
            hidden = [...h.querySelectorAll(m[2].replace(/^[>+~]\s*/, ''))].filter((c) => { const s = cs(c); return s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0; });
          } catch {}
          if (!hidden.length || seen.has(h)) continue;
          seen.add(h);
          const clickable = h.matches(INTERACTIVE + ', [aria-haspopup], [aria-expanded]') || [...h.querySelectorAll(INTERACTIVE + ', [aria-haspopup], [aria-expanded]')].some((c) => isVisible(c) && !hidden.some((x) => x.contains(c)));
          out.push(cand('hover-only', h, clickable ? 0.5 : 0.65, `Content inside this element is only revealed on :hover (${r.selectorText.slice(0, 80)}); touch screens can't hover, so it may be unreachable.`, { rule: r.selectorText.slice(0, 160), hidden: hidden.slice(0, 3).map(selectorFor) }));
        }
      }
    }
    // Overlapping tap targets.
    const targets = els.filter((el) => el.matches(INTERACTIVE) && isVisible(el)).slice(0, 300);
    const rects = targets.map(rectOf);
    const pairs = new Set();
    for (let i = 0; i < targets.length; i++)
      for (let j = i + 1; j < targets.length; j++) {
        const a = targets[i], b = targets[j];
        if (a.contains(b) || b.contains(a)) continue;
        const ix = intersect(rects[i], rects[j]);
        if (!ix) continue;
        const area = ix.width * ix.height;
        const minArea = Math.min(rects[i].width * rects[i].height, rects[j].width * rects[j].height);
        if (area < 16 || area / minArea < 0.15) continue;
        const k = selectorFor(a) + '|' + selectorFor(b);
        if (pairs.has(k)) continue;
        pairs.add(k);
        out.push(cand('overlap', a, 0.7, `Tap targets overlap (${Math.round((area / minArea) * 100)}% of the smaller one): a tap may hit the wrong control.`, { tap_overlap: true, overlap_px: Math.round(area) }, b));
      }
    // Near-full-screen scroll containers that swallow vertical swipes.
    const pageScrolls = (document.scrollingElement || document.documentElement).scrollHeight > innerHeight + 40;
    if (pageScrolls)
      for (const el of els) {
        if (el === document.body || el === document.documentElement || !scrollsY(el) || !isVisible(el)) continue;
        const r = rectOf(el);
        if (r.height < innerHeight * 0.85 || r.width < innerWidth * 0.9) continue;
        if (isFixedLike(el)) continue; // full-screen sheets are handled as overlays
        out.push(cand('scroll-trap', el, 0.55, `A ${Math.round(r.width)}×${Math.round(r.height)}px inner scroll area fills the screen: swipes scroll it instead of the page, so content after it is hard to reach on touch.`, { height: Math.round(r.height), viewport: [innerWidth, innerHeight] }));
      }
    return out.slice(0, 30);
  }

  // ---------- visual polish ----------
  function parseColor(c) {
    const m = c && c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
  const lum = ({ r, g, b }) => {
    const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const contrast = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  /** Effective background behind el, or null when an image/gradient makes it unknowable. */
  function backgroundOf(el) {
    const layers = [];
    for (let p = el; p; p = p.parentElement) {
      const s = cs(p);
      if (s.backgroundImage && s.backgroundImage !== 'none') return null;
      const c = parseColor(s.backgroundColor);
      if (c && c.a > 0) {
        layers.push(c);
        if (c.a >= 1) break;
      }
    }
    let bg = { r: 255, g: 255, b: 255, a: 1 };
    for (const l of layers.reverse()) bg = over(l, bg);
    return bg;
  }
  function detectPolish(els) {
    const out = [];
    // Low contrast text (WCAG AA): 4.5:1, or 3:1 for large text.
    const pairs = new Map();
    for (const el of els) {
      if (out.length >= 25) break;
      if (!directText(el) || !isVisible(el)) continue;
      if (el.closest('[disabled], [aria-disabled=true], [aria-hidden=true]') || el.matches('option')) continue;
      const s = cs(el);
      const fg = parseColor(s.color);
      const bg = backgroundOf(el);
      if (!fg || !bg) continue;
      let op = 1;
      for (let p = el; p; p = p.parentElement) op *= Number(cs(p).opacity);
      const ratio = contrast(over({ ...fg, a: fg.a * op }, bg), bg);
      const size = parseFloat(s.fontSize);
      const large = size >= 24 || (size >= 18.66 && Number(s.fontWeight) >= 700);
      const need = large ? 3 : 4.5;
      if (ratio >= need) continue;
      const k = s.color + '|' + JSON.stringify(bg) + '|' + large;
      const n = (pairs.get(k) || 0) + 1;
      pairs.set(k, n);
      if (n > 3) continue; // same colour pair: report a few instances
      out.push(cand('low-contrast', el, ratio < need * 0.67 ? 0.8 : 0.6, `Text contrast ${ratio.toFixed(2)}:1 is below WCAG AA ${need}:1 (${s.color} on rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)})).`, { ratio: Math.round(ratio * 100) / 100, required: need, color: s.color, background: `rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)})`, font_px: size }));
    }
    // Stretched / squashed images.
    for (const el of els) {
      if (el.tagName !== 'IMG' || !el.complete || !el.naturalWidth || !isVisible(el)) continue;
      const s = cs(el);
      if (s.objectFit !== 'fill') continue;
      const r = rectOf(el);
      if (r.width < 24 || r.height < 24) continue;
      const nat = el.naturalWidth / el.naturalHeight;
      const shown = r.width / r.height;
      const skew = Math.abs(shown / nat - 1);
      if (skew < 0.06) continue;
      out.push(cand('distorted-image', el, Math.min(0.9, 0.55 + skew), `Image is ${shown > nat ? 'stretched' : 'squashed'}: shown at ${Math.round(r.width)}×${Math.round(r.height)} (ratio ${shown.toFixed(2)}) but the image is ${el.naturalWidth}×${el.naturalHeight} (ratio ${nat.toFixed(2)}). Use object-fit or keep the aspect ratio.`, { natural: [el.naturalWidth, el.naturalHeight], rendered: [Math.round(r.width), Math.round(r.height)], skew: Math.round(skew * 100) / 100 }));
    }
    // Misaligned items in a row: equal-height siblings in a flex row / grid row whose tops are off by 1-6px.
    const parents = new Set(els.filter((e) => { const d = cs(e).display; return (d.includes('flex') && !cs(e).flexDirection.startsWith('column')) || d.includes('grid'); }));
    for (const p of parents) {
      const kids = [...p.children].filter(isVisible).filter((k) => !['absolute', 'fixed'].includes(cs(k).position));
      if (kids.length < 3) continue;
      const rows = new Map();
      for (const k of kids) {
        const r = rectOf(k);
        const key = Math.round(r.top / 12);
        const row = rows.get(key) || rows.get(key - 1) || rows.get(key + 1) || [];
        if (!row.length) rows.set(key, row);
        row.push({ k, r });
      }
      for (const row of rows.values()) {
        if (row.length < 3) continue;
        const h = row.map((x) => Math.round(x.r.height));
        if (Math.max(...h) - Math.min(...h) > 2) continue;
        const tops = row.map((x) => Math.round(x.r.top));
        const mode = tops.sort((a, b) => tops.filter((v) => v === b).length - tops.filter((v) => v === a).length)[0];
        for (const x of row) {
          const d = Math.abs(Math.round(x.r.top) - mode);
          if (d >= 1 && d <= 6) out.push(cand('misalignment', x.k, 0.5, `Item sits ${d}px ${x.r.top > mode ? 'lower' : 'higher'} than its ${row.length - 1} same-height siblings in the row.`, { offset_px: d, row_size: row.length }, p));
        }
      }
    }
    return out;
  }

  // ---------- primary content landmarks ----------
  // Not a detect() check: the viewport sweep compares these across widths (missingLandmarks in detect/index.ts).
  const CTA = 'a.button, a[href*=apply]';
  /** Why a landmark can't be seen (absent, zero-size, display:none, visibility:hidden, opacity 0, off-screen), or null. */
  function landmarkHidden(el) {
    if (!el) return 'absent';
    for (let p = el; p && p !== document.documentElement; p = p.parentElement) {
      const s = cs(p);
      if (s.display === 'none') return 'display:none';
      if (Number(s.opacity) === 0) return 'opacity 0';
    }
    if (cs(el).visibility === 'hidden' || cs(el).visibility === 'collapse') return 'visibility:hidden';
    const r = rectOf(el);
    if (r.width < 1 || r.height < 1) return 'zero size';
    if (r.right <= 0 || r.left >= innerWidth || r.bottom + scrollY <= 0) return 'outside the viewport';
    return null;
  }
  /** The first h1, the primary CTA and the hero form, each with the reason it is hidden (null when shown). */
  function landmarks() {
    const h1 = document.querySelector('h1');
    const hero = document.querySelector('[class*=hero i]') || (h1 && h1.closest('section, header, main'));
    const items = [
      ['h1', 'Main heading (h1)', h1],
      ['cta', 'Primary call-to-action', (hero && hero.querySelector(CTA)) || document.querySelector(CTA)],
      ['form', 'Hero form', hero ? hero.querySelector('form') : null],
    ];
    return items.map(([key, label, el]) => ({ key, label, hidden: landmarkHidden(el), selector: el ? selectorFor(el) : null, text: el ? textOf(el) : '', bbox: el ? r2(rectOf(el)) : { x: 0, y: 0, width: 0, height: 0 }, signature: el ? signatureOf(el) : '' }));
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
      ...run('spill-out', () => detectSectionSpill(els)),
      ...run('overlap', () => detectOverlap(els)),
      ...run('too-close', () => detectSpacing(els, o)),
      ...run('viewport-overflow', () => detectViewportOverflow(els)),
      ...run('small-tap-target', () => detectTapTargets(els, o)),
      ...run('broken-image', () => detectMisc(els)),
      ...run('layout-shift', () => detectLayoutShift()),
      ...run('overlap', () => detectOccludedText(els)),
      ...run('overlap', () => detectHiddenTextLines(els)),
      ...run('broken-state', () => detectFlipCards(els)),
      ...(!o.only || o.only.some((t) => FOCUS_TYPES.includes(t)) ? detectFocus().filter((c) => !o.only || o.only.includes(c.type)) : []),
      ...(!o.only || o.only.some((t) => ['overlay-overflow', 'hidden-by-sticky', 'scroll-trap'].includes(t)) ? detectOverlays(els).filter((c) => !o.only || o.only.includes(c.type)) : []),
      ...(!o.only || o.only.some((t) => ['hover-only', 'overlap', 'scroll-trap'].includes(t)) ? detectTouch(els).filter((c) => !o.only || o.only.includes(c.type)) : []),
      ...(!o.only || o.only.some((t) => ['low-contrast', 'distorted-image', 'misalignment'].includes(t)) ? detectPolish(els).filter((c) => !o.only || o.only.includes(c.type)) : []),
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

  window.__bugbash = { version: 1, detect, detectFocus, flipFaces, landmarks, selectorFor, signatureOf, interactives, domHash, elementInfo, findBySignature, drawBox, caption, ring, clearOverlay, shifts, resetShifts: () => (shifts.length = 0) };
})();
