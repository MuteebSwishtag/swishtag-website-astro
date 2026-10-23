import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateData } from '../src/data.mjs';

const faq = href => JSON.stringify({ home: { title: 'Answers', link: { href, label: 'Contact' }, items: [{ question: 'Question?', answer: 'Answer', open: false }] } });
test('the current FAQ content matches the strict editor schema', async () => {
  const source = await readFile(new URL('../../src/data/faqs.json', import.meta.url), 'utf8');
  assert.ok(validateData('src/data/faqs.json', source).home.items.length);
});
test('FAQ editing rejects executable URL schemes, expression props and unexpected data types', () => {
  for (const href of ['javascript:alert(1)', 'data:text/html,test', '//attacker.test', '/\\attacker.test', 'https://user:password@site.test', 'https://site.test\n']) {
    assert.throws(() => validateData('src/data/faqs.json', faq(href)), error => error.code === 'invalid_content');
  }
  const data = JSON.parse(faq('/contact/')); data.home['set:html'] = '<script>evil()</script>';
  assert.throws(() => validateData('src/data/faqs.json', JSON.stringify(data)));
  delete data.home['set:html']; data.home.items[0].answer = {};
  assert.throws(() => validateData('src/data/faqs.json', JSON.stringify(data)));
  assert.throws(() => validateData('src/data/faqs.json', '{bad json}'));
});
test('FAQ links accept local paths and HTTPS without credentials', () => {
  for (const href of ['/contact/', 'https://swishtag.com/contact/?from=faq']) assert.equal(validateData('src/data/faqs.json', faq(href)).home.link.href, href);
});
