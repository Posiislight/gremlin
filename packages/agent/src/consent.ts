import type { Page } from 'playwright';

const BANNER = '[id*=cookie i], [class*=consent i], [aria-label*=cookie i]';
const REJECT = /^(reject( all)?|decline|necessary only|only necessary)$/i;

/** Click a visible "reject / necessary only" button inside a likely cookie banner. Never clicks "accept". */
export async function dismissConsent(page: Page): Promise<boolean> {
  try {
    const banners = page.locator(BANNER);
    if ((await banners.count()) === 0) return false;
    const buttons = banners.getByRole('button', { name: REJECT });
    const n = Math.min(await buttons.count(), 5);
    for (let i = 0; i < n; i++) {
      const b = buttons.nth(i);
      if (await b.isVisible()) {
        await b.click({ timeout: 1500 });
        return true;
      }
    }
  } catch {
    /* banner vanished or navigation raced; treat as not dismissed */
  }
  return false;
}
