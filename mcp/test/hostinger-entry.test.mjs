import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('Hostinger entry starts when imported and serves health on the assigned PORT', { timeout: 15000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'swishtag-mcp-entry-'));
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const config = JSON.parse(await readFile(new URL('../config.example.json', import.meta.url), 'utf8'));
  const filename = path.join(directory, 'config.json');
  await writeFile(filename, JSON.stringify(config));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('MCP_') && key !== 'NODE_OPTIONS'));
  Object.assign(env, { PORT: String(port), MCP_PORT: '1', MCP_HOST: '127.0.0.1', MCP_CONFIG_PATH: filename, MCP_AUDIT_PATH: path.join(directory, 'audit.jsonl') });
  const entry = new URL('../src/hostinger-entry.mjs', import.meta.url).href;
  // --eval means the imported entry is not process.argv[1], matching Hostinger.
  const child = spawn(process.execPath, ['--input-type=module', '--eval', `await import(${JSON.stringify(entry)});`], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; let spawnError;
  child.stdout.on('data', value => { output = (output + value).slice(-4000); });
  child.stderr.on('data', value => { output = (output + value).slice(-4000); });
  child.on('error', error => { spawnError = error; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill(); await exited;
    }
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('swishtag-mcp-entry-'));
    await rm(directory, { recursive: true, force: true });
  });
  const deadline = Date.now() + 10000;
  while (!output.includes('Swishtag MCP listening on') && Date.now() < deadline) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) assert.fail(`Imported entry exited before startup: ${output}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(output.includes(`Swishtag MCP listening on 127.0.0.1:${port}`), output);
  const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2000) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok', service: 'swishtag-website-mcp' });
  const metadata = await fetch(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource/mcp`);
  assert.equal((await metadata.json()).resource, config.server.publicUrl);
  const denied = await fetch(`http://127.0.0.1:${port}/mcp`);
  assert.equal(denied.status, 401);
});
