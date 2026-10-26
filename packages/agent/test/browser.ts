import { chromium, type Browser } from 'playwright';

/** Launch one headless chromium. Use in beforeAll; close in afterAll. */
export async function launchBrowser(): Promise<Browser> {
  return chromium.launch({ headless: true });
}
