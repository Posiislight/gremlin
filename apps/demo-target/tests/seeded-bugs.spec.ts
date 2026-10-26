import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import seed from '../seed.json';

const customer = seed.users.find((u) => u.persona === 'customer')!;

async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(password);
  await page.getByTestId('login-submit').click();
  await page.waitForURL(/\/(profile|admin\/orders)$/);
}

async function loginCustomer(page: Page): Promise<void> {
  await login(page, customer.email!, customer.password!);
}

/** Adds product `id` to the cart via its product page and waits for the badge. */
async function addToCart(page: Page, id: number): Promise<void> {
  await page.goto(`/product/${id}`);
  await page.getByTestId('add-to-cart').click();
  await expect(page.getByTestId('cart-badge')).toBeVisible();
}

async function ordersCount(page: Page): Promise<number> {
  await page.goto('/orders');
  const text = await page.getByTestId('orders-count').innerText();
  return Number.parseInt(text.trim(), 10);
}

// ---------------------------------------------------------------------------
// Sanity: happy paths must work
// ---------------------------------------------------------------------------
test.describe('sanity', () => {
  test('browse: /shop lists the seeded products', async ({ page }) => {
    await page.goto('/shop');
    const cards = page.getByTestId('product-card');
    await expect(cards).toHaveCount(seed.products.length);
    const names = await page.getByTestId('product-name').allInnerTexts();
    for (const p of seed.products) expect(names.map((n) => n.trim())).toContain(p.name);
  });

  test('add to cart: badge shows 1', async ({ page }) => {
    await page.goto('/product/3');
    await page.getByTestId('add-to-cart').click();
    await expect(page.getByTestId('cart-badge')).toHaveText('1');
  });

  test('login: customer lands on /profile', async ({ page }) => {
    await loginCustomer(page);
    await expect(page).toHaveURL(/\/profile$/);
    await expect(page.getByTestId('profile-email')).toHaveText(customer.email!);
  });
});

// ---------------------------------------------------------------------------
// Seeded bugs: each test asserts the bug IS PRESENT
// ---------------------------------------------------------------------------
test.describe('seeded bugs', () => {
  test('bug 1: cart total is NaN when quantity is cleared', async ({ page }) => {
    await addToCart(page, 3);
    await page.goto('/cart');
    await expect(page.getByTestId('cart-total')).not.toContainText('NaN');
    await page.getByTestId('qty-input').first().fill('');
    await expect(page.getByTestId('cart-total')).toContainText('NaN');
  });

  test('bug 2: checkout API returns 500 for lowercase coupon', async ({ request }) => {
    const bad = await request.post('/api/checkout', {
      data: { items: [{ id: 3, qty: 1 }], coupon: 'save10' },
    });
    expect(bad.status()).toBe(500);
    // control: uppercase coupon is fine
    const good = await request.post('/api/checkout', {
      data: { items: [{ id: 3, qty: 1 }], coupon: 'SAVE10' },
    });
    expect(good.status()).toBe(200);
  });

  test('bug 3: profile throws an uncaught exception when bio is empty', async ({ page }) => {
    await loginCustomer(page);
    const errors: Error[] = [];
    page.on('pageerror', (e) => errors.push(e));
    await page.goto('/profile');
    await expect.poll(() => errors.length, { timeout: 10_000 }).toBeGreaterThan(0);
  });

  test('bug 4: footer Careers link is a 404', async ({ page }) => {
    await page.goto('/');
    const careers = page.getByRole('link', { name: 'Careers' });
    await expect(careers).toHaveCount(1);
    const [response] = await Promise.all([
      page.waitForResponse((r) => new URL(r.url()).pathname === '/careers'),
      careers.click(),
    ]);
    expect(response.status()).toBe(404);
    await expect(page).toHaveURL(/\/careers$/);
  });

  test('bug 5: adding the same item twice leaves the badge at 1', async ({ page }) => {
    await page.goto('/product/3');
    await page.getByTestId('add-to-cart').click();
    await expect(page.getByTestId('cart-badge')).toHaveText('1');
    await page.getByTestId('add-to-cart').click();
    await page.waitForTimeout(500);
    await expect(page.getByTestId('cart-badge')).toHaveText('1');
  });

  test('bug 6: back after checkout re-submits the order', async ({ page }) => {
    await loginCustomer(page);
    const before = await ordersCount(page);
    await addToCart(page, 3);
    await page.goto('/checkout');
    await page.getByTestId('checkout-button').click();
    await page.waitForURL(/\/orders$/);
    const [resubmit] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/api/checkout') && r.request().method() === 'POST'),
      page.goBack(),
    ]);
    expect(resubmit.status()).toBe(200);
    const after = await ordersCount(page);
    expect(after).toBe(before + 2);
  });

  test('bug 7: searching for a single quote shows a raw stack trace', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('search-input').fill("'");
    await page.getByTestId('search-input').press('Enter');
    await page.waitForURL(/\/search\?q=/);
    const text = await page.locator('body').innerText();
    expect(text).toMatch(/at .*\(.*:\d+:\d+\)/);
  });

  test('bug 8: cart delete button has no accessible name (axe button-name)', async ({ page }) => {
    await addToCart(page, 3);
    await page.goto('/cart');
    await expect(page.getByTestId('delete-item').first()).toBeVisible();
    const results = await new AxeBuilder({ page })
      .include('[data-testid="delete-item"]')
      .withRules(['button-name'])
      .analyze();
    expect(results.violations.map((v) => v.id)).toContain('button-name');
  });

  test('bug 9: customer can open /admin/orders directly', async ({ page }) => {
    await loginCustomer(page);
    const response = await page.goto('/admin/orders');
    expect(response?.status()).toBe(200);
    await expect(page.getByRole('heading', { name: 'All orders' })).toBeVisible();
  });

  test('bug 10: checkout button overflows the viewport on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await addToCart(page, 3);
    await page.goto('/checkout');
    const button = page.getByTestId('checkout-button');
    await expect(button).toBeVisible();
    const box = await button.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x + box!.width).toBeGreaterThan(390);
  });

  test('bug 11: product page LCP is above 4000 ms', async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __lcp: number }).__lcp = 0;
      new PerformanceObserver((list) => {
        const entries = list.getEntries();
        const last = entries[entries.length - 1];
        if (last) (window as unknown as { __lcp: number }).__lcp = last.startTime;
      }).observe({ type: 'largest-contentful-paint', buffered: true });
    });
    await page.goto('/product/1', { waitUntil: 'load' });
    await page.waitForTimeout(1000);
    const lcp = await page.evaluate(() => (window as unknown as { __lcp: number }).__lcp);
    expect(lcp).toBeGreaterThan(4000);
  });

  test('bug 12: GET /api/orders returns 500 about one call in three', async ({ request }) => {
    let failures = 0;
    for (let i = 0; i < 30; i++) {
      const r = await request.get('/api/orders');
      if (r.status() === 500) failures++;
    }
    expect(failures).toBeGreaterThanOrEqual(5);
    expect(failures).toBeLessThanOrEqual(15);
  });
});
