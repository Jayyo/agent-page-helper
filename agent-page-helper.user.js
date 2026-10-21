// ==UserScript==
// @name         Agent Page Helper
// @namespace    https://github.com/Jayyo/agent-page-helper
// @version      0.1.0
// @description  Page-side snapshots and DOM actions for LLM browser agents: compact element lists with refs, controlled-input fill, occlusion checks, same-origin frame traversal.
// @author       Jay Cho
// @homepageURL  https://github.com/Jayyo/agent-page-helper
// @license      MIT
// @match        *://*/*
// @grant        none
// @run-at       document-start
// ==/UserScript==
//
// The same file is a userscript and a plain script: inject it with
// context.addInitScript({ path }) or evaluate its source in any JS channel.
// It defines window.__aph__ and does nothing else until you call it:
// no network, no storage, no attributes written into the DOM.

(function () {
  'use strict';
  if (window.__aph__) return;

  const VERSION = '0.1.0';
  const LIMITS = { elements: 100, headings: 40, live: 10, name: 60, value: 40, text: 400, frameDepth: 8, domDepth: 400 };

  // ---------------------------------------------------------------- refs
  // A ref is a per-document prefix plus a counter ("kqxz12"). The prefix is four
  // random letters drawn on every page load, so a ref kept from a previous page
  // fails (WRONG_DOCUMENT) instead of hitting whatever element got the same number
  // on the new page; two loads share a prefix with odds of about 1 in 457,000.
  const DOC = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => String.fromCharCode(97 + (b % 26))).join('');
  const REF_RE = /^[a-z]{4}\d+$/;
  let counter = 0;
  const refOf = new WeakMap();   // Element -> ref
  const byRef = new Map();       // ref -> WeakRef<Element>

  function refFor(el) {
    let ref = refOf.get(el);
    if (!ref) {
      ref = DOC + (++counter);
      refOf.set(el, ref);
      if (byRef.size >= 5000 && counter % 1000 === 0) sweepRefs();
    }
    if (!byRef.has(ref)) byRef.set(ref, new WeakRef(el));
    return ref;
  }
  function sweepRefs() {
    for (const [ref, w] of byRef) { const el = w.deref(); if (!el || !el.isConnected) byRef.delete(ref); }
  }
  function fail(code, message, extra) {
    return { ok: false, error: Object.assign({ code, message }, extra) };
  }
  function resolve(ref) {
    if (typeof ref !== 'string' || !REF_RE.test(ref)) return fail('BAD_REF', `not a helper ref: ${String(ref).slice(0, 40)}`);
    if (!ref.startsWith(DOC)) return fail('WRONG_DOCUMENT', `ref ${ref} is from another page load; take a new snapshot`);
    const w = byRef.get(ref);
    const el = w && w.deref();
    if (!el || !el.isConnected) { byRef.delete(ref); return fail('STALE_REF', `ref ${ref} is no longer in the document`); }
    return { ok: true, el };
  }

  // ---------------------------------------------------------------- small utils
  const BIDI = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;
  function clean(s, max) {
    if (s == null) return '';
    s = String(s).replace(BIDI, '').replace(/\s+/g, ' ').trim();
    return max && s.length > max ? s.slice(0, max - 1) + '…' : s;
  }
  // A <form> exposes its controls as properties ([LegacyOverrideBuiltIns]), so
  // <input name="id"> or name="hidden" would shadow form.id or form.hidden. Read
  // element state through the prototypes instead.
  const EP = Element.prototype;
  const getter = (proto, name) => Object.getOwnPropertyDescriptor(proto, name).get;
  const TAG = getter(EP, 'tagName');
  const SHADOW = getter(EP, 'shadowRoot');
  const FIRST = getter(EP, 'firstElementChild');
  const NEXT = getter(EP, 'nextElementSibling');
  const FORM_ELEMENTS = getter(HTMLFormElement.prototype, 'elements');
  function viewOf(el) { return el.ownerDocument.defaultView || window; }
  function tagOf(el) { return TAG.call(el).toUpperCase(); }
  function attr(el, name) { const v = EP.getAttribute.call(el, name); return v == null ? '' : v; }
  function hasAttr(el, name) { return EP.hasAttribute.call(el, name); }
  function classOf(el) { return attr(el, 'class'); }
  function describe(el) {
    if (!el || el.nodeType !== 1) return '';
    const tag = tagOf(el).toLowerCase();
    if (attr(el, 'id')) return `${tag}#${clean(attr(el, 'id'), 40)}`;
    const cls = classOf(el).trim().split(/\s+/)[0];
    return cls ? `${tag}.${clean(cls, 40)}` : tag;
  }
  // Like Node.contains, but also walks out of shadow roots.
  function composedContains(outer, node) {
    for (let n = node; n; n = n.parentNode || n.host) if (n === outer) return true;
    return false;
  }

  // ---------------------------------------------------------------- roles, names, state
  const INTERACTIVE_ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox',
    'menuitemradio', 'option', 'combobox', 'textbox', 'searchbox', 'slider', 'spinbutton', 'listbox', 'treeitem', 'gridcell']);
  const INPUT_ROLES = { button: 'button', submit: 'button', reset: 'button', image: 'button', file: 'button',
    checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton', search: 'searchbox' };
  const FILLABLE_TYPES = new Set(['', 'text', 'search', 'email', 'url', 'tel', 'password', 'number', 'date',
    'datetime-local', 'month', 'week', 'time', 'color', 'range']);
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'HEAD', 'META', 'LINK']);
  const SECRET_AUTOCOMPLETE = /\b(current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp(-month|-year)?)\b/i;

  function roleOf(el) {
    const explicit = attr(el, 'role').trim().split(/\s+/)[0];
    if (explicit) return explicit;
    switch (tagOf(el)) {
      case 'A': case 'AREA': return hasAttr(el, 'href') ? 'link' : null;
      case 'BUTTON': case 'SUMMARY': return 'button';
      case 'SELECT': return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
      case 'TEXTAREA': return 'textbox';
      case 'INPUT': return INPUT_ROLES[el.type] || 'textbox';
      case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': return 'heading';
      case 'OUTPUT': return 'status';
      case 'DIALOG': return 'dialog';
      case 'IMG': return el.getAttribute('alt') === '' ? null : 'img';
    }
    return isEditableRoot(el) ? 'textbox' : null;
  }
  function isEditableRoot(el) {
    return el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable);
  }

  // Text of a subtree for names: skips form controls (so a label that wraps a
  // <select> does not swallow every option's text), follows <slot>s to their
  // assigned nodes, and skips hidden parts unless `includeHidden` (aria-labelledby
  // may point at hidden text).
  function textOf(node, max = 200, includeHidden = false) {
    let out = '';
    const children = (n) => (tagOf(n) === 'SLOT' && n.assignedNodes({ flatten: true }).length ? n.assignedNodes({ flatten: true }) : Array.from(n.childNodes));
    (function walk(n) {
      for (const c of children(n)) {
        if (out.length >= max) return;
        if (c.nodeType === 3) out += c.nodeValue;
        else if (c.nodeType === 1) {
          if (SKIP_TAGS.has(tagOf(c)) || attr(c, 'aria-hidden') === 'true') continue;
          if (tagOf(c) === 'SELECT' || tagOf(c) === 'TEXTAREA' || tagOf(c) === 'INPUT') continue;
          if (!includeHidden && (hasAttr(c, 'hidden') || (c.checkVisibility && !c.checkVisibility({ visibilityProperty: true })))) continue;
          if (tagOf(c) === 'IMG') { out += ' ' + attr(c, 'alt') + ' '; continue; }
          walk(c);
          if (tagOf(c) === 'BR' || tagOf(c) === 'P' || tagOf(c) === 'DIV' || tagOf(c) === 'LI') out += ' ';
        }
      }
    })(node);
    return clean(out, max);
  }

  function nameOf(el) {
    const root = el.getRootNode();
    const labelledby = attr(el, 'aria-labelledby').trim();
    if (labelledby && root.getElementById) {
      const t = labelledby.split(/\s+/).map((id) => { const n = root.getElementById(id); return n ? textOf(n, 200, true) : ''; }).filter(Boolean).join(' ');
      if (t) return t;
    }
    const label = attr(el, 'aria-label').trim();
    if (label) return label;
    if (el.labels && el.labels.length && !(tagOf(el) === 'INPUT' && (el.type === 'submit' || el.type === 'reset' || el.type === 'button'))) {
      const t = Array.from(el.labels, (l) => textOf(l)).filter(Boolean).join(' ');
      if (t) return t;
    }
    switch (tagOf(el)) {
      case 'INPUT':
        if (el.type === 'submit' || el.type === 'reset' || el.type === 'button') return el.value || (el.type === 'submit' ? 'Submit' : el.type === 'reset' ? 'Reset' : '');
        if (el.type === 'image') return attr(el, 'alt') || el.value || 'Submit';
        return attr(el, 'title') || attr(el, 'placeholder');
      case 'SELECT': case 'TEXTAREA': return attr(el, 'title') || attr(el, 'placeholder');
      case 'IMG': return attr(el, 'alt') || attr(el, 'title');
      case 'IFRAME': case 'FRAME': return attr(el, 'title') || attr(el, 'name');
    }
    const t = textOf(el);
    if (t) return t;
    if (attr(el, 'title')) return attr(el, 'title');
    // Icon-only controls: fall back to the first labelled descendant.
    const inner = el.querySelector && el.querySelector('[aria-label], img[alt], svg title, [title]');
    if (!inner) return '';
    return clean(tagOf(inner).toLowerCase() === 'title' ? inner.textContent : attr(inner, 'aria-label') || attr(inner, 'alt') || attr(inner, 'title'));
  }

  function isSecret(el) {
    return el.type === 'password' || SECRET_AUTOCOMPLETE.test(attr(el, 'autocomplete'));
  }
  // Value as shown to the agent. Passwords, one-time codes and card fields are masked.
  function valueOf(el, max = LIMITS.value) {
    const tag = tagOf(el);
    let v;
    if (tag === 'SELECT') v = Array.from(el.selectedOptions, (o) => o.label || o.text).join(', ');
    else if (tag === 'TEXTAREA' || (tag === 'INPUT' && (FILLABLE_TYPES.has(el.type) || el.type === 'hidden'))) v = el.value;
    else if (tag === 'INPUT' && el.type === 'file') v = Array.from(el.files || [], (f) => f.name).join(', ');
    else if (el.isContentEditable) v = el.innerText;
    if (!v) return '';
    return isSecret(el) ? `[masked:${v.length}]` : clean(v, max);
  }

  function isDisabled(el) {
    return el.disabled === true || attr(el, 'aria-disabled') === 'true' || !!(el.closest && el.closest('fieldset[disabled]') && el.matches('input,select,textarea,button'));
  }
  function matches(el, sel) { try { return el.matches(sel); } catch (e) { return false; } }

  function stateOf(el, role) {
    const s = {};
    const tag = tagOf(el);
    if (tag === 'INPUT' && !INPUT_ROLES[el.type] && el.type !== 'text' && el.type) s.type = el.type;
    if (tag === 'INPUT' && el.type === 'file') s.type = 'file';
    const value = valueOf(el);
    if (value) s.value = value;
    if (!value && attr(el, 'placeholder')) s.placeholder = clean(attr(el, 'placeholder'), LIMITS.value);
    if (tag === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) s.checked = el.indeterminate ? 'mixed' : el.checked;
    else if (role === 'checkbox' || role === 'radio' || role === 'switch' || role === 'menuitemcheckbox' || role === 'menuitemradio') {
      const c = attr(el, 'aria-checked'); s.checked = c === 'mixed' ? 'mixed' : c === 'true';
    }
    if (hasAttr(el, 'aria-expanded')) s.expanded = attr(el, 'aria-expanded') === 'true';
    if (hasAttr(el, 'aria-pressed')) s.pressed = attr(el, 'aria-pressed') === 'true';
    if (attr(el, 'aria-selected') === 'true') s.selected = true;
    if (isDisabled(el)) s.disabled = true;
    if (el.readOnly && (tag === 'INPUT' || tag === 'TEXTAREA')) s.readonly = true;
    if (el.required || attr(el, 'aria-required') === 'true') s.required = true;
    if (attr(el, 'aria-invalid') === 'true' || matches(el, ':user-invalid')) s.invalid = true;
    if ((tag === 'A' || tag === 'AREA') && hasAttr(el, 'href')) s.href = clean(typeof el.href === 'string' ? el.href : absolute(attr(el, 'href'), el.baseURI), 120);
    return s;
  }

  // ---------------------------------------------------------------- visibility and hit testing
  function isVisible(el) {
    if (el.checkVisibility) {
      if (!el.checkVisibility({ visibilityProperty: true })) return false;
    } else {
      const s = viewOf(el).getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  }

  // Walk up from the element that was hit to the overlay it belongs to (a dialog or
  // a fixed/sticky box); otherwise report the nearest ancestor with an id.
  function blocker(hit) {
    let withId = null;
    let n = hit;
    for (let i = 0; n && n.nodeType === 1 && i < 10; i++, n = n.parentElement) {
      const role = attr(n, 'role');
      if (role === 'dialog' || role === 'alertdialog' || tagOf(n) === 'DIALOG' || attr(n, 'aria-modal') === 'true') return n;
      const pos = viewOf(n).getComputedStyle(n).position;
      if (pos === 'fixed' || pos === 'sticky') return n;
      if (!withId && n.id) withId = n;
    }
    return withId || hit;
  }
  function hitsTarget(el, hit) {
    if (hit === el || composedContains(el, hit) || composedContains(hit, el)) return true;
    // A styled <label> drawn over its own (visually hidden) checkbox still activates it.
    return !!(el.labels && Array.from(el.labels).some((l) => composedContains(l, hit)));
  }
  // Center-point hit test, repeated at every same-origin frame boundary.
  // Returns { hit: 'clear' | 'covered' | 'offscreen' | 'unknown', by? }.
  function hitTest(el) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return { hit: 'unknown' };
    let x = r.left + r.width / 2, y = r.top + r.height / 2;
    let target = el;
    for (let depth = 0; depth <= LIMITS.frameDepth; depth++) {
      const view = viewOf(target);
      if (x < 0 || y < 0 || x >= view.innerWidth || y >= view.innerHeight) return { hit: 'offscreen' };
      const root = target.getRootNode();
      const hit = root.elementFromPoint ? root.elementFromPoint(x, y) : null;
      if (!hit) return { hit: 'unknown' };
      if (!hitsTarget(target, hit)) return { hit: 'covered', by: blocker(hit) };
      let frame = null;
      try { frame = view.frameElement; } catch (e) { /* cross-origin parent */ }
      if (!frame) return { hit: 'clear' };
      const fr = frame.getBoundingClientRect();
      const fs = viewOf(frame).getComputedStyle(frame);
      x += fr.left + frame.clientLeft + parseFloat(fs.paddingLeft || 0);
      y += fr.top + frame.clientTop + parseFloat(fs.paddingTop || 0);
      target = frame;
    }
    return { hit: 'unknown' };
  }

  // How far an element is from being on screen, in px: outside its own frame's
  // viewport, or outside this window's once the offsets of the same-origin frames
  // in between are added (CSS transforms on frames are ignored). 0 = on screen.
  function offscreenDistance(el) {
    const r = el.getBoundingClientRect();
    let top = r.top, bottom = r.bottom, dist = 0;
    let view = viewOf(el);
    for (let depth = 0; depth <= LIMITS.frameDepth; depth++) {
      const h = view.innerHeight;
      dist = Math.max(dist, bottom < 0 ? -bottom : top > h ? top - h : 0);
      if (view === window) break;
      let frame = null;
      try { frame = view.frameElement; } catch (e) { /* cross-origin parent */ }
      if (!frame) break;
      const fr = frame.getBoundingClientRect();
      const offset = fr.top + frame.clientTop + parseFloat(viewOf(frame).getComputedStyle(frame).paddingTop || 0);
      top = Math.max(top, 0) + offset;
      bottom = Math.min(bottom, h) + offset;
      view = viewOf(frame);
    }
    return dist;
  }

  // ---------------------------------------------------------------- frames and the DOM walk
  function frameAccess(fr) {
    let doc = null;
    try { doc = fr.contentDocument; } catch (e) { return { access: 'cross-origin' }; }
    if (doc) return { access: 'same-origin', doc };
    let win = null;
    try { win = fr.contentWindow; } catch (e) { /* ignore */ }
    if (!win) return { access: 'unavailable' };
    try { void win.document; return { access: 'unavailable' }; } catch (e) { return { access: 'cross-origin' }; }
  }

  // Depth-first walk over light DOM, open shadow roots and same-origin frames.
  // visit(el, ctx) may return false to skip the subtree, and may set
  // ctx.markInteractive / ctx.pointer to pass state down to the element's
  // descendants. Returns every frame met on the way, numbered in walk order
  // (0 = the starting document), including frames it could not enter.
  function walk(start, visit, opts = {}) {
    const frames = [{ index: 0, parent: null, depth: 0, url: start.ownerDocument ? start.ownerDocument.URL : document.URL, access: 'same-origin' }];
    const ctx = { frame: 0, interactiveAncestor: null, parentPointer: false, markInteractive: false, pointer: false };
    (function rec(el, depth) {
      if (depth > LIMITS.domDepth || SKIP_TAGS.has(tagOf(el))) return;
      if (hasAttr(el, 'hidden') || hasAttr(el, 'inert') || attr(el, 'aria-hidden') === 'true') return;
      ctx.markInteractive = false;
      ctx.pointer = ctx.parentPointer;
      if (visit(el, ctx) === false) return;
      const saved = { interactiveAncestor: ctx.interactiveAncestor, parentPointer: ctx.parentPointer, frame: ctx.frame };
      if (ctx.markInteractive) ctx.interactiveAncestor = el;
      ctx.parentPointer = ctx.pointer;
      const shadow = SHADOW.call(el);
      if (shadow) for (let c = shadow.firstElementChild; c; c = NEXT.call(c)) rec(c, depth + 1);
      for (let c = FIRST.call(el); c; c = NEXT.call(c)) rec(c, depth + 1);
      if ((tagOf(el) === 'IFRAME' || tagOf(el) === 'FRAME') && opts.frames !== false) {
        const parent = frames[saved.frame];
        const fa = frameAccess(el);
        const info = { index: frames.length, parent: parent.index, depth: parent.depth + 1, name: clean(attr(el, 'title') || attr(el, 'name'), LIMITS.name),
          url: fa.doc ? fa.doc.URL : clean(el.src || attr(el, 'src'), 200), access: fa.access, ref: refFor(el) };
        frames.push(info);
        const rootEl = fa.doc && (fa.doc.body || fa.doc.documentElement);
        if (rootEl && info.depth <= LIMITS.frameDepth && isVisible(el)) {
          ctx.frame = info.index; ctx.interactiveAncestor = null; ctx.parentPointer = false;
          if (opts.onFrame) opts.onFrame(info, true);
          rec(rootEl, depth + 1);
          if (opts.onFrame) opts.onFrame(info, false);
        }
      }
      ctx.interactiveAncestor = saved.interactiveAncestor; ctx.parentPointer = saved.parentPointer; ctx.frame = saved.frame;
    })(start, 0);
    return frames;
  }

  function startElement(root) {
    if (root == null) return document.body || document.documentElement;
    if (typeof root === 'string' && REF_RE.test(root)) {
      const r = resolve(root);
      if (!r.ok) throw new Error(r.error.message);
      return r.el;
    }
    const el = document.querySelector(root);
    if (!el) throw new Error(`root not found: ${root}`);
    return el;
  }

  // Interactive = native control, interactive ARIA role, explicit tabindex/onclick,
  // the root of an editable region, or the element that introduces cursor:pointer
  // (children that merely inherit the cursor are not counted again).
  function classify(el, ctx) {
    const tag = tagOf(el);
    const role = roleOf(el);
    let kind = null;
    if (role && INTERACTIVE_ROLES.has(role)) kind = 'role';
    else if (tag === 'BUTTON' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'SUMMARY') kind = 'native';
    else if (tag === 'INPUT' && el.type !== 'hidden') kind = 'native';
    else if ((tag === 'A' || tag === 'AREA') && hasAttr(el, 'href')) kind = 'native';
    else if (isEditableRoot(el)) kind = 'editable';
    else if (!ctx.interactiveAncestor && tag !== 'IFRAME' && tag !== 'FRAME' && tag !== 'BODY' && tag !== 'HTML'
      && ((hasAttr(el, 'tabindex') && el.tabIndex >= 0) || hasAttr(el, 'onclick'))) kind = 'handler';
    let pointer = ctx.parentPointer;
    if (!kind && !ctx.interactiveAncestor && tag !== 'BODY' && tag !== 'HTML') {
      try { pointer = viewOf(el).getComputedStyle(el).cursor === 'pointer'; } catch (e) { /* detached */ }
      if (pointer && !ctx.parentPointer && tag !== 'LABEL') kind = 'pointer';
    }
    return { role, kind, pointer };
  }

  // ---------------------------------------------------------------- snapshot
  function collect(opts) {
    const t0 = performance.now();
    const max = opts.maxElements == null ? LIMITS.elements : opts.maxElements;
    const start = startElement(opts.root);
    const items = [];          // interactive elements, headings, live regions in document order
    let order = 0;
    const frameEvents = [];
    const frames = walk(start, (el, ctx) => {
      const { role, kind, pointer } = classify(el, ctx);
      ctx.pointer = pointer;
      if (kind) {
        ctx.markInteractive = true;
        if (isVisible(el)) items.push({ type: 'el', el, role, kind, frame: ctx.frame, order: order++ });
        return;
      }
      if (role === 'heading' && isVisible(el)) {
        items.push({ type: 'heading', el, frame: ctx.frame, order: order++ });
        return;
      }
      const live = attr(el, 'aria-live');
      if ((role === 'status' || role === 'alert' || (live && live !== 'off')) && isVisible(el)) {
        items.push({ type: 'live', el, role: role || 'status', frame: ctx.frame, order: order++ });
      }
    }, {
      frames: opts.frames,
      onFrame: (info, entering) => frameEvents.push({ info, entering, order: order++ }),
    });

    // Pick which interactive elements to list: everything in the viewport first,
    // then the ones closest to it. Output stays in document order.
    const els = items.filter((i) => i.type === 'el');
    let chosen = els;
    if (els.length > max) {
      for (const i of els) i.dist = offscreenDistance(i.el);
      chosen = els.slice().sort((a, b) => a.dist - b.dist || a.order - b.order).slice(0, max);
    }
    const keep = new Set(chosen);
    const headingItems = items.filter((i) => i.type === 'heading');
    const keptHeadings = new Set(headingItems.slice(0, LIMITS.headings));
    const liveItems = items.filter((i) => i.type === 'live' && textOf(i.el, 2)).slice(0, LIMITS.live);
    const keptLive = new Set(liveItems);

    const elements = [], headings = [], live = [];
    const entries = [];   // ordered entries for the text renderer
    for (const i of items) {
      if (i.type === 'el' && keep.has(i)) {
        const e = { ref: refFor(i.el), role: i.role || null, name: clean(nameOf(i.el), LIMITS.name) };
        if (!i.role) e.tag = tagOf(i.el).toLowerCase();
        Object.assign(e, stateOf(i.el, i.role));
        if (i.frame) e.frame = i.frame;
        if (opts.occlusion !== false) {
          const h = hitTest(i.el);
          if (h.hit === 'covered') { e.hit = 'covered'; e.coveredBy = describe(h.by); e.coveredByRef = refFor(h.by); }
          else e.hit = h.hit;
        }
        elements.push(e); entries.push({ order: i.order, frame: i.frame, el: e });
      } else if (i.type === 'heading' && keptHeadings.has(i)) {
        const level = /^H[1-6]$/.test(tagOf(i.el)) ? +tagOf(i.el)[1] : (parseInt(attr(i.el, 'aria-level'), 10) || 2);
        const h = { level, text: clean(textOf(i.el, 160), 100) };
        if (i.frame) h.frame = i.frame;
        headings.push(h); entries.push({ order: i.order, frame: i.frame, heading: h });
      } else if (i.type === 'live' && keptLive.has(i)) {
        const l = { role: i.role, text: clean(textOf(i.el, 300), 160) };
        if (i.frame) l.frame = i.frame;
        live.push(l); entries.push({ order: i.order, frame: i.frame, live: l });
      }
    }
    for (const f of frameEvents) entries.push({ order: f.order, frameEvent: f });
    entries.sort((a, b) => a.order - b.order);

    const mainEl = document.querySelector('main, [role="main"]') || document.querySelector('article') || document.body;
    const textChars = opts.textChars == null ? LIMITS.text : opts.textChars;
    const text = textChars > 0 && mainEl && !opts.root ? clean(mainEl.innerText, textChars) : '';

    const result = {
      url: location.href,
      title: clean(document.title, 120),
      untrusted: true,
      elements,
      headings,
      live,
      frames: frames.slice(1).map((f) => { const c = Object.assign({}, f); if (c.url) c.url = clean(c.url, 200); return c; }),
      text,
      stats: {
        found: els.length,
        listed: elements.length,
        headingsOmitted: Math.max(0, headingItems.length - LIMITS.headings),
        ms: Math.round(performance.now() - t0),
      },
    };
    return { result, entries };
  }

  function q(s) { return JSON.stringify(s); }
  function shortUrl(u) {
    try {
      const url = new URL(u, location.href);
      return url.origin === location.origin ? clean(url.pathname + url.search, 80) : clean(url.href, 100);
    } catch (e) { return clean(u, 100); }
  }
  function renderLine(e, opts) {
    let s = `[${e.ref}] ${e.role || e.tag}`;
    if (e.name) s += ' ' + q(e.name);
    if (e.type) s += ` type=${e.type}`;
    if (e.value) s += ` value=${q(e.value)}`;
    if (e.placeholder && e.placeholder !== e.name) s += ` placeholder=${q(e.placeholder)}`;
    if (e.checked !== undefined) s += e.checked === 'mixed' ? ' mixed' : e.checked ? ' checked' : ' unchecked';
    if (e.expanded !== undefined) s += e.expanded ? ' expanded' : ' collapsed';
    if (e.pressed) s += ' pressed';
    if (e.selected) s += ' selected';
    if (e.disabled) s += ' disabled';
    if (e.readonly) s += ' readonly';
    if (e.required) s += ' required';
    if (e.invalid) s += ' invalid';
    if (opts.hrefs && e.href) s += ` -> ${shortUrl(e.href)}`;
    if (e.hit === 'covered') s += ` covered-by=[${e.coveredByRef}] ${e.coveredBy}`;
    return s;
  }
  function renderText(result, entries, opts) {
    const lines = [`page ${q(result.title)} ${clean(result.url, 160)}`];
    const depth = { 0: 0 };
    for (const f of result.frames) depth[f.index] = f.depth;
    const pad = (n) => '  '.repeat(n || 0);
    for (const en of entries) {
      if (en.frameEvent) {
        const { info, entering } = en.frameEvent;
        if (entering) lines.push(`${pad(info.depth - 1)}frame ${info.index}${info.name ? ' ' + q(info.name) : ''} ${shortUrl(info.url)}`);
        continue;
      }
      const indent = pad(depth[en.frame || 0]);
      if (en.el) lines.push(indent + renderLine(en.el, opts));
      else if (en.heading) lines.push(`${indent}h${en.heading.level} ${q(en.heading.text)}`);
      else if (en.live) lines.push(`${indent}${en.live.role} ${q(en.live.text)}`);
    }
    for (const f of result.frames) {
      if (f.access !== 'same-origin') lines.push(`${pad(f.depth - 1)}frame ${f.index}${f.name ? ' ' + q(f.name) : ''} ${shortUrl(f.url)} (${f.access}, not traversed)`);
    }
    const st = result.stats;
    if (st.listed < st.found) lines.push(`listed ${st.listed} of ${st.found} interactive elements (viewport first); use find(text) or snapshot({ root }) for the rest`);
    if (st.headingsOmitted) lines.push(`${st.headingsOmitted} more headings omitted`);
    if (result.text) lines.push(`text: ${q(result.text)}`);
    return lines.join('\n');
  }

  // ---------------------------------------------------------------- value setters
  // Assigning el.value on a React-controlled input updates React's value tracker,
  // so React sees no change and keeps its own state. The prototype's setter (from
  // the element's own realm, which matters for frames) bypasses the tracker.
  function setNative(el, prop, value) {
    const view = viewOf(el);
    const proto = tagOf(el) === 'TEXTAREA' ? view.HTMLTextAreaElement.prototype
      : tagOf(el) === 'SELECT' ? view.HTMLSelectElement.prototype
        : tagOf(el) === 'OPTION' ? view.HTMLOptionElement.prototype
          : view.HTMLInputElement.prototype;
    const d = Object.getOwnPropertyDescriptor(proto, prop);
    if (d && d.set) d.set.call(el, value); else el[prop] = value;
  }
  function fire(el, type, init) {
    const view = viewOf(el);
    const Ctor = type === 'input' && view.InputEvent ? view.InputEvent : view.Event;
    el.dispatchEvent(new Ctor(type, Object.assign({ bubbles: true, composed: true }, init)));
  }
  function gate(el, opts, needsHit) {
    if (isDisabled(el)) return fail('DISABLED', `${describe(el)} is disabled`);
    if (opts.force) return null;
    if (!isVisible(el)) return fail('NOT_VISIBLE', `${describe(el)} is not visible`);
    if (needsHit) {
      const h = hitTest(el);
      if (h.hit === 'covered') return fail('OCCLUDED', `${describe(el)} is covered by ${describe(h.by)}`, { coveredBy: describe(h.by), coveredByRef: refFor(h.by) });
    }
    return null;
  }
  function domClick(el) {
    if (typeof el.click === 'function') el.click();
    else { const view = viewOf(el); el.dispatchEvent(new view.MouseEvent('click', { bubbles: true, cancelable: true, composed: true, view })); }
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));

  // ---------------------------------------------------------------- forms
  function frameDocs() {
    const docs = [];
    walk(document.documentElement, () => true, {
      onFrame: (info, entering) => { if (entering) docs.push(info); },
    });
    const out = [{ index: 0, doc: document }];
    for (const info of docs) { const fa = frameAccess(refElement(info.ref)); if (fa.doc) out.push({ index: info.index, doc: fa.doc }); }
    return out;
  }
  function refElement(ref) { const w = byRef.get(ref); return w && w.deref(); }
  function errorText(el) {
    const ids = (attr(el, 'aria-errormessage') + ' ' + attr(el, 'aria-describedby')).trim();
    const root = el.getRootNode();
    if (ids && root.getElementById) {
      for (const id of ids.split(/\s+/)) { const n = root.getElementById(id); const t = n && textOf(n); if (t) return clean(t, 200); }
    }
    return el.validationMessage || '';
  }
  const MESSAGE_SELECTOR = '[role="alert"], .error, .errors, .invalid-feedback, .field-error, .error-message, .errorMessage, .form-error, .text-danger, .has-error .help-block';

  // ---------------------------------------------------------------- popups
  const popupLog = [];
  let popupMode = 'off';
  let active = null;     // the window.open wrapper that currently logs
  let original = null;   // what window.open was before `active`
  function logPopup(entry) { popupLog.push(entry); if (popupLog.length > 100) popupLog.shift(); }
  function absolute(u, base = location.href) { try { return new URL(u, base).href; } catch (e) { return String(u); } }
  function onLinkClick(e) {
    if (popupMode === 'off' || e.defaultPrevented) return;
    const a = e.composedPath().find((n) => n.nodeType === 1 && (tagOf(n) === 'A' || tagOf(n) === 'AREA'));
    if (!a || !hasAttr(a, 'href')) return;
    const target = attr(a, 'target').toLowerCase();
    if (target !== '_blank' && target !== '_new') return;
    const url = absolute(attr(a, 'href'), a.baseURI);
    if (/^javascript:/i.test(url)) return;
    logPopup({ url, target, via: 'link', mode: popupMode, ts: Date.now() });
    if (popupMode === 'same-tab' || popupMode === 'block') {
      e.preventDefault();
      if (popupMode === 'same-tab') location.assign(url);
    }
  }
  function wrapOpen(realOpen) {
    const wrapper = function open(url, target, features) {
      // Wrappers left inside a chain the page built on top of them only pass calls on.
      if (popupMode === 'off' || active !== wrapper) return realOpen.apply(window, arguments);
      const abs = url ? absolute(url) : '';
      logPopup({ url: abs, target: target ? String(target) : '', via: 'window.open', mode: popupMode, ts: Date.now() });
      if (popupMode === 'block') return null;
      if (popupMode === 'same-tab' && abs) { location.assign(abs); return null; }
      return realOpen.apply(window, arguments);
    };
    return wrapper;
  }
  function setPopupMode(mode) {
    if (!['off', 'record', 'same-tab', 'block'].includes(mode)) throw new Error(`unknown popup mode: ${mode}`);
    popupMode = mode;
    if (mode === 'off') {
      document.removeEventListener('click', onLinkClick, true);
      // Put window.open back only if nobody replaced our wrapper in the meantime.
      if (active && window.open === active) window.open = original;
      active = original = null;
      return;
    }
    document.addEventListener('click', onLinkClick, true);
    if (active && window.open === active) return;
    original = window.open;
    active = wrapOpen(original);
    window.open = active;
  }

  // ---------------------------------------------------------------- public API
  const api = {
    version: VERSION,
    doc: DOC,

    // Compact view of the page. format: 'json' (default) or 'text'.
    // Options: maxElements, root (ref or CSS selector), textChars, frames, occlusion, hrefs.
    snapshot(opts = {}) {
      const { result, entries } = collect(opts);
      return opts.format === 'text' ? renderText(result, entries, opts) : result;
    },

    // Visible elements whose name (or own text) contains `text`. Interactive matches
    // come first; a matching <label> is reported as the control it labels.
    // Options: exact, role, limit, interactiveOnly.
    find(text, opts = {}) {
      if (typeof text !== 'string' || !text) throw new Error('find(text): text must be a non-empty string');
      const limit = opts.limit || 20;
      const needle = opts.exact ? clean(text) : clean(text).toLowerCase();
      const hit = (s) => (opts.exact ? s === needle : s.toLowerCase().includes(needle));
      const found = [];
      const seen = new Set();
      const add = (el, role, name, interactive, frame) => {
        if (seen.has(el)) return;
        seen.add(el);
        const e = { ref: refFor(el), role: role || null, name: clean(name, LIMITS.name), interactive };
        if (!role) e.tag = tagOf(el).toLowerCase();
        if (frame) e.frame = frame;
        found.push(e);
      };
      walk(document.body || document.documentElement, (el, ctx) => {
        const { role, kind, pointer } = classify(el, ctx);
        ctx.pointer = pointer;
        if (kind) {
          ctx.markInteractive = true;
          if ((!opts.role || role === opts.role) && hit(clean(nameOf(el))) && isVisible(el)) add(el, role, nameOf(el), true, ctx.frame);
          return;
        }
        if (opts.interactiveOnly || ctx.interactiveAncestor) return;
        // Match on the element's own text nodes, so its ancestors are not reported as well.
        let own = '';
        for (let c = el.firstChild; c; c = c.nextSibling) if (c.nodeType === 3) own += c.nodeValue;
        own = clean(own);
        if (!own || !hit(own) || !isVisible(el)) return;
        const control = tagOf(el) === 'LABEL' && el.control;
        if (control && isVisible(control)) {
          const crole = roleOf(control);
          if (!opts.role || crole === opts.role) add(control, crole, nameOf(control), true, ctx.frame);
        } else if (!opts.role || role === opts.role) {
          add(el, role, textOf(el), false, ctx.frame);
        }
      });
      found.sort((a, b) => b.interactive - a.interactive);
      return found.slice(0, limit);
    },

    // querySelectorAll across same-origin frames and open shadow roots.
    query(selector, opts = {}) {
      const limit = opts.limit || 50;
      const out = [];
      const seen = new Set();
      const take = (el, frame) => {
        if (out.length >= limit || seen.has(el) || (opts.visibleOnly !== false && !isVisible(el))) return;
        seen.add(el);
        const role = roleOf(el);
        const e = { ref: refFor(el), role: role || null, tag: tagOf(el).toLowerCase(), name: clean(nameOf(el), LIMITS.name) };
        if (frame) e.frame = frame;
        out.push(e);
      };
      document.querySelector(selector);   // throws a SyntaxError for invalid selectors
      walk(document.documentElement, (el, ctx) => {
        if (out.length >= limit) return false;
        if (el.matches(selector)) take(el, ctx.frame);
      });
      return out;
    },

    // Everything known about one element.
    inspect(ref) {
      const r = resolve(ref);
      if (!r.ok) return r;
      const el = r.el;
      const role = roleOf(el);
      const rect = el.getBoundingClientRect();
      const h = hitTest(el);
      const info = Object.assign({ ok: true, ref, tag: tagOf(el).toLowerCase(), role, name: clean(nameOf(el), 200) }, stateOf(el, role), {
        visible: isVisible(el),
        hit: h.hit,
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        attributes: {},
      });
      if (h.by) { info.coveredBy = describe(h.by); info.coveredByRef = refFor(h.by); }
      for (const a of ['id', 'name', 'type', 'title', 'autocomplete', 'maxlength', 'pattern', 'min', 'max', 'data-testid']) {
        if (hasAttr(el, a)) info.attributes[a] = clean(attr(el, a), 120);
      }
      if (classOf(el)) info.attributes.class = clean(classOf(el), 120);
      if (tagOf(el) === 'SELECT' && !isSecret(el)) info.options = Array.from(el.options).slice(0, 50).map((o) => ({ value: clean(o.value, 60), label: clean(o.label || o.text, 60), selected: o.selected }));
      if (el.validationMessage) info.validationMessage = el.validationMessage;
      return info;
    },

    // DOM click (el.click(): isTrusted is false). Refuses disabled, hidden or covered
    // elements unless { force: true }.
    click(ref, opts = {}) {
      const r = resolve(ref);
      if (!r.ok) return r;
      const blocked = gate(r.el, opts, true);
      if (blocked) return blocked;
      domClick(r.el);
      return { ok: true, ref };
    },

    // Replace the value of a text-like input, textarea or contenteditable.
    // Fires input and change; blurs afterwards unless { blur: false }.
    fill(ref, text, opts = {}) {
      const r = resolve(ref);
      if (!r.ok) return r;
      const el = r.el;
      text = text == null ? '' : String(text);
      const tag = tagOf(el);
      const isInput = tag === 'INPUT';
      if (isInput && !FILLABLE_TYPES.has(el.type)) {
        const hint = el.type === 'checkbox' || el.type === 'radio' ? 'use setChecked()' : el.type === 'file' ? 'use uploadFile() from the Node side' : 'use click()';
        return fail('UNSUPPORTED_CONTROL', `cannot fill input type=${el.type}; ${hint}`);
      }
      if (!isInput && tag !== 'TEXTAREA' && !el.isContentEditable) return fail('UNSUPPORTED_CONTROL', `cannot fill <${tag.toLowerCase()}>; use select() for <select>, click() for custom widgets`);
      if ((isInput || tag === 'TEXTAREA') && el.readOnly) return fail('READONLY', `${describe(el)} is read-only`);
      const blocked = gate(el, opts, false);
      if (blocked) return blocked;
      el.focus({ preventScroll: true });
      if (el.isContentEditable && !isInput && tag !== 'TEXTAREA') {
        const doc = el.ownerDocument;
        const range = doc.createRange();
        range.selectNodeContents(el);
        const sel = doc.getSelection();
        sel.removeAllRanges(); sel.addRange(range);
        const ok = text ? doc.execCommand('insertText', false, text) : doc.execCommand('delete', false);
        if (!ok) return fail('UNSUPPORTED_CONTROL', 'the editable element rejected insertText');
      } else {
        setNative(el, 'value', text);
        fire(el, 'input', { inputType: 'insertReplacementText', data: text });
        fire(el, 'change');
        // Single-line inputs drop newlines; email and url inputs also trim.
        let expected = isInput ? text.replace(/[\r\n]/g, '') : text.replace(/\r\n?/g, '\n');
        if (isInput && (el.type === 'email' || el.type === 'url')) expected = expected.trim();
        if (el.value !== expected && !(isInput && el.type === 'color')) {
          if (opts.blur !== false) el.blur();
          return fail('VALUE_REJECTED', `${describe(el)} did not accept the value`, { value: valueOf(el) });
        }
      }
      if (opts.blur !== false) el.blur();
      return { ok: true, ref, value: valueOf(el) };
    },

    // Choose options of a native <select> by value or visible label.
    select(ref, values, opts = {}) {
      const r = resolve(ref);
      if (!r.ok) return r;
      const el = r.el;
      if (tagOf(el) !== 'SELECT') return fail('UNSUPPORTED_CONTROL', `select() needs a native <select>, got <${tagOf(el).toLowerCase()}>; click the option instead`);
      const blocked = gate(el, opts, false);
      if (blocked) return blocked;
      const wanted = Array.isArray(values) ? values.map(String) : [String(values)];
      if (!el.multiple && wanted.length !== 1) return fail('BAD_ARGUMENT', 'a single-choice select takes exactly one value');
      const options = Array.from(el.options);
      const picked = [];
      for (const w of wanted) {
        const o = options.find((x) => x.value === w) || options.find((x) => clean(x.label || x.text) === w)
          || options.find((x) => clean(x.label || x.text).toLowerCase() === w.toLowerCase());
        if (!o) return fail('OPTION_NOT_FOUND', `no option ${q(w)}`, { options: options.slice(0, 20).map((x) => clean(x.label || x.text, 40)) });
        picked.push(o);
      }
      el.focus({ preventScroll: true });
      if (el.multiple) for (const o of options) setNative(o, 'selected', picked.includes(o));
      else setNative(el, 'value', picked[0].value);
      fire(el, 'input');
      fire(el, 'change');
      if (opts.blur !== false) el.blur();
      return { ok: true, ref, value: valueOf(el, 200) };
    },

    // Bring a checkbox, radio or switch to the requested state with a DOM click,
    // then confirm the page kept it. Returns a promise.
    async setChecked(ref, checked = true, opts = {}) {
      const r = resolve(ref);
      if (!r.ok) return r;
      const el = r.el;
      const native = tagOf(el) === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio');
      const role = roleOf(el);
      if (!native && !['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio'].includes(role)) {
        return fail('UNSUPPORTED_CONTROL', `${describe(el)} is not a checkbox, radio or switch`);
      }
      const read = () => (native ? el.checked : attr(el, 'aria-checked') === 'true');
      if (read() === !!checked) return { ok: true, ref, checked: read(), changed: false };
      if (!checked && (el.type === 'radio' || role === 'radio' || role === 'menuitemradio')) return fail('UNSUPPORTED_CONTROL', 'a radio button cannot be unchecked; check another option instead');
      const blocked = gate(el, opts, true);
      if (blocked) return blocked;
      domClick(el);
      await tick();
      if (read() !== !!checked) return fail('NO_EFFECT', `${describe(el)} did not change state`);
      return { ok: true, ref, checked: read(), changed: true };
    },

    focus(ref) {
      const r = resolve(ref);
      if (!r.ok) return r;
      r.el.focus({ preventScroll: true });
      return { ok: true, ref, focused: r.el.getRootNode().activeElement === r.el };
    },

    scrollIntoView(ref, opts = {}) {
      const r = resolve(ref);
      if (!r.ok) return r;
      r.el.scrollIntoView({ block: opts.block || 'center', inline: 'nearest' });
      return { ok: true, ref };
    },

    // Validation problems visible right now: constraint validation, aria-invalid
    // fields and rendered error messages, across same-origin frames.
    errors() {
      const out = [];
      const seenMsg = new Set();
      for (const { index, doc } of frameDocs()) {
        for (const el of doc.querySelectorAll('input, select, textarea')) {
          if (el.type === 'hidden') continue;
          const field = attr(el, 'name') || attr(el, 'id') || clean(nameOf(el), 40);
          const constraint = el.willValidate && !el.validity.valid;
          const ariaInvalid = attr(el, 'aria-invalid') === 'true';
          if (!constraint && !ariaInvalid) continue;
          const e = { kind: ariaInvalid ? 'aria-invalid' : 'constraint', ref: refFor(el), field, message: ariaInvalid ? errorText(el) : el.validationMessage };
          if (constraint) e.userInvalid = matches(el, ':user-invalid');
          if (index) e.frame = index;
          out.push(e);
        }
        for (const m of doc.querySelectorAll(MESSAGE_SELECTOR)) {
          if (seenMsg.has(m) || !isVisible(m)) continue;
          const t = textOf(m, 300);
          if (!t || out.some((o) => o.message === t)) continue;
          for (const inner of m.querySelectorAll(MESSAGE_SELECTOR)) seenMsg.add(inner);
          const e = { kind: 'message', ref: refFor(m), message: clean(t, 200) };
          if (index) e.frame = index;
          out.push(e);
        }
      }
      return out;
    },

    // Current values of forms (or of one form/container given as a ref or CSS selector).
    // Passwords, one-time codes and card numbers are masked; hidden inputs are skipped
    // unless { includeHidden: true }. Masking is best effort, not a privacy guarantee.
    formState(target, opts = {}) {
      const containers = [];
      if (typeof target === 'string' && REF_RE.test(target)) {
        const r = resolve(target);
        if (!r.ok) return r;
        containers.push({ el: r.el, frame: 0 });
      } else {
        for (const { index, doc } of frameDocs()) {
          const found = target ? doc.querySelectorAll(target) : doc.querySelectorAll('form');
          if (found.length) for (const f of found) containers.push({ el: f, frame: index });
          else if (!target && (doc.body || doc.documentElement)) containers.push({ el: doc.body || doc.documentElement, frame: index });
        }
      }
      const out = [];
      for (const { el: form, frame } of containers) {
        const fields = Object.create(null);
        const isForm = tagOf(form) === 'FORM';
        const controls = isForm ? Array.from(FORM_ELEMENTS.call(form)) : Array.from(EP.querySelectorAll.call(form, 'input, select, textarea'));
        for (const el of controls) {
          if (!el.matches('input, select, textarea')) continue;
          if (el.type === 'hidden' && !opts.includeHidden) continue;
          const key = attr(el, 'name') || attr(el, 'id') || clean(nameOf(el), 40);
          if (!key) continue;
          let value;
          if (el.type === 'checkbox' || el.type === 'radio') { if (!el.checked) continue; value = el.value === 'on' ? true : el.value; }
          else value = valueOf(el, 200);
          if (value === '' || value == null) continue;
          if (key in fields) fields[key] = [].concat(fields[key], value);
          else fields[key] = value;
        }
        if (!Object.keys(fields).length) continue;
        const entry = { ref: refFor(form), name: attr(form, 'name') || attr(form, 'id'), fields };
        if (isForm && hasAttr(form, 'action')) entry.action = clean(absolute(attr(form, 'action')), 200);
        if (frame) entry.frame = frame;
        out.push(entry);
      }
      return out;
    },

    // Frames reachable from this document, including ones that cannot be entered.
    frames() {
      return walk(document.documentElement, () => true).slice(1);
    },

    // Track new-window requests (window.open and target=_blank links).
    // 'record' logs and lets them open, 'same-tab' navigates this tab instead,
    // 'block' drops them, 'off' (default) restores window.open.
    capturePopups(mode = 'record') {
      setPopupMode(mode);
      return { ok: true, mode: popupMode };
    },
    popups(opts = {}) {
      const list = popupLog.slice();
      if (opts.clear) popupLog.length = 0;
      return list;
    },

    // Resolves once the document has had no mutations for `quiet` ms (or after `timeout`).
    waitStable(opts = {}) {
      const quiet = opts.quiet || 300;
      const timeout = opts.timeout || 5000;
      const t0 = performance.now();
      return new Promise((done) => {
        let timer = null;
        const finish = (stable) => { obs.disconnect(); clearTimeout(timer); clearTimeout(cap); done({ ok: true, stable, waited: Math.round(performance.now() - t0) }); };
        const obs = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(() => finish(true), quiet); });
        obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
        timer = setTimeout(() => finish(true), quiet);
        const cap = setTimeout(() => finish(false), timeout);
      });
    },

    // Remove listeners, restore window.open and drop the global.
    dispose() {
      setPopupMode('off');
      byRef.clear();
      delete window.__aph__;
      return { ok: true };
    },
  };

  Object.defineProperty(window, '__aph__', { value: api, configurable: true, enumerable: false, writable: false });
})();
