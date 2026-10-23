import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/server.mjs';
import { AuthenticationError } from '../src/auth.mjs';

const AUTHORIZATION = 'Bearer integration-test-token';
const SHA = 'a'.repeat(40);

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'swishtag-mcp-server-'));
  const policyPath = path.join(directory, 'policy.json');
  const document = { policy: {
    roles: { viewer: { permissions: ['site.read'], paths: ['src/'] } },
    users: { 'oidc|alice': { enabled: true, roles: ['viewer'] } },
  } };
  const savePolicy = () => writeFile(policyPath, JSON.stringify(document));
  await savePolicy();
  const principal = Object.freeze({ subject: 'oidc|alice', issuedAt: Math.floor(Date.now() / 1000), expiresAt: Math.floor(Date.now() / 1000) + 300, policyPath });
  const records = [];
  const calls = [];
  let throwSecret = false;
  const service = {
    async inspect(actor, args) {
      calls.push({ actor, args });
      if (throwSecret) throw new Error('Do not expose server-only-token or database-password.');
      return { revision: SHA, files: [{ path: 'src/pages/index.astro', bytes: 100 }], actor: actor.subject };
    },
  };
  let handler = (_req, res) => res.writeHead(503).end();
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  const config = { server: { publicUrl: `https://127.0.0.1:${port}/mcp`, port, allowedOrigins: ['https://trusted.example.test'] } };
  const metadata = { resource: config.server.publicUrl, authorization_servers: ['https://identity.example.test/'], scopes_supported: ['website:manage'], bearer_methods_supported: ['header'] };
  const authenticator = {
    async authenticate(header) { if (header !== AUTHORIZATION) throw new AuthenticationError(); return principal; },
    metadata: () => metadata,
    challenge: () => `Bearer resource_metadata="https://127.0.0.1:${port}/.well-known/oauth-protected-resource/mcp", scope="website:manage"`,
  };
  handler = createApp({ config, authenticator, service, audit: { async append(record) { records.push(record); } } });
  const clients = [];
  t.after(async () => {
    await Promise.all(clients.map(client => client.close()));
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('swishtag-mcp-server-'));
    await rm(directory, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    baseUrl, config, metadata, document, savePolicy, calls, records,
    failInspect() { throwSecret = true; },
    async client() {
      const client = new Client({ name: 'website-mcp-integration-test', version: '1.0.0' }, { capabilities: {} });
      clients.push(client);
      const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { authorization: AUTHORIZATION } } });
      await client.connect(transport);
      return client;
    },
  };
}

test('real MCP SDK client initializes, lists permitted tools and calls site_inspect over HTTP', async t => {
  const server = await fixture(t);
  const client = await server.client();
  assert.equal(client.getServerVersion().name, 'swishtag-website');
  const listed = await client.listTools();
  assert.ok(listed.tools.some(tool => tool.name === 'site_inspect'));
  assert.equal(listed.tools.some(tool => tool.name === 'publish'), false);
  assert.equal(listed.tools.some(tool => tool.name === 'wordpress_apply'), false);
  const result = await client.callTool({ name: 'site_inspect', arguments: { prefix: 'src/pages/', limit: 5 } });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.revision, SHA);
  assert.equal(result.structuredContent.actor, 'oidc|alice');
  assert.equal(server.calls.length, 1);
  assert.equal(server.calls[0].actor.subject, 'oidc|alice');
  assert.deepEqual(server.calls[0].args, { prefix: 'src/pages/', limit: 5 });
  assert.deepEqual(server.records.filter(record => record.tool === 'site_inspect').map(record => record.state), ['started', 'succeeded']);
  assert.doesNotMatch(JSON.stringify(server.records), /integration-test-token/);
});

