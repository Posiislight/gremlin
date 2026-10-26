# Brief for Alan: build the Gremlin demo shop (`apps/demo-target`)

You are building a small kayak/outdoor web shop that is **deliberately broken in exactly 12 ways**.
A QA robot will later hunt for these bugs, so each bug must be present, reproducible and
unambiguous. **Implement every bug on purpose. Do NOT fix them. Do NOT add extra bugs.**

The definition of done is: `tests/seeded-bugs.spec.ts` passes 15/15. It is already written.
**Do not modify `tests/seeded-bugs.spec.ts`, `seed.json` or `playwright.config.ts`.**
If a test seems wrong, re-read this brief; the contract below matches the tests exactly.

## 1. Stack and constraints

- Next.js (App Router) + TypeScript. Put the app inside `apps/demo-target` (already has `package.json`,
  `tsconfig.json`, `playwright.config.ts`, `seed.json`, `tests/`). Add `next`, `react`, `react-dom` and
  `@types/react` to this package. Do not remove the existing devDependencies.
- Port **3100** for dev and start.
- **No external database.** Data lives in cookies and static seed data (no server-side mutable state). It must deploy to Vercel,
  so **no filesystem writes at runtime**. Importing `seed.json` at build time is fine.
- **TODO-for-Alan:** replace the placeholder `dev`, `build`, `start` scripts in `package.json`
  with `next dev -p 3100`, `next build`, `next start -p 3100`. They currently just fail on purpose.
- Keep `test:bugs` (`playwright test`) and `typecheck` scripts as they are. Make `tsc --noEmit` pass:
  add `next-env.d.ts`/Next plugin settings to `tsconfig.json` and `"jsx": "preserve"` as Next needs,
  and add `.tsx` files to `include`. Keep `tests` and `playwright.config.ts` in `include`.
- Visual quality: it should look like a plausible small kayak shop (clean layout, header, footer,
  product cards). Nice to have, but secondary. Do not spend time on it before the tests pass.

## 2. Test credentials (also in `seed.json`)

| persona | email | password | role | bio |
|---|---|---|---|---|
| guest | none | none | no account | n/a |
| customer | `ann@example.com` | `Passw0rd!ann` | customer | **empty string** (needed for bug 3) |
| admin | `root@example.com` | `Passw0rd!root` | admin | `Runs the shop.` |

Products (ids 1 to 6, prices in cents, thumbnail path) and coupons are in `seed.json`. Read it from there.
Create simple SVG thumbnails `public/images/product-1.svg` ... `product-6.svg` (a colored rectangle with
the product name is fine).

Coupons: `SAVE10` = 10 percent off, `SUMMER20` = 20 percent off, `PADDLE5` = 500 cents off. Codes are
case-sensitive uppercase in the table.

## 3. Sessions, cart and orders (design decisions, follow them)

- **Session:** `POST /api/login` sets an httpOnly cookie `session` whose value is
  `base64(JSON.stringify({email, role, name}))`. No server-side session store (Vercel is stateless).
  `GET /api/me` (see API table) is required.
- **Cart:** client-side only, in `localStorage` key `cart` as `[{id:number, qty:number}]`.
  It is independent of login (guests can have a cart). Use a React context/hook so the header badge,
  product page and cart page update immediately without reload.
- **Orders:** stored in a cookie `orders` (JSON, base64, keep the newest 10) set by `POST /api/checkout`,
  plus the static `orders` list in `seed.json`. This keeps counts correct on stateless Vercel.
  An order is `{id, userEmail, totalCents, items}`. Use `userEmail` from the `session` cookie, or
  `"guest"` if none. Order ids are deterministic: `String(2000 + n)` where `n` = (number of orders already in the incoming `orders` cookie) + 1. Never use random ids or timestamps.
  - `/orders` shows orders where `userEmail` equals the logged-in user: seed orders for that email
    plus cookie orders for that email.
  - `/admin/orders` shows ALL seed orders plus ALL cookie orders.
- `/orders` and `/admin/orders` must be **server components that read cookies directly** (dynamic).
  **They must NOT call `GET /api/orders`** (that endpoint is flaky on purpose, bug 12).
- **`GET /api/orders` is called from exactly one place: the Order history widget on `/profile` (bug 12).**
  `/orders`, `/checkout`, `/admin/orders`, the header and every other page must NEVER call it.

## 4. Route and test-id contract

Every item below must exist with exactly this `data-testid` (the tests use these).

### Global layout (every page)
- Header: logo link to `/`, links Shop (`/shop`), Cart (`/cart`), Orders (`/orders`), Login (`/login`),
  Profile (`/profile`). **Any logged-in user (customer too, not only admin) also sees an `Admin` link
  to `/admin/orders`** (this is what makes bug 9 discoverable). Guests do not see it. The header reads the
  session cookie on the server (or via `/api/me`).
