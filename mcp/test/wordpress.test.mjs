import test from 'node:test';
import assert from 'node:assert/strict';
import { WordPressClient, validateWordPressFields, validateWordPressImage, revisionToFields } from '../src/wordpress.mjs';

const modified = '2026-10-23T10:20:30';
const post = (overrides = {}) => ({ id: 42, title: { raw: 'Title' }, content: { raw: '<p>Original</p>' }, excerpt: { raw: 'Excerpt' }, slug: 'title', status: 'publish', featured_media: 1, categories: [2], tags: [], date: '2026-10-01T08:00:00', date_gmt: '2026-10-01T03:00:00', modified_gmt: modified, link: 'https://www.swishtag.com/title/', ...overrides });
const config = { baseUrl: 'https://cms.example.test/wp-json/wp/v2/', username: 'mcp-editor', applicationPassword: 'super-secret' };
function fixture(responses) {
  const calls = [];
  const client = new WordPressClient({ ...config, fetchImpl: async (url, options) => {
    calls.push({ url: new URL(url), ...options });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next instanceof Response ? next : Response.json(next);
  } });
  return { client, calls };
}

test('unconfigured client reports missing connection without network requests', async () => {
  const client = new WordPressClient();
  assert.deepEqual(await client.inspect(), { configured: false });
  await assert.rejects(client.get({ id: 1 }), /not configured/);
});

test('credentials require a configured HTTPS endpoint and are never returned', async () => {
  assert.throws(() => new WordPressClient({ ...config, baseUrl: 'http://cms.example.test' }), /HTTPS/);
  assert.throws(() => new WordPressClient({ ...config, baseUrl: 'https://secret:password@cms.example.test' }), /HTTPS/);
  assert.throws(() => new WordPressClient({ ...config, baseUrl: 'https://cms.example.test/?path=secret' }), /HTTPS/);
  const { client, calls } = fixture([{ id: 2, name: 'MCP Editor', capabilities: { edit_posts: true, manage_options: true } }]);
  const info = await client.inspect();
  assert.equal(info.capabilities.edit_posts, true);
  assert.equal(info.capabilities.manage_options, undefined);
  assert.doesNotMatch(JSON.stringify(info), /super-secret|Basic/);
  assert.equal(calls[0].headers.authorization, `Basic ${Buffer.from('mcp-editor:super-secret').toString('base64')}`);
  assert.equal(calls[0].redirect, 'error');
});

test('fixed route collection and ID validation prevents arbitrary endpoints', async () => {
  const { client, calls } = fixture([]);
  await assert.rejects(client.get({ type: '../users', id: 1 }), /type/);
  await assert.rejects(client.get({ id: '../../users' }), /ID/);
  await assert.rejects(client.list({ perPage: 1000 }), /perPage/);
  assert.equal(calls.length, 0);
});

test('posts and portfolio reads request editable raw content with bounded pages', async () => {
  const { client, calls } = fixture([Response.json([post()], { headers: { 'x-wp-total': '23', 'x-wp-totalpages': '2' } }), post()]);
  const collection = await client.list({ type: 'portfolio', perPage: 20, search: 'project' });
  assert.equal(collection.total, 23);
  assert.equal(collection.items[0].title, 'Title');
  assert.equal(calls[0].url.pathname, '/wp-json/wp/v2/portfolio');
  assert.equal(calls[0].url.searchParams.get('context'), 'edit');
  assert.equal(calls[0].url.searchParams.get('search'), 'project');
  const snapshot = await client.snapshot({ id: 42 });
  assert.equal(snapshot.fields.content, '<p>Original</p>');
  assert.equal(snapshot.modified_gmt, modified);
});

test('allowlisted fields reject privilege, remote URL, and arbitrary metadata changes', () => {
  for (const fields of [{ author: 7 }, { password: 'secret' }, { type: 'page' }, { status: 'trash' }, { meta: { unregistered: 'value' } }, { content: { rendered: 'html' } }]) {
    assert.throws(() => validateWordPressFields(fields));
  }
  assert.deepEqual(validateWordPressFields({ title: 'New', meta: { seo_title: 'SEO' } }, { metaKeys: ['seo_title'] }), { title: 'New', meta: { seo_title: 'SEO' } });
  assert.throws(() => validateWordPressFields({ tags: [1] }, { type: 'portfolio' }), /Unsupported/);
});

