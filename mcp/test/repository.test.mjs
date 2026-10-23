import test from 'node:test';
import assert from 'node:assert/strict';
import { Repository, changeBranch, jsonBytes } from '../src/repository.mjs';
import { ServiceError } from '../src/github.mjs';

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const NEXT = 'c'.repeat(40);
const OLD = 'd'.repeat(40);
const BLOB = 'e'.repeat(40);
const OTHER_BLOB = 'f'.repeat(40);
const ID = '1a2b3c4d-1234-4abc-9def-123456789abc';
const actor = { subject: 'oidc|alice' };
const branch = changeBranch(ID);
const savedManifest = () => ({ version: 1, id: ID, owner: actor.subject, base: BASE, summary: 'Update website', createdAt: '2026-10-23T10:00:00Z', events: [] });
const savedChange = () => ({ id: ID, branch, head: HEAD, manifest: savedManifest() });
const blob = (path, sha = BLOB, mode = '100644') => ({ path, sha, mode, type: 'blob' });

class MockGitHub {
  config = { baseBranch: 'main' };
  refs = new Map([['main', BASE], [branch, HEAD]]);
  trees = new Map();
  calls = [];
  manifest = savedManifest();
  comparison = { status: 'ahead' };
  validated = { valid: true, sha: HEAD };
  advanceError;
  async head(name = 'main') { this.calls.push(['head', name]); return this.refs.get(name); }
  async read(path, sha) { this.calls.push(['read', path, sha]); return { bytes: jsonBytes(this.manifest) }; }
  async tree(sha) { this.calls.push(['tree', sha]); return this.trees.get(sha) || []; }
  async compare(base, head) { this.calls.push(['compare', base, head]); return this.comparison; }
  async validation(sha) { this.calls.push(['validation', sha]); return this.validated; }
  async writeCommit(parent, edits, message) { this.calls.push(['writeCommit', parent, edits, message]); return { sha: NEXT }; }
  async createBranch(name, sha) { this.calls.push(['createBranch', name, sha]); this.refs.set(name, sha); }
  async advance(name, sha) {
    this.calls.push(['advance', name, sha]);
    if (this.advanceError) throw this.advanceError;
    this.refs.set(name, sha);
  }
}

test('change IDs are primitive UUID v4 values and cannot select arbitrary refs', () => {
  assert.equal(changeBranch(ID), `mcp/${ID}`);
  for (const value of [null, '', 'main', `../${ID}`, [ID], { toString: () => ID }, ID.replace('-4abc-', '-1abc-')]) {
    assert.throws(() => changeBranch(value), error => error.code === 'invalid_change');
  }
});

test('creating a change records its base, owner and immutable actor event in source', async () => {
  const gh = new MockGitHub();
  const result = await new Repository(gh).create(actor, 'Update footer\nrequest');
  const write = gh.calls.find(call => call[0] === 'writeCommit');
  const manifestEdit = write[2].find(edit => edit.path === `.mcp/changes/${result.id}.json`);
  const manifest = JSON.parse(manifestEdit.bytes);
  assert.equal(write[1], BASE);
  assert.equal(manifest.base, BASE);
  assert.equal(manifest.owner, actor.subject);
  assert.equal(manifest.events[0].actor, actor.subject);
  assert.equal(manifest.events[0].action, 'change.created');
  assert.ok(Number.isFinite(Date.parse(manifest.events[0].at)));
  assert.doesNotMatch(write[3], /[\r\n]/);
  assert.deepEqual(gh.calls.at(-1), ['createBranch', `mcp/${result.id}`, NEXT]);
});

test('stale expected change head rejects before reading or writing repository files', async () => {
  const gh = new MockGitHub();
  const repository = new Repository(gh);
  await assert.rejects(repository.get(ID, OLD), error => error.code === 'conflict');
  assert.deepEqual(gh.calls, [['head', branch]]);
  gh.calls = [];
  gh.refs.set(branch, OLD);
  await assert.rejects(repository.write(savedChange(), actor, [{ path: 'src/data/seo.json', bytes: Buffer.from('{}') }], 'seo.updated'), error => error.code === 'conflict');
  assert.deepEqual(gh.calls, [['head', branch]]);
});

test('change manifests must match the requested ID and a complete source base SHA', async () => {
  const gh = new MockGitHub();
  gh.manifest = { ...savedManifest(), id: 'wrong' };
  await assert.rejects(new Repository(gh).get(ID), error => error.code === 'invalid_change');
  gh.manifest = { ...savedManifest(), base: 'main' };
  await assert.rejects(new Repository(gh).get(ID), error => error.code === 'invalid_sha');
});

test('writing appends authenticated actor history and details cannot forge attribution', async () => {
  const gh = new MockGitHub();
  const change = savedChange();
  await new Repository(gh).write(change, actor, [{ path: 'src/data/seo.json', bytes: Buffer.from('{}') }], 'seo.updated', { path: 'src/data/seo.json', actor: 'attacker', action: 'forged', id: 'forged', at: 'invalid' });
  const write = gh.calls.find(call => call[0] === 'writeCommit');
  const manifest = JSON.parse(write[2].at(-1).bytes);
  assert.equal(manifest.events[0].actor, actor.subject);
  assert.equal(manifest.events[0].action, 'seo.updated');
  assert.equal(manifest.events[0].path, 'src/data/seo.json');
  assert.notEqual(manifest.events[0].id, 'forged');
  assert.ok(Number.isFinite(Date.parse(manifest.events[0].at)));
  assert.equal(change.manifest.events.length, 0);
  assert.deepEqual(gh.calls.at(-1), ['advance', branch, NEXT]);
});

