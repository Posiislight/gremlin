import { chromium, type Browser } from 'playwright';
import { HOST_RULES } from './hosts.js';

/**
 * Launch one headless chromium. Use in beforeAll; close in afterAll.
 * Windows occasionally refuses to create a process under memory pressure / on-access scanning (`spawn EPERM`);
 * that transient OS error is retried, anything else is not.
 */
export async function launchBrowser(): Promise<Browser> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await chromium.launch({ headless: true, args: [`--host-resolver-rules=${HOST_RULES}`] });
    } catch (e) {
      if (attempt >= 5 || !/spawn EPERM/.test(String(e))) throw e;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}
