// Live smoke test: OPENROUTER_API_KEY=... pnpm --filter @gremlin/llm smoke
import { z } from 'zod';
import { createLlm, loadLlmConfig } from '../src/index.js';

const cfg = loadLlmConfig(process.env);
if (!cfg.apiKey) {
  console.error('OPENROUTER_API_KEY is not set. Export it and re-run: pnpm --filter @gremlin/llm smoke');
  process.exit(1);
}

const llm = createLlm(cfg);
const { value, usage } = await llm.callTool('navigator', {
  system: 'You are a test agent. Always answer by calling the provided tool.',
  messages: [{ role: 'user', content: 'Say you are done and give a short reason.' }],
  tool: {
    name: 'finish',
    description: 'Finish the task with a reason.',
    schema: z.object({ reason: z.string() }),
  },
});

console.log('value:', value);
console.log(`latency: ${usage.latencyMs}ms`);
console.log('usage:', usage);
