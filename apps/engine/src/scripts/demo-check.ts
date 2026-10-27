/** Verify the running local demo without printing credentials or relying on sample data. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import { ApiScan, ApiScanDetail, ApiTimeline, ListProjectsResponse } from '@gremlin/contract';

const env = parseEnv(readFileSync(resolve(import.meta.dirname, '../../../../.env.demo'), 'utf8'));
const headers = { authorization: `Bearer ${env.GREMLIN_API_KEY}` };
const base = env.GREMLIN_ENGINE_URL!;
async function get(path: string) {
  const res = await fetch(`${base}${path}`, { headers });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}
const client = new Client({ name: 'gremlin-demo-check', version: '1' });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } }));
  const { tools } = await client.listTools();
  console.info(`MCP connected: ${tools.length} tools`);
  const { projects } = ListProjectsResponse.parse(await get('/v1/projects'));
  if (!projects.length) throw new Error('Demo project not found');
  const playbook = await client.callTool({ name: 'get_playbook', arguments: { projectId: projects[0]!.id } });
  if (playbook.isError) throw new Error('get_playbook failed');
  if (process.argv.includes('--start')) {
    const started = await client.callTool({ name: 'start_scan', arguments: {
      url: 'http://127.0.0.1:3100/cart.html', teamSize: 1, allowedActions: 'full',
      focus: 'Perform TWO separate click actions on Add to cart. After the first click, click Add to cart AGAIN before expecting, reporting or finishing. Then inspect the save status. Report the failed POST /api/cart after the SECOND click and finish.',
    } });
    if (started.isError) throw new Error('MCP start_scan failed');
    console.info('Started real scan through MCP');
  }
  const { scans } = z.object({ scans: z.array(ApiScan) }).parse(await get(`/v1/projects/${projects[0]!.id}/scans`));
  if (!scans.length) throw new Error('Start a scan from the dashboard first');
  const scan = ApiScanDetail.parse(await get(`/v1/scans/${scans[0]!.id}`));
  const fromMcp = await client.callTool({ name: 'get_scan', arguments: { scanId: scan.id } });
  if (fromMcp.isError) throw new Error('get_scan failed');
  console.info(JSON.stringify({ scanId: scan.id, status: scan.status, findings: scan.findings.map((f) => ({ id: f.id, title: f.title })), runs: scan.runs.map((r) => ({ id: r.id, status: r.status, error: r.error })) }));
  for (const run of scan.runs.filter((r) => r.hasTimeline)) {
    const t = ApiTimeline.parse(await get(`/v1/runs/${run.id}/timeline`));
    for (const url of [t.videoUrl, t.traceUrl, ...t.rrwebSegments.map((s) => s.signedUrl)].filter((u): u is string => Boolean(u))) {
      const proxied = await fetch(`${env.GREMLIN_WEB_URL}/api/gremlin${url}`);
      if (!proxied.ok) throw new Error(`Artifact proxy HTTP ${proxied.status}`);
      await proxied.arrayBuffer();
    }
    console.info(`Verified replay: ${t.steps.length} steps, ${t.rrwebSegments.length} DOM segments, video=${Boolean(t.videoUrl)}`);
    console.info(`Replay: ${env.GREMLIN_WEB_URL}/runs/${run.id}`);
  }
  for (const f of scan.findings.slice(0, 1)) {
    const prompt = await client.callTool({ name: 'get_fix_prompt', arguments: { id: f.id } });
    if (prompt.isError) throw new Error('get_fix_prompt failed');
    console.info('MCP finding -> fix prompt verified');
  }
} finally { await client.close(); }
