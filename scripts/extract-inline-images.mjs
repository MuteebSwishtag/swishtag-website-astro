// One-off: move inline base64 images out of page markup into real files.
// Bytes are written exactly as decoded (no re-encoding), so pixels are identical.
// Usage: node scripts/extract-inline-images.mjs
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "public", "assets", "inline");
const publicPrefix = "/assets/inline/";

// Each file lists names for its data URIs in source order.
const targets = [
  ["src/components/home/Hero.astro", ["home-hero-rocket", "home-hero-clouds"]],
  ["src/components/home/GrowthPain.astro", ["home-growth-pain"]],
  ["src/components/home/FinalCta.astro", ["home-final-cta"]],
  ["src/legacy/promo-plus-body.html", ["promo-plus-workflow-1", "promo-plus-workflow-2", "promo-plus-workflow-3", "promo-plus-workflow-4", "promo-plus-workflow-5"]],
  ["src/pages/solutions/index.astro", ["solutions-hub-astronaut", "solutions-company-store-preview", "solutions-enterprise-preview"]],
  ["src/pages/book-demo/index.astro", ["book-demo-astronaut"]],
];

const EXT = { webp: "webp", png: "png", jpeg: "jpg", jpg: "jpg", gif: "gif" };
const pattern = /data:image\/(webp|png|jpeg|jpg|gif);base64,([A-Za-z0-9+/=]+)/g;

mkdirSync(outDir, { recursive: true });
const manifest = {};
const byHash = new Map(); // identical images share one file

for (const [rel, names] of targets) {
  const file = join(root, rel);
  const source = readFileSync(file, "utf8");
  let index = 0;
  const updated = source.replace(pattern, (_match, type, data) => {
    const name = names[index];
    index += 1;
    if (!name) throw new Error(`${rel}: more data URIs than names`);
    const bytes = Buffer.from(data, "base64");
    if (bytes.toString("base64").replace(/=+$/, "") !== data.replace(/=+$/, "")) {
      throw new Error(`${rel}: ${name} did not round-trip`);
    }
    const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 10);
    let fileName = byHash.get(hash);
    if (!fileName) {
      fileName = `${name}-${hash}.${EXT[type]}`;
      writeFileSync(join(outDir, fileName), bytes);
      byHash.set(hash, fileName);
    }
    manifest[name] = { file: publicPrefix + fileName, bytes: bytes.length, from: rel };
    return publicPrefix + fileName;
  });
  if (index !== names.length) throw new Error(`${rel}: expected ${names.length} data URIs, found ${index}`);
  writeFileSync(file, updated);
}

console.log(JSON.stringify(manifest, null, 2));
