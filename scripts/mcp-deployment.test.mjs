import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSourceSha, writeReleaseMarker } from './mcp-release-marker.mjs';
import { writeValidationReceipt } from './mcp-validation-receipt.mjs';

async function fixture(t, withGit = false) {
  const root = await mkdtemp(join(tmpdir(), 'swishtag-mcp-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  if (withGit) {
    execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=MCP Test', '-c', 'user.email=mcp@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'Build validation fixture'], { cwd: root });
  }
  return root;
}

test('release marker rejects mutable refs and reports missing Git metadata honestly', async t => {
  const root = await fixture(t);
  assert.throws(() => resolveSourceSha(root, 'main'), /full lowercase Git commit SHA/);
  const marker = await writeReleaseMarker(root, '');
  assert.equal(marker.sha, null);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'dist/client/.well-known/site-release.json'), 'utf8')), marker);
});

test('validation receipt binds build files to the actual candidate checkout', async t => {
  const root = await fixture(t, true);
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  await mkdir(join(root, 'dist/server'), { recursive: true });
  await writeFile(join(root, 'dist/server/entry.mjs'), 'console.log("fixture");\n');
  await writeReleaseMarker(root, sha);
  const receipt = await writeValidationReceipt(root, sha);
  assert.equal(receipt.sha, sha);
  assert.ok(receipt.files.some(file => file.path === 'dist/server/entry.mjs' && file.sha256.length === 64));
  await assert.rejects(writeValidationReceipt(root, 'b'.repeat(40)), /checkout does not match/);
  await writeReleaseMarker(root, 'b'.repeat(40));
  await assert.rejects(writeValidationReceipt(root, sha), /release marker does not match/);
});

test('validation receipt refuses a static-only build for this SSR application', async t => {
  const root = await fixture(t, true);
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  await writeReleaseMarker(root, sha);
  await assert.rejects(writeValidationReceipt(root, sha), /standalone server entry/);
});
