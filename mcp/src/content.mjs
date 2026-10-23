import { parse } from '@astrojs/compiler';
import ts from 'typescript';

export class ContentEditError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ContentEditError';
    this.code = 'invalid_content_edit';
    this.status = 400;
    this.statusCode = 400;
  }
}

function fail(message) { throw new ContentEditError(message); }
const excluded = new Set(['script', 'style', 'template', 'noscript', 'head', 'title', 'iframe', 'object', 'embed', 'base', 'link', 'meta', 'xmp', 'plaintext', 'noembed', 'noframes']);
const attributeNames = new Set(['href', 'src', 'alt', 'title', 'aria-label']);
const seoNames = new Set(['title', 'description', 'canonical', 'robots']);

function text(value, label, { empty = true, limit = 20000 } = {}) {
  if (typeof value !== 'string' || (!empty && !value.length) || value.length > limit || /\x00/u.test(value) || !value.isWellFormed()) fail(`${label} must be ${empty ? 'a' : 'a nonempty'} string within the size limit.`);
  return value;
}

function escapeHtml(value) {
  return value.replace(/[&<>"'{}]/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '{': '&#123;', '}': '&#125;' })[character]);
}

async function astro(source) {
  text(source, 'Source', { empty: false, limit: 2 * 1024 * 1024 });
  try {
    const result = await parse(source, { position: true });
    if (result.diagnostics?.some(diagnostic => diagnostic.severity === 1)) fail('The Astro source has syntax errors; use a source editor to repair it first.');
    return result.ast;
  } catch (error) {
    if (error instanceof ContentEditError) throw error;
    fail('Unable to safely parse this Astro source.');
  }
}

function walkStatic(node, visitor) {
  // Expressions can themselves contain HTML descendants, all of which must be
  // skipped. A text node under an expression is executable JS, not visible copy.
  if (node.type === 'expression' || node.type === 'frontmatter' || node.type === 'comment') return;
  if (['element', 'custom-element'].includes(node.type) && excluded.has(node.name.toLowerCase())) return;
  if (node.attributes?.some(attribute => ['set:html', 'set:text', 'is:raw'].includes(attribute.name))) return;
  visitor(node);
  for (const child of node.children || []) walkStatic(child, visitor);
}

function bounds(bytes, node) {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > bytes.length) fail('The parser could not locate an exact source range for this content.');
  return { start, end };
}

function replaceBytes(bytes, start, end, replacement) {
  return Buffer.concat([bytes.subarray(0, start), Buffer.from(replacement, 'utf8'), bytes.subarray(end)]).toString('utf8');
}

/** Replace one exact raw-source substring inside a static HTML text node. */
export async function editVisibleText(source, { find, replace } = {}) {
  text(find, 'find', { empty: false });
  text(replace, 'replace');
  const ast = await astro(source);
  const bytes = Buffer.from(source, 'utf8');
  const matches = [];
  walkStatic(ast, node => {
    if (node.type !== 'text' || !node.value.includes(find)) return;
    const { start, end } = bounds(bytes, node);
    // Compiler positions are UTF-8 byte offsets; JS string indexes are not.
    // Also verify the range because compiler positions can be incomplete.
    const raw = bytes.subarray(start, end).toString('utf8');
    if (raw !== node.value) fail('The parser source range does not match the requested text.');
    for (let index = raw.indexOf(find); index !== -1; index = raw.indexOf(find, index + 1)) {
      const matchStart = start + Buffer.byteLength(raw.slice(0, index), 'utf8');
      matches.push({ start: matchStart, end: matchStart + Buffer.byteLength(find, 'utf8') });
    }
  });
  if (matches.length !== 1) fail('find must match exactly one occurrence within static visible text; expressions, scripts, styles and frontmatter are excluded.');
  const updated = replaceBytes(bytes, matches[0].start, matches[0].end, escapeHtml(replace));
  await astro(updated);
  return updated;
}

function safeUrl(value, { absolute = false } = {}) {
  if (value !== value.trim() || /[\\\x00-\x20\x7f]/u.test(value)) fail('URLs must not contain whitespace, control characters or backslashes.');
  if (!absolute && value.startsWith('/') && !value.startsWith('//')) {
    const parsed = new URL(value, 'https://website.invalid');
    if (parsed.origin === 'https://website.invalid') return;
  }
  if (/^https:\/\//iu.test(value)) {
    try {
      const parsed = new URL(value);
      if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) return;
    } catch { /* Return the same safe error for every invalid URL. */ }
  }
  fail(absolute ? 'Canonical URLs must be absolute HTTPS URLs without credentials.' : 'URL attributes must use HTTPS or a same-site path beginning with one slash.');
}

