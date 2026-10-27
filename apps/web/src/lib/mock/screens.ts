// Synthetic "screenshots" (SVG data URIs) for the mock shop so the replay UI has something real to scrub.
export type ShopScene = {
  page: 'shop' | 'cart' | 'checkout';
  cart: number;
  /** Highlighted element rect (viewport 1280x800) */
  focus?: { x: number; y: number; w: number; h: number };
  error?: string;
  caption?: string;
};

const products = [
  { name: 'Trail Runner 2', price: '$129.00', hue: 150 },
  { name: 'Ridge Shell', price: '$214.00', hue: 205 },
  { name: 'Summit Pack 28L', price: '$96.00', hue: 28 },
];

export function shopSvg(s: ShopScene): string {
  const cards = products
    .map((p, i) => {
      const x = 64 + i * 392;
      return `<g transform="translate(${x},200)">
  <rect width="360" height="440" rx="14" fill="#fff" stroke="#e6e8ec"/>
  <rect x="16" y="16" width="328" height="250" rx="10" fill="hsl(${p.hue} 38% 90%)"/>
  <circle cx="180" cy="141" r="62" fill="hsl(${p.hue} 42% 62%)" opacity=".85"/>
  <text x="20" y="306" font-family="Inter,Arial" font-size="22" font-weight="600" fill="#12141a">${p.name}</text>
  <text x="20" y="338" font-family="Inter,Arial" font-size="18" fill="#6b7280">${p.price}</text>
  <rect x="20" y="364" width="320" height="48" rx="10" fill="#12141a"/>
  <text x="180" y="395" text-anchor="middle" font-family="Inter,Arial" font-size="17" font-weight="600" fill="#fff">Add to cart</text>
</g>`;
    })
    .join('');
  const body =
    s.page === 'shop'
      ? `<text x="64" y="150" font-family="Inter,Arial" font-size="40" font-weight="700" fill="#12141a">Trail essentials</text>
<text x="64" y="182" font-family="Inter,Arial" font-size="18" fill="#6b7280">Free returns on every order</text>${cards}`
      : s.page === 'cart'
        ? `<text x="64" y="150" font-family="Inter,Arial" font-size="40" font-weight="700" fill="#12141a">Your cart</text>
<rect x="64" y="190" width="760" height="120" rx="14" fill="#fff" stroke="#e6e8ec"/>
<text x="96" y="240" font-family="Inter,Arial" font-size="22" font-weight="600" fill="#12141a">Trail Runner 2</text>
<text x="96" y="276" font-family="Inter,Arial" font-size="18" fill="#6b7280">Qty ${s.cart}  -  $${(129 * Math.max(1, s.cart)).toFixed(2)}</text>
<rect x="64" y="340" width="220" height="52" rx="10" fill="#12141a"/>
<text x="174" y="373" text-anchor="middle" font-family="Inter,Arial" font-size="18" font-weight="600" fill="#fff">Checkout</text>`
        : `<text x="64" y="150" font-family="Inter,Arial" font-size="40" font-weight="700" fill="#12141a">Checkout</text>
<rect x="64" y="190" width="520" height="52" rx="10" fill="#fff" stroke="#d1d5db"/>
<rect x="64" y="262" width="520" height="52" rx="10" fill="#fff" stroke="#d1d5db"/>
<rect x="64" y="340" width="220" height="52" rx="10" fill="#12141a"/>
<text x="174" y="373" text-anchor="middle" font-family="Inter,Arial" font-size="18" font-weight="600" fill="#fff">Place order</text>`;
  const err = s.error
    ? `<rect x="64" y="${s.page === 'checkout' ? 420 : 410}" width="760" height="64" rx="10" fill="#fee2e2" stroke="#f87171"/>
<text x="92" y="${s.page === 'checkout' ? 460 : 450}" font-family="Inter,Arial" font-size="18" font-weight="600" fill="#991b1b">${s.error}</text>`
    : '';
  const focus = s.focus
    ? `<rect x="${s.focus.x}" y="${s.focus.y}" width="${s.focus.w}" height="${s.focus.h}" rx="10" fill="rgba(182,255,59,.16)" stroke="#8fd11a" stroke-width="3" stroke-dasharray="8 5"/>`
    : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 800" width="1280" height="800">
<rect width="1280" height="800" fill="#f6f7f9"/>
<rect width="1280" height="76" fill="#fff"/><line x1="0" y1="76" x2="1280" y2="76" stroke="#e6e8ec"/>
<text x="64" y="48" font-family="Inter,Arial" font-size="24" font-weight="800" fill="#12141a">ridge&amp;co</text>
<text x="880" y="46" font-family="Inter,Arial" font-size="17" fill="#6b7280">Shop</text>
<text x="950" y="46" font-family="Inter,Arial" font-size="17" fill="#6b7280">Journal</text>
<text x="1040" y="46" font-family="Inter,Arial" font-size="17" fill="#6b7280">Account</text>
<circle cx="1180" cy="38" r="22" fill="#12141a"/><text x="1180" y="45" text-anchor="middle" font-family="Inter,Arial" font-size="18" font-weight="700" fill="#fff">${s.cart}</text>
${body}${err}${focus}
${s.caption ? `<text x="64" y="780" font-family="Inter,Arial" font-size="14" fill="#9ca3af">${s.caption}</text>` : ''}
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
