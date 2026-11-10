// `import href from "./file.css?rawcss"` returns the public URL of a content-hashed copy of the
// CSS file (/_astro/<name>.<hash>.css), copied byte for byte into the client build.
// Unlike `?url`, the file skips Vite's CSS pipeline, so the minifier cannot drop vendor prefixes
// (e.g. -webkit-backdrop-filter, which Safari 17 and older need), merge rules, or fail on
// declarations that browsers simply ignore. The hash changes whenever the file changes.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const QUERY = "?rawcss";
const PREFIX = "\0rawcss:";
const SUFFIX = ".rawcss.js";

export default function rawCssUrl() {
  const files = new Map(); // public file name -> absolute source path
  let clientDir;

  const vitePlugin = {
    name: "swishtag-raw-css-url",
    enforce: "pre",
    async resolveId(id, importer) {
      if (!id.endsWith(QUERY)) return null;
      const resolved = await this.resolve(id.slice(0, -QUERY.length), importer, { skipSelf: true });
      if (!resolved) return null;
      // The virtual id must not end in ".css", or Vite would treat this JS module as CSS.
      return PREFIX + resolved.id.split("?")[0] + SUFFIX;
    },
    load(id) {
      if (!id.startsWith(PREFIX)) return null;
      const file = id.slice(PREFIX.length, -SUFFIX.length);
      this.addWatchFile(file);
      if (this.environment?.mode === "dev" || process.env.npm_lifecycle_event === "dev") {
        return `export default ${JSON.stringify("/@fs" + (file.startsWith("/") ? "" : "/") + file.replace(/\\/g, "/") + "?direct")};`;
      }
      const source = fs.readFileSync(file);
      const hash = crypto.createHash("sha256").update(source).digest("base64url").slice(0, 8);
      const name = `${path.basename(file, ".css")}.${hash}.css`;
      files.set(name, file);
      return `export default ${JSON.stringify(`/_astro/${name}`)};`;
    },
  };

  return {
    name: "swishtag-raw-css-url",
    hooks: {
      "astro:config:setup": ({ updateConfig }) => {
        updateConfig({ vite: { plugins: [vitePlugin] } });
      },
      "astro:config:done": ({ config }) => {
        clientDir = config.build.client;
      },
      "astro:build:done": ({ logger }) => {
        const out = new URL("_astro/", clientDir);
        fs.mkdirSync(out, { recursive: true });
        for (const [name, file] of files) fs.copyFileSync(file, new URL(name, out));
        logger.info(`Copied ${files.size} page stylesheets to _astro/`);
      },
    },
  };
}