/** Edit an existing quoted literal attribute; never an Astro expression. */
export async function editStaticAttribute(source, { element, attribute, oldValue, newValue } = {}) {
  text(element, 'element', { empty: false, limit: 80 });
  text(attribute, 'attribute', { empty: false, limit: 80 });
  text(oldValue, 'oldValue');
  text(newValue, 'newValue');
  if (!/^[a-z][a-z0-9]*$/u.test(element) || excluded.has(element)) fail('element must identify an ordinary static HTML element.');
  if (!attributeNames.has(attribute)) fail('Only href, src, alt, title and aria-label can be edited.');
  if (attribute === 'href' || attribute === 'src') safeUrl(newValue);
  const ast = await astro(source);
  const bytes = Buffer.from(source, 'utf8');
  const matches = [];
  walkStatic(ast, node => {
    if (node.type !== 'element' || node.name !== element) return;
    const attributes = node.attributes.filter(item => item.name === attribute);
    if (attributes.length > 1) fail('Duplicate attributes cannot be edited safely.');
    const item = attributes[0];
    if (!item || item.kind !== 'quoted' || item.value !== oldValue) return;
    const start = item.position?.start?.offset;
    if (!Number.isSafeInteger(start) || start < 0 || start >= bytes.length) fail('The parser could not locate the attribute.');
    const tail = bytes.subarray(start).toString('utf8');
    // Attribute raw/end fields are incomplete in some compiler versions, so
    // verify a complete quoted token anchored at its compiler-provided offset.
    const token = /^([a-zA-Z][a-zA-Z0-9:-]*)\s*=\s*(["'])([\s\S]*?)\2/u.exec(tail);
    if (!token || token[1] !== attribute) fail('Only explicitly quoted literal HTML attributes can be edited.');
    matches.push({ start, end: start + Buffer.byteLength(token[0], 'utf8') });
  });
  if (matches.length !== 1) fail('element, attribute and oldValue must identify exactly one quoted static HTML attribute.');
  const updated = replaceBytes(bytes, matches[0].start, matches[0].end, `${attribute}="${escapeHtml(newValue)}"`);
  await astro(updated);
  return updated;
}

function jsonString(value) {
  // Keep every frontmatter delimiter on its existing line, including inputs
  // containing newlines, Unicode line separators, backticks or script tags.
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/gu, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** Edit only literal initializers of existing top-level const SEO bindings. */
export async function editSeo(source, fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields) || !Object.keys(fields).length || Object.keys(fields).some(name => !seoNames.has(name))) fail('SEO fields must contain title, description, canonical or robots.');
  for (const [name, value] of Object.entries(fields)) {
    text(value, name);
    if (name === 'canonical') safeUrl(value, { absolute: true });
  }
  const ast = await astro(source);
  const frontmatter = ast.children.filter(node => node.type === 'frontmatter');
  if (frontmatter.length !== 1) fail('SEO editing requires an existing Astro frontmatter block.');
  const node = frontmatter[0];
  const bytes = Buffer.from(source, 'utf8');
  const { start, end } = bounds(bytes, node);
  if (bytes.subarray(start, end).toString('utf8') !== `---${node.value}---`) fail('The parser could not verify the frontmatter source range.');
  const script = ts.createSourceFile('page-frontmatter.ts', node.value, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (script.parseDiagnostics.length) fail('The frontmatter contains JavaScript or TypeScript syntax errors.');
  const edits = [];
  for (const [name, value] of Object.entries(fields)) {
    const bindings = [];
    for (const statement of script.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === name) bindings.push({ declaration, constant: Boolean(statement.declarationList.flags & ts.NodeFlags.Const) });
      }
    }
    if (bindings.length !== 1 || !bindings[0].constant) fail(`SEO field ${name} must already have one top-level const binding.`);
    const initializer = bindings[0].declaration.initializer;
    if (!initializer || !(ts.isStringLiteral(initializer) || ts.isNoSubstitutionTemplateLiteral(initializer))) fail(`SEO field ${name} uses a dynamic expression; a source editor must change it.`);
    const relativeStart = initializer.getStart(script);
    const relativeEnd = initializer.end;
    edits.push({
      start: start + 3 + Buffer.byteLength(node.value.slice(0, relativeStart), 'utf8'),
      end: start + 3 + Buffer.byteLength(node.value.slice(0, relativeEnd), 'utf8'),
      replacement: jsonString(value),
    });
  }
  let updated = source;
  for (const edit of edits.sort((left, right) => right.start - left.start)) updated = replaceBytes(Buffer.from(updated, 'utf8'), edit.start, edit.end, edit.replacement);
  await astro(updated);
  return updated;
}