- `data-testid="search-input"`: text input inside a `<form action="/search" method="get">`
  with `name="q"`. Pressing Enter submits a normal GET navigation to `/search?q=...`.
  This input must be present on **every** page, including `/`.
- `data-testid="cart-badge"`: small number next to Cart. **Render it only when the cart is non-empty**
  (when empty, render nothing). Its text is only the number, e.g. `1`.
- Footer on every page with a plain `<a href="/careers">Careers</a>` (use a plain `<a>`, NOT `next/link`,
  so it is a real browser navigation). The link text is exactly `Careers` and **there must be only one
  link named Careers on the page**.

### Pages
| route | contents |
|---|---|
| `/` | Home: hero banner, short blurb, link to `/shop`. Fast static images only. |
| `/shop` | Grid of **all 6 products**. Each is `data-testid="product-card"` containing `data-testid="product-name"` (exact product name text) and the price, linking to `/product/[id]`. |
| `/product/[id]` | Product detail: name, price, description, hero image (see bug 11), `data-testid="add-to-cart"` button. Unknown id -> `notFound()`. |
| `/cart` | One row per cart line with name, `data-testid="qty-input"` (`<input type="number">`, value = qty), `data-testid="delete-item"` (see bug 8), a link to `/checkout`, and `data-testid="cart-total"` showing the total as `$12.34` style text. |
| `/checkout` | Order summary, `data-testid="coupon-input"` (text), `data-testid="checkout-button"` (button). Guests may check out. |
| `/profile` | **Client component** that fetches `GET /api/me` on mount (if 401, `router.push('/login')`) and renders `data-testid="profile-email"` (exact email text), `data-testid="profile-bio"` (exact bio text; an empty bio renders an empty but present element) and the name in a profile card. **Below the card** an "Order history" widget `data-testid="order-history"` (see bug 12). |
| `/orders` | `data-testid="orders-count"` (text is ONLY the integer, e.g. `1`), and one `data-testid="order-row"` per order. |
| `/admin/orders` | `<h1>All orders</h1>` (exact text) and a table of all orders. |
| `/search?q=` | Results list of products whose name contains `q` (case-insensitive), or "No results". Also has the global `search-input`. |
| `/login` | Form with `data-testid="login-email"`, `data-testid="login-password"` (type password), `data-testid="login-submit"`. Submitting does `fetch('POST /api/login')`; on success `router.push('/profile')` for customers and `router.push('/admin/orders')` for admins; on failure show an error message. |
| `/careers` | **Does not exist** (bug 4). Next's normal 404 page is correct. |

### API
| endpoint | behavior |
|---|---|
| `GET /api/me` | **Required.** Reads the `session` cookie, looks the user up in `seed.json`, returns 200 `{email, role, name, bio}` (bio from seed, `""` for ann). 401 `{}` for guests. |
| `POST /api/login` | body `{email, password}`. Match against `seed.json`. 200 `{ok:true, role}` + `Set-Cookie session`. Else 401 `{ok:false}`. |
| `POST /api/checkout` | body `{items:[{id,qty}], coupon?:string}`. Computes total from `seed.json` prices, applies coupon, appends the order to the `orders` cookie. 200 `{orderId, totalCents}`. Unknown valid-format coupon (uppercase but not in table) -> 400 `{error}`. Must work with no session (guest). Lowercase coupon -> bug 2. |
| `GET /api/orders` | Bug 12 behavior. 200 `{orders:[...]}` (the logged-in user's orders, empty array for guests) except every 3rd call from the same client returns 500. Counter is cookie-based (see bug 12). |
| `GET /api/hero?id=N` | Slow hero image, see bug 11. |

Use `export const dynamic = 'force-dynamic'` on route handlers and pages that read cookies.

## 5. Happy paths that must work (tests: sanity)

1. **Browse:** `/shop` shows exactly 6 `product-card`s whose `product-name`s equal the seed product names.
2. **Add to cart:** on `/product/3` click `add-to-cart` once -> `cart-badge` has text `1`.
3. **Login:** on `/login` fill the customer credentials, submit -> URL becomes `/profile` and
   `profile-email` has text `ann@example.com`.
4. Checkout with no coupon or uppercase `SAVE10` returns 200 and the order shows up on `/orders`.
5. Admin login lands on `/admin/orders`.
6. `/profile` for admin shows `profile-bio` = `Runs the shop.` with no page errors.

## 6. The 12 seeded bugs (implement each deliberately)

Each block says what the test checks and exactly how to build the defect.

1. **Cart total NaN when quantity cleared.** On `/cart`, `qty-input` onChange does
   `const qty = parseInt(e.target.value)` (NO fallback, NO `|| 1`, NO validation) and stores it; the line
   total and `cart-total` are `price * qty` formatted with `$` + `(cents/100).toFixed(2)`. When the
   input is emptied, `qty` is `NaN` and `cart-total` shows `$NaN`. Test: add product 3, open `/cart`,
   total has no NaN; fill `qty-input` with `''`; `cart-total` contains `NaN`.
2. **Checkout 500 for lowercase coupon.** In `POST /api/checkout`, if `coupon` is provided and
   `coupon !== coupon.toUpperCase()` (e.g. `save10`), **throw an error / return status 500** (`{error:"Internal Server Error"}`).
   Uppercase `SAVE10` works (200). Test posts `{items:[{id:3,qty:1}],coupon:'save10'}` -> 500, and
   `coupon:'SAVE10'` -> 200.
3. **Uncaught exception on profile when bio is empty.** `/profile` is a client component. In a
   `useEffect`, if the user's bio is the empty string, run `setTimeout(() => { (user.bio as any).trim().foo.bar }, 0)`
   style code that throws an **uncaught** TypeError **outside React's render** (inside a `setTimeout` or event
   handler, so it surfaces as a browser `pageerror`; do not wrap in try/catch and do not rely on an error
   boundary). Simplest: `setTimeout(() => { throw new TypeError("Cannot read properties of undefined (reading 'length')"); }, 0)`
   when `bio === ''`. Customer `ann` has an empty bio; admin (bio `Runs the shop.`) must NOT throw. The test checks both: customer gets a
   `pageerror` matching `TypeError|Cannot read`, admin gets none. The page
   otherwise renders normally. Test: log in as customer, open `/profile`, expect such a `pageerror`.
