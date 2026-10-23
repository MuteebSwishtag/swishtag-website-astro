import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SHA_PATTERN = /^[a-f0-9]{40}$/;

export function resolveSourceSha(root, suppliedSha = process.env.MCP_BUILD_SHA) {
  if (suppliedSha !== undefined && suppliedSha !== '') {
    if (!SHA_PATTERN.test(suppliedSha)) throw new Error('MCP_BUILD_SHA must be a full lowercase Git commit SHA.');
    return suppliedSha;
  }
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return SHA_PATTERN.test(sha) ? sha : null;
  } catch {
    // Archive deployments may omit .git. Never report an invented revision.
    return null;
  }
}

export async function writeReleaseMarker(root = process.cwd(), suppliedSha) {
  const marker = { schema: 1, sha: resolveSourceSha(root, suppliedSha), builtAt: new Date().toISOString() };
  const directory = resolve(root, 'dist/client/.well-known');
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, 'site-release.json'), `${JSON.stringify(marker)}\n`, 'utf8');
  return marker;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const marker = await writeReleaseMarker(process.cwd());
    console.log(`Release marker: ${marker.sha ?? 'unknown (Git metadata is unavailable)'}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
