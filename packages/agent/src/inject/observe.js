// Evaluated in the page as a function expression: (opts) => raw observation.
// Tags interactable elements with data-gremlin-ref="e<N>" (stable per element).
(opts) => {
  const MAX = (opts && opts.max) || 150;
  const MAX_TEXT_CHARS = (opts && opts.maxTextChars) || 6000;
  const SEL = [
    'a[href]', 'button', 'input:not([type=hidden])', 'textarea', 'select', 'summary',
    '[role=button]', '[role=link]', '[role=checkbox]', '[role=tab]', '[role=menuitem]',
    '[role=switch]', '[role=radio]', '[role=combobox]', '[role=option]',
    '[onclick]', '[contenteditable=""]', '[contenteditable=true]',
  ].join(',');
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

  const isHidden = (el) => {
    if (el.closest('[hidden],[aria-hidden=true]')) return true;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return true;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return true;
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (getComputedStyle(p).display === 'none') return true;
    }
    return false;
  };

  const roleOf = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.split(/\s+/)[0];
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (['button', 'submit', 'reset', 'image'].includes(t)) return 'button';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'range') return 'slider';
      if (t === 'search') return 'searchbox';
      return 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    return 'generic';
  };

  const nameOf = (el) => {
    const al = clean(el.getAttribute('aria-label'));
    if (al) return al;
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const t = clean(lb.split(/\s+/).map((id) => {
        const n = document.getElementById(id);
        return n ? n.textContent : '';
      }).join(' '));
      if (t) return t;
    }
    if (el.labels && el.labels.length) {
      const t = clean(Array.from(el.labels).map((l) => l.textContent).join(' '));
      if (t) return t.slice(0, 80);
    }
    const ph = clean(el.getAttribute('placeholder'));
    if (ph) return ph;
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      const t = (el.getAttribute('type') || '').toLowerCase();
      if (['button', 'submit', 'reset'].includes(t)) {
        const v = clean(el.value);
        if (v) return v.slice(0, 80);
      }
    }
    const alt = clean(el.getAttribute('alt')) || clean(el.getAttribute('title'));
    if (alt) return alt.slice(0, 80);
    if (tag === 'select' || tag === 'textarea' || tag === 'input') return clean(el.getAttribute('name')).slice(0, 80);
    let txt = clean(el.innerText || el.textContent);
    if (!txt) {
      const img = el.querySelector('img[alt]');
      if (img) txt = clean(img.getAttribute('alt'));
    }
    return txt.slice(0, 80);
  };

  const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role=heading]'));
  const sectionOf = (el) => {
    const lm = el.closest('form,section,article,[role=region],[role=dialog],nav,aside,header,footer,main,[role=main],[role=navigation]');
    const lab = lm ? clean(lm.getAttribute('aria-label')) : '';
    if (lab) return lab.slice(0, 60);
    let best = null;
    for (const h of headings) {
      if (h.contains(el) || (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) best = h;
      else break;
    }
    if (best) {
      const t = clean(best.textContent);
      if (t) return t.slice(0, 60);
    }
    if (lm) return lm.getAttribute('role') || lm.tagName.toLowerCase();
    return undefined;
  };

  // allocate new ref numbers after the highest existing one
  let max = 0;
  document.querySelectorAll('[data-gremlin-ref]').forEach((e) => {
    const n = parseInt((e.getAttribute('data-gremlin-ref') || '').slice(1), 10);
    if (n > max) max = n;
  });
  let next = max + 1;

  const vh = window.innerHeight, vw = window.innerWidth;
  const all = [];
  for (const el of document.querySelectorAll(SEL)) {
    if (isHidden(el)) continue;
    const r = el.getBoundingClientRect();
    const inViewport = r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
    all.push({ el, inViewport });
  }
  const ordered = all.filter((x) => x.inViewport).concat(all.filter((x) => !x.inViewport));
  const items = [];
  for (const { el, inViewport } of ordered.slice(0, MAX)) {
    let ref = el.getAttribute('data-gremlin-ref');
    if (!ref) { ref = 'e' + next++; el.setAttribute('data-gremlin-ref', ref); }
    const it = {
      ref, role: roleOf(el), name: nameOf(el),
      disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
      inViewport,
    };
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (tag === 'input' && (type === 'checkbox' || type === 'radio')) {
      it.value = el.checked ? 'checked' : 'unchecked';
    } else if ((tag === 'input' || tag === 'textarea' || tag === 'select') && type !== 'password' && el.value) {
      it.value = String(el.value).slice(0, 80);
    }
    const sec = sectionOf(el);
    if (sec) it.section = sec;
    items.push(it);
  }

  // alerts: conservative, only explicit alert / live regions with text
  const alerts = [];
  document.querySelectorAll('[role=alert],[aria-live=assertive],[aria-live=polite]').forEach((e) => {
    if (isHidden(e)) return;
    const t = clean(e.textContent);
    if (t && !alerts.includes(t)) alerts.push(t.slice(0, 300));
  });

  // text digest
  const heads = [];
  document.querySelectorAll('h1,h2,h3').forEach((h) => {
    if (isHidden(h)) return;
    const t = clean(h.textContent);
    if (t) heads.push(t.slice(0, 120));
  });
  const mainEl = document.querySelector('main,[role=main]') || document.body;
  let text = '';
  if (mainEl) {
    const walker = document.createTreeWalker(mainEl, NodeFilter.SHOW_TEXT);
    const parts = [];
    let len = 0;
    while (len < MAX_TEXT_CHARS * 2 && walker.nextNode()) {
      const p = walker.currentNode.parentElement;
      if (!p || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(p.tagName)) continue;
      const t = clean(walker.currentNode.nodeValue);
      if (!t || isHidden(p)) continue;
      parts.push(t);
      len += t.length + 1;
    }
    text = parts.join(' ');
  }
  return {
    title: document.title, items, alerts: alerts.slice(0, 10), headings: heads.slice(0, 20),
    text: text.slice(0, MAX_TEXT_CHARS * 2), total: all.length,
  };
}
