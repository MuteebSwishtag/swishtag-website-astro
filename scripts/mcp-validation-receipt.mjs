import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function buildInventory(root, directory = resolve(root, 'dist')) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await buildInventory(root, path));
    else if (entry.isFile()) {
      const contents = await readFile(path);
      files.push({ path: relative(root, path).split(sep).join('/'), bytes: contents.length, sha256: createHash('sha256').update(contents).digest('hex') });
    } else throw new Error('Build output cannot contain symbolic links or special files.');
  }
  return files;
}

export async function writeValidationReceipt(root = process.cwd(), sha = process.env.MCP_BUILD_SHA) {
  if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error('MCP_BUILD_SHA must be the full validated Git commit SHA.');
  const actualSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  if (sha !== actualSha) throw new Error('Candidate checkout does not match MCP_BUILD_SHA.');
  const files = await buildInventory(root);
  if (!files.some(file => file.path === 'dist/server/entry.mjs')) throw new Error('Build did not produce the Astro standalone server entry.');
  const marker = JSON.parse(await readFile(resolve(root, 'dist/client/.well-known/site-release.json'), 'utf8'));
  if (marker.schema !== 1 || marker.sha !== sha) throw new Error('Build release marker does not match the source revision.');
  const receipt = {
    schema: 1,
    sha,
    validatedAt: new Date().toISOString(),
    repository: process.env.GITHUB_REPOSITORY ?? null,
    workflowRunId: process.env.GITHUB_RUN_ID ?? null,
    workflowRunAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    node: process.version,
    checks: ['npm ci', 'npm run build', 'standalone SSR smoke test'],
    files,
  };
  await mkdir(resolve(root, '.mcp-output'), { recursive: true });
  await writeFile(resolve(root, '.mcp-output/validation.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const receipt = await writeValidationReceipt();
    console.log(`Validated ${receipt.sha}: ${receipt.files.length} build files.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
