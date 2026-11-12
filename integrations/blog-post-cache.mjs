// Shared WordPress post lookup for the blog page and the URL guard.
// Plain JS. A short timeout and an in-memory cache keep a slow CMS from hanging the page.

const WORDPRESS_POSTS_API = "https://cms.swishtag.com/wp-json/wp/v2/posts";
const TIMEOUT_MS = 4000;
const HIT_TTL_MS = 5 * 60 * 1000;
const MISS_TTL_MS = 60 * 1000;
const SAFE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const statusCache = new Map();
const postCache = new Map();

function remember(store, key, value, ttl) {
  store.delete(key);
  store.set(key, { expires: Date.now() + ttl, value });
  while (store.size > 200) {
    const oldest = store.keys().next().value;
    store.delete(oldest);
  }
}

function read(store, key) {
  const hit = store.get(key);
  if (!hit) return null;
  if (hit.expires <= Date.now()) {
    store.delete(key);
    return null;
  }
  return hit.value;
}

function decodeEntities(value) {
  return String(value || "")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function stripTags(value) {
  return decodeEntities(String(value || "").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function hasShortcodeNoise(value) {
  return /\b(?:vc_row|vc_column|vc_column_text|full_screen_row_position)\b/i.test(value || "");
}

export function trimDescription(value, maxLength = 155) {
  const text = stripTags(value);
  if (text.length <= maxLength) return text;
  const slice = text.slice(0, maxLength + 1);
  const sentenceEnd = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("! "), slice.lastIndexOf("? "));
  if (sentenceEnd >= 80) return slice.slice(0, sentenceEnd + 1).trim();
  const dotted = slice.lastIndexOf(".");
  if (dotted >= 80 && dotted <= maxLength) return slice.slice(0, dotted + 1).trim();
  return slice.slice(0, maxLength).replace(/\s+\S*$/, "").replace(/[,:;]+$/, "").trim();
}

function descriptionSource(post) {
  const yoast = post?.yoast_head_json?.description || post?.yoast_head_json?.og_description || "";
  const excerpt = stripTags(post?.excerpt?.rendered || "");
  if (yoast && !hasShortcodeNoise(yoast)) return stripTags(yoast);
  if (excerpt.length > 24 && !hasShortcodeNoise(excerpt)) return excerpt;
  return stripTags(post?.content?.rendered || "");
}

function normalizeMediaUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    if (url.hostname === "swishtag.com" || url.hostname === "www.swishtag.com" || url.hostname.startsWith("dei.")) {
      url.protocol = "https:";
      url.hostname = "cms.swishtag.com";
      return url.href;
    }
    return url.href;
  } catch {
    return value;
  }
}

function rewriteTag(tag) {
  let next = tag;
  const dataSrc = next.match(/\sdata-src=["']([^"']+)["']/i);
  const src = next.match(/\ssrc=["']([^"']*)["']/i);
  if (dataSrc && (!src || src[1].startsWith("data:"))) {
    const url = normalizeMediaUrl(dataSrc[1]);
    if (src) next = next.replace(src[0], ` src="${url}"`);
    else next = next.replace(/<img/i, `<img src="${url}"`);
  } else if (src && src[1]) {
    next = next.replace(src[0], ` src="${normalizeMediaUrl(src[1])}"`);
  }
  const srcset = next.match(/\ssrcset=["']([^"']+)["']/i);
  if (srcset) {
    const rewritten = srcset[1].split(",").map((part) => {
      const bits = part.trim().split(/\s+/);
      if (bits[0]) bits[0] = normalizeMediaUrl(bits[0]);
      return bits.join(" ");
    }).join(", ");
    next = next.replace(srcset[0], ` srcset="${rewritten}"`);
  }
  return next;
}

function sanitizeArticleHtml(html) {
  let output = String(html || "").replace(/<!--[\s\S]*?-->/g, " ");
  const shortcode = /\[(?:\/)?(?:vc_[\w-]+|mk_[\w-]+|et_pb_[\w-]+|fusion_[\w-]+|nectar_[\w-]+|caption|gallery|embed|audio|video|playlist|contact-form-7|gravityform|wp_caption)(?:[^\]]*)?\]/gi;
  for (let pass = 0; pass < 3; pass += 1) output = output.replace(shortcode, " ");
  output = output
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
    .replace(/<div[^>]*id=["']ez-toc-container["'][\s\S]*?<\/div>/gi, "");
  output = output.replace(/<img\b[^>]*>/gi, rewriteTag);
  let section = 0;
  output = output.replace(/<h2\b([^>]*)>/gi, (full, attrs) => {
    section += 1;
    if (/\sid\s*=/.test(attrs)) return full;
    return `<h2${attrs} id="section-${section}">`;
  });
  return output;
}

function headingList(html) {
  const headings = [];
  const pattern = /<h2\b[^>]*\sid=["']([^"']+)["'][^>]*>([\s\S]*?)<\/h2>/gi;
  let match = pattern.exec(html);
  while (match && headings.length < 8) {
    const text = stripTags(match[2]);
    if (text) headings.push({ id: match[1], text });
    match = pattern.exec(html);
  }
  return headings;
}

function categoryName(post) {
  const terms = post?._embedded?.["wp:term"] || [];
  const category = terms.flat().find((term) => term && term.taxonomy === "category" && term.slug !== "uncategorized");
  if (category?.name) return stripTags(category.name);
  return "Insights";
}

function formatDate(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }).format(date);
}

