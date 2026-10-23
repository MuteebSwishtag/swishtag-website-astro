import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { parse } from '@astrojs/compiler';
import ts from 'typescript';
import { editVisibleText, editStaticAttribute, editSeo } from '../src/content.mjs';

const rejection = { code: 'invalid_content_edit', status: 400 };

test('visible text editing reaches nested HTML slots and preserves all other source', async () => {
  const source = '---\nconst secret = "Old heading";\n---\n<BaseLayout><section><h1>Old heading and extra</h1></section></BaseLayout>';
  assert.equal(await editVisibleText(source, { find: 'Old heading', replace: 'New heading' }), source.replace('<h1>Old heading', '<h1>New heading'));
});

test('visible text never modifies frontmatter, expressions, scripts, styles or comments', async () => {
  const source = '---\nconst title = "Private token";\n---\n<!-- Private token --><script>const value="Private token";</script><style>.a{content:"Private token"}</style>{true && <p>Private token</p>}<p>{"Private token"}</p><p>Visible word</p>';
  await assert.rejects(editVisibleText(source, { find: 'Private token', replace: 'changed' }), rejection);
  assert.equal(await editVisibleText(source, { find: 'Visible word', replace: 'Updated word' }), source.replace('<p>Visible word', '<p>Updated word'));
});

test('text inside ignored raw, injected and inactive HTML subtrees is excluded', async () => {
  for (const body of ['<div is:raw>Hidden text</div>', '<div set:html={"elsewhere"}>Hidden text</div>', '<template><p>Hidden text</p></template>', '<head><title>Hidden text</title></head>', '<iframe>Hidden text</iframe>']) {
    await assert.rejects(editVisibleText(body, { find: 'Hidden text', replace: 'changed' }), rejection);
  }
});

test('text replacement escapes HTML markup, entities and Astro interpolation', async () => {
  const malicious = '</p><script>fetch("https://evil.example")</script>{process.env.SECRET} &copy;';
  const result = await editVisibleText('<p>Original</p>', { find: 'Original', replace: malicious });
  assert.equal(result, '<p>&lt;/p&gt;&lt;script&gt;fetch(&quot;https://evil.example&quot;)&lt;/script&gt;&#123;process.env.SECRET&#125; &amp;copy;</p>');
  const { ast } = await parse(result);
  assert.deepEqual(ast.children[0].children.map(node => node.type), ['text']);
});

test('text matching requires one exact occurrence, including overlapping matches', async () => {
  for (const source of ['<p>word word</p>', '<p>word</p><span>word</span>', '<p>aaaa</p>']) {
    await assert.rejects(editVisibleText(source, { find: source.includes('word') ? 'word' : 'aa', replace: 'new' }), rejection);
  }
  await assert.rejects(editVisibleText('<p>word</p>', { find: '', replace: 'new' }), rejection);
  await assert.rejects(editVisibleText('<p>word</p>', { find: 'absent', replace: 'new' }), rejection);
});

test('UTF-8 source positions handle accented characters, emoji and CRLF exactly', async () => {
  const source = '---\r\nconst title = "Café 😃";\r\n---\r\n<div>😃<p>Un café, please 😃.</p><span>Keep é</span></div>';
  const result = await editVisibleText(source, { find: 'café, please 😃', replace: 'thé, thanks 🚀' });
  assert.equal(result, source.replace('café, please 😃', 'thé, thanks 🚀'));
  await assert.rejects(editVisibleText(source, { find: '\ud83d', replace: 'half an emoji' }), rejection);
});

test('literal attribute editing changes one matching HTML attribute only', async () => {
  const source = '<div><a class="keep" href = "/old/" title="Old">Read</a><a href="/other/">Other</a></div>';
  const result = await editStaticAttribute(source, { element: 'a', attribute: 'href', oldValue: '/old/', newValue: '/new/' });
  assert.equal(result, source.replace('href = "/old/"', 'href="/new/"'));
});

