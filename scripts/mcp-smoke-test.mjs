import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

async function unusedPort() {
  const server = createServer();
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
  const { port } = server.address();
  await new Promise((accept, reject) => server.close(error => error ? reject(error) : accept()));
  return port;
}

export async function smokeTest(root = process.cwd(), expectedSha = process.env.MCP_BUILD_SHA) {
  const entry = resolve(root, 'dist/server/entry.mjs');
  await access(entry);
  const port = await unusedPort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [entry], {
    cwd: root,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), NODE_ENV: 'production' },
    stdio: 'ignore',
    windowsHide: true,
  });
  let startupError;
  child.once('error', error => { startupError = error; });
  try {
    const deadline = Date.now() + 30_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (startupError) throw startupError;
      if (child.exitCode !== null) throw new Error(`Astro exited before readiness (code ${child.exitCode}).`);
      try {
        const response = await fetch(`${origin}/.well-known/site-release.json`, { signal: AbortSignal.timeout(1500) });
        if (response.ok) { ready = true; break; }
      } catch { /* The Node listener may still be starting. */ }
      await new Promise(accept => setTimeout(accept, 150));
    }
    if (!ready) throw new Error('Astro did not serve its release marker within 30 seconds.');

    const markerResponse = await fetch(`${origin}/.well-known/site-release.json`, { signal: AbortSignal.timeout(5000) });
    const marker = await markerResponse.json();
    if (marker.schema !== 1 || (expectedSha && marker.sha !== expectedSha)) throw new Error('The served release marker does not match the validated source SHA.');

    const checked = [];
    for (const path of ['/', '/company/', '/contact-us/']) {
      const response = await fetch(`${origin}${path}`, { signal: AbortSignal.timeout(10_000), redirect: 'follow' });
      if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) throw new Error(`SSR smoke check failed for ${path}: HTTP ${response.status}.`);
      const html = await response.text();
      if (!/<html[\s>]/i.test(html) || !/<title>[^<]+<\/title>/i.test(html)) throw new Error(`SSR smoke check found incomplete HTML for ${path}.`);
      checked.push({ path, status: response.status });
    }
    let redirects;
    try { redirects = JSON.parse(await readFile(resolve(root, 'src/data/redirects.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const sample = Object.entries(redirects ?? {})[0];
    if (sample) {
      const [path, rule] = sample;
      const destination = typeof rule === 'string' ? rule : rule.destination;
      const status = typeof rule === 'string' ? 301 : rule.status;
      const response = await fetch(`${origin}${path}`, { signal: AbortSignal.timeout(5000), redirect: 'manual' });
      const location = response.headers.get('location');
      if (response.status !== status || !location || new URL(location, origin).href !== new URL(destination, origin).href) throw new Error('The repository-managed redirect did not return its configured HTTP status and destination.');
      checked.push({ path, status: response.status, destination });
    }
    return { sha: marker.sha, routes: checked };
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await Promise.race([
        new Promise(accept => child.once('exit', accept)),
        new Promise(accept => setTimeout(accept, 5000)),
      ]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    console.log(JSON.stringify(await smokeTest()));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