function readTime(post) {
  const words = stripTags(post?.content?.rendered || "").split(/\s+/).filter(Boolean).length;
  const minutes = Math.max(1, Math.ceil(words / 220));
  return `${minutes} min read`;
}

function featuredImage(post) {
  const media = post?._embedded?.["wp:featuredmedia"]?.[0];
  const sizes = media?.media_details?.sizes || {};
  return normalizeMediaUrl(sizes.large?.source_url || sizes.medium_large?.source_url || sizes.full?.source_url || media?.source_url || "");
}

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) {
    const error = new Error(`WordPress returned ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

async function fetchPostRecord(slug, fields) {
  const url = new URL(WORDPRESS_POSTS_API);
  url.searchParams.set("slug", slug);
  url.searchParams.set("per_page", "1");
  if (fields) url.searchParams.set("_fields", fields);
  else url.searchParams.set("_embed", "author,wp:featuredmedia,wp:term");
  const posts = await fetchJson(url);
  return Array.isArray(posts) && posts.length > 0 ? posts[0] : null;
}

function slugCandidates(slug) {
  const key = String(slug || "").trim().toLowerCase();
  if (!key || key.length > 200 || !SAFE_SLUG.test(key)) return [];
  const candidates = [key];
  if (key.endsWith("-2026")) candidates.push(key.replace(/-2026$/, ""));
  return candidates;
}

export async function blogSlugStatus(slug) {
  const candidates = slugCandidates(slug);
  if (!candidates.length) return 404;
  const key = candidates[0];
  const cached = read(statusCache, key);
  if (cached) return cached;
  try {
    for (const candidate of candidates) {
      const post = await fetchPostRecord(candidate, "id,slug");
      if (post) {
        remember(statusCache, key, 200, HIT_TTL_MS);
        return 200;
      }
    }
    remember(statusCache, key, 404, MISS_TTL_MS);
    return 404;
  } catch {
    return 503;
  }
}

function preparePost(post, publicSlug) {
  const headline = stripTags(post?.title?.rendered);
  const source = descriptionSource(post);
  const html = sanitizeArticleHtml(post?.content?.rendered || "");
  const authorName = stripTags(post?._embedded?.author?.[0]?.name || "");
  return {
    slug: publicSlug,
    headline,
    title: headline ? `${headline} | Swishtag` : "Insight | Swishtag",
    description: trimDescription(source, 155),
    dek: trimDescription(source, 220),
    canonical: `https://swishtag.com/${publicSlug}/`,
    image: featuredImage(post),
    html,
    headings: headingList(html),
    category: categoryName(post),
    dateLabel: formatDate(post?.date_gmt ? `${post.date_gmt}Z` : post?.date),
    readTime: readTime(post),
    dateGmt: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(post?.date_gmt || "") ? `${post.date_gmt}Z` : null,
    modifiedGmt: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(post?.modified_gmt || "") ? `${post.modified_gmt}Z` : null,
    authorName,
  };
}

export async function loadBlogPost(slug) {
  const candidates = slugCandidates(slug);
  if (!candidates.length) return { status: 404, post: null };
  const key = candidates[0];
  const cached = read(postCache, key);
  if (cached) return cached;
  try {
    for (const candidate of candidates) {
      const record = await fetchPostRecord(candidate);
      if (record) {
        const value = { status: 200, post: preparePost(record, key) };
        remember(postCache, key, value, HIT_TTL_MS);
        remember(statusCache, key, 200, HIT_TTL_MS);
        return value;
      }
    }
    const missing = { status: 404, post: null };
    remember(postCache, key, missing, MISS_TTL_MS);
    remember(statusCache, key, 404, MISS_TTL_MS);
    return missing;
  } catch {
    return { status: 503, post: null };
  }
}
