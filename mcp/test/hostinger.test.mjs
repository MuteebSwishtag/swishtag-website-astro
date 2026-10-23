import test from 'node:test';
import assert from 'node:assert/strict';
import { HostingerClient } from '../src/hostinger.mjs';

const sha = 'a'.repeat(40);
const config = { siteUrl: 'https://www.example.test/', hostingerAccount: 'u123456', hostingerDomain: 'www.example.test', hostingerToken: 'hosting-secret' };

test('unconfigured deployment reports missing settings without network access', async () => {
  const client = new HostingerClient({ fetchImpl: () => { throw new Error('must not fetch'); } });
  const status = await client.status();
  assert.equal(status.site.configured, false);
  assert.equal(status.hostinger.configured, false);
  assert.deepEqual(status.hostinger.missing, ['deployment.hostingerAccount', 'deployment.hostingerDomain', 'MCP_HOSTINGER_TOKEN']);
});

test('deployment URLs and account path segments are validated', () => {
  assert.throws(() => new HostingerClient({ siteUrl: 'http://example.test' }), /HTTPS/);
  assert.throws(() => new HostingerClient({ siteUrl: 'https://secret:password@example.test' }), /HTTPS/);
  assert.throws(() => new HostingerClient({ siteUrl: 'https://example.test/?secret=value' }), /HTTPS/);
  assert.throws(() => new HostingerClient({ hostingerAccount: '../secrets' }), /hostingerAccount/);
  assert.throws(() => new HostingerClient({ hostingerDomain: 'example.test/other' }), /domain name/);
});

test('live release verification never sends the hosting credential to the website', async () => {
  const calls = [];
  const client = new HostingerClient({ ...config, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (url.hostname === 'www.example.test') return Response.json({ schema: 1, sha, builtAt: '2026-10-23T10:00:00Z', secret: 'private' });
    return Response.json({ data: [{ uuid: '69f07fe2-197a-4fb3-9dae-606f965ad13d', state: 'completed', created_at: '2026-10-23T10:00:00Z', updated_at: '2026-10-23T10:01:00Z', options: { source_options: { branch: 'master', commit: { hash: sha, message: 'secret commit text' } }, env_vars: [{ key: 'SECRET', value: 'private' }] }, logs: 'hosting-secret' }], meta: { current_page: 1 } });
  } });
  const status = await client.status({ expectedSha: sha });
  assert.equal(status.site.sha, sha);
  assert.equal(status.site.matchesExpectedSha, true);
  assert.equal(status.hostinger.builds[0].sha, sha);
  assert.equal(status.hostinger.builds[0].state, 'completed');
  assert.doesNotMatch(JSON.stringify(status), /hosting-secret|private|secret commit/);
  const website = calls.find(call => call.url.hostname === 'www.example.test');
  assert.equal(website.options.headers.authorization, undefined);
  assert.equal(website.options.redirect, 'error');
  assert.equal(website.url.pathname, '/.well-known/site-release.json');
  const hostinger = calls.find(call => call.url.hostname === 'developers.hostinger.com');
  assert.equal(hostinger.options.headers.authorization, 'Bearer hosting-secret');
  assert.equal(hostinger.options.redirect, 'error');
  assert.equal(hostinger.url.pathname, '/api/hosting/v1/accounts/u123456/websites/www.example.test/nodejs/builds');
});

test('missing and unknown release revisions never claim a successful deployment', async () => {
  const missing = new HostingerClient({ siteUrl: config.siteUrl, fetchImpl: async () => new Response('missing', { status: 404 }) });
  assert.equal((await missing.status({ expectedSha: sha })).site.markerValid, false);
  const unknown = new HostingerClient({ siteUrl: config.siteUrl, fetchImpl: async () => Response.json({ schema: 1, sha: null }) });
  const status = await unknown.status({ expectedSha: sha });
  assert.equal(status.site.sha, null);
  assert.equal(status.site.matchesExpectedSha, null);
  const stale = new HostingerClient({ siteUrl: config.siteUrl, fetchImpl: async () => Response.json({ schema: 1, sha: 'b'.repeat(40) }) });
  assert.equal((await stale.status({ expectedSha: sha })).site.matchesExpectedSha, false);
});

test('upstream credentials and errors never appear in deployment status', async () => {
  const client = new HostingerClient({ ...config, fetchImpl: async () => { throw new Error('hosting-secret private DNS error'); } });
  assert.doesNotMatch(JSON.stringify(await client.status()), /hosting-secret|private DNS/);
  const httpError = new HostingerClient({ ...config, fetchImpl: async () => new Response('hosting-secret', { status: 403 }) });
  assert.doesNotMatch(JSON.stringify(await httpError.status()), /hosting-secret/);
});

test('oversized and malformed responses are bounded and rejected', async () => {
  const marker = new HostingerClient({ siteUrl: config.siteUrl, fetchImpl: async () => new Response('x'.repeat(9000)) });
  assert.equal((await marker.status()).site.markerValid, false);
  const api = new HostingerClient({ ...config, siteUrl: undefined, fetchImpl: async () => Response.json({ arbitrary: 'not a list' }) });
  assert.match((await api.status()).hostinger.error, /invalid builds/);
});

test('expected SHA input must be immutable before any request', async () => {
  const client = new HostingerClient({ fetchImpl: () => { throw new Error('must not fetch'); } });
  await assert.rejects(client.status({ expectedSha: 'master' }), /expectedSha/);
});