4. **Footer Careers link 404.** The footer `<a href="/careers">Careers</a>` leads to a route that does
   not exist, so the server responds with HTTP **404**. Do not create `/careers`. Test clicks it and
   checks the response status for `/careers` is 404.
5. **Adding the same item twice shows count 1.** Adding an item already in the cart must increase the
   line's `qty` to 2 (cart page shows 2) but the header `cart-badge` must show the **number of distinct
   lines** (`cart.length`), not the sum of quantities. First add -> `1`, second add of the same product -> still `1`. The test then opens `/cart` and expects exactly ONE `qty-input` with value `2` (both clicks must register).
6. **Back after checkout re-submits the order.** On `/checkout`, clicking `checkout-button` does
   `POST /api/checkout` with the cart (and the `coupon-input` value if any), saves that exact JSON
   payload in `sessionStorage` key `lastCheckout`, clears the cart, then `router.push('/orders')`.
   Bug: the `/checkout` page has a `useEffect(() => {...}, [])` that, **on mount**, checks
   `sessionStorage.lastCheckout`; if present, it **POSTs that payload to `/api/checkout` again**
   (this is the re-submit when the user presses Back and the page remounts). It must not remove
   `lastCheckout`. **The re-submit must fire EXACTLY ONCE per mount, even under React StrictMode in `next dev`** (StrictMode runs effects twice): guard with a `useRef` flag (`if (fired.current) return; fired.current = true;`) and also set `reactStrictMode: false` in `next.config`. Two concurrent POSTs would race on the `orders` cookie and give N+3. Order ids come from the cookie count (section 3), never random. A normal first visit (no `lastCheckout`) does nothing. Test: login as customer;
   read `orders-count` = N; add item, `/checkout`, click `checkout-button`, land on `/orders`;
   `page.goBack()` triggers the second `POST /api/checkout` (must be status 200); a fresh `/orders`
   visit shows N + 2. (Because the effect also mounts when the test first opens `/checkout` before
   any checkout, `lastCheckout` must be absent then; the test uses a fresh browser context each time.)
7. **Search `'` shows a raw stack trace.** The search handler builds a fake "SQL" filter. If `q`
   contains a single quote `'`, it throws an error; the page catches it and renders `error.stack` as
   text inside `<pre data-testid="search-error">` (visible on the page, not only in the console).
   Do this so the visible text always contains a line that matches the regex `/at .*\(.*:\d+:\d+\)/`.
   **Required implementation: render this hardcoded text** (real stacks are minified in production and would not match), e.g.
   `Error: unterminated quoted string at or near "'"\n    at searchProducts (/var/task/lib/search.ts:42:13)\n    at runQuery (/var/task/lib/db.ts:17:9)`.
   Normal queries must still return normal results with no stack.
8. **Icon-only delete button without accessible name.** On `/cart`, each line has
   `<button data-testid="delete-item"><svg aria-hidden="true" ...trash icon.../></button>`.
   **No** text, **no** `aria-label`, **no** `title`, **no** `aria-labelledby`, nothing visually hidden.
   Clicking it removes the line from the cart. axe rule `button-name` must report a violation on it.
   (All other buttons and links in the app should have proper accessible names.)
