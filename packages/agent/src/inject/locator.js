// Evaluated in the page against the live element: derives candidate locator parts.
(el) => {
  const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim();
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute('type') ?? 'text').toLowerCase();

  const implicitRole = () => {
    const m = {
      button: 'button', select: 'combobox', textarea: 'textbox', summary: 'button',
      h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading',
    };
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : null;
    if (tag === 'input') {
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      if (type === 'search') return 'searchbox';
      if (['hidden', 'file', 'color', 'date', 'time', 'datetime-local', 'month', 'week', 'password'].includes(type)) return null;
      return 'textbox';
    }
    return m[tag] ?? null;
  };
  const role = clean(el.getAttribute('role')).split(' ')[0] || implicitRole();

  const labels = el.labels;
  const labelText = labels && labels.length ? clean(labels[0].textContent) : '';
  const ariaLabel = clean(el.getAttribute('aria-label'));
  let name = '';
  const lb = el.getAttribute('aria-labelledby');
  if (lb) name = clean(lb.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' '));
  if (!name) name = ariaLabel;
  if (!name && labelText) name = labelText;
  if (!name && tag === 'input' && ['button', 'submit', 'reset'].includes(type)) name = clean(el.value);
  if (!name && tag === 'img') name = clean(el.getAttribute('alt'));
  if (!name && !['input', 'textarea', 'select'].includes(tag)) name = clean(el.textContent);
  if (!name) name = clean(el.getAttribute('title')) || clean(el.getAttribute('placeholder'));

  const ownText = ['input', 'textarea', 'select'].includes(tag) ? '' : clean(el.textContent);

  const parts = [];
  for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
    const parent = n.parentElement;
    const idx = parent ? Array.prototype.indexOf.call(parent.children, n) + 1 : 1;
    parts.unshift(`${n.tagName.toLowerCase()}:nth-child(${idx})`);
  }
  return {
    testId: el.getAttribute('data-testid'),
    role,
    name,
    label: labelText || ariaLabel || null,
    placeholder: clean(el.getAttribute('placeholder')) || null,
    text: ownText && ownText.length <= 80 ? ownText : null,
    css: 'html > ' + parts.join(' > '),
  };
}
