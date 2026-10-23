import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebsiteService } from '../src/service.mjs';
import { ServiceError } from '../src/github.mjs';
import { validateWordPressFields } from '../src/wordpress.mjs';

const CHANGE_ID = '11111111-1111-4111-8111-111111111111';
const OPERATION_ID = '22222222-2222-4222-8222-222222222222';
const operationPath = id => `.mcp/wordpress/${id}.json`;
const image = { filename: 'cover.png', mimeType: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jLuUAAAAASUVORK5CYII=', altText: 'Project cover' };
const page = '---\nconst title = "Company | Swishtag";\nconst description = "Company description";\nconst canonical = "https://swishtag.com/company/";\nconst robots = "index,follow";\n---\n<html><head><title>{title}</title></head><body><h1>Company</h1></body></html>\n';
const clone = value => structuredClone(value);

async function fixture(t, { status = 'draft' } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'swishtag-mcp-service-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const policyPath = join(directory, 'policy.json');
  const policy = { roles: {}, users: {} };
  const actor = async (subject = 'owner', permissions = ['wordpress.edit', 'wordpress.read'], paths = ['*']) => {
    policy.roles[subject] = { permissions, paths };
    policy.users[subject] = { roles: [subject] };
    await writeFile(policyPath, JSON.stringify({ policy }));
    return { subject, policyPath, issuedAt: Date.now() / 1000 - 5, expiresAt: Date.now() / 1000 + 3600 };
  };
  const events = [];
  const versioned = new Map();
  let sequence = 1;
  const sha = number => number.toString(16).padStart(40, '0');
  let head = sha(sequence);
  versioned.set(head, new Map([
    ['src/pages/company/index.astro', Buffer.from(page)],
    ['src/pages/contact-us/index.astro', Buffer.from(page)],
    ['src/data/home.json', Buffer.from('{"heading":"Original"}')],
    ['src/data/redirects.json', Buffer.from('{"/services":"/solutions/"}')],
  ]));
  const manifest = { id: CHANGE_ID, owner: 'owner', base: head, summary: 'Service test change', events: [] };
  const state = { failAction: null, before: { type: 'posts', id: 42, modified_gmt: '2026-10-23T10:00:00', fields: { title: 'Original', content: '<p>Original</p>', excerpt: '', slug: 'original', status, featured_media: 1, categories: [], tags: [] } } };
  const github = {
    head: async () => head,
    read: async (path, revision) => {
      const bytes = versioned.get(revision)?.get(path);
      if (!bytes) throw new ServiceError('Missing fixture file.', 'not_found', 404);
      return { bytes: Buffer.from(bytes), size: bytes.length, sha: 'f'.repeat(40) };
    },
    tree: async revision => [...versioned.get(revision).keys()].map(path => ({ path, type: 'blob', mode: '100644' })),
  };
  const repository = {
    github,
    get: async (id, expectedHead) => {
      if (id !== CHANGE_ID) throw new ServiceError('Missing fixture change.', 'not_found', 404);
      if (expectedHead && expectedHead !== head) throw new ServiceError('Stale fixture head.', 'conflict', 409);
      return { id, branch: `mcp/${id}`, head, manifest: clone(manifest) };
    },
    readJson: async (change, path) => JSON.parse((await github.read(path, change.head)).bytes.toString('utf8')),
    write: async (change, principal, edits, action, details = {}) => {
      if (state.failAction === action) throw new Error(`Simulated ${action} storage failure.`);
      assert.equal(change.head, head, 'service must write against the latest durable head');
      const next = new Map([...versioned.get(head)].map(([path, bytes]) => [path, Buffer.from(bytes)]));
      for (const edit of edits) {
        if (edit.bytes === null) next.delete(edit.path);
        else next.set(edit.path, Buffer.from(edit.bytes));
      }
      head = sha(++sequence);
      versioned.set(head, next);
      events.push({ kind: 'git', action, actor: principal.subject, head, ...details });
      manifest.events.push({ action, actor: principal.subject });
      return { id: change.id, head, action };
    },
    writeJson: async (change, principal, path, value, action, details) => repository.write(change, principal, [{ path, bytes: Buffer.from(JSON.stringify(value)) }], action, details),
    diff: async () => [...versioned.get(head).keys()].filter(path => path.startsWith('.mcp/')).map(path => ({ path, status: 'added' })),
    publish: async change => { events.push({ kind: 'publish' }); return { state: 'source_published', sha: change.head }; },
  };
  const wordpress = {
    configured: () => true,
    validate: (fields, options) => validateWordPressFields(fields, options),
    snapshot: async args => { events.push({ kind: 'snapshot', ...args }); return clone(state.before); },
    update: async args => { events.push({ kind: 'update', ...clone(args) }); return { ...clone(state.before), fields: { ...clone(state.before.fields), ...clone(args.fields) } }; },
    uploadMedia: async args => { events.push({ kind: 'media', ...clone(args) }); return { id: 9, source_url: 'https://cms.example.test/uploads/cover.png' }; },
  };
  const service = new WebsiteService({ repository, wordpress, hostinger: { status: async () => ({ site: { configured: false } }) }, config: {} });
  const operation = async id => repository.readJson(await repository.get(CHANGE_ID), operationPath(id));
  const stage = async (principal, fields = { title: 'Changed' }) => service.wpStage(principal, { changeId: CHANGE_ID, expectedHead: head, type: 'posts', id: 42, fields });
  return { actor, service, repository, github, wordpress, events, state, stage, operation, get head() { return head; } };
}

test('WordPress staging commits the editable before snapshot and intent without changing live content', async t => {
  const f = await fixture(t, { status: 'publish' });
  const actor = await f.actor();
  const result = await f.stage(actor);
  const operation = await f.operation(result.operationId);
  assert.equal(result.state, 'staged');
  assert.equal(result.requiresPublishingPermission, true);
  assert.equal(operation.actor, 'owner');
  assert.equal(operation.before.fields.title, 'Original');
  assert.equal(operation.before.modified_gmt, '2026-10-23T10:00:00');
  assert.deepEqual(operation.fields, { title: 'Changed' });
  assert.equal(f.events.filter(event => event.kind === 'update' || event.kind === 'media').length, 0);
  assert.equal(f.events.at(-1).action, 'wordpress.staged');
});

test('WordPress draft update writes a durable applying intent before the live request and final result afterward', async t => {
  const f = await fixture(t);
  const actor = await f.actor();
  const staged = await f.stage(actor);
  f.wordpress.update = async args => {
    assert.equal((await f.operation(staged.operationId)).state, 'applying');
    assert.equal(f.events.at(-1).action, 'wordpress.applying');
    assert.equal(args.expectedModified, '2026-10-23T10:00:00');
    f.events.push({ kind: 'update', ...args });
    return { ...clone(f.state.before), fields: { ...clone(f.state.before.fields), ...args.fields } };
  };
  const result = await f.service.wpApply(actor, { changeId: CHANGE_ID, expectedHead: f.head, operationId: staged.operationId });
  assert.equal(result.state, 'applied');
  assert.deepEqual(f.events.filter(event => event.kind === 'git' || event.kind === 'update').map(event => event.action ?? event.kind), ['wordpress.staged', 'wordpress.applying', 'update', 'wordpress.applied']);
  assert.equal((await f.operation(staged.operationId)).after.fields.title, 'Changed');
});

test('restoring saved WordPress content captures a fresh before snapshot and concurrency precondition', async t => {
  const f = await fixture(t);
  const actor = await f.actor();
  const original = await f.stage(actor);
  f.state.before.fields.title = 'Changed by a WordPress editor later';
  f.state.before.fields.status = 'publish';
  f.state.before.modified_gmt = '2026-10-23T14:00:00';
  const restored = await f.service.wpStage(actor, {
    changeId: CHANGE_ID, expectedHead: f.head,
    restoreChangeId: CHANGE_ID, restoreOperationId: original.operationId,
  });
  const record = await f.operation(restored.operationId);
  assert.equal(record.fields.title, 'Original');
  assert.equal(record.before.fields.title, 'Changed by a WordPress editor later');
  assert.equal(record.before.modified_gmt, '2026-10-23T14:00:00');
  assert.equal(restored.requiresPublishingPermission, true);
  assert.equal(f.events.filter(event => event.kind === 'snapshot').length, 2);
  assert.equal(f.events.some(event => event.kind === 'update'), false);
});

test('editing an already published post requires wordpress.publish even when status is omitted', async t => {
  const f = await fixture(t, { status: 'publish' });
  const actor = await f.actor();
  const staged = await f.stage(actor);
  await assert.rejects(f.service.wpApply(actor, { changeId: CHANGE_ID, expectedHead: f.head, operationId: staged.operationId }), { code: 'forbidden' });
  assert.equal((await f.operation(staged.operationId)).state, 'staged');
  assert.equal(f.events.some(event => event.kind === 'update' || event.action === 'wordpress.applying'), false);
});

test('publishing, scheduling or privatizing a draft requires wordpress.publish', async t => {
  for (const status of ['publish', 'future', 'private']) {
    await t.test(status, async subtest => {
      const f = await fixture(subtest);
      const actor = await f.actor();
      const staged = await f.stage(actor, { status });
      await assert.rejects(f.service.wpApply(actor, { changeId: CHANGE_ID, expectedHead: f.head, operationId: staged.operationId }), { code: 'forbidden' });
      assert.equal((await f.operation(staged.operationId)).state, 'staged');
    });
  }
});

test('WordPress media bytes and intent are committed together and uploads require publishing permission', async t => {
  const f = await fixture(t);
  let actor = await f.actor('owner', ['wordpress.edit', 'wordpress.read', 'assets.edit']);
  const staged = await f.service.wpStageImage(actor, { changeId: CHANGE_ID, expectedHead: f.head, ...image });
  const record = await f.operation(staged.operationId);
  assert.deepEqual((await f.github.read(record.path, f.head)).bytes, Buffer.from(image.base64, 'base64'));
  assert.equal(f.events.filter(event => event.kind === 'git').length, 1);
  await assert.rejects(f.service.wpApply(actor, { changeId: CHANGE_ID, expectedHead: f.head, operationId: staged.operationId }), { code: 'forbidden' });
  assert.equal(f.events.some(event => event.kind === 'media'), false);
  actor = await f.actor('owner', ['wordpress.edit', 'wordpress.read', 'assets.edit', 'wordpress.publish']);
  assert.equal((await f.service.wpApply(actor, { changeId: CHANGE_ID, expectedHead: f.head, operationId: staged.operationId })).state, 'applied');
  assert.equal(f.events.filter(event => event.kind === 'media').length, 1);
});

test('a WordPress timeout records an unknown outcome and blocks a blind retry', async t => {
  const f = await fixture(t);
  const actor = await f.actor();
  const staged = await f.stage(actor);
  let calls = 0;
  f.wordpress.update = async () => { calls++; throw new Error('timeout with secret-internal-upstream-url'); };
  const result = await f.service.wpApply(actor, { changeId: CHANGE_ID, expectedHead: f.head, operationId: staged.operationId });
  assert.equal(result.state, 'unknown');
  assert.equal((await f.operation(staged.operationId)).state, 'unknown');
  assert.doesNotMatch(JSON.stringify(result), /secret-internal/);
  await assert.rejects(f.service.wpApply(actor, { changeId: CHANGE_ID, expectedHead: f.head, operationId: staged.operationId }), { code: 'already_attempted' });
  assert.equal(calls, 1);
});

test('concurrent attempts with the same change head cannot replay one WordPress operation', async t => {
  const f = await fixture(t);
  const actor = await f.actor();
  const staged = await f.stage(actor);
  const args = { changeId: CHANGE_ID, expectedHead: f.head, operationId: staged.operationId };
  const results = await Promise.allSettled([f.service.wpApply(actor, args), f.service.wpApply(actor, args)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal(f.events.filter(event => event.kind === 'update').length, 1);
  assert.equal((await f.operation(staged.operationId)).state, 'applied');
});

test('failure to commit applying intent prevents any WordPress mutation', async t => {
  const f = await fixture(t);
  const actor = await f.actor();
  const staged = await f.stage(actor);
  f.state.failAction = 'wordpress.applying';
  await assert.rejects(f.service.wpApply(actor, { changeId: CHANGE_ID, expectedHead: f.head, operationId: staged.operationId }), /storage failure/);
  assert.equal((await f.operation(staged.operationId)).state, 'staged');
  assert.equal(f.events.some(event => event.kind === 'update'), false);
});

test('failure to record a successful live mutation leaves durable applying state and blocks retry', async t => {
  const f = await fixture(t);
  const actor = await f.actor();
  const staged = await f.stage(actor);
  f.state.failAction = 'wordpress.applied';
  await assert.rejects(f.service.wpApply(actor, { changeId: CHANGE_ID, expectedHead: f.head, operationId: staged.operationId }), /storage failure/);
  assert.equal((await f.operation(staged.operationId)).state, 'applying');
  await assert.rejects(f.service.wpApply(actor, { changeId: CHANGE_ID, expectedHead: f.head, operationId: staged.operationId }), { code: 'already_attempted' });
  assert.equal(f.events.filter(event => event.kind === 'update').length, 1);
});

test('reconciliation fetches current editable fields and can resolve a previously uncertain update', async t => {
  const f = await fixture(t);
  const actor = await f.actor();
  const record = { operationId: OPERATION_ID, kind: 'update', state: 'unknown', type: 'posts', postId: 42, before: clone(f.state.before), fields: { title: 'Changed' } };
  await f.repository.writeJson(await f.repository.get(CHANGE_ID), actor, operationPath(OPERATION_ID), record, 'fixture');
  f.state.before.fields.title = 'Changed';
  f.state.before.modified_gmt = '2026-10-23T12:00:00';
  const result = await f.service.wpOperation(actor, { changeId: CHANGE_ID, operationId: OPERATION_ID, expectedHead: f.head, reconcile: true });
  assert.equal(result.state, 'applied');
  assert.equal((await f.operation(OPERATION_ID)).observed.modified_gmt, '2026-10-23T12:00:00');
  assert.equal(f.events.at(-2).kind, 'snapshot');
  assert.equal(f.events.at(-1).action, 'wordpress.reconciled');
  assert.equal(f.events.some(event => event.kind === 'update'), false);
});

test('reconciliation requires the current change head before reading WordPress state', async t => {
  const f = await fixture(t);
  const actor = await f.actor();
  const record = { operationId: OPERATION_ID, kind: 'update', state: 'unknown', type: 'posts', postId: 42, before: clone(f.state.before), fields: { title: 'Changed' } };
  await f.repository.writeJson(await f.repository.get(CHANGE_ID), actor, operationPath(OPERATION_ID), record, 'fixture');
  await assert.rejects(f.service.wpOperation(actor, { changeId: CHANGE_ID, operationId: OPERATION_ID, reconcile: true }), { code: 'conflict' });
  assert.equal(f.events.some(event => event.kind === 'snapshot'), false);
  assert.equal((await f.operation(OPERATION_ID)).state, 'unknown');
});

test('differing reconciliation remains unresolved and prevents source publication', async t => {
  const f = await fixture(t);
  const actor = await f.actor('owner', ['wordpress.edit', 'wordpress.read', 'deploy.publish']);
  const record = { operationId: OPERATION_ID, kind: 'update', state: 'unknown', type: 'posts', postId: 42, before: clone(f.state.before), fields: { title: 'Not yet observed' } };
  await f.repository.writeJson(await f.repository.get(CHANGE_ID), actor, operationPath(OPERATION_ID), record, 'fixture');
  const result = await f.service.wpOperation(actor, { changeId: CHANGE_ID, operationId: OPERATION_ID, expectedHead: f.head, reconcile: true });
  assert.equal(result.state, 'unresolved');
  await assert.rejects(f.service.publish(actor, { changeId: CHANGE_ID, expectedHead: f.head }), { code: 'wordpress_unresolved' });
  assert.equal(f.events.some(event => event.kind === 'publish'), false);
});

test('change ownership applies to source and WordPress changes while full administrators can take over', async t => {
  const f = await fixture(t);
  const other = await f.actor('other', ['assets.edit', 'wordpress.edit', 'wordpress.read']);
  await assert.rejects(f.service.sourceWrite(other, { changeId: CHANGE_ID, expectedHead: f.head, path: 'src/styles/test.css', content: 'p { color: red; }' }), /change owner/);
  await assert.rejects(f.stage(other), /change owner/);
  const administrator = await f.actor('administrator', ['website.full']);
  await f.service.sourceWrite(administrator, { changeId: CHANGE_ID, expectedHead: f.head, path: 'src/data/home.json', content: '{"heading":"Changed"}' });
  assert.equal(f.events.at(-1).actor, 'administrator');
});

test('raw executable source requires website.full even for a page editor', async t => {
  const f = await fixture(t);
  let actor = await f.actor('owner', ['site.read', 'content.edit', 'seo.edit', 'pages.edit']);
  await assert.rejects(f.service.sourceWrite(actor, { changeId: CHANGE_ID, expectedHead: f.head, path: 'src/pages/company/index.astro', content: page }), { code: 'forbidden' });
  assert.equal(f.events.length, 0);
  actor = await f.actor('owner', ['website.full']);
  await f.service.sourceWrite(actor, { changeId: CHANGE_ID, expectedHead: f.head, path: 'src/pages/company/index.astro', content: page });
  assert.equal(f.events.at(-1).action, 'source.updated');
});

test('SEO-only grants edit permitted page metadata without acquiring text, layout or other page access', async t => {
  const f = await fixture(t);
  const actor = await f.actor('owner', ['seo.edit'], ['src/pages/company/index.astro']);
  const args = { changeId: CHANGE_ID, expectedHead: f.head, path: 'src/pages/company/index.astro', fields: { title: 'Updated company title' } };
  await f.service.structuredEdit(actor, args, 'seo');
  const updated = (await f.github.read(args.path, f.head)).bytes.toString('utf8');
  assert.match(updated, /Updated company title/);
  assert.match(updated, /<h1>Company<\/h1>/);
  await assert.rejects(f.service.structuredEdit(actor, { ...args, expectedHead: f.head, path: 'src/pages/contact-us/index.astro' }, 'seo'), { code: 'forbidden' });
  await assert.rejects(f.service.structuredEdit(actor, { ...args, expectedHead: f.head, path: 'src/layouts/BaseLayout.astro' }, 'seo'), /individual page templates/);
  await assert.rejects(f.service.structuredEdit(actor, { ...args, expectedHead: f.head, path: 'src/pages/api/forms/submit.astro' }, 'seo'), /website Astro template/);
  await assert.rejects(f.service.structuredEdit(actor, { ...args, expectedHead: f.head, oldText: 'Company', newText: 'Changed' }, 'text'), { code: 'forbidden' });
});

test('redirect validation includes existing routes and normalizes trailing slashes when detecting cycles', async t => {
  const f = await fixture(t);
  const actor = await f.actor('owner', ['redirects.edit']);
  await assert.rejects(f.service.redirect(actor, { changeId: CHANGE_ID, expectedHead: f.head, from: '/solutions', to: '/services/', status: 301 }), { code: 'invalid_redirect' });
  assert.equal(f.events.length, 0);
  await f.service.redirect(actor, { changeId: CHANGE_ID, expectedHead: f.head, from: '/old', to: '/new/', status: 308 });
  assert.deepEqual(await f.repository.readJson(await f.repository.get(CHANGE_ID), 'src/data/redirects.json'), { '/services': '/solutions/', '/old': { destination: '/new/', status: 308 } });
});

test('published status observed at apply time requires publishing authority even if its timestamp has not changed', async t => {
  const f = await fixture(t);
  const actor = await f.actor();
  const staged = await f.stage(actor);
  f.state.before.fields.status = 'publish';
  await assert.rejects(f.service.wpApply(actor, { changeId: CHANGE_ID, expectedHead: f.head, operationId: staged.operationId }), { code: 'forbidden' });
  assert.equal(f.events.some(event => event.kind === 'update'), false);
  assert.equal((await f.operation(staged.operationId)).state, 'staged');
});

test('an unresolved post can be reconciled again after an operator corrects the live fields', async t => {
  const f = await fixture(t);
  const actor = await f.actor();
  const record = { operationId: OPERATION_ID, kind: 'update', state: 'unresolved', type: 'posts', postId: 42, before: clone(f.state.before), fields: { title: 'Recovered' } };
  await f.repository.writeJson(await f.repository.get(CHANGE_ID), actor, operationPath(OPERATION_ID), record, 'fixture');
  f.state.before.fields.title = 'Recovered';
  const result = await f.service.wpOperation(actor, { changeId: CHANGE_ID, operationId: OPERATION_ID, expectedHead: f.head, reconcile: true });
  assert.equal(result.state, 'applied');
});

test('production history exposes revision and parent choices without requesting other repository sources', async t => {
  const f = await fixture(t);
  const actor = await f.actor('owner', ['history.read']);
  f.github.config = { baseBranch: 'master' };
  f.github.request = async path => {
    assert.equal(path, '/commits?sha=master&per_page=5&page=2');
    return [{ sha: 'a'.repeat(40), commit: { message: 'Published footer\nInternal details', committer: { date: '2026-10-23T10:00:00Z' } }, html_url: 'https://github.com/owner/repo/commit/a', parents: [{ sha: 'b'.repeat(40) }] }];
  };
  const result = await f.service.history(actor, { page: 2, perPage: 5 });
  assert.equal(result.commits[0].summary, 'Published footer');
  assert.deepEqual(result.commits[0].parents, ['b'.repeat(40)]);
});
