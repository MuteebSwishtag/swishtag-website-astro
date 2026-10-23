import test from 'node:test';
import assert from 'node:assert/strict';
import { sitePath, editPermission, rawEditPermission, validateImage } from '../src/paths.mjs';

test('website path validation accepts repository-relative website files and brackets', () => {
  for (const path of ['src/pages/project/[slug].astro', 'src/components/layout/Footer.astro', 'public/images/Project Cover.png', 'src/data/seo.json', 'astro.config.mjs', 'package-lock.json']) assert.equal(sitePath(path), path);
});

test('repository controls, credentials, generated output and traversal are outside website tools', () => {
  for (const path of [
    '../src/pages/index.astro', 'src/../package.json', '/src/pages/index.astro', 'src//pages/index.astro',
    'src\\pages\\index.astro', 'C:/src/pages/index.astro', 'src/%2e%2e/package.json', 'src/pages/./index.astro',
    'src/pages/../../.git/config', '.github/workflows/mcp-validate.yml', 'mcp/config.json', 'docs/admin.json',
    'src/.env', 'public/.env.production', 'src/secrets.json', 'public/my-credentials.json', 'public/private-key.pem',
    'public/api/swishtag-mail-config.php', 'src/node_modules/package/index.js', 'public/dist/index.html', 'public/mcp/policy.json',
    'src/pages/index.astro\0', 'src/pages/index.astro\n', 'src/pages/', '', null, ['src/pages/index.astro'],
  ]) assert.throws(() => sitePath(path), error => error.code === 'invalid_path', String(path));
});

test('server runtime, API endpoints and dependency edits require full website permission', () => {
  for (const path of ['src/lib/config.mjs', 'src/pages/api/forms/submit.js', 'package.json', 'package-lock.json', 'tsconfig.json']) assert.equal(editPermission(path), 'website.full');
});

test('raw executable source editing requires full access; scoped roles use structured tools', () => {
  for (const path of ['src/components/layout/Footer.astro', 'src/pages/index.astro', 'src/pages/api/forms/submit.js', 'public/assets/footer.js', 'public/api/send-form.php', 'src/lib/config.mjs', 'astro.config.mjs', 'package.json', 'src/data/redirects.json']) assert.equal(rawEditPermission(path), 'website.full');
  assert.equal(rawEditPermission('src/data/seo.json'), 'website.full');
  assert.equal(rawEditPermission('src/data/faqs.json'), 'content.edit');
  assert.equal(rawEditPermission('src/styles/global.css'), 'assets.edit');
});

test('image uploads require public image paths and matching nonempty bytes', () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jLuUAAAAASUVORK5CYII=';
  assert.equal(validateImage('public/images/cover.png', png).toString('base64'), png);
  for (const [path, bytes] of [
    ['src/data/cover.png', png], ['public/cover.svg', png], ['public/cover.jpg', png],
    ['public/cover.png', ''], ['public/cover.png', 'not-base64'], ['../public/cover.png', png],
    ['public/cover.png', Buffer.from('<script>alert(1)</script>').toString('base64')],
  ]) assert.throws(() => validateImage(path, bytes));
});
