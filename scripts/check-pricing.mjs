// Pricing guard (audit v2 Part 03). Run after a build: `npm run check:pricing`.
// The Company Store page is the pricing source of truth: $1,200 first store, $300 additional
// store, $100/month Care (and $100 per 25 products / per 250 migrated). This fails if any built
// HTML page has a "$" amount within 80 characters of "company store" (either order) that is not
// one of those amounts. It reads dist/ only and is intentionally not part of `npm run build`.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(root, "dist");
const ALLOWED = new Set(["1200", "300", "100"]);
const WINDOW = 80;

function htmlFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...htmlFiles(full));
    else if (entry.name.endsWith(".html")) out.push(full);
  }
  return out;
}

function toText(html) {
  return html
    .replace(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi, " $1 ")
    .replace(/<(script|style|svg)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

if (!fs.existsSync(distDir)) {
  console.error("check:pricing: dist/ not found. Run `npm run build` first.");
  process.exit(2);
}

const problems = [];
const files = htmlFiles(distDir);
const amount = /\$\s?(\d[\d,]*(?:\.\d+)?)\s*(k|K)?/g;
for (const file of files) {
  const text = toText(fs.readFileSync(file, "utf8"));
  const lower = text.toLowerCase();
  let m;
  amount.lastIndex = 0;
  while ((m = amount.exec(text))) {
    const start = Math.max(0, m.index - WINDOW);
    const end = Math.min(text.length, m.index + m[0].length + WINDOW);
    if (!/company[\s-]stores?/.test(lower.slice(start, end))) continue;
    let value = m[1].replace(/,/g, "");
    if (m[2]) value = String(Number(value) * 1000);
    value = value.replace(/\.0+$/, "");
    if (!ALLOWED.has(value)) {
      problems.push(`${path.relative(root, file)}: "${text.slice(start, end).trim()}"`);
    }
  }
}

if (problems.length) {
  console.error(`check:pricing FAILED: ${problems.length} company-store price(s) not in {$1,200, $300, $100}:`);
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}
console.log(`check:pricing OK: ${files.length} built HTML files, no company-store price other than $1,200 / $300 / $100.`);
