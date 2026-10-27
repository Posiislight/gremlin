import type { FastifyInstance } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { authenticate } from '../auth.js';
import { registerTools, type McpDeps } from './tools.js';

export type { McpDeps } from './tools.js';
export { replayUrl, scrub } from './prompt.js';

const notAllowed = {
  jsonrpc: '2.0',
  error: { code: -32000, message: 'Method not allowed: stateless server, use POST /mcp' },
  id: null,
};

/**
 * Fastify plugin: stateless MCP Streamable HTTP at POST /mcp, authenticated with the project API key
 * (`Authorization: Bearer grm_...`), same as the REST API. Mount with `app.register(mcpRoutes({ db, queues }))`.
 */
export function mcpRoutes(deps: McpDeps) {
  return async function (app: FastifyInstance): Promise<void> {
    app.addHook('onRequest', authenticate(deps.db));

    app.post('/mcp', async (req, reply) => {
      const server = new McpServer({ name: 'gremlin', version: '0.1.0' });
      const host = (req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host;
      const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim() ?? req.protocol;
      const publicBase = deps.publicBase ?? (host ? `${proto}://${host}` : undefined);
      registerTools(server, req.projectId, { ...deps, ...(publicBase ? { publicBase } : {}) });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      reply.hijack();
      reply.raw.on('close', () => {
        void transport.close();
        void server.close();
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req.raw, reply.raw, req.body);
      } catch {
        if (!reply.raw.headersSent) {
          reply.raw.writeHead(500, { 'content-type': 'application/json' });
          reply.raw.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null }));
        }
      }
    });

    for (const method of ['GET', 'DELETE'] as const) {
      app.route({
        method,
        url: '/mcp',
        handler: async (_req, reply) => reply.code(405).header('allow', 'POST').send(notAllowed),
      });
    }
  };
}
