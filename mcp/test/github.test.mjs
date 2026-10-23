import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubClient, ServiceError, assertSha } from '../src/github.mjs';

const SHA = 'a'.repeat(40);
const NEXT = 'b'.repeat(40);
const TREE = 'c'.repeat(40);
const BLOB = 'd'.repeat(40);
const config = { owner: 'swishtag', repo: 'website', baseBranch: 'main', workflow: 'mcp-validate.yml', token: 'server-only-token' };

function fixture(responses, overrides = {}) {
  const calls = [];
  const client = new GitHubClient({ ...config, ...overrides }, { fetchImpl: async (url, options) => {
    calls.push({ url: new URL(url), ...options, parsedBody: options.body === undefined ? undefined : JSON.parse(options.body) });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    if (next === undefined) throw new Error('Unexpected fetch');
    return next instanceof Response ? next : Response.json(next);
  } });
  return { client, calls };
}

function run(overrides = {}) {
  return { id: 123, display_title: `MCP Validate ${SHA}`, head_branch: 'main', event: 'workflow_dispatch',
    path: '.github/workflows/mcp-validate.yml', repository: { full_name: 'swishtag/website' },
    status: 'completed', conclusion: 'success', html_url: 'https://github.com/swishtag/website/actions/runs/123', ...overrides };
}
function artifacts(overrides = {}) {
  return { artifacts: [
    { id: 5, name: `mcp-validation-${SHA}`, expired: false, workflow_run: { id: 123 } },
    { id: 6, name: `mcp-build-${SHA}`, expired: false, workflow_run: { id: 123 } },
  ], ...overrides };
}

test('commit identities require primitive full lowercase SHAs, with no coercion', () => {
  assert.equal(assertSha(SHA), SHA);
  for (const value of [undefined, null, '', SHA.slice(0, 7), SHA.toUpperCase(), `${SHA}/../main`, [SHA], { toString: () => SHA }]) {
    assert.throws(() => assertSha(value), error => error instanceof ServiceError && error.code === 'invalid_sha');
  }
});

test('GitHub requests use one configured repository, server credentials, and disabled redirects', async () => {
  const { client, calls } = fixture([{ object: { sha: SHA } }]);
  assert.equal(await client.head(), SHA);
  assert.equal(calls[0].url.href, 'https://api.github.com/repos/swishtag/website/git/ref/heads/main');
  assert.equal(calls[0].headers.Authorization, 'Bearer server-only-token');
  assert.equal(calls[0].redirect, 'error');
  assert.equal(calls[0].headers['X-GitHub-Api-Version'], '2022-11-28');
  const missing = fixture([], { token: '' });
  await assert.rejects(missing.client.head(), error => error.code === 'missing_credentials');
  assert.equal(missing.calls.length, 0);
});

test('branch mutation never forces refs, and unsafe refs are rejected before network access', async () => {
  const { client, calls } = fixture([{}, {}]);
  await client.createBranch('mcp/change-123', SHA);
  await client.advance('mcp/change-123', NEXT);
  assert.deepEqual(calls[0].parsedBody, { ref: 'refs/heads/mcp/change-123', sha: SHA });
  assert.deepEqual(calls[1].parsedBody, { sha: NEXT, force: false });
  assert.equal(calls[1].method, 'PATCH');
  assert.equal(calls[1].url.pathname, '/repos/swishtag/website/git/refs/heads/mcp%2Fchange-123');
  for (const branch of ['../main', '/main', 'main/', 'a//b', '.private', 'main.lock', 'main@{1}', 'main?x=1']) {
    assert.throws(() => client.advance(branch, SHA), error => error.code === 'invalid_branch');
  }
  assert.equal(calls.length, 2);
});

test('non-fast-forward ref rejection is a conflict and never retried with force', async () => {
  const { client, calls } = fixture([new Response('sensitive upstream error', { status: 422 })]);
  await assert.rejects(client.advance('main', NEXT), error => error.code === 'conflict' && error.status === 409 && !error.message.includes('sensitive'));
  assert.equal(calls.length, 1);
});

test('commit writing links the new tree and commit to the exact saved parent', async () => {
  const { client, calls } = fixture([{ tree: { sha: TREE } }, { sha: BLOB }, { sha: NEXT }, { sha: SHA }]);
  await client.writeCommit(SHA, [{ path: 'src/data/content.json', bytes: Buffer.from('{"title":"new"}') }, { path: 'public/old.png', bytes: null }], 'Website update');
  assert.equal(calls[0].url.pathname, `/repos/swishtag/website/git/commits/${SHA}`);
  assert.deepEqual(calls[2].parsedBody, { base_tree: TREE, tree: [
    { path: 'src/data/content.json', mode: '100644', type: 'blob', sha: BLOB },
    { path: 'public/old.png', mode: '100644', type: 'blob', sha: null },
  ] });
  assert.deepEqual(calls[3].parsedBody, { message: 'Website update', tree: NEXT, parents: [SHA] });
});