test('unknown operation errors never expose upstream credentials to the client or audit', async t => {
  const server = await fixture(t);
  const client = await server.client();
  server.failInspect();
  const result = await client.callTool({ name: 'site_inspect', arguments: {} });
  assert.equal(result.isError, true);
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.code, 'operation_failed');
  assert.doesNotMatch(JSON.stringify(result), /server-only-token|database-password|Do not expose/);
  assert.equal(server.records.at(-1).state, 'failed');
  assert.equal(server.records.at(-1).code, 'operation_failed');
  assert.doesNotMatch(JSON.stringify(server.records), /server-only-token|database-password|integration-test-token/);
});

test('an existing SDK connection loses tool access immediately after policy revocation', async t => {
  const server = await fixture(t);
  const client = await server.client();
  await client.callTool({ name: 'site_inspect', arguments: {} });
  server.document.policy.users['oidc|alice'].enabled = false;
  await server.savePolicy();
  const result = await client.callTool({ name: 'site_inspect', arguments: {} });
  assert.equal(result.isError, true);
  assert.equal(server.calls.length, 1);
  const tools = await client.listTools();
  assert.equal(tools.tools.some(tool => tool.name === 'site_inspect'), false);
  assert.equal(tools.tools.some(tool => tool.name === 'publish'), false);
});

test('MCP authentication failure returns a resource discovery challenge and minimal error', async t => {
  const server = await fixture(t);
  const response = await fetch(`${server.baseUrl}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  assert.equal(response.status, 401);
  assert.match(response.headers.get('www-authenticate'), /resource_metadata="https:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource\/mcp"/);
  assert.deepEqual(await response.json(), { error: 'invalid_token' });
  assert.deepEqual(server.records.map(record => [record.tool, record.state]), [['authentication', 'denied']]);
  assert.equal(server.calls.length, 0);
});

test('untrusted browser origins and host headers are rejected before tool execution', async t => {
  const server = await fixture(t);
  const badOrigin = await fetch(`${server.baseUrl}/healthz`, { headers: { origin: 'https://attacker.example.test' } });
  assert.equal(badOrigin.status, 403);
  assert.deepEqual(await badOrigin.json(), { error: 'untrusted_origin' });
  // Node fetch normalizes Host; use the actual HTTP client to exercise this boundary.
  const badHost = await new Promise((resolve, reject) => {
    const request = http.get(`${server.baseUrl}/healthz`, { headers: { host: 'attacker.example.test' } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks)) }));
    });
    request.on('error', reject);
  });
  assert.equal(badHost.status, 421);
  assert.deepEqual(badHost.body, { error: 'unrecognized_host' });
  assert.equal(server.calls.length, 0);
});

test('health and OAuth resource metadata are public, cache-disabled and credential-free', async t => {
  const server = await fixture(t);
  const health = await fetch(`${server.baseUrl}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok', service: 'swishtag-website-mcp' });
  for (const resource of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    const response = await fetch(`${server.baseUrl}${resource}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-powered-by'), null);
    assert.deepEqual(await response.json(), server.metadata);
  }
});

test('allowed CORS preflights are handled without authentication', async t => {
  const server = await fixture(t);
  const response = await fetch(`${server.baseUrl}/mcp`, { method: 'OPTIONS', headers: { origin: 'https://trusted.example.test', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' } });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://trusted.example.test');
  assert.match(response.headers.get('access-control-allow-headers'), /Authorization/);
  assert.equal(server.records.length, 0);
});

test('invalid JSON returns HTTP 400 without echoing submitted secrets', async t => {
  const server = await fixture(t);
  const response = await fetch(`${server.baseUrl}/mcp`, { method: 'POST', headers: { authorization: AUTHORIZATION, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{"password":"submitted-secret",' });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'invalid_request' });
  assert.equal(server.calls.length, 0);
});

test('authenticated unsupported MCP HTTP methods return 405 with allowed methods', async t => {
  const server = await fixture(t);
  for (const method of ['GET', 'DELETE', 'PUT']) {
    const response = await fetch(`${server.baseUrl}/mcp`, { method, headers: { authorization: AUTHORIZATION } });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'POST, OPTIONS');
    assert.deepEqual(await response.json(), { error: 'method_not_allowed' });
  }
});
