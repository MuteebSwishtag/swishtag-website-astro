// Astro integration: after the build, install the prerendered-page URL guard into the
// standalone server entry (dist/server/entry.mjs), so it runs however the app is started
// (npm start, or Hostinger's "server/entry.mjs" entry file). See ./url-guard-runtime.mjs.
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const MARKER = 'import "./url-guard.mjs";';

export default function urlGuard() {
  let serverDir;
  return {
    name: "swishtag-url-guard",
    hooks: {
      "astro:config:done": ({ config }) => {
        serverDir = config.build.server;
      },
      "astro:build:done": ({ logger }) => {
        const entry = new URL("entry.mjs", serverDir);
        if (!fs.existsSync(entry)) throw new Error(`[url-guard] ${fileURLToPath(entry)} not found; the URL guard could not be installed.`);
        fs.copyFileSync(new URL("./url-guard-runtime.mjs", import.meta.url), new URL("url-guard.mjs", serverDir));
        const source = fs.readFileSync(entry, "utf8");
        if (!source.startsWith(MARKER)) fs.writeFileSync(entry, `${MARKER}\n${source}`);
        logger.info("URL guard installed in server/entry.mjs");
      },
    },
  };
}