test('concurrent sibling advancement rejection propagates and does not force or overwrite refs', async () => {
  const gh = new MockGitHub();
  gh.advanceError = new ServiceError('Non fast forward', 'conflict', 409);
  await assert.rejects(new Repository(gh).write(savedChange(), actor, [], 'change.updated'), error => error.code === 'conflict');
  assert.equal(gh.refs.get(branch), HEAD);
  assert.equal(gh.calls.filter(call => call[0] === 'advance').length, 1);
  assert.equal(gh.calls.some(call => call[0] === 'createBranch'), false);
});

test('production base drift blocks publication before validation or writes', async () => {
  const gh = new MockGitHub();
  gh.refs.set('main', OLD);
  await assert.rejects(new Repository(gh).publish(savedChange(), actor), error => error.code === 'stale_base');
  assert.deepEqual(gh.calls, [['head', 'main']]);
});

test('publication requires current candidate head and successful validation for that exact SHA', async () => {
  const stale = new MockGitHub();
  stale.refs.set(branch, OLD);
  await assert.rejects(new Repository(stale).publish(savedChange(), actor), error => error.code === 'conflict');
  assert.equal(stale.calls.some(call => call[0] === 'validation'), false);
  for (const validated of [{ valid: false, sha: HEAD }, { valid: true, sha: OLD }, { valid: true }]) {
    const gh = new MockGitHub();
    gh.validated = validated;
    await assert.rejects(new Repository(gh).publish(savedChange(), actor), error => error.code === 'validation_required');
    assert.equal(gh.calls.some(call => call[0] === 'advance'), false);
  }
});

test('publication advances only the configured production ref after proving ancestry', async () => {
  const gh = new MockGitHub();
  const result = await new Repository(gh).publish(savedChange(), actor);
  assert.deepEqual(gh.calls, [
    ['head', 'main'], ['head', branch], ['validation', HEAD], ['compare', BASE, HEAD], ['advance', 'main', HEAD],
  ]);
  assert.equal(result.actor, actor.subject);
  assert.equal(result.previousSha, BASE);
  assert.equal(result.sha, HEAD);
  assert.equal(result.state, 'source_published');
  for (const status of ['behind', 'diverged', 'identical']) {
    const rejected = new MockGitHub();
    rejected.comparison = { status };
    await assert.rejects(new Repository(rejected).publish(savedChange(), actor), error => error.code === 'conflict');
    assert.equal(rejected.calls.some(call => call[0] === 'advance'), false);
  }
});

test('production non-fast-forward rejection propagates after the ancestry check', async () => {
  const gh = new MockGitHub();
  gh.advanceError = new ServiceError('Branch advanced during publication', 'conflict', 409);
  await assert.rejects(new Repository(gh).publish(savedChange(), actor), error => error.code === 'conflict');
  assert.equal(gh.refs.get('main'), BASE);
  assert.equal(gh.calls.filter(call => call[0] === 'advance').length, 1);
});

test('rollback targets must be ancestors; diverged history produces no commit or branch', async () => {
  for (const status of ['behind', 'diverged']) {
    const gh = new MockGitHub();
    gh.comparison = { status };
    await assert.rejects(new Repository(gh).create(actor, 'Roll back', { rollbackTo: OLD }), error => error.code === 'invalid_rollback');
    assert.deepEqual(gh.calls, [['head', 'main'], ['compare', OLD, BASE]]);
  }
});

test('rollback restores website blobs and modes, retaining current controls, credentials and history', async () => {
  const gh = new MockGitHub();
  const protectedPaths = ['mcp/src/auth.mjs', 'mcp/config.json', '.github/workflows/mcp-validate.yml', '.mcp/changes/previous.json', '.env', 'public/api/swishtag-mail-config.php'];
  gh.trees.set(BASE, [blob('src/pages/index.astro'), blob('public/new.png'), blob('public/runner.js', BLOB, '100644'), ...protectedPaths.map(path => blob(path))]);
  gh.trees.set(OLD, [blob('src/pages/index.astro', OTHER_BLOB), blob('src/data/old.json', OTHER_BLOB), blob('public/runner.js', BLOB, '100755'), ...protectedPaths.map(path => blob(path, OTHER_BLOB))]);
  const result = await new Repository(gh).create(actor, 'Restore previous website', { rollbackTo: OLD });
  const write = gh.calls.find(call => call[0] === 'writeCommit');
  const restored = write[2].filter(edit => !edit.path.startsWith('.mcp/'));
  assert.deepEqual(restored, [
    { path: 'src/pages/index.astro', sha: OTHER_BLOB, mode: '100644' },
    { path: 'public/new.png', bytes: null },
    { path: 'public/runner.js', sha: BLOB, mode: '100755' },
    { path: 'src/data/old.json', sha: OTHER_BLOB, mode: '100644' },
  ]);
  assert.equal(write[1], BASE);
  const manifest = JSON.parse(write[2].at(-1).bytes);
  assert.equal(manifest.events[0].action, 'rollback.created');
  assert.equal(manifest.events[0].rollbackTo, OLD);
  assert.equal(manifest.events[0].actor, actor.subject);
  assert.equal(manifest.id, result.id);
  assert.equal(gh.refs.get('main'), BASE);
});

test('rollback rejects target website symlinks before creating a commit', async () => {
  const gh = new MockGitHub();
  gh.trees.set(BASE, [blob('public/link', BLOB)]);
  gh.trees.set(OLD, [blob('public/link', OTHER_BLOB, '120000')]);
  await assert.rejects(new Repository(gh).create(actor, 'Restore', { rollbackTo: OLD }), error => error.code === 'invalid_rollback');
  assert.equal(gh.calls.some(call => call[0] === 'writeCommit'), false);
});
