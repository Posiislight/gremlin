import { defineConfig } from 'vitest/config';

export default defineConfig({
  // hookTimeout: afterAll closes the browser; on Windows that can take ~40 s while another Chromium is busy.
  // expect.poll: conditions are polled (no fixed sleeps); the generous ceiling only matters on a loaded machine.
  test: { testTimeout: 120_000, hookTimeout: 180_000, expect: { poll: { timeout: 30_000 } } },
});