test('repository reads reject symlinks, submodules, oversized blobs and truncated trees', async () => {
  for (const item of [
    { path: 'public/link', sha: BLOB, type: 'blob', mode: '120000', size: 10 },
    { path: 'public/link', sha: BLOB, type: 'commit', mode: '160000', size: 10 },
    { path: 'public/link', sha: BLOB, type: 'blob', mode: '100644', size: 2000 },
  ]) {
    const { client, calls } = fixture([{ tree: [item] }]);
    await assert.rejects(client.read('public/link', SHA, 1000), error => ['invalid_file', 'file_too_large'].includes(error.code));
    assert.equal(calls.length, 1);
  }
  const truncated = fixture([{ truncated: true, tree: [] }]);
  await assert.rejects(truncated.client.tree(SHA), error => error.code === 'tree_too_large');
  const decodedTooLarge = fixture([{ tree: [{ path: 'public/a', type: 'blob', mode: '100644', sha: BLOB }] }, { encoding: 'base64', content: Buffer.alloc(10).toString('base64') }]);
  await assert.rejects(decodedTooLarge.client.read('public/a', SHA, 5), error => error.code === 'file_too_large');
});

test('rollback commit entries reuse exact regular blobs and restore executable modes', async () => {
  const { client, calls } = fixture([{ tree: { sha: TREE } }, { sha: NEXT }, { sha: SHA }]);
  await client.writeCommit(SHA, [{ path: 'public/runner.js', sha: BLOB, mode: '100755' }], 'Restore website');
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[1].parsedBody, { base_tree: TREE, tree: [{ path: 'public/runner.js', mode: '100755', type: 'blob', sha: BLOB }] });
  const invalid = fixture([{ tree: { sha: TREE } }]);
  await assert.rejects(invalid.client.writeCommit(SHA, [{ path: 'public/link', sha: BLOB, mode: '120000' }], 'Unsafe restore'), error => error.code === 'invalid_file');
  assert.equal(invalid.calls.length, 1);
});

test('dispatch binds the trusted workflow branch to the exact candidate SHA input', async () => {
  const { client, calls } = fixture([new Response(null, { status: 204 })]);
  assert.deepEqual(await client.dispatch(SHA), { sha: SHA, state: 'queued', workflow: 'mcp-validate.yml' });
  assert.deepEqual(calls[0].parsedBody, { ref: 'main', inputs: { ref: SHA } });
  assert.equal(calls[0].url.pathname, '/repos/swishtag/website/actions/workflows/mcp-validate.yml/dispatches');
});

test('validation requires exact workflow, branch, dispatch event, candidate SHA and repository', async () => {
  for (const bad of [
    { display_title: `MCP Validate ${NEXT}` }, { head_branch: 'untrusted' }, { event: 'pull_request' },
    { path: '.github/workflows/other.yml' }, { repository: { full_name: 'attacker/website' } },
  ]) {
    const { client, calls } = fixture([{ workflow_runs: [run(bad)] }]);
    assert.deepEqual(await client.validation(SHA), { sha: SHA, state: 'not_started', valid: false });
    assert.equal(calls.length, 1);
  }
});

test('successful validation needs completed successful run plus both unexpired same-run artifacts', async () => {
  const good = fixture([{ workflow_runs: [run({ head_sha: NEXT })] }, artifacts()]);
  const verified = await good.client.validation(SHA);
  assert.equal(verified.valid, true);
  assert.equal(verified.sha, SHA);
  // head_sha is the trusted workflow branch; the candidate is the immutable input.
  assert.equal(good.calls[0].url.searchParams.get('event'), 'workflow_dispatch');
  assert.equal(good.calls[1].url.pathname, '/repos/swishtag/website/actions/runs/123/artifacts');
  for (const [runChange, artifactChange] of [
    [{ status: 'in_progress' }, artifacts()], [{ conclusion: 'failure' }, artifacts()],
    [{}, { artifacts: artifacts().artifacts.slice(0, 1) }],
    [{}, { artifacts: artifacts().artifacts.map(item => ({ ...item, expired: true })) }],
    [{}, { artifacts: artifacts().artifacts.map(item => ({ ...item, workflow_run: { id: 999 } })) }],
  ]) {
    const bad = fixture([{ workflow_runs: [run(runChange)] }, artifactChange]);
    assert.equal((await bad.client.validation(SHA)).valid, false);
  }
});

test('GitHub transport failures and response bodies are sanitized and bounded', async () => {
  const { client } = fixture([new Error('Token server-only-token leaked from transport'), new Response('server-only-token', { status: 403 }), new Response('{}', { headers: { 'content-length': String(21 * 1024 * 1024) } }), new Response('invalid JSON')]);
  for (let i = 0; i < 4; i++) await assert.rejects(client.head(), error => error instanceof ServiceError && !error.message.includes('server-only-token'));
});

test('preview creation keeps the PR draft and rejects arbitrary human comment links', async () => {
  const { client, calls } = fixture([[], { number: 7, html_url: 'https://github.com/swishtag/website/pull/7' }, [
    { user: { type: 'User', login: 'hostinger' }, body: 'https://fake.hostingersite.com', html_url: 'https://example.test/comment' },
  ]]);
  const preview = await client.preview('mcp/change-1', 'Update footer');
  assert.equal(preview.state, 'waiting_for_hostinger');
  assert.deepEqual(preview.previews, []);
  assert.equal(calls[1].parsedBody.draft, true);
  assert.equal(calls[1].parsedBody.base, 'main');
});
