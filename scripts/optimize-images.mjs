// One-off: write lighter WebP copies of oversized images next to the originals.
// Sizes are at least 2x the largest rendered CSS size (retina), never upscaled.
// Originals stay in the repo; pages point at the .webp files.
// Usage: node scripts/optimize-images.mjs
import sharp from "sharp";
import { readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const assets = join(root, "public", "assets");
const QUALITY = 90;

// [source, target, max height or null for native size, lossless?]
const jobs = [
  // Promo Plus hero before/after: shown at most ~300x280 CSS px (object-fit: contain), hover scale 1.05.
  ["promo-plus/before.png", "promo-plus/before.webp", 640],
  ["promo-plus/after.png", "promo-plus/after.webp", 640],
  // Approval preview: up to ~733x152 CSS px with object-fit: cover, so native width is about 2x already.
  ["promo-plus/mockup-creation.png", "promo-plus/mockup-creation.webp", null],
  ["promo-plus/send-for-approval.png", "promo-plus/send-for-approval.webp", null],
  ["promo-plus/production-file.png", "promo-plus/production-file.webp", null],
  // Case-study images shown up to ~912 CSS px wide; native is 890 px, so keep native.
  // Fine detail here loses too much at lossy q90, so these are lossless WebP (pixel-identical).
  ["case-studies/formeteca-hero.png", "case-studies/formeteca-hero.webp", null, true],
  ["case-studies/cosmify-related-1.png", "case-studies/cosmify-related-1.webp", null, true],
];

// Brand SVGs over 100 KB wrap embedded rasters. Cards show them in a 178x82 box (contain, hover 1.09).
// Render at 2x the SVG's own 300x200 size (600x400), well above 2x display.
const brandsDir = join(assets, "case-studies", "brands");
const brandJobs = readdirSync(brandsDir)
  .filter((f) => f.endsWith(".svg") && statSync(join(brandsDir, f)).size > 100 * 1024)
  .sort();

const rows = [];
const kb = (n) => Math.round(n / 1024);

for (const [src, dest, maxHeight, lossless] of jobs) {
  let img = sharp(join(assets, src));
  if (maxHeight) img = img.resize({ height: maxHeight, withoutEnlargement: true });
  const opts = lossless
    ? { lossless: true, effort: 6 }
    : { quality: QUALITY, alphaQuality: 100, effort: 6, smartSubsample: true };
  const info = await img.webp(opts).toFile(join(assets, dest));
  rows.push([src, dest, statSync(join(assets, src)).size, info.size, `${info.width}x${info.height}`]);
}

for (const file of brandJobs) {
  const src = `case-studies/brands/${file}`;
  const dest = src.replace(/\.svg$/, ".webp");
  const info = await sharp(join(assets, src), { density: 144 })
    .resize({ width: 600, height: 400, fit: "fill" })
    .webp({ quality: QUALITY, alphaQuality: 100, effort: 6, smartSubsample: true })
    .toFile(join(assets, dest));
  rows.push([src, dest, statSync(join(assets, src)).size, info.size, `${info.width}x${info.height}`]);
}

for (const [src, dest, before, after, dims] of rows) {
  console.log(`${src}\t${kb(before)} KB\t${dest}\t${kb(after)} KB\t${dims}`);
}
const total = rows.reduce((a, r) => [a[0] + r[2], a[1] + r[3]], [0, 0]);
console.log(`TOTAL\t${kb(total[0])} KB -> ${kb(total[1])} KB`);