test('update checks saved modification time and performs only allowlisted POST', async () => {
  const { client, calls } = fixture([post(), post({ title: { raw: 'Updated' }, modified_gmt: '2026-10-23T10:30:00' })]);
  const saved = await client.update({ id: 42, fields: { title: 'Updated' }, expectedModified: modified });
  assert.equal(saved.fields.title, 'Updated');
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[1].method, 'POST');
  assert.deepEqual(JSON.parse(calls[1].body), { title: 'Updated' });
  const stale = fixture([post({ modified_gmt: '2026-10-23T11:00:00' })]);
  await assert.rejects(stale.client.update({ id: 42, fields: { title: 'Updated' }, expectedModified: modified }), /changed since/);
  assert.equal(stale.calls.length, 1);
  await assert.rejects(stale.client.update({ id: 42, fields: { title: 'Updated' } }), /modification time/);
});

test('restore verifies item ownership and restores a stored snapshot through update', async () => {
  const { client, calls } = fixture([post(), post({ content: { raw: '<p>Old</p>' } })]);
  await assert.rejects(async () => client.restore({ id: 42, snapshot: { type: 'posts', id: 43, fields: { title: 'Wrong' } }, expectedModified: modified }), /different item/);
  await client.restore({ id: 42, snapshot: { type: 'posts', id: 42, fields: { content: '<p>Old</p>' } }, expectedModified: modified });
  assert.deepEqual(JSON.parse(calls[1].body), { content: '<p>Old</p>' });
});

test('revisions preserve raw content and reject revisions for another parent', async () => {
  const revision = { id: 88, parent: 42, modified_gmt: modified, title: { raw: 'Earlier' }, content: { raw: '[vc_row]legacy[/vc_row]' }, excerpt: { raw: '' } };
  const { client, calls } = fixture([[revision], revision, { ...revision, parent: 99 }]);
  const list = await client.revisions({ id: 42 });
  assert.equal(list.items[0].fields.content, '[vc_row]legacy[/vc_row]');
  assert.equal(calls[0].url.pathname, '/wp-json/wp/v2/posts/42/revisions');
  assert.deepEqual((await client.getRevision({ id: 42, revisionId: 88 })).fields, revisionToFields(revision));
  await assert.rejects(client.getRevision({ id: 42, revisionId: 88 }), /different post/);
});

test('draft creation cannot publish or change user identity', async () => {
  const { client, calls } = fixture([post({ status: 'draft' })]);
  await client.createDraft({ fields: { title: 'Draft', status: 'publish' } });
  assert.equal(JSON.parse(calls[0].body).status, 'draft');
  await assert.rejects(client.createDraft({ fields: { title: 'Draft', author: 1 } }), /Unsupported/);
});

test('media uses validated bytes and one multipart request, without fetching source URLs', async () => {
  const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jLuUAAAAASUVORK5CYII=';
  const input = { filename: 'cover.png', mimeType: 'image/png', base64, altText: 'Project cover' };
  const { client, calls } = fixture([{ id: 9, source_url: 'https://cms.example.test/uploads/cover.png', alt_text: input.altText, mime_type: input.mimeType }]);
  assert.equal((await client.uploadMedia(input)).id, 9);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, '/wp-json/wp/v2/media');
  assert.equal(calls[0].body.get('alt_text'), 'Project cover');
  assert.equal(calls[0].body.get('file').type, 'image/png');
  for (const bad of [{ ...input, filename: '../cover.png' }, { ...input, mimeType: 'image/jpeg' }, { ...input, filename: 'cover.svg' }, { ...input, base64: Buffer.from('<script>bad</script>').toString('base64') }]) {
    assert.throws(() => validateWordPressImage(bad));
  }
});

test('upstream responses and network failures do not leak secrets or untrusted error text', async () => {
  const failed = fixture([new Error('https://mcp-editor:super-secret@example.test'), new Response('super-secret<script>', { status: 401 })]);
  await assert.rejects(failed.client.get({ id: 1 }), error => !error.message.includes('super-secret') && /request failed/.test(error.message));
  await assert.rejects(failed.client.get({ id: 1 }), error => !error.message.includes('super-secret') && /401/.test(error.message));
  const oversized = fixture([new Response('{}', { headers: { 'content-length': String(5 * 1024 * 1024) } })]);
  await assert.rejects(oversized.client.get({ id: 1 }), /size limit/);
  const noRaw = fixture([post({ content: { rendered: '<p>Rendered only</p>' } })]);
  await assert.rejects(noRaw.client.get({ id: 1 }), /editable content/);
});
