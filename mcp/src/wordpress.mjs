// Server-side WordPress integration. Never import this module into the Astro client.
const TYPES = new Set(['posts', 'portfolio']);
const STATUSES = new Set(['publish', 'future', 'draft', 'pending', 'private']);
const STRING_LIMITS = { title: 2000, content: 1_000_000, excerpt: 100_000, slug: 200, date: 40, date_gmt: 40 };
const RESPONSE_LIMIT = 4 * 1024 * 1024;
const IMAGE_LIMIT = 5 * 1024 * 1024;

function requireType(type) {
  if (!TYPES.has(type)) throw new Error('WordPress type must be posts or portfolio.');
  return type;
}

function requireId(id) {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('WordPress ID must be a positive integer.');
  return id;
}

function integer(value, min, max, name) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}.`);
  return value;
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function limitedString(value, max, name) {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new Error(`Invalid ${name}.`);
  return value;
}

function metaKeyList(keys) {
  if (!Array.isArray(keys) || keys.length > 40 || keys.some(key => typeof key !== 'string' || !/^[a-zA-Z0-9_]{1,100}$/.test(key))) {
    throw new Error('Invalid WordPress metadata allowlist.');
  }
  return [...new Set(keys)];
}

/** Validate before recording an intent; no network or filesystem side effects. */
export function validateWordPressFields(fields, { type = 'posts', metaKeys = [] } = {}) {
  requireType(type);
  const allowedMeta = new Set(metaKeyList(metaKeys));
  if (!plainObject(fields) || Object.keys(fields).length === 0) throw new Error('WordPress fields must be a nonempty object.');
  const result = {};
  for (const [key, value] of Object.entries(fields)) {
    if (Object.hasOwn(STRING_LIMITS, key)) {
      result[key] = limitedString(value, STRING_LIMITS[key], key);
      if (key === 'slug' && value && !/^[a-zA-Z0-9%_-]+$/.test(value)) throw new Error('Invalid WordPress slug.');
      if ((key === 'date' || key === 'date_gmt') && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z)?$/.test(value)) throw new Error('Invalid WordPress publication date.');
    } else if (key === 'status' && STATUSES.has(value)) {
      result.status = value;
    } else if (key === 'featured_media') {
      result.featured_media = integer(value, 0, Number.MAX_SAFE_INTEGER, key);
    } else if (type === 'posts' && (key === 'categories' || key === 'tags')) {
      if (!Array.isArray(value) || value.length > 100) throw new Error(`Invalid ${key}.`);
      result[key] = [...new Set(value.map(id => requireId(id)))];
    } else if (key === 'meta') {
      if (!plainObject(value) || Object.keys(value).length > 40) throw new Error('Invalid WordPress metadata.');
      result.meta = {};
      for (const [metaKey, metaValue] of Object.entries(value)) {
        if (!allowedMeta.has(metaKey)) throw new Error('WordPress metadata field is not allowlisted.');
        if (typeof metaValue === 'string') limitedString(metaValue, 20_000, 'metadata value');
        else if (typeof metaValue !== 'boolean' && !(typeof metaValue === 'number' && Number.isFinite(metaValue)) && metaValue !== null) {
          throw new Error('WordPress metadata values must be scalar.');
        }
        Object.defineProperty(result.meta, metaKey, { value: metaValue, enumerable: true, writable: true, configurable: true });
      }
    } else {
      throw new Error(`Unsupported WordPress field: ${/^[a-z_]{1,50}$/.test(key) ? key : '(invalid)'}.`);
    }
  }
  return result;
}

function baseEndpoint(baseUrl) {
  let url;
  try { url = new URL(baseUrl); } catch { throw new Error('Invalid WordPress base URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || /[%\\]/.test(url.pathname)) {
    throw new Error('WordPress requires a credential-free HTTPS base URL.');
  }
  let path = url.pathname.replace(/\/+$/, '');
  if (path.endsWith('/wp-json/wp/v2')) path += '/';
  else if (path.endsWith('/wp-json')) path += '/wp/v2/';
  else path += '/wp-json/wp/v2/';
  url.pathname = path;
  return url;
}

async function boundedJson(response) {
  if (Number(response.headers.get('content-length')) > RESPONSE_LIMIT) throw new Error('WordPress response exceeded the size limit.');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('WordPress returned an empty response.');
  let bytes = 0;
  const chunks = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > RESPONSE_LIMIT) {
        await reader.cancel();
        throw new Error('WordPress response exceeded the size limit.');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('WordPress returned invalid JSON.'); }
}

function raw(value, name) {
  if (typeof value?.raw !== 'string') throw new Error(`WordPress did not return editable ${name}; check application-password permissions.`);
  return value.raw;
}

/** A fixed-endpoint client. Repository history and permission checks belong to the caller. */
export class WordPressClient {
  #endpoint;
  #authorization;
  #fetch;
  #metaKeys;

  constructor({ baseUrl, username, applicationPassword, metaKeys = [], fetchImpl = globalThis.fetch } = {}) {
    this.#metaKeys = metaKeyList(metaKeys);
    this.#fetch = fetchImpl;
    if (!baseUrl && !username && !applicationPassword) return;
    if (!baseUrl || typeof username !== 'string' || !username || /[:\r\n]/.test(username)
      || typeof applicationPassword !== 'string' || !applicationPassword || /[\r\n]/.test(applicationPassword)) {
      throw new Error('Configure the WordPress URL, username, and application password together.');
    }
    this.#endpoint = baseEndpoint(baseUrl);
    this.#authorization = `Basic ${Buffer.from(`${username}:${applicationPassword}`).toString('base64')}`;
  }

  configured() { return Boolean(this.#endpoint); }

  validate(fields, { type = 'posts' } = {}) {
    return validateWordPressFields(fields, { type, metaKeys: this.#metaKeys });
  }

  async #request(path, { query = {}, method = 'GET', body, headers = {} } = {}) {
    if (!this.configured()) throw new Error('WordPress is not configured on the MCP server.');
    const url = new URL(path, this.#endpoint);
    if (url.origin !== this.#endpoint.origin || !url.pathname.startsWith(this.#endpoint.pathname)) throw new Error('Invalid WordPress route.');
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value));
    let response;
    try {
      response = await this.#fetch(url, {
        method, redirect: 'error', signal: AbortSignal.timeout(20_000),
        headers: { accept: 'application/json', authorization: this.#authorization, ...headers }, body,
      });
    } catch { throw new Error('WordPress request failed; check connectivity, HTTPS, and server configuration.'); }
    if (!response.ok || response.status >= 300) {
      await response.body?.cancel();
      throw new Error(`WordPress request failed (HTTP ${response.status}); check capabilities and endpoint configuration.`);
    }
    const data = await boundedJson(response);
    return { data, total: Number(response.headers.get('x-wp-total') || 0), totalPages: Number(response.headers.get('x-wp-totalpages') || 0) };
  }

  #snapshot(type, post) {
    requireId(post.id);
    const fields = {};
    for (const field of ['title', 'content', 'excerpt']) if (post[field] !== undefined) fields[field] = raw(post[field], field);
    for (const field of ['slug', 'status', 'featured_media', 'date', 'date_gmt']) if (post[field] !== undefined && post[field] !== null) fields[field] = post[field];
    if (type === 'posts') for (const field of ['categories', 'tags']) if (post[field] !== undefined) fields[field] = post[field];
    if (this.#metaKeys.length && plainObject(post.meta)) {
      fields.meta = Object.fromEntries(this.#metaKeys.filter(key => Object.hasOwn(post.meta, key)).map(key => [key, post.meta[key]]));
    }
    return {
      type, id: post.id, modified_gmt: limitedString(post.modified_gmt, 40, 'modification time'),
      link: typeof post.link === 'string' ? post.link : '', fields: this.validate(fields, { type }),
    };
  }

  async inspect() {
    if (!this.configured()) return { configured: false };
    const { data } = await this.#request('users/me', { query: { context: 'edit', _fields: 'id,name,capabilities' } });
    const capabilities = Object.fromEntries(['edit_posts', 'edit_others_posts', 'publish_posts', 'upload_files', 'edit_pages'].map(key => [key, data.capabilities?.[key] === true]));
    return { configured: true, origin: this.#endpoint.origin, user: { id: data.id, name: data.name }, capabilities, types: [...TYPES], metaKeys: this.#metaKeys };
  }

  async list({ type = 'posts', page = 1, perPage = 20, search = '', status = 'any' } = {}) {
    requireType(type); integer(page, 1, 10000, 'page'); integer(perPage, 1, 50, 'perPage'); limitedString(search, 200, 'search');
    if (status !== 'any' && !STATUSES.has(status)) throw new Error('Invalid WordPress status.');
    const { data, total, totalPages } = await this.#request(type, {
      query: { context: 'edit', page, per_page: perPage, search: search || undefined, status, _fields: 'id,title,slug,status,modified_gmt,link' },
    });
    if (!Array.isArray(data)) throw new Error('WordPress returned an invalid collection.');
    return { items: data.map(item => ({ type, id: item.id, title: raw(item.title, 'title'), slug: item.slug, status: item.status, modified_gmt: item.modified_gmt, link: item.link })), page, total, totalPages };
  }

  async get({ type = 'posts', id } = {}) {
    const { data } = await this.#request(`${requireType(type)}/${requireId(id)}`, { query: { context: 'edit' } });
    return this.#snapshot(type, data);
  }

  snapshot(args) { return this.get(args); }

  async update({ type = 'posts', id, fields, expectedModified } = {}) {
    const clean = this.validate(fields, { type }); requireId(id);
    if (typeof expectedModified !== 'string' || !expectedModified) throw new Error('A saved WordPress modification time is required.');
    const current = await this.get({ type, id });
    if (current.modified_gmt !== expectedModified) throw new Error('WordPress changed since the saved snapshot; inspect and create a new change.');
    const { data } = await this.#request(`${type}/${id}`, { method: 'POST', query: { context: 'edit' }, body: JSON.stringify(clean), headers: { 'content-type': 'application/json' } });
    return this.#snapshot(type, data);
  }

  async createDraft({ type = 'posts', fields } = {}) {
    const clean = this.validate({ ...fields, status: 'draft' }, { type });
    const { data } = await this.#request(type, { method: 'POST', query: { context: 'edit' }, body: JSON.stringify(clean), headers: { 'content-type': 'application/json' } });
    return this.#snapshot(type, data);
  }

  async revisions({ type = 'posts', id, page = 1, perPage = 20 } = {}) {
    integer(page, 1, 10000, 'page'); integer(perPage, 1, 50, 'perPage');
    const { data, total, totalPages } = await this.#request(`${requireType(type)}/${requireId(id)}/revisions`, { query: { context: 'edit', page, per_page: perPage } });
    if (!Array.isArray(data)) throw new Error('WordPress returned an invalid revision collection.');
    return { items: data.map(revision => ({ id: revision.id, parent: revision.parent, modified_gmt: revision.modified_gmt, fields: revisionToFields(revision) })), page, total, totalPages };
  }

  async getRevision({ type = 'posts', id, revisionId } = {}) {
    const { data } = await this.#request(`${requireType(type)}/${requireId(id)}/revisions/${requireId(revisionId)}`, { query: { context: 'edit' } });
    if (data.parent !== id) throw new Error('WordPress revision belongs to a different post.');
    return { id: data.id, parent: data.parent, modified_gmt: data.modified_gmt, fields: revisionToFields(data) };
  }

  restore({ type = 'posts', id, snapshot, expectedModified } = {}) {
    if (!snapshot || snapshot.type !== type || snapshot.id !== id) throw new Error('WordPress snapshot belongs to a different item.');
    return this.update({ type, id, fields: snapshot.fields, expectedModified });
  }

  async uploadMedia(input = {}) {
    const { filename, mimeType, base64, altText = '' } = input;
    const bytes = validateWordPressImage({ filename, mimeType, base64, altText });
    const form = new FormData();
    form.set('file', new Blob([bytes], { type: mimeType }), filename);
    form.set('alt_text', altText);
    const { data } = await this.#request('media', { method: 'POST', query: { context: 'edit', _fields: 'id,source_url,alt_text,mime_type' }, body: form });
    return { id: data.id, source_url: data.source_url, alt_text: data.alt_text, mime_type: data.mime_type };
  }
}

export function revisionToFields(revision) {
  const fields = {};
  for (const field of ['title', 'content', 'excerpt']) if (revision[field] !== undefined) fields[field] = raw(revision[field], field);
  return validateWordPressFields(fields);
}

/** Validate before saving image bytes and intent in repository history. SVG is excluded. */
export function validateWordPressImage({ filename, mimeType, base64, altText = '' } = {}) {
  if (typeof filename !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,150}\.(png|jpg|jpeg|gif|webp)$/i.test(filename)) throw new Error('Use a safe PNG, JPEG, GIF, or WebP filename.');
  limitedString(altText, 2000, 'image alternative text');
  if (typeof base64 !== 'string' || base64.length > Math.ceil(IMAGE_LIMIT / 3) * 4 || base64.length % 4 !== 0 || !/^[a-zA-Z0-9+/]+={0,2}$/.test(base64)) throw new Error('Invalid image base64 or image exceeds 5 MiB.');
  const bytes = Buffer.from(base64, 'base64');
  if (!bytes.length || bytes.length > IMAGE_LIMIT || bytes.toString('base64') !== base64) throw new Error('Invalid image base64 or image exceeds 5 MiB.');
  const formats = {
    'image/png': { extensions: ['png'], valid: bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) },
    'image/jpeg': { extensions: ['jpg', 'jpeg'], valid: bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 },
    'image/gif': { extensions: ['gif'], valid: /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii')) },
    'image/webp': { extensions: ['webp'], valid: bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP' },
  };
  const format = formats[mimeType];
  if (!format?.valid || !format.extensions.includes(filename.split('.').at(-1).toLowerCase())) throw new Error('Image MIME type, extension, and file signature must agree.');
  return bytes;
}
