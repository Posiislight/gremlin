import { chromium, type Browser } from 'playwright';
import { HOST_RULES } from './hosts.js';

/** Launch one headless chromium. Use in beforeAll; close in afterAll. */
export async function launchBrowser(): Promise<Browser> {
  return chromium.launch({ headless: true, args: [`--host-resolver-rules=${HOST_RULES}`] });
}