9. **Customer can open `/admin/orders` directly.** The `/admin/orders` page only checks that a session
   exists (guests redirect to `/login`); it **does not check the role**. A logged-in customer gets HTTP
   200 and sees the `All orders` heading. Do not add a role check anywhere for this page.
10. **Checkout button off-screen on mobile.** The `checkout-button` on `/checkout` has CSS
    `width: 480px; min-width: 480px; flex-shrink: 0;` (a fixed width wider than a phone). At a 390px
    wide viewport its bounding box right edge (`x + width`) must be greater than 390. Do not clip or
    wrap it. On desktop it must look fine.
11. **Product page LCP about 6 s from an unoptimised hero image.** On `/product/[id]`, the main hero image is
    a plain `<img src="/api/hero?id=N" width="1600" height="900" style="width:100%;height:auto;display:block">`
    (NOT `next/image`, no `priority`, no lazy loading). `GET /api/hero` waits **5500 ms**
    (`await new Promise(r => setTimeout(r, 5500))`) and then returns a large SVG
    (`Content-Type: image/svg+xml`, 1600x900, a colored gradient with the product name; set
    `Cache-Control: no-store`). The hero must be the largest element above the fold so it is the LCP element.
    No other slow resources. Test: LCP on `/product/1` is greater than 4000 ms. On Vercel set
    `export const maxDuration = 15` in the route. The test warms `/product/1` first, but also run the final check against `build` + `start`.
12. **Order history intermittently 500s (1 in 3).** Stateless, cookie-based counter: `GET /api/orders` reads
    cookie `ordersApiCalls` (integer, default 0), increments it, writes it back with `Set-Cookie`
    (`Path=/; SameSite=Lax`), and **if the new value is divisible by 3 returns status 500**
    `{error:"Internal Server Error"}` (still set the cookie on the 500), otherwise 200 `{orders:[...]}`.
    The counter belongs to each client (browser context or API request context), not to the server.
    **Observable in the UI:** the `/profile` `data-testid="order-history"` widget fetches `/api/orders`
    client-side on mount (once per mount, guard with `useRef` for StrictMode). On 200 it lists the orders
    (or "No orders yet"); on a non-200 it shows
    `<p data-testid="order-history-error">Could not load order history</p>`. No retry. Nothing else calls
    `/api/orders`. Test: with a fresh API request context (empty cookie jar), 30 requests -> exactly 10
    return 500 (the test accepts 5 to 15).

## 7. How to run

```bash
# one time
pnpm install
pnpm --filter demo-target exec playwright install chromium

# terminal 1: start the app on 3100
pnpm --filter demo-target dev          # (after you replace the TODO scripts)

# terminal 2: run the acceptance suite
BASE_URL=http://localhost:3100 pnpm --filter demo-target test:bugs
```

For a production-like check, run `build` then `start` and re-run the suite. The suite can also run
against a deployed Vercel URL: `BASE_URL=https://<deployment> pnpm --filter demo-target test:bugs`.
The suite has no `webServer`: you must start the app yourself first. Tests run serially, one worker.
Bug 11 takes about 7 seconds, bug 12 makes 30 quick requests.

## 8. Definition of done

- `BASE_URL=http://localhost:3100 pnpm --filter demo-target test:bugs` reports **15 passed**
  (3 sanity + 12 bugs), run twice in a row on one running server (bug 12 must pass on a server that already
  served earlier calls).
- The 15 tests must pass against BOTH `next dev` AND `next build && next start` (dev has StrictMode and cold compiles).
- `pnpm --filter demo-target typecheck` and `pnpm --filter demo-target build` succeed.
- `tests/seeded-bugs.spec.ts`, `seed.json`, `playwright.config.ts` are unchanged.
- No bug is "fixed", and there are no additional deliberate bugs. Anything beyond the contract
  (styling, extra copy) must not break these tests.
- Deploys to Vercel with no env vars required.

## 9. Common mistakes to avoid

- Using `next/link` for the Careers link (client navigation may not hit `/careers` as a document). Use `<a>`.
- Rendering `cart-badge` when the cart is empty, or showing the sum of quantities (bug 5 needs distinct lines).
- Making `/orders` fetch `/api/orders` (it would randomly 500 and break bug 6).
- Validating or defaulting the quantity in the cart (that would remove bug 1).
- Using `next/image` for the hero (that would optimise it and remove bug 11).
- Giving the delete button an `aria-label` (that would remove bug 8).
- Adding a role check to `/admin/orders` (that would remove bug 9).
- Throwing the profile error during React render (a boundary swallows it); throw in `setTimeout`.
- Calling `/api/orders` from anywhere except the profile Order history widget.
- Letting a StrictMode double effect fire two checkout POSTs (bug 6).
- Using a server-side counter for bug 12 (it must be the `ordersApiCalls` cookie).
- Writing to disk at runtime (breaks on Vercel).
