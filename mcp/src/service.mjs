import { randomUUID } from 'node:crypto';
import { assertPermission, authorize, AuthorizationError } from './auth.mjs';
import { ServiceError, assertSha } from './github.mjs';
import { sitePath, editPermission, rawEditPermission, validateImage } from './paths.mjs';
import { jsonBytes, changeBranch } from './repository.mjs';
import { editVisibleText, editStaticAttribute, editSeo } from './content.mjs';
import { validateWordPressImage } from './wordpress.mjs';
import { validateData } from './data.mjs';

const WP_PATH = id => { changeBranch(id); return `.mcp/wordpress/${id}.json`; };
const text = file => file.bytes.toString('utf8');
const now = () => new Date().toISOString();
const EDIT_PERMISSIONS = ['website.full', 'content.edit', 'seo.edit', 'assets.edit', 'navigation.edit', 'footer.edit', 'layouts.edit', 'pages.edit', 'redirects.edit', 'wordpress.edit'];

export class WebsiteService {
  constructor({ repository, wordpress, hostinger, config }) {
    this.repo = repository; this.github = repository.github; this.wordpress = wordpress; this.hostinger = hostinger; this.config = config;
    this.locks = new Map();
  }
  async locked(key, action) {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release; const gate = new Promise(resolve => { release = resolve; });
    const current = previous.catch(() => {}).then(() => gate); this.locks.set(key, current);
    await previous.catch(() => {});
    try { return await action(); } finally { release(); if (this.locks.get(key) === current) this.locks.delete(key); }
  }
  async owned(actor, id, expectedHead) {
    const change = await this.repo.get(id, expectedHead);
    if (change.manifest.owner !== actor.subject && !await authorize(actor, 'website.full')) throw new AuthorizationError('Only the change owner or a full-access website administrator may edit it.');
    return change;
  }
  async inspect(actor, { changeId, prefix = '', limit = 200 } = {}) {
    await assertPermission(actor, 'site.read');
    const head = changeId ? (await this.repo.get(changeId)).head : await this.github.head();
    const files = [];
    for (const entry of await this.github.tree(head)) {
      if (entry.type !== 'blob' || !entry.path.startsWith(prefix)) continue;
      try { sitePath(entry.path); } catch { continue; }
      if (await authorize(actor, 'site.read', entry.path)) files.push({ path: entry.path, bytes: entry.size, sha: entry.sha });
    }
    return { revision: head, total: files.length, files: files.slice(0, limit),
      locations: { navigation: 'src/components/layout/Header.astro', footer: 'src/components/layout/Footer.astro', layout: 'src/layouts/BaseLayout.astro', redirects: 'src/data/redirects.json' },
      wordpress: { configured: this.wordpress?.configured() ?? false },
    };
  }
  async read(actor, { path, changeId, revision }) {
    sitePath(path); await assertPermission(actor, 'site.read', path);
    if (changeId && revision) throw new ServiceError('Choose a change ID or revision, not both.');
    const head = changeId ? (await this.repo.get(changeId)).head : revision ? assertSha(revision) : await this.github.head();
    const file = await this.github.read(path, head);
    const binary = /\.(png|jpe?g|gif|webp|ico|woff2?|pdf)$/i.test(path);
    return { path, revision: head, blobSha: file.sha, bytes: file.size, encoding: binary ? 'base64' : 'utf8', content: binary ? file.bytes.toString('base64') : text(file) };
  }
  async create(actor, { summary }) {
    if (!(await Promise.all(EDIT_PERMISSIONS.map(p => authorize(actor, p)))).some(Boolean)) throw new AuthorizationError();
    return this.repo.create(actor, summary);
  }
  async change(actor, { changeId }) {
    await assertPermission(actor, 'history.read');
    const change = await this.repo.get(changeId);
    const files = [];
    for (const file of await this.repo.diff(change)) {
      try { sitePath(file.path); } catch { continue; }
      if (await authorize(actor, 'site.read', file.path)) files.push(file);
    }
    return { id: change.id, branch: change.branch, head: change.head, ...change.manifest, files };
  }
  async history(actor, { page = 1, perPage = 20 } = {}) {
    await assertPermission(actor, 'history.read');
    const branch = this.github.config.baseBranch;
    const commits = await this.github.request(`/commits?sha=${encodeURIComponent(branch)}&per_page=${perPage}&page=${page}`);
    return { branch, page, commits: commits.map(item => ({ sha: item.sha, summary: item.commit.message.split('\n')[0].slice(0, 200),
      at: item.commit.committer?.date, url: item.html_url, parents: item.parents.map(parent => parent.sha) })) };
  }
  async sourceWrite(actor, { changeId, expectedHead, path, content, remove = false }) {
    sitePath(path); await assertPermission(actor, rawEditPermission(path), path);
    if (!remove && path.endsWith('.json')) validateData(path, content);
    if (remove && rawEditPermission(path) !== 'website.full') await assertPermission(actor, 'website.full', path);
    const change = await this.owned(actor, changeId, expectedHead);
    return this.repo.write(change, actor, [{ path, bytes: remove ? null : Buffer.from(content) }], remove ? 'source.deleted' : 'source.updated', { path });
  }
  async structuredEdit(actor, args, kind) {
    const { changeId, expectedHead, path } = args;
    sitePath(path);
    if (!path.endsWith('.astro') || path.startsWith('src/pages/api/') || !path.startsWith('src/')) throw new ServiceError('Structured edits require a website Astro template.', 'invalid_content');
    const permission = kind === 'seo' ? 'seo.edit' : editPermission(path);
    if (kind === 'seo' && !path.startsWith('src/pages/')) throw new ServiceError('SEO edits target individual page templates.', 'invalid_content');
    await assertPermission(actor, permission, path);
    const change = await this.owned(actor, changeId, expectedHead);
    const before = text(await this.github.read(path, change.head));
    const after = kind === 'text' ? await editVisibleText(before, args) : kind === 'attribute' ? await editStaticAttribute(before, args) : await editSeo(before, args.fields);
    return this.repo.write(change, actor, [{ path, bytes: Buffer.from(after) }], `${kind}.updated`, { path });
  }
  async uploadImage(actor, args) {
    const { changeId, expectedHead, path, base64 } = args;
    await assertPermission(actor, 'assets.edit', sitePath(path));
    const bytes = validateImage(path, base64);
    const change = await this.owned(actor, changeId, expectedHead);
    return this.repo.write(change, actor, [{ path, bytes }], 'image.uploaded', { path, bytes: bytes.length });
  }
  async redirect(actor, { changeId, expectedHead, from, to, status = 301, remove = false }) {
    const path = 'src/data/redirects.json';
    await assertPermission(actor, 'redirects.edit', path);
    if (!/^\/(?!\/)[A-Za-z0-9/_-]*$/.test(from) || from === '/' || /^\/(api|admin)(\/|$)/.test(from)) throw new ServiceError('Redirect source must be a non-administrative local path.', 'invalid_redirect');
    if (!remove && (!to || !/^\/(?!\/)[A-Za-z0-9/_-]*$/.test(to) || from.replace(/\/$/, '') === to.replace(/\/$/, ''))) throw new ServiceError('Redirect target must be a different local path.', 'invalid_redirect');
    const change = await this.owned(actor, changeId, expectedHead);
    const redirects = await this.repo.readJson(change, path);
    if (remove) delete redirects[from]; else Object.defineProperty(redirects, from, { value: { destination: to, status }, enumerable: true, configurable: true, writable: true });
    const normalized = Object.fromEntries(Object.entries(redirects).map(([source, target]) => [source.replace(/\/$/, ''), (typeof target === 'string' ? target : target.destination).replace(/\/$/, '')]));
    for (const start of Object.keys(normalized)) {
      const visited = new Set(); let cursor = start;
      while (normalized[cursor]) {
        if (visited.has(cursor)) throw new ServiceError('Redirects would contain a cycle.', 'invalid_redirect');
        visited.add(cursor); cursor = normalized[cursor];
      }
    }
    return this.repo.writeJson(change, actor, path, redirects, 'redirect.updated', { from, to: remove ? null : to });
  }
  async validate(actor, { changeId, expectedHead }) {
    await assertPermission(actor, 'build.validate');
    const change = await this.repo.get(changeId, expectedHead);
    await this.checkPaths(actor, change, 'build.validate');
    return this.github.dispatch(change.head);
  }
  async validation(actor, { changeId }) {
    await assertPermission(actor, 'site.read');
    return this.github.validation((await this.repo.get(changeId)).head);
  }
  async preview(actor, { changeId, expectedHead }) {
    await assertPermission(actor, 'preview.create');
    const change = await this.repo.get(changeId, expectedHead);
    await this.checkPaths(actor, change, 'preview.create');
    return this.github.preview(change.branch, change.manifest.summary);
  }
  async checkPaths(actor, change, permission) {
    for (const file of await this.repo.diff(change)) {
      if (/^\.mcp\/(changes|wordpress)\/[0-9a-f-]+\.json$/.test(file.path)) continue;
      sitePath(file.path); await assertPermission(actor, permission, file.path);
    }
  }
  async publish(actor, { changeId, expectedHead }) {
    await assertPermission(actor, 'deploy.publish');
    return this.locked('production', async () => {
      const change = await this.repo.get(changeId, expectedHead);
      await this.checkPaths(actor, change, 'deploy.publish');
      for (const entry of (await this.github.tree(change.head)).filter(e => e.path.startsWith('.mcp/wordpress/') && e.type === 'blob')) {
        const operation = await this.repo.readJson(change, entry.path);
        if (['applying', 'unknown', 'unresolved'].includes(operation.state)) throw new ServiceError('A WordPress operation has an unresolved outcome. Reconcile it before publishing.', 'wordpress_unresolved');
      }
      return this.repo.publish(change, actor);
    });
  }
  async rollback(actor, { revision, summary }) {
    await assertPermission(actor, 'deploy.rollback');
    // A whole-website rollback may touch any source path, so require the global grant.
    await assertPermission(actor, 'website.full');
    return this.repo.create(actor, summary, { rollbackTo: assertSha(revision) });
  }
  async deployment(actor, { expectedSha } = {}) {
    await assertPermission(actor, 'site.read');
    const sourceSha = await this.github.head();
    return { sourceSha, ...await this.hostinger.status({ expectedSha: expectedSha ?? sourceSha }) };
  }
  async wpInspect(actor, args) {
    await assertPermission(actor, 'wordpress.read');
    if (args.action === 'get') return this.wordpress.get(args);
    if (args.action === 'revisions') return this.wordpress.revisions(args);
    return this.wordpress.list(args);
  }
  async wpStage(actor, { changeId, expectedHead, type, id, fields, restoreChangeId, restoreOperationId }) {
    await assertPermission(actor, 'wordpress.edit'); await assertPermission(actor, 'wordpress.read');
    const change = await this.owned(actor, changeId, expectedHead);
    if (restoreOperationId) {
      const earlier = await this.repo.get(restoreChangeId);
      const record = await this.repo.readJson(earlier, WP_PATH(restoreOperationId));
      if (record.kind !== 'update' || !record.before) throw new ServiceError('That operation does not contain a restorable post snapshot.', 'invalid_restore');
      type = record.type; id = record.postId; fields = record.before.fields;
    }
    fields = this.wordpress.validate(fields, { type });
    const before = await this.wordpress.snapshot({ type, id });
    const operationId = randomUUID();
    const record = { version: 1, operationId, kind: 'update', state: 'staged', actor: actor.subject, at: now(), type, postId: id, before, fields };
    const result = await this.repo.writeJson(change, actor, WP_PATH(operationId), record, 'wordpress.staged', { operationId, type, postId: id });
    return { ...result, operationId, state: 'staged', requiresPublishingPermission: ['publish', 'future', 'private'].includes(before.fields.status) || ['publish', 'future', 'private'].includes(fields.status) };
  }
  async wpStageImage(actor, { changeId, expectedHead, filename, mimeType, base64, altText = '' }) {
    await assertPermission(actor, 'wordpress.edit'); await assertPermission(actor, 'assets.edit');
    const bytes = validateWordPressImage({ filename, mimeType, base64, altText });
    const change = await this.owned(actor, changeId, expectedHead);
    const operationId = randomUUID(); const path = `public/assets/wp-media/${operationId}.${filename.split('.').at(-1).toLowerCase()}`;
    await assertPermission(actor, 'assets.edit', path);
    const record = { version: 1, operationId, kind: 'image', state: 'staged', actor: actor.subject, at: now(), filename, mimeType, path, altText };
    const result = await this.repo.write(change, actor, [{ path, bytes }, { path: WP_PATH(operationId), bytes: jsonBytes(record) }], 'wordpress.image_staged', { operationId, path });
    return { ...result, operationId, state: 'staged' };
  }
  async wpApply(actor, { changeId, expectedHead, operationId }) {
    await assertPermission(actor, 'wordpress.edit'); await assertPermission(actor, 'wordpress.read');
    const initial = await this.owned(actor, changeId, expectedHead);
    const initialRecord = await this.repo.readJson(initial, WP_PATH(operationId));
    const key = initialRecord.kind === 'image' ? `wp-image:${operationId}` : `wp:${initialRecord.type}:${initialRecord.postId}`;
    return this.locked(key, async () => {
      let change = await this.owned(actor, changeId, expectedHead);
      const record = await this.repo.readJson(change, WP_PATH(operationId));
      if (record.state !== 'staged') throw new ServiceError('Operation was already attempted. Inspect or reconcile it; do not blindly retry.', 'already_attempted', 409);
      const current = record.kind === 'update' ? await this.wordpress.snapshot({ type: record.type, id: record.postId }) : null;
      if (current && current.modified_gmt !== record.before.modified_gmt) throw new ServiceError('WordPress changed since staging. Inspect it and stage a fresh update.', 'conflict', 409);
      if (record.kind === 'image' || ['publish', 'future', 'private'].includes(current?.fields.status) || ['publish', 'future', 'private'].includes(record.before?.fields.status) || ['publish', 'future', 'private'].includes(record.fields?.status)) await assertPermission(actor, 'wordpress.publish');
      const applying = { ...record, state: 'applying', appliedBy: actor.subject, attemptedAt: now() };
      const receipt = await this.repo.writeJson(change, actor, WP_PATH(operationId), applying, 'wordpress.applying', { operationId });
      change = await this.repo.get(changeId, receipt.head);
      let after;
      try {
        if (record.kind === 'image') {
          await assertPermission(actor, 'assets.edit', record.path);
          const image = await this.github.read(record.path, change.head, 5 * 1024 * 1024);
          after = await this.wordpress.uploadMedia({ filename: record.filename, mimeType: record.mimeType, base64: image.bytes.toString('base64'), altText: record.altText });
        } else after = await this.wordpress.update({ type: record.type, id: record.postId, fields: record.fields, expectedModified: record.before.modified_gmt });
      } catch {
        const result = await this.repo.writeJson(change, actor, WP_PATH(operationId), { ...applying, state: 'unknown', note: 'Verify current WordPress state before staging another attempt.' }, 'wordpress.unknown', { operationId });
        return { ...result, operationId, state: 'unknown', note: 'WordPress did not confirm success. Reconcile before retrying; a timeout may have occurred after the update.' };
      }
      // If recording this result fails, the durable applying intent remains: reconciliation is required.
      const result = await this.repo.writeJson(change, actor, WP_PATH(operationId), { ...applying, state: 'applied', completedAt: now(), after }, 'wordpress.applied', { operationId });
      return { ...result, operationId, state: 'applied', after };
    });
  }
  async wpOperation(actor, { changeId, operationId, reconcile = false, expectedHead }) {
    await assertPermission(actor, 'wordpress.read');
    if (reconcile && !expectedHead) throw new ServiceError('Reconciliation requires the current expectedHead.', 'conflict', 409);
    const change = reconcile ? await this.owned(actor, changeId, expectedHead) : await this.repo.get(changeId);
    const record = await this.repo.readJson(change, WP_PATH(operationId));
    if (!reconcile) return record;
    await assertPermission(actor, 'wordpress.edit');
    if (!['applying', 'unknown', 'unresolved'].includes(record.state) || record.kind !== 'update') throw new ServiceError('Only unresolved post updates can be reconciled automatically. Image uploads require checking the WordPress Media Library.', 'invalid_reconciliation');
    const current = await this.wordpress.snapshot({ type: record.type, id: record.postId });
    const matches = Object.entries(record.fields).every(([key, value]) => JSON.stringify(current.fields[key]) === JSON.stringify(value));
    const state = matches ? 'applied' : 'unresolved';
    const result = await this.repo.writeJson(change, actor, WP_PATH(operationId), { ...record, state, reconciledAt: now(), observed: current }, 'wordpress.reconciled', { operationId, state });
    return { ...result, state, current, note: matches ? 'Current fields match the staged intent.' : 'Current fields differ. Review the observed snapshot and stage a fresh operation if needed.' };
  }
}
