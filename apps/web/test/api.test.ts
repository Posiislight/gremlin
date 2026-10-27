import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules(); });

it('fails visibly when a configured live engine is unreachable instead of returning sample scans', async () => {
  vi.stubEnv('NEXT_PUBLIC_MOCK', '0');
  vi.stubEnv('NEXT_PUBLIC_GREMLIN_API', 'http://localhost:8080');
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  const { listProjects } = await import('../src/lib/api');
  await expect(listProjects()).rejects.toThrow('engine_unreachable');
});

it('retains explicit mock mode for offline previews', async () => {
  vi.stubEnv('NEXT_PUBLIC_MOCK', '1');
  const { listProjects } = await import('../src/lib/api');
  expect((await listProjects()).source).toBe('mock');
});

it('does not substitute a sample fix prompt when a live engine disconnects', async () => {
  vi.stubEnv('NEXT_PUBLIC_MOCK', '0');
  vi.stubEnv('NEXT_PUBLIC_GREMLIN_API', 'http://localhost:8080');
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  const { getFixPrompt } = await import('../src/lib/api');
  await expect(getFixPrompt('real-finding')).rejects.toThrow('engine_unreachable');
});
