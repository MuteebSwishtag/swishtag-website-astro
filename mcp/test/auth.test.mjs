import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { assertPermission, authorize, createAuthenticator } from '../src/auth.mjs';
import { loadConfig } from '../src/config.mjs';

let privateKey, otherPrivateKey, keySet;
const tempDirectories = [];
const issuer = 'https://identity.example.com/';
const audience = 'https://mcp.example.com/mcp';

before(async () => {
  const signing = await generateKeyPair('RS256');
  privateKey = signing.privateKey;
  ({ privateKey: otherPrivateKey } = await generateKeyPair('RS256'));
  const jwk = await exportJWK(signing.publicKey);
  keySet = createLocalJWKSet({ keys: [{ ...jwk, kid: 'test-key', alg: 'RS256', use: 'sig' }] });
});

after(async () => {
  await Promise.all(tempDirectories.map(directory => rm(directory, { recursive: true, force: true })));
});

async function fixture(policy) {
  const directory = await mkdtemp(path.join(tmpdir(), 'swishtag-mcp-auth-'));
  tempDirectories.push(directory);
  const configPath = path.join(directory, 'config.json');
  const raw = JSON.parse(await readFile(new URL('../config.example.json', import.meta.url), 'utf8'));
  raw.server.publicUrl = audience;
  raw.auth.issuer = issuer;
  raw.auth.audience = audience;
  raw.auth.jwksUri = 'https://identity.example.com/jwks';
  raw.policy = policy || {
    roles: {
      viewer: { permissions: ['site.read'], paths: ['src/'] },
      editor: { permissions: ['content.edit'], paths: ['src/data/'] },
      admin: { permissions: ['website.full'], paths: ['*'] },
    },
    users: {
      'user-1': { enabled: true, roles: ['viewer', 'editor'] },
      'user-admin': { enabled: true, roles: ['admin'] },
    },
  };
  await writeFile(configPath, JSON.stringify(raw));
  const config = await loadConfig({ configPath, env: {} });
  return {
    raw, config, configPath,
    auth: createAuthenticator(config, { keySet }),
    async save() { await writeFile(configPath, JSON.stringify(raw)); },
  };
}

async function token(claims = {}, { key = privateKey, typ = 'at+jwt', algorithm = 'RS256', omit = [] } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: issuer, aud: audience, sub: 'user-1', iat: now, exp: now + 300,
    scope: 'website:manage', ...claims,
  };
  for (const claim of omit) delete payload[claim];
  const header = { alg: algorithm, kid: 'test-key' };
  if (typ !== undefined && typ !== null) header.typ = typ;
  return `Bearer ${await new SignJWT(payload).setProtectedHeader(header).sign(key)}`;
}

function rejectsAuth(promise, code = 'invalid_token', status = 401) {
  return assert.rejects(promise, error => error.code === code && error.status === status && !error.message.includes('eyJ'));
}

test('verifies an individually signed resource access token and grants only configured permissions', async () => {
  const { auth } = await fixture();
  const principal = await auth.authenticate(await token({ name: 'A person', email: 'person@example.com', jti: 'jti-1' }));
  assert.equal(principal.subject, 'user-1');
  assert.equal(principal.issuer, issuer);
  assert.equal(principal.tokenId, 'jti-1');
  assert.ok(Object.isFrozen(principal));
  assert.equal(await authorize(principal, 'site.read', 'src/pages/index.astro'), true);
  assert.equal(await authorize(principal, 'content.edit', 'src/data/faqs.json'), true);
  assert.equal(await authorize(principal, 'deploy.publish'), false);
  await assert.rejects(assertPermission(principal, 'deploy.publish'), { code: 'forbidden', status: 403 });
});

test('never expands editor write paths using a separate broad read role', async () => {
  const { auth } = await fixture();
  const principal = await auth.authenticate(await token());
  assert.equal(await authorize(principal, 'content.edit', 'src/pages/index.astro'), false);
  assert.equal(await authorize(principal, 'content.edit', 'src/data-other/faqs.json'), false);
  for (const file of ['../src/data/faqs.json', '/src/data/faqs.json', 'src/data/../pages/index.astro', 'src\\data\\faqs.json', 'src/data/%2e%2e/secret', 'src/data//faqs.json']) {
    assert.equal(await authorize(principal, 'content.edit', file), false, file);
  }
});

