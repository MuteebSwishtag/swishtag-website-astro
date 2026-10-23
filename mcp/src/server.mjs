import express from 'express';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadConfig } from './config.mjs';
import { createAuthenticator } from './auth.mjs';
import { GitHubClient } from './github.mjs';
import { Repository } from './repository.mjs';
import { WordPressClient } from './wordpress.mjs';
import { HostingerClient } from './hostinger.mjs';
import { WebsiteService } from './service.mjs';
import { AuditLog } from './audit.mjs';
import { createToolServer } from './tools.mjs';

export function createApp({ config, authenticator = createAuthenticator(config), service, audit } = {}) {
  const app = express(); app.disable('x-powered-by');
  const origin = new URL(config.server.publicUrl);
  const hosts = new Set([origin.host, `127.0.0.1:${config.server.port}`, `localhost:${config.server.port}`]);
  const limits = new Map();
  app.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" });
    if (!hosts.has(req.headers.host)) return res.status(421).json({ error: 'unrecognized_host' });
    const requestOrigin = req.headers.origin;
    if (requestOrigin && requestOrigin !== origin.origin && !config.server.allowedOrigins.includes(requestOrigin)) return res.status(403).json({ error: 'untrusted_origin' });
    if (requestOrigin) res.set({ 'Access-Control-Allow-Origin': requestOrigin, Vary: 'Origin', 'Access-Control-Expose-Headers': 'WWW-Authenticate, MCP-Protocol-Version' });
    if (req.method === 'OPTIONS') {
      res.set({ 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, MCP-Protocol-Version, MCP-Session-Id, Last-Event-ID', 'Access-Control-Max-Age': '600' });
      return res.sendStatus(204);
    }
    next();
  });
  app.get('/healthz', (_req, res) => res.json({ status: 'ok', service: 'swishtag-website-mcp' }));
  app.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], (_req, res) => res.json(authenticator.metadata()));
  app.use('/mcp', async (req, res, next) => {
    const minute = Math.floor(Date.now() / 60000);
    const countFor = key => {
      const bucket = limits.get(key); const count = bucket?.minute === minute ? bucket.count + 1 : 1;
      limits.set(key, { minute, count });
      if (limits.size > 10000) for (const [k, v] of limits) if (v.minute !== minute) limits.delete(k);
      return count;
    };
    try {
      req.principal = await authenticator.authenticate(req.headers.authorization);
      if (countFor(`subject:${req.principal.subject}`) > 300) return res.set('Retry-After', '60').status(429).json({ error: 'rate_limited' });
      next();
    }
    catch (error) {
      if (countFor(`invalid:${req.socket.remoteAddress ?? 'unknown'}`) > 60) return res.set('Retry-After', '60').status(429).json({ error: 'rate_limited' });
      const status = error.status === 403 ? 403 : 401;
      await audit.append({ tool: 'authentication', state: 'denied', code: error.code || 'invalid_token' }).catch(() => {});
      res.set('WWW-Authenticate', authenticator.challenge(error)).status(status).json({ error: status === 403 ? 'forbidden' : 'invalid_token' });
    }
  });
  app.post('/mcp', express.json({ limit: '10mb', strict: true }), async (req, res) => {
    let server; let transport;
    try {
      server = await createToolServer({ service, principal: req.principal, audit });
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      await transport?.close().catch(() => {}); await server?.close().catch(() => {});
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Unable to handle MCP request.' } });
    }
  });
  app.all('/mcp', (_req, res) => res.set('Allow', 'POST, OPTIONS').status(405).json({ error: 'method_not_allowed' }));
  app.use((error, _req, res, _next) => { if (!res.headersSent) res.status(error.status === 413 ? 413 : 400).json({ error: 'invalid_request' }); });
  return app;
}

export async function start() {
  const config = await loadConfig();
  const audit = new AuditLog(process.env.MCP_AUDIT_PATH || path.resolve(path.dirname(config.configPath), '../.mcp-runtime/audit.jsonl'));
  await audit.append({ tool: 'server', state: 'starting' });
  const service = new WebsiteService({ config, repository: new Repository(new GitHubClient(config.github)),
    wordpress: new WordPressClient(config.wordpress.username || config.wordpress.applicationPassword ? config.wordpress : {}), hostinger: new HostingerClient(config.deployment) });
  const app = createApp({ config, service, audit });
  const listener = app.listen(config.server.port, config.server.host, () => {
    process.stderr.write(`Swishtag MCP listening on ${config.server.host}:${config.server.port}\n`);
  });
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => listener.close(() => process.exit(0)));
  return listener;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  start().catch(() => { process.stderr.write('MCP startup failed. Check config, policy, credentials and audit-directory permissions.\n'); process.exitCode = 1; });
}
