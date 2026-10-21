// ==UserScript==
// @name         Agent Page Helper
// @namespace    https://github.com/Jayyo/agent-page-helper
// @version      0.1.0
// @description  Page-side helper for LLM browser agents: compact snapshots, stable element ids, controlled-input fill, occlusion checks, frame traversal.
// @author       Jay Cho
// @match        *://*/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';
    if (window.__aph__) return; // already injected (re-created frames, duplicate injection)

    const CONFIG = {
        MAX_INTERACTIVE_ELEMENTS: 100, MAX_TEXT_LENGTH: 50, MAX_CONTENT_LENGTH: 1000,
        CACHE_TTL_MS: 500, MUTATION_DEBOUNCE_MS: 100, MAX_DOM_DEPTH: 50, MAX_FRAME_DEPTH: 10
    };

    // ===== stable ids (WeakMap: no attributes written into the DOM; works for elements of child frames) =====
    const elementIdMap = new WeakMap();
    const idToElementMap = new Map();
    let idCounter = 0;
    function getStableId(el) {
        if (elementIdMap.has(el)) return elementIdMap.get(el);
        const id = `e${++idCounter}`;
        elementIdMap.set(el, id); idToElementMap.set(id, el); return id;
    }
    function getElementById(id) {
        const el = idToElementMap.get(id);
        if (el && el.isConnected) return el;   // isConnected also works inside shadow roots and frames
        idToElementMap.delete(id); return null;
    }
    function validateElement(id, v = {}) {
        const el = getElementById(id);
        if (!el) return { valid: false, error: 'Element not found or removed from DOM' };
        if (v.tag && el.tagName.toLowerCase() !== v.tag.toLowerCase())
            return { valid: false, error: `Tag mismatch: expected ${v.tag}, got ${el.tagName.toLowerCase()}` };
        if (v.text) { const t = (el.textContent || '').trim().toLowerCase(); if (!t.includes(v.text.toLowerCase())) return { valid: false, error: `Text mismatch: "${v.text}" not in element` }; }
        if (v.role) { const r = el.getAttribute('role') || getImplicitRole(el); if (r !== v.role) return { valid: false, error: `Role mismatch: expected ${v.role}, got ${r}` }; }
        return { valid: true, element: el };
    }

    // ===== collect same-origin frame documents (<iframe> and frameset <frame>) =====
    function collectDocs() {
        const docs = [document];
        (function walk(doc, depth) {
            if (depth > CONFIG.MAX_FRAME_DEPTH) return;
            let frames; try { frames = doc.querySelectorAll('iframe,frame'); } catch (e) { return; }
            for (const fr of frames) {
                let d; try { d = fr.contentDocument; } catch (e) { continue; } // cross-origin: skip
                if (d) { docs.push(d); walk(d, depth + 1); }
            }
        })(document, 0);
        return docs;
    }

    // ===== DOM walker (open shadow + same-origin iframe/frame) =====
    function walkDOM(root, cb, opt = {}) {
        const { includeShadow = true, includeFrames = true, maxDepth = CONFIG.MAX_DOM_DEPTH } = opt;
        const visited = new WeakSet();
        (function walk(node, depth) {
            if (depth > maxDepth || !node || visited.has(node)) return;
            visited.add(node);
            if (node.nodeType === Node.ELEMENT_NODE) cb(node, depth);
            if (includeShadow && node.shadowRoot) walk(node.shadowRoot, depth + 1);
            const kids = node.children || node.childNodes;
            for (const c of kids) if (c.nodeType === Node.ELEMENT_NODE) walk(c, depth + 1);
            if (includeFrames && (node.tagName === 'IFRAME' || node.tagName === 'FRAME')) {  // includes frameset <frame>
                try { const d = node.contentDocument; if (d && (d.body || d.documentElement)) walk(d.body || d.documentElement, depth + 1); } catch (e) { /* cross-origin */ }
            }
        })(root, 0);
    }

    const INTERACTIVE_TAGS = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'DETAILS', 'SUMMARY', 'DIALOG', 'MENU', 'MENUITEM']);
    const INTERACTIVE_ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'tab', 'tabpanel', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'combobox', 'textbox', 'searchbox', 'slider', 'spinbutton', 'switch', 'listbox', 'gridcell', 'treeitem', 'row']);
    const LANDMARK_ROLES = new Set(['banner', 'navigation', 'main', 'complementary', 'contentinfo', 'search', 'form', 'region']);

    function isVisible(el) {
        if (!el) return false;
        if (el.hidden || el.getAttribute('aria-hidden') === 'true') return false;
        const win = (el.ownerDocument.defaultView || window);
        const s = win.getComputedStyle(el);
        if (!s || s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) return false;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return false;
        return true;
    }
    function isInteractive(el) {
        if (INTERACTIVE_TAGS.has(el.tagName)) return true;
        const role = el.getAttribute('role');
        if (role && INTERACTIVE_ROLES.has(role)) return true;
        if (el.hasAttribute('onclick') || el.hasAttribute('onkeydown') || el.hasAttribute('onkeyup')) return true;
        if (el.tabIndex >= 0 || el.contentEditable === 'true') return true;
        try { if ((el.ownerDocument.defaultView || window).getComputedStyle(el).cursor === 'pointer') { const t = (el.textContent || '').trim(); if (t.length > 0 && t.length < 200) return true; } } catch (e) {}
        return false;
    }
    function getImplicitRole(el) {
        const tag = el.tagName, type = (el.type || '').toLowerCase();
        const m = { 'A': el.href ? 'link' : null, 'BUTTON': 'button', 'INPUT': { button: 'button', submit: 'button', reset: 'button', checkbox: 'checkbox', radio: 'radio', range: 'slider', text: 'textbox', email: 'textbox', password: 'textbox', search: 'searchbox', tel: 'textbox', url: 'textbox', number: 'spinbutton' }[type] || 'textbox', 'SELECT': 'combobox', 'TEXTAREA': 'textbox', 'NAV': 'navigation', 'MAIN': 'main', 'HEADER': 'banner', 'FOOTER': 'contentinfo', 'ASIDE': 'complementary', 'FORM': 'form', 'ARTICLE': 'article', 'SECTION': (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')) ? 'region' : null };
        return m[tag] || null;
    }
    function getLandmarkRole(el) { const r = el.getAttribute('role'); return (r && LANDMARK_ROLES.has(r)) ? r : getImplicitRole(el); }
    function getAccessibleName(el) {
        const al = el.getAttribute('aria-label'); if (al) return al;
        const lb = el.getAttribute('aria-labelledby'); if (lb) { const e = (el.ownerDocument).getElementById(lb); if (e) return (e.textContent || '').trim(); }
        if (el.id) { try { const l = el.ownerDocument.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) return (l.textContent || '').trim(); } catch (e) {} }
        const t = (el.textContent || '').trim(); if (t && t.length < 200) return t;
        return el.alt || el.title || el.placeholder || '';
    }
    function truncate(s, n) { if (!s) return ''; s = ('' + s).trim().replace(/\s+/g, ' '); return s.length <= n ? s : s.slice(0, n - 3) + '...'; }
    function ariaErrText(el, doc) {  // error text of an aria-invalid field via aria-errormessage/aria-describedby
        const ref = el.getAttribute('aria-errormessage') || el.getAttribute('aria-describedby');
        if (ref) { for (const id of ref.split(/\s+/)) { try { const e = doc.getElementById(id); if (e) { const t = (e.textContent || '').trim(); if (t) return truncate(t, 200); } } catch (x) {} } }
        return el.validationMessage || '';
    }

    // ===== native value setter (controlled inputs: React, Vue, WebSquare, Nexacro) =====
    function nativeSetValue(el, value) {
        let proto;
        if (el instanceof HTMLTextAreaElement) proto = HTMLTextAreaElement.prototype;
        else if (el instanceof HTMLSelectElement) proto = HTMLSelectElement.prototype;
        else proto = HTMLInputElement.prototype;
        const d = Object.getOwnPropertyDescriptor(proto, 'value');
        if (d && d.set) d.set.call(el, value); else el.value = value;
    }

    // ===== snapshot (frameset documents have no <body>: walk documentElement) =====
    let cachedSnapshot = null, cacheTimestamp = 0, observerStarted = false;
    function startObserver() {
        if (observerStarted || !document.documentElement) return;
        observerStarted = true; let t = null;
        new MutationObserver(() => { clearTimeout(t); t = setTimeout(() => { cachedSnapshot = null; }, CONFIG.MUTATION_DEBOUNCE_MS); })
            .observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'disabled', 'aria-hidden'] });
    }
    function generateSnapshot(force) {
        startObserver();
        if (!force && cachedSnapshot && Date.now() - cacheTimestamp < CONFIG.CACHE_TTL_MS) return cachedSnapshot;
        const interactive = [], landmarks = [], headings = [], forms = [];
        const root = document.body || document.documentElement;   // frameset pages
        if (root) walkDOM(root, (el) => {
            if (!isVisible(el)) return;
            const tag = el.tagName.toLowerCase();
            if (isInteractive(el)) interactive.push({ id: getStableId(el), tag, role: el.getAttribute('role') || getImplicitRole(el), text: truncate(getAccessibleName(el), CONFIG.MAX_TEXT_LENGTH), href: el.href ? truncate(el.href, 100) : undefined, type: el.type || undefined, disabled: el.disabled || undefined, checked: el.checked, value: el.value ? truncate(el.value, 30) : undefined, placeholder: el.placeholder ? truncate(el.placeholder, 30) : undefined });
            const lr = getLandmarkRole(el);
            if (lr && LANDMARK_ROLES.has(lr)) landmarks.push({ id: getStableId(el), role: lr, label: truncate(el.getAttribute('aria-label') || '', 50) });
            if (/^H[1-6]$/.test(el.tagName)) headings.push({ id: getStableId(el), level: +el.tagName[1], text: truncate(el.textContent, 80) });
            if (tag === 'form') forms.push({ id: getStableId(el), name: el.name || el.id || '', action: el.action ? truncate(el.action, 100) : undefined });
        });
        const clean = arr => arr.map(o => { const c = {}; for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') c[k] = v; return c; });
        cachedSnapshot = { url: location.href, title: document.title, untrusted: true, interactive: clean(interactive.slice(0, CONFIG.MAX_INTERACTIVE_ELEMENTS)), landmarks: clean(landmarks), headings: clean(headings), forms: clean(forms), mainContent: extractMainContent(), stats: { totalInteractive: interactive.length, shown: Math.min(interactive.length, CONFIG.MAX_INTERACTIVE_ELEMENTS) }, timestamp: Date.now() };
        cacheTimestamp = Date.now(); return cachedSnapshot;
    }
    function extractMainContent() {
        for (const sel of ['main', '[role="main"]', 'article', '.main-content', '#main-content', '.content', '#content']) { const el = document.querySelector(sel); if (el) return truncate(el.innerText, CONFIG.MAX_CONTENT_LENGTH); }
        return truncate((document.body || document.documentElement || {}).innerText || '', CONFIG.MAX_CONTENT_LENGTH / 2);
    }

    function occlusion(el) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return { offscreen: true };
        const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
        if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) return { offscreen: true };
        const doc = el.ownerDocument; let top;
        try { top = doc.elementsFromPoint(cx, cy)[0]; } catch (e) { return { occluded: false }; }
        if (!top) return { occluded: false };
        const ok = top === el || el.contains(top) || top.contains(el);
        return ok ? { occluded: false } : { occluded: true, by: top.tagName.toLowerCase() + (top.className ? '.' + String(top.className).split(' ')[0] : '') };
    }

    // ===== window.open / target=_blank capture =====
    const openLog = [];
    let openMode = 'record';   // 'record' = log the URL and open as usual | 'nav' = same tab | 'block'
    try {
        const realOpen = window.open.bind(window);
        const fakeOpen = function (url, name, feat) {
            const u = url ? String(url) : '';
            if (u) { window.__aph__.lastOpen = u; openLog.push({ url: u, name: name || '', ts: Date.now() }); }
            if (u && openMode === 'nav') { location.assign(u); return stubWin(); }
            if (openMode === 'block') return stubWin();
            return realOpen(url, name, feat);
        };
        const stubWin = () => ({ closed: false, focus() {}, blur() {}, close() { this.closed = true; }, postMessage() {}, get opener() { return window; }, get location() { return window.location; } });
        Object.defineProperty(window, 'open', { configurable: true, get: () => fakeOpen, set() {} });
        window.__aphRealOpen = realOpen;  // escape hatch for popups that must really open
    } catch (e) {}
    document.addEventListener('click', function (e) {
        const a = e.target && e.target.closest && e.target.closest('a[target]'); if (!a) return;
        const t = (a.getAttribute('target') || '').toLowerCase();
        if (t !== '_blank' && t !== '_new') return;
        if (!a.href || a.href.startsWith('javascript:') || a.href.startsWith('#')) return;
        window.__aph__.lastOpen = a.href; openLog.push({ url: a.href, via: 'anchor', ts: Date.now() });
        if (openMode === 'nav' || openMode === 'block') { e.preventDefault(); e.stopPropagation(); if (openMode === 'nav') location.assign(a.href); }
    }, true);

    // ===== public API =====
    window.__aph__ = {
        version: '0.1.0',
        lastOpen: null,
        getSnapshot(o = {}) { return generateSnapshot(o.forceRefresh); },
        getInteractive(o = {}) { const { limit = 50, filter = null, role = null } = o; let items = generateSnapshot().interactive; if (filter) { const f = filter.toLowerCase(); items = items.filter(e => (e.text || '').toLowerCase().includes(f) || (e.role || '').toLowerCase().includes(f) || (e.placeholder || '').toLowerCase().includes(f)); } if (role) items = items.filter(e => e.role === role); return items.slice(0, limit); },
        findByText(text, o = {}) { const { tag = null, exact = false, limit = 10 } = o; const out = []; const root = document.body || document.documentElement; if (root) walkDOM(root, (el) => { if (!isVisible(el)) return; if (tag && el.tagName.toLowerCase() !== tag.toLowerCase()) return; const c = getAccessibleName(el); if (!c) return; if (exact ? c === text : c.toLowerCase().includes(text.toLowerCase())) out.push({ id: getStableId(el), tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || getImplicitRole(el), text: truncate(c, CONFIG.MAX_TEXT_LENGTH), interactive: isInteractive(el) }); }); return out.slice(0, limit); },
        findBySelector(sel, o = {}) { const { limit = 10 } = o; const out = []; try { for (const el of document.querySelectorAll(sel)) { if (out.length >= limit) break; if (!isVisible(el)) continue; out.push({ id: getStableId(el), tag: el.tagName.toLowerCase(), text: truncate(getAccessibleName(el), CONFIG.MAX_TEXT_LENGTH) }); } } catch (e) { return { error: `Invalid selector: ${e.message}` }; } return out; },

        // ===== frame traversal (frameset / same-origin iframes) =====
        // querySelectorAll across all same-origin frames; matches get stable ids usable with click/fill
        queryAll(sel, o = {}) {
            const { limit = 50, visibleOnly = true } = o; const out = [];
            collectDocs().forEach((doc, di) => {
                let els; try { els = doc.querySelectorAll(sel); } catch (e) { return; }
                for (const el of els) { if (out.length >= limit) break; if (visibleOnly && !isVisible(el)) continue; out.push({ id: getStableId(el), frame: di, frameUrl: di === 0 ? 'top' : (doc.defaultView && doc.defaultView.frameElement ? (doc.defaultView.frameElement.name || doc.URL) : doc.URL), tag: el.tagName.toLowerCase(), text: truncate(getAccessibleName(el), CONFIG.MAX_TEXT_LENGTH) }); }
            });
            return out;
        },
        // frame structure, for frameset pages whose top document is empty
        frames() {
            const out = []; const docs = collectDocs();
            docs.forEach((doc, di) => { const fe = doc.defaultView && doc.defaultView.frameElement; out.push({ index: di, url: doc.URL, name: (fe && fe.name) || (di === 0 ? '(top)' : ''), interactiveCount: (() => { let n = 0; try { doc.querySelectorAll('a,button,input,select,textarea').forEach(e => { if (isVisible(e)) n++; }); } catch (x) {} return n; })() }); });
            return out;
        },

        click(id, v = {}) { const r = validateElement(id, v); if (!r.valid) return { success: false, error: r.error }; const occ = occlusion(r.element); try { r.element.click(); return { success: true, id, occlusion: occ.occluded ? occ : undefined, offscreen: occ.offscreen || undefined }; } catch (e) { return { success: false, error: e.message }; } },
        fill(id, value, v = {}) { const r = validateElement(id, v); if (!r.valid) return { success: false, error: r.error }; const el = r.element; try { el.focus(); if (el.isContentEditable) el.textContent = value; else nativeSetValue(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); el.dispatchEvent(new Event('blur', { bubbles: true })); return { success: true, id, value: el.isContentEditable ? el.textContent : el.value }; } catch (e) { return { success: false, error: e.message }; } },
        select(id, value, v = {}) { const r = validateElement(id, v); if (!r.valid) return { success: false, error: r.error }; const el = r.element; try { if (el.tagName === 'SELECT') { let opt = [...el.options].find(o => o.value === value) || [...el.options].find(o => (o.textContent || '').trim() === value); if (!opt) return { success: false, error: `option not found: ${value}` }; nativeSetValue(el, opt.value); } else nativeSetValue(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return { success: true, id, value: el.value }; } catch (e) { return { success: false, error: e.message }; } },
        focus(id) { const el = getElementById(id); if (!el) return { success: false, error: 'Element not found' }; try { el.focus(); return { success: true, id }; } catch (e) { return { success: false, error: e.message }; } },
        scrollTo(id, o = {}) { const el = getElementById(id); if (!el) return { success: false, error: 'Element not found' }; try { el.scrollIntoView({ behavior: o.smooth !== false ? 'smooth' : 'instant', block: o.block || 'center', inline: o.inline || 'nearest' }); return { success: true, id }; } catch (e) { return { success: false, error: e.message }; } },
        getElement(id) { const el = getElementById(id); if (!el) return { found: false }; const rect = el.getBoundingClientRect(); return { found: true, tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || getImplicitRole(el), text: truncate(getAccessibleName(el), CONFIG.MAX_TEXT_LENGTH), visible: isVisible(el), interactive: isInteractive(el), occlusion: occlusion(el), rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }, attributes: { id: el.id || undefined, class: el.className || undefined, href: el.href || undefined, disabled: el.disabled || undefined } }; },
        attr(id, name) { const el = getElementById(id); if (!el) return { error: 'not found' }; return { value: el.getAttribute(name) }; },

        // ===== validation errors (read-only, all same-origin frames) =====
        getErrors() {
            const out = [];
            collectDocs().forEach((doc, di) => {
                // 1) HTML5 constraint validation (:invalid + validationMessage)
                let fields; try { fields = doc.querySelectorAll('input,select,textarea'); } catch (e) { return; }
                for (const el of fields) {
                    try {
                        if (el.willValidate && !el.validity.valid) {
                            out.push({ frame: di, kind: 'constraint', id: getStableId(el), field: el.name || el.id || '', message: el.validationMessage || '', value: truncate(el.value, 40) });
                        }
                        if (el.getAttribute('aria-invalid') === 'true') {
                            out.push({ frame: di, kind: 'aria-invalid', id: getStableId(el), field: el.name || el.id || '', message: ariaErrText(el, doc) });
                        }
                    } catch (e) {}
                }
                // 2) visible error-message elements rendered by frameworks
                let msgs; try { msgs = doc.querySelectorAll('[role="alert"],.error,.invalid,.help-block,.field-error,.errorMessage,.error-message,.invalid-feedback,.text-danger,.has-error'); } catch (e) { return; }
                for (const m of msgs) {
                    if (!isVisible(m)) continue;
                    const t = (m.textContent || '').trim();
                    if (t && t.length < 300) out.push({ frame: di, kind: 'message', id: getStableId(m), text: truncate(t, 200) });
                }
            });
            return out;
        },

        // ===== current form values (read-only, all same-origin frames) =====
        exportForm(formSel) {
            const forms = [];
            collectDocs().forEach((doc, di) => {
                let formEls; try { formEls = formSel ? doc.querySelectorAll(formSel) : doc.querySelectorAll('form'); } catch (e) { return; }
                // pages without <form> elements (common in widget frameworks): use the body
                const targets = formEls.length ? [...formEls] : [doc.body || doc.documentElement].filter(Boolean);
                targets.forEach((form, fi) => {
                    const fields = {};
                    let inputs; try { inputs = form.querySelectorAll('input,select,textarea'); } catch (e) { return; }
                    for (const el of inputs) {
                        const key = el.name || el.id || el.getAttribute('aria-label') || el.placeholder;
                        if (!key) continue;
                        let val;
                        if (el.type === 'checkbox' || el.type === 'radio') { if (!el.checked) continue; val = el.value || true; }
                        else if (el.type === 'password') val = '••••(' + (el.value || '').length + ')';   // never export password values
                        else val = el.value;
                        if (val === '' || val == null) continue;
                        fields[key] = typeof val === 'string' ? truncate(val, 200) : val;
                    }
                    if (Object.keys(fields).length) forms.push({ frame: di, formIndex: fi, name: form.name || form.id || '', action: form.action || undefined, fields });
                });
            });
            return forms;
        },

        // ===== popups ('record' by default: log only; 'nav' = same tab; 'block') =====
        popupLog() { return openLog.slice(); },
        setOpenMode(mode) { openMode = mode; return { openMode }; },
        getOpenMode() { return { openMode, lastOpen: this.lastOpen, count: openLog.length }; },

        waitStable(timeout = 3000) { return new Promise(resolve => { let timer; const obs = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(() => { obs.disconnect(); resolve({ stable: true }); }, 200); }); obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true }); timer = setTimeout(() => { obs.disconnect(); resolve({ stable: true }); }, 200); setTimeout(() => { obs.disconnect(); resolve({ stable: false, reason: 'timeout' }); }, timeout); }); },
        cleanup() { let removed = 0; for (const [id, el] of idToElementMap.entries()) if (!el.isConnected) { idToElementMap.delete(id); removed++; } return { removed, remaining: idToElementMap.size }; },
        health() { return { version: this.version, runAt: 'document-start', isTop: window.top === window, url: location.href, idMapSize: idToElementMap.size, openMode, openLog: openLog.length }; },
        debug() { return this.health(); }
    };
    window.__aphReady = true;   // e.g. page.waitForFunction(() => window.__aphReady)
})();