test('website.full allows all registered tool permissions but no unknown management permission', async () => {
  const { auth } = await fixture();
  const principal = await auth.authenticate(await token({ sub: 'user-admin' }));
  assert.equal(await authorize(principal, 'deploy.publish'), true);
  assert.equal(await authorize(principal, 'deploy.rollback'), true);
  assert.equal(await authorize(principal, 'wordpress.publish'), true);
  assert.equal(await authorize(principal, 'layouts.edit', 'src/layouts/BaseLayout.astro'), true);
  assert.equal(await authorize(principal, 'credentials.read'), false);
});

test('rejects missing, malformed, oversized and query-style authorization', async () => {
  const { auth } = await fixture();
  for (const header of [undefined, '', 'Basic password', 'Bearer a.b.c extra', 'access_token=abc', `Bearer ${'a'.repeat(17000)}`]) {
    await rejectsAuth(auth.authenticate(header));
  }
});

test('rejects a forged signature, wrong issuer, wrong audience and a future token', async () => {
  const { auth } = await fixture();
  const now = Math.floor(Date.now() / 1000);
  await rejectsAuth(auth.authenticate(await token({}, { key: otherPrivateKey })));
  await rejectsAuth(auth.authenticate(await token({ iss: 'https://attacker.example.com/' })));
  await rejectsAuth(auth.authenticate(await token({ aud: 'https://github.com' })));
  await rejectsAuth(auth.authenticate(await token({ aud: 'oauth-login-client-id' })));
  await rejectsAuth(auth.authenticate(await token({ nbf: now + 60 })));
  await rejectsAuth(auth.authenticate(await token({ iat: now + 60, exp: now + 600 })));
});

test('requires expiration, subject, issuer, audience and issued-at claims', async () => {
  const { auth } = await fixture();
  for (const claim of ['exp', 'iat', 'sub', 'iss', 'aud']) await rejectsAuth(auth.authenticate(await token({}, { omit: [claim] })));
});

test('rejects expired tokens and overly long access-token lifetimes', async () => {
  const { auth } = await fixture();
  const now = Math.floor(Date.now() / 1000);
  await rejectsAuth(auth.authenticate(await token({ iat: now - 120, exp: now - 60 })));
  await rejectsAuth(auth.authenticate(await token({ exp: now + 7200 })));
  await rejectsAuth(auth.authenticate(await token({ iat: now - 7200, exp: now + 100 })));
});

test('rejects missing or unrecognized access-token types and accepts configured JWT type', async () => {
  const { auth } = await fixture();
  await rejectsAuth(auth.authenticate(await token({}, { typ: null })));
  await rejectsAuth(auth.authenticate(await token({}, { typ: 'id_token' })));
  assert.equal((await auth.authenticate(await token({}, { typ: 'JWT' }))).subject, 'user-1');
});

test('rejects symmetric algorithm substitution', async () => {
  const { auth } = await fixture();
  const secret = new TextEncoder().encode('this-test-secret-is-over-thirty-two-bytes-long');
  await rejectsAuth(auth.authenticate(await token({}, { algorithm: 'HS256', key: secret })));
});

test('requires the management scope even when the token contains admin-like claims', async () => {
  const { auth } = await fixture();
  await rejectsAuth(auth.authenticate(await token({ scope: 'openid profile', roles: ['admin'], permissions: ['website.full'] })), 'insufficient_scope', 403);
  const principal = await auth.authenticate(await token({ roles: ['admin'], permissions: ['website.full'] }));
  assert.equal(await authorize(principal, 'deploy.publish'), false);
});

test('scope claim is explicitly configurable for providers using scp arrays', async () => {
  const { auth, config } = await fixture();
  const header = await token({ scope: undefined, scp: ['website:manage'] });
  await rejectsAuth(auth.authenticate(header), 'insufficient_scope', 403);
  config.auth.scopesClaim = 'scp';
  assert.equal((await createAuthenticator(config, { keySet }).authenticate(header)).subject, 'user-1');
});

test('unknown and disabled subjects are denied even with valid tokens', async () => {
  const f = await fixture();
  await rejectsAuth(f.auth.authenticate(await token({ sub: 'unknown' })), 'forbidden', 403);
  f.raw.policy.users['user-1'].enabled = false;
  await f.save();
  await rejectsAuth(f.auth.authenticate(await token()), 'forbidden', 403);
});

