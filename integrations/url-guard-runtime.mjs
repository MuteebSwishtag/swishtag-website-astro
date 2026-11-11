// Runtime guard for prerendered pages, copied to dist/server/url-guard.mjs at build time
// and imported first by dist/server/entry.mjs (see ./url-guard.mjs).
//
// Prerendered pages are served by @astrojs/node's static file handler, which runs before
// Astro's router. Without this guard, odd URL forms for those pages would return 200
// instead of what the site returned when they were server-rendered:
//   /path/index.html  -> 301 /path/       (root: /index.html -> /)
//   /path//, /path/// -> 301 /path/       (extra trailing slashes; other slashes untouched, as before)
//   /404.html         -> 404 with the 404 page
// Query strings are kept. Only GET/HEAD requests whose canonical target is a prerendered
// page are touched; everything else passes straight through to the adapter unchanged.
//
// SERVER_REDIRECTS: retired URLs that must answer with a single server-side 301 in every
// form (/x, /x/, /x/index.html, /x//), query string kept. Astro's `redirects` config
// drops the query string and does not cover /x/index.html, so these live here instead.
//   /contact-us/ -> /book-demo/   (Muteeb, 2026-11-11: no duplicate contact page)
//   /solutions/book-demo/ -> /book-demo/, /solutions/solutions/ -> /solutions/   (audit 404s, Part 02)
//
// Retired legacy blog page /insights/blog/ (Muteeb, 2026-11-11): old share links
// /insights/blog/?slug=<post> get a single 301 to /<post>/ (other query params kept) when the
// slug is a plain WordPress-style slug; every other form of /insights/blog/ returns the 404 page.
//
// GONE_PATHS: removed pages that must return the site 404 page in every form (/x, /x/,
// /x/index.html, /x//, any query string) instead of being redirected.
//   Old SAGE page URLs (Muteeb, 2026-11-11: SAGE stays removed; old URLs 404).
//   /thank-you/ (replaced by /contact/thank-you/; the old demo page is gone).
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLIENT_DIR = fileURLToPath(new URL("../client/", import.meta.url));
const pageCache = new Map();
const SERVER_REDIRECTS = Object.freeze({
  "/contact-us/": "/book-demo/",
  "/solutions/book-demo/": "/book-demo/",
  "/solutions/solutions/": "/solutions/",
});

const GONE_PATHS = new Set([
  "/solutions/shopify-sage-connect-integration/",
  "/shopify-sage-connect-integration/",
  "/thank-you/",
]);

const LEGACY_BLOG_PATH = "/insights/blog/";
const SAFE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function legacyBlogRedirect(req, res, query) {
  const params = new URLSearchParams(query);
  const slug = (params.get("slug") || "").trim().toLowerCase();
  if (!slug || slug.length > 200 || !SAFE_SLUG.test(slug)) return send404(req, res);
  params.delete("slug");
  const rest = params.toString();
  res.statusCode = 301;
  res.setHeader("Location", `/${slug}/` + (rest ? `?${rest}` : ""));
  res.end();
  return true;
}

function isPrerenderedPage(pathname) {
  if (pageCache.has(pathname)) return pageCache.get(pathname);
  const file = path.resolve(CLIENT_DIR, "." + pathname, "index.html");
  const inside = file.startsWith(path.resolve(CLIENT_DIR) + path.sep);
  let exists = false;
  if (inside) {
    try {
      exists = fs.statSync(file).isFile();
    } catch {}
  }
  pageCache.set(pathname, exists);
  return exists;
}

function send404(req, res) {
  let body;
  try {
    body = fs.readFileSync(path.join(CLIENT_DIR, "404.html"));
  } catch {
    return false;
  }
  res.statusCode = 404;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Length", body.length);
  res.end(req.method === "HEAD" ? undefined : body);
  return true;
}

export function urlGuard(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const raw = (req.url || "/").split("#")[0];
  const q = raw.indexOf("?");
  const rawPath = q === -1 ? raw : raw.slice(0, q);
  const query = q === -1 ? "" : raw.slice(q);

  let decoded;
  try {
    decoded = decodeURI(rawPath);
  } catch {
    return false;
  }
  if (decoded.includes("\\") || /(^|\/)\.\.?(\/|$)/.test(decoded)) return false;

  if (decoded === "/404.html") return send404(req, res);

  let retired = decoded;
  if (retired.endsWith("/index.html")) retired = retired.slice(0, -"index.html".length);
  retired = retired.replace(/\/{2,}$/, "/");
  if (!retired.endsWith("/")) retired += "/";
  if (GONE_PATHS.has(retired)) return send404(req, res);
  if (retired === LEGACY_BLOG_PATH) return legacyBlogRedirect(req, res, query);
  if (Object.prototype.hasOwnProperty.call(SERVER_REDIRECTS, retired)) {
    res.statusCode = 301;
    res.setHeader("Location", SERVER_REDIRECTS[retired] + query);
    res.end();
    return true;
  }

  let target = decoded;
  if (target.endsWith("/index.html")) target = target.slice(0, -"index.html".length);
  target = target.replace(/\/{2,}$/, "/");
  if (target === decoded) return false;

  const pageDir = target.endsWith("/") ? target : target + "/";
  if (!isPrerenderedPage(pageDir)) return false;

  res.statusCode = 301;
  res.setHeader("Location", encodeURI(target) + query);
  res.end();
  return true;
}

function wrap(listener) {
  if (typeof listener !== "function") return listener;
  return function guardedListener(req, res, ...rest) {
    if (urlGuard(req, res)) return;
    return listener.call(this, req, res, ...rest);
  };
}

// The standalone adapter builds its own request handler inside startServer(). Wrap the
// listener of the first HTTP(S) server it creates, then restore the original functions.
for (const mod of [http, https]) {
  const original = mod.createServer;
  mod.createServer = function createServerWithUrlGuard(...args) {
    http.createServer = originals.http;
    https.createServer = originals.https;
    const i = args.findIndex((a) => typeof a === "function");
    if (i !== -1) args[i] = wrap(args[i]);
    return original.apply(this, args);
  };
  mod.__urlGuardOriginal = original;
}
const originals = { http: http.__urlGuardOriginal, https: https.__urlGuardOriginal };
delete http.__urlGuardOriginal;
delete https.__urlGuardOriginal;
