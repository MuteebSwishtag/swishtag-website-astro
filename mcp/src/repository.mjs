import { randomUUID } from 'node:crypto';
import { assertSha, ServiceError } from './github.mjs';
import { sitePath } from './paths.mjs';

const jsonBytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
export function changeBranch(id) {
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) throw new ServiceError('Invalid change ID.', 'invalid_change');
  return `mcp/${id}`;
}
const manifestPath = id => `.mcp/changes/${id}.json`;
const event = (actor, action, details = {}) => ({ ...details, id: randomUUID(), at: new Date().toISOString(), actor: actor.subject, action });

export class Repository {
  constructor(github) { this.github = github; }
  async create(actor, summary, { rollbackTo } = {}) {
    const id = randomUUID();
    const base = await this.github.head();
    const manifest = { version: 1, id, owner: actor.subject, base, summary, createdAt: new Date().toISOString(),
      events: [event(actor, rollbackTo ? 'rollback.created' : 'change.created', rollbackTo ? { rollbackTo } : {})] };
    const initialEdits = [];
    if (rollbackTo) {
      const comparison = await this.github.compare(assertSha(rollbackTo), base);
      if (!['ahead', 'identical'].includes(comparison.status)) throw new ServiceError('Rollback target must be an ancestor of the production branch.', 'invalid_rollback');
      const before = new Map((await this.github.tree(base)).filter(e => e.type === 'blob').map(e => [e.path, e]));
      const target = new Map((await this.github.tree(rollbackTo)).filter(e => e.type === 'blob').map(e => [e.path, e]));
      for (const path of new Set([...before.keys(), ...target.keys()])) {
        try { sitePath(path); } catch { continue; }
        if (before.get(path)?.sha === target.get(path)?.sha && before.get(path)?.mode === target.get(path)?.mode) continue;
        const old = target.get(path);
        if (old && !['100644', '100755'].includes(old.mode)) throw new ServiceError('Rollback contains a non-regular website file.', 'invalid_rollback');
        initialEdits.push(old ? { path, sha: old.sha, mode: old.mode } : { path, bytes: null });
      }
    }
    const commit = await this.github.writeCommit(base, [...initialEdits, { path: manifestPath(id), bytes: jsonBytes(manifest) }], `MCP: ${summary.replace(/[\r\n]/g, ' ').slice(0, 160)}`);
    await this.github.createBranch(changeBranch(id), commit.sha);
    return { id, branch: changeBranch(id), head: commit.sha, base, summary };
  }
  async get(id, expectedHead) {
    const branch = changeBranch(id);
    const head = await this.github.head(branch);
    if (expectedHead && head !== assertSha(expectedHead)) throw new ServiceError('The change has a newer revision. Inspect it and use its latest head.', 'conflict', 409);
    const file = await this.github.read(manifestPath(id), head);
    let manifest;
    try { manifest = JSON.parse(file.bytes.toString('utf8')); } catch { throw new ServiceError('Invalid change manifest.', 'invalid_change'); }
    if (manifest.id !== id || manifest.version !== 1 || !manifest.owner || !Array.isArray(manifest.events)) throw new ServiceError('Invalid change manifest.', 'invalid_change');
    assertSha(manifest.base);
    return { id, branch, head, manifest };
  }
  async write(change, actor, edits, action, details = {}) {
    if (await this.github.head(change.branch) !== change.head) throw new ServiceError('The change has a newer revision.', 'conflict', 409);
    const manifest = { ...change.manifest, events: [...change.manifest.events, event(actor, action, details)] };
    if (manifest.events.length > 500) throw new ServiceError('Change history limit reached; publish or create a fresh change.', 'change_too_large');
    const commit = await this.github.writeCommit(change.head, [...edits, { path: manifestPath(change.id), bytes: jsonBytes(manifest) }], `MCP ${action}: ${change.id}`);
    // Non-forced advancement rejects sibling commits created concurrently.
    await this.github.advance(change.branch, commit.sha);
    return { id: change.id, branch: change.branch, head: commit.sha, action };
  }
  async readJson(change, path) { return JSON.parse((await this.github.read(path, change.head, 3 * 1024 * 1024)).bytes.toString('utf8')); }
  async writeJson(change, actor, path, value, action, details = {}) {
    return this.write(change, actor, [{ path, bytes: jsonBytes(value) }], action, details);
  }
  async diff(change) {
    const before = new Map((await this.github.tree(change.manifest.base)).filter(e => e.type === 'blob').map(e => [e.path, e]));
    const after = new Map((await this.github.tree(change.head)).filter(e => e.type === 'blob').map(e => [e.path, e]));
    const result = [];
    for (const path of new Set([...before.keys(), ...after.keys()])) {
      if (before.get(path)?.sha !== after.get(path)?.sha || before.get(path)?.mode !== after.get(path)?.mode) {
        result.push({ path, status: !before.has(path) ? 'added' : !after.has(path) ? 'deleted' : 'modified' });
      }
    }
    return result;
  }
  async publish(change, actor) {
    const base = await this.github.head();
    if (base !== change.manifest.base) throw new ServiceError('Production has changed since this change began. Create a fresh change and reapply the edits before publishing.', 'stale_base', 409);
    if (await this.github.head(change.branch) !== change.head) throw new ServiceError('The change has a newer revision.', 'conflict', 409);
    const validation = await this.github.validation(change.head);
    if (!validation.valid || validation.sha !== change.head) throw new ServiceError('A successful validation with unexpired artifacts is required for this exact head.', 'validation_required', 409);
    const comparison = await this.github.compare(base, change.head);
    if (comparison.status !== 'ahead') throw new ServiceError('Change must descend from the current production commit.', 'conflict', 409);
    await this.github.advance(this.github.config.baseBranch, change.head);
    return { id: change.id, sha: change.head, previousSha: base, branch: this.github.config.baseBranch,
      state: 'source_published', deployment: 'Hostinger deployment is asynchronous; call deployment_status to verify the live commit.', actor: actor.subject, validation };
  }
}

export { jsonBytes };