test('re-reads policy to revoke a subject and remove a role grant between tool calls', async () => {
  const f = await fixture();
  const principal = await f.auth.authenticate(await token());
  assert.equal(await authorize(principal, 'content.edit', 'src/data/faqs.json'), true);
  f.raw.policy.roles.editor.permissions = [];
  await f.save();
  assert.equal(await authorize(principal, 'content.edit', 'src/data/faqs.json'), false);
  delete f.raw.policy.users['user-1'];
  await f.save();
  assert.equal(await authorize(principal, 'site.read', 'src/pages/index.astro'), false);
});

test('revokedBefore invalidates prior tokens while allowing a fresh sign-in', async () => {
  const f = await fixture();
  const now = Math.floor(Date.now() / 1000);
  const oldToken = await token({ iat: now - 120 });
  const principal = await f.auth.authenticate(oldToken);
  f.raw.policy.users['user-1'].revokedBefore = new Date((now - 60) * 1000).toISOString();
  await f.save();
  assert.equal(await authorize(principal, 'site.read'), false);
  await rejectsAuth(f.auth.authenticate(oldToken), 'forbidden', 403);
  assert.equal((await f.auth.authenticate(await token())).subject, 'user-1');
});

test('policy corruption fails closed without leaking policy contents', async () => {
  const f = await fixture();
  const principal = await f.auth.authenticate(await token());
  await writeFile(f.configPath, '{THIS-IS-NOT-JSON');
  await assert.rejects(authorize(principal, 'site.read'), { code: 'forbidden', status: 403 });
  await rejectsAuth(f.auth.authenticate(await token()), 'forbidden', 403);
});

test('metadata and challenges advertise only the configured resource, issuer and scope', async () => {
  const { auth } = await fixture();
  assert.deepEqual(auth.metadata(), {
    resource: audience,
    authorization_servers: [issuer],
    scopes_supported: ['website:manage'],
    bearer_methods_supported: ['header'],
    resource_name: 'Swishtag Website Management',
  });
  assert.equal(auth.resourceMetadataUrl, 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp');
  assert.match(auth.challenge(), /scope="website:manage"/u);
  assert.match(auth.challenge({ code: 'insufficient_scope' }), /error="insufficient_scope"/u);
  assert.doesNotMatch(auth.challenge({ code: 'bad"\r\nvalue' }), /bad/u);
});

test('loads provider credentials only from the environment and defaults to this repository branch', async () => {
  const f = await fixture();
  f.raw.github.token = 'ignored-file-secret';
  f.raw.wordpress.applicationPassword = 'ignored-file-secret';
  delete f.raw.github.baseBranch;
  await f.save();
  const withoutSecrets = await loadConfig({ configPath: f.configPath, env: {} });
  assert.equal(withoutSecrets.github.token, '');
  assert.equal(withoutSecrets.wordpress.applicationPassword, '');
  assert.equal(withoutSecrets.github.baseBranch, 'master');
  const config = await loadConfig({ configPath: f.configPath, env: { MCP_GITHUB_TOKEN: 'environment-secret', MCP_WORDPRESS_APPLICATION_PASSWORD: 'wp-secret', MCP_HOSTINGER_TOKEN: 'hosting-secret' } });
  assert.equal(config.github.token, 'environment-secret');
  assert.equal(config.wordpress.applicationPassword, 'wp-secret');
  assert.equal(config.deployment.hostingerToken, 'hosting-secret');
});

test('rejects insecure provider URLs, conflicting audience, unsafe algorithms and invalid policies', async () => {
  const mutations = [
    raw => { raw.auth.issuer = 'http://identity.example.com/'; },
    raw => { raw.auth.jwksUri = 'https://user:password@identity.example.com/jwks'; },
    raw => { raw.auth.audience = 'https://different.example.com/mcp'; },
    raw => { raw.server.publicUrl = 'https://mcp.example.com/mcp?access_token=x'; },
    raw => { raw.auth.algorithms = ['HS256']; },
    raw => { raw.auth.requiredScopes = []; },
    raw => { raw.server.allowedOrigins = ['*']; },
    raw => { raw.policy.users['user-1'].roles = ['unknown']; },
    raw => { raw.policy.roles.viewer.permissions = ['credentials.read']; },
    raw => { raw.policy.roles.editor.paths = ['../secrets/']; },
    raw => { raw.policy.roles.editor.permissions = undefined; },
  ];
  for (const mutate of mutations) {
    const f = await fixture();
    mutate(f.raw);
    await f.save();
    await assert.rejects(loadConfig({ configPath: f.configPath, env: {} }), { code: 'configuration_error' });
  }
});