test('attributes use compiler decoded old values and escaped new values', async () => {
  const source = '<div>😃<img src="/photo.png" alt="A &amp; B" /></div>';
  const result = await editStaticAttribute(source, { element: 'img', attribute: 'alt', oldValue: 'A & B', newValue: 'é " onload="alert(1) {process.env.SECRET} <tag> &' });
  assert.equal(result, source.replace('alt="A &amp; B"', 'alt="é &quot; onload=&quot;alert(1) &#123;process.env.SECRET&#125; &lt;tag&gt; &amp;"'));
  const { ast } = await parse(result);
  const image = ast.children[0].children.find(node => node.name === 'img');
  assert.deepEqual(image.attributes.map(attribute => attribute.name), ['src', 'alt']);
});

test('attribute editing rejects expressions, unquoted values, component props and ambiguity', async () => {
  for (const source of ['<a href={"/old/"}>text</a>', '<a href=/old/>text</a>', '<Link href="/old/">text</Link>', '{ok && <a href="/old/">text</a>}', '<a href="/old/" href="/other/">text</a>', '<a href="/old/">one</a><a href="/old/">two</a>']) {
    await assert.rejects(editStaticAttribute(source, { element: 'a', attribute: 'href', oldValue: '/old/', newValue: '/new/' }), rejection);
  }
});

test('attributes cannot modify executable elements, events, styles or arbitrary properties', async () => {
  for (const element of ['script', 'style', 'iframe', 'object', 'embed', 'link', 'base']) {
    await assert.rejects(editStaticAttribute(`<${element} src="/old.js"></${element}>`, { element, attribute: 'src', oldValue: '/old.js', newValue: 'https://evil.example/payload.js' }), rejection);
  }
  for (const attribute of ['onerror', 'onclick', 'style', 'srcdoc', 'set:html', 'data-private']) {
    await assert.rejects(editStaticAttribute('<p title="old">text</p>', { element: 'p', attribute, oldValue: 'old', newValue: 'alert(1)' }), rejection);
  }
});

test('URL attributes accept HTTPS or same-site absolute paths and reject bypass attempts', async () => {
  const source = '<a href="/old/">Text</a>';
  for (const newValue of ['https://example.com/path?a=1&b=2#anchor', '/local/?q=hello#anchor']) {
    const result = await editStaticAttribute(source, { element: 'a', attribute: 'href', oldValue: '/old/', newValue });
    assert.ok(result.includes(newValue.replaceAll('&', '&amp;')));
  }
  for (const newValue of ['javascript:alert(1)', 'data:text/html,<script>', '//evil.example', '/\\evil.example', '/\t/evil.example', ' https://evil.example', 'http://example.com', 'https://user:password@example.com', 'https://', '&#106;avascript:alert(1)', 'mailto:test@example.com']) {
    await assert.rejects(editStaticAttribute(source, { element: 'a', attribute: 'href', oldValue: '/old/', newValue }), rejection);
  }
});

test('SEO edits change only existing top-level const string initializers', async () => {
  const source = '---\n// const title = "comment decoy";\nconst title: string = "Old";\nconst description = \'Old description\', canonical = "https://example.com/old/";\nfunction example() { const title = "Nested"; }\nconst robots = `index,follow`;\n---\n<BaseLayout title={title}><h1>Old</h1></BaseLayout>';
  const result = await editSeo(source, { title: 'New title', description: 'New description', canonical: 'https://example.com/new/', robots: 'noindex,nofollow' });
  assert.equal(result, source.replace('= "Old"', '= "New title"').replace("= 'Old description'", '= "New description"').replace('= "https://example.com/old/"', '= "https://example.com/new/"').replace('= `index,follow`', '= "noindex,nofollow"'));
});

