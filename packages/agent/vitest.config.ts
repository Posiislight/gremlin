import { defineConfig } from 'vitest/config';

export default defineConfig({
  // hookTimeout: afterAll closes the browser; on Windows that can take ~40 s while another Chromium is busy.
  test: { testTimeout: 60_000, hookTimeout: 180_000 },
});
