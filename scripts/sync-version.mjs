// Keep src/index.ts FALLBACK_VERSION in sync with package.json.
// Wired as the npm "postversion" script, so `npm version <x>` maintains both.
import { readFileSync, writeFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const srcPath = new URL("../src/index.ts", import.meta.url);
const src = readFileSync(srcPath, "utf8");
const next = src.replace(
  /export const FALLBACK_VERSION = "[^"]*";/,
  `export const FALLBACK_VERSION = "${pkg.version}";`,
);
if (!/export const FALLBACK_VERSION = "[^"]*";/.test(src)) {
  console.error("FALLBACK_VERSION marker not found in src/index.ts");
  process.exit(1);
}
if (next !== src) writeFileSync(srcPath, next);
console.log(`FALLBACK_VERSION -> ${pkg.version}`);
