// Hand-built rrweb event stream for the mock shop: a full snapshot + a few incremental events,
// enough for rrweb-player to render an inspectable DOM and a live-changing cart badge.
export const MOCK_T0 = 1_760_000_000_000;

type RNode = Record<string, unknown>;
let nextId = 1;
const id = () => nextId++;

const text = (t: string): RNode => ({ type: 3, textContent: t, id: id() });
const el = (tagName: string, attributes: Record<string, string>, childNodes: RNode[] = []): RNode => ({
  type: 2,
  tagName,
  attributes,
  childNodes,
  id: id(),
});

export type MockRrweb = { events: Record<string, unknown>[]; durationMs: number };

export function mockRrwebEvents(opts: { fixed: boolean }): MockRrweb {
  nextId = 1;
  const doctype: RNode = { type: 1, name: 'html', publicId: '', systemId: '', id: id() };
  const countText = text('0');
  const badge = el(
    'span',
    {
      'data-testid': 'cart-count',
      style:
        'display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:999px;background:#12141a;color:#fff;font:700 15px Inter,Arial',
    },
    [countText],
  );
  let firstBtn: RNode | null = null;
  const addBtn = (name: string, ref: string): RNode => {
    const b = el(
      'button',
      {
        'data-gremlin-ref': ref,
        'aria-label': `Add ${name} to cart`,
        style:
          'width:100%;padding:12px;border:0;border-radius:10px;background:#12141a;color:#fff;font:600 15px Inter,Arial;margin-top:14px',
      },
      [text('Add to cart')],
    );
    firstBtn ??= b;
    return b;
  };
  const card = (name: string, price: string, hue: number, ref: string): RNode =>
    el(
      'article',
      { class: 'card', style: 'background:#fff;border:1px solid #e6e8ec;border-radius:14px;padding:16px;width:300px' },
      [
        el('div', { style: `height:190px;border-radius:10px;background:hsl(${hue} 38% 90%)` }),
        el('h3', { style: 'font:600 19px Inter,Arial;margin:16px 0 4px;color:#12141a' }, [text(name)]),
        el('p', { style: 'font:15px Inter,Arial;margin:0;color:#6b7280' }, [text(price)]),
        addBtn(name, ref),
      ],
    );
  const main = el('main', { style: 'padding:40px 48px' }, [
    el('h1', { style: 'font:700 34px Inter,Arial;margin:0 0 6px;color:#12141a' }, [text('Trail essentials')]),
    el('p', { style: 'font:16px Inter,Arial;margin:0 0 28px;color:#6b7280' }, [text('Free returns on every order')]),
    el('section', { style: 'display:flex;gap:24px' }, [
      card('Trail Runner 2', '$129.00', 150, 'e12'),
      card('Ridge Shell', '$214.00', 205, 'e13'),
      card('Summit Pack 28L', '$96.00', 28, 'e14'),
    ]),
  ]);
  const header = el(
    'header',
    { style: 'display:flex;justify-content:space-between;align-items:center;padding:20px 48px;background:#fff;border-bottom:1px solid #e6e8ec' },
    [el('strong', { style: 'font:800 22px Inter,Arial;color:#12141a' }, [text('ridge&co')]), badge],
  );
  const body = el('body', { style: 'margin:0;background:#f6f7f9' }, [header, main]);
  const html = el('html', { lang: 'en' }, [el('head', {}, [el('title', {}, [text('ridge&co - Shop')])]), body]);
  const doc: RNode = { type: 0, childNodes: [doctype, html], id: id() };

  const t = (ms: number) => MOCK_T0 + ms;
  const events: Record<string, unknown>[] = [
    { type: 4, data: { href: 'https://shop.example.test/shop', width: 1280, height: 800 }, timestamp: t(0) },
    { type: 2, data: { node: doc, initialOffset: { left: 0, top: 0 } }, timestamp: t(8) },
  ];
  const textMut = (ms: number, value: string) =>
    events.push({ type: 3, data: { source: 0, texts: [{ id: (countText as { id: number }).id, value }], attributes: [], removes: [], adds: [] }, timestamp: t(ms) });
  const move = (ms: number, x: number, y: number) =>
    events.push({ type: 3, data: { source: 1, positions: [{ x, y, id: 1, timeOffset: 0 }] }, timestamp: t(ms) });
  const click = (ms: number, x: number, y: number) =>
    events.push({ type: 3, data: { source: 2, type: 2, id: (firstBtn as unknown as { id: number }).id, x, y }, timestamp: t(ms) });

  move(900, 200, 300);
  move(1700, 280, 560);
  click(1800, 280, 560);
  textMut(1900, '1');
  move(3300, 290, 560);
  click(3400, 290, 560);
  // Bug: the badge never increments in the failing run.
  if (opts.fixed) textMut(3500, '2');
  move(7000, 140, 366);
  if (!opts.fixed) {
    const banner = el(
      'div',
      { role: 'alert', style: 'margin:24px 48px;padding:18px 22px;background:#fee2e2;border:1px solid #f87171;border-radius:10px;font:600 16px Inter,Arial;color:#991b1b' },
      [text('Something went wrong. Please try again.')],
    );
    events.push({
      type: 3,
      data: { source: 0, texts: [], attributes: [], removes: [], adds: [{ parentId: (body as { id: number }).id, nextId: null, node: banner }] },
      timestamp: t(7300),
    });
  }
  events.push({ type: 3, data: { source: 1, positions: [{ x: 700, y: 400, id: 1, timeOffset: 0 }] }, timestamp: t(10000) });
  return { events, durationMs: 10000 };
}