test('SEO JSON serialization prevents newline, frontmatter and JavaScript injection', async () => {
  const source = '---\nconst title = "Old";\n---\n<h1>{title}</h1>';
  const malicious = '";process.env.SECRET;\n---\n<script>alert(1)</script>\n---\n`${process.env.SECRET}`\u2028\u2029';
  const result = await editSeo(source, { title: malicious });
  const { ast } = await parse(result);
  assert.equal(ast.children.filter(node => node.type === 'frontmatter').length, 1);
  assert.equal(ast.children.some(node => node.name === 'script'), false);
  assert.ok(result.endsWith('---\n<h1>{title}</h1>'));
  const script = ts.createSourceFile('f.ts', ast.children[0].value, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  assert.equal(script.parseDiagnostics.length, 0);
  assert.equal(script.statements.length, 1);
  const initializer = script.statements[0].declarationList.declarations[0].initializer;
  assert.ok(ts.isStringLiteral(initializer));
  assert.equal(initializer.text, malicious);
});

test('SEO rejects dynamic bindings, reassigned variables, missing fields and comments as decoys', async () => {
  for (const declaration of ['const title = makeTitle();', 'const title = `Dynamic ${name}`;', 'const title = "A" + "B";', 'const title = ("A");', 'let title = "old";', 'var title = "old";', '// const title = "old";\nconst other = "value";', 'function f(){ const title = "old"; }', 'const title = "one"; const title = "two";']) {
    await assert.rejects(editSeo(`---\n${declaration}\n---\n<p>hello</p>`, { title: 'changed' }), rejection);
  }
  await assert.rejects(editSeo('<h1>No frontmatter</h1>', { title: 'changed' }), rejection);
  await assert.rejects(editSeo('---\nconst title="old";\n---\n<p>hello</p>', { untrusted: 'changed' }), rejection);
  await assert.rejects(editSeo('---\nconst title="old";\n---\n<p>hello</p>', {}), rejection);
});

test('SEO canonical URLs must be absolute HTTPS URLs without credentials', async () => {
  const source = '---\nconst canonical = "https://example.com/";\n---\n<p>hello</p>';
  for (const canonical of ['/relative/', 'javascript:alert(1)', '//evil.example/', 'https://user:password@example.com/']) {
    await assert.rejects(editSeo(source, { canonical }), rejection);
  }
});

test('SEO byte ranges preserve non-ASCII source and CRLF', async () => {
  const source = '---\r\nconst place = "Café 😃";\r\nconst title = "Original";\r\nconst description = "é";\r\n---\r\n<p>Keep 🚀</p>';
  const result = await editSeo(source, { title: 'Changé 🚀', description: 'Updated 😃' });
  assert.equal(result, source.replace('"Original"', '"Changé 🚀"').replace('description = "é"', 'description = "Updated 😃"'));
});

test('works on the actual repository footer and home page without altering executable source', async () => {
  const footer = await readFile(new URL('../../src/components/layout/Footer.astro', import.meta.url), 'utf8');
  const { ast } = await parse(footer);
  const candidates = [];
  function visit(node, blocked = false) {
    if (['expression', 'frontmatter'].includes(node.type) || ['script', 'style'].includes(node.name)) return;
    if (node.type === 'text' && node.value.trim().length > 10) candidates.push(node.value);
    for (const child of node.children || []) visit(child, blocked);
  }
  visit(ast);
  const find = candidates.find(value => candidates.filter(other => other.includes(value)).length === 1);
  assert.ok(find, 'footer has unambiguous static text');
  const result = await editVisibleText(footer, { find, replace: 'Test footer text' });
  assert.equal(result, footer.replace(find, 'Test footer text'));
  const home = await readFile(new URL('../../src/pages/index.astro', import.meta.url), 'utf8');
  const updatedHome = await editSeo(home, { title: 'Test website title' });
  assert.equal(updatedHome, home.replace('"Swishtag Commerce without chaos."', '"Test website title"'));
});
