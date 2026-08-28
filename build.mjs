// Cordon build — esbuild, no framework churn.
// content script  → IIFE  (MV3 forbids ES modules in content_scripts)
// service worker  → ESM   (MV3 "type": "module")
// side panel      → ESM   (loaded from an HTML page)
import * as esbuild from "esbuild";
import { cp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(".");
const SRC = path.join(ROOT, "extension");
const OUT = path.join(ROOT, "dist");
const watch = process.argv.includes("--watch");
const target = process.argv.includes("--firefox") ? "firefox" : "chrome";

// A visible build stamp. Without one, "did the extension actually reload?" is
// unanswerable, and you end up testing stale code without realising it.
const STAMP = new Date().toTimeString().slice(0, 8);

const common = {
  bundle: true,
  sourcemap: watch ? "inline" : false,
  minify: !watch,
  target: ["chrome114", "firefox115"],
  logLevel: "info",
  define: {
    "process.env.NODE_ENV": JSON.stringify(watch ? "development" : "production"),
    __BUILD__: JSON.stringify(STAMP),
  },
  alias: { "@": path.join(SRC, "src") },
};

const builds = [
  { entryPoints: [path.join(SRC, "src/content/index.ts")], outfile: path.join(OUT, "content.js"), format: "iife" },
  { entryPoints: [path.join(SRC, "src/background/index.ts")], outfile: path.join(OUT, "background.js"), format: "esm" },
  { entryPoints: [path.join(SRC, "src/sidepanel/index.ts")], outfile: path.join(OUT, "sidepanel.js"), format: "esm" },
  // The vision model runs here: WebGPU is not available to service workers.
  { entryPoints: [path.join(SRC, "src/offscreen/index.ts")], outfile: path.join(OUT, "offscreen.js"), format: "esm" },
];

/** ONNX Runtime ships its WASM kernels as separate files that it fetches at
 *  runtime; they have to sit somewhere the extension can serve them from. */
const ORT_DIST = path.join(ROOT, "node_modules", "onnxruntime-web", "dist");
const ORT_FILES = [
  "ort-wasm-simd-threaded.wasm",
  "ort-wasm-simd-threaded.mjs",
  "ort-wasm-simd-threaded.jsep.wasm",
  "ort-wasm-simd-threaded.jsep.mjs",
];

async function copyStatic() {
  await cp(path.join(SRC, "src/sidepanel/index.html"), path.join(OUT, "sidepanel.html"));
  await cp(path.join(SRC, "src/sidepanel/sidepanel.css"), path.join(OUT, "sidepanel.css"));
  await cp(path.join(SRC, "src/offscreen/index.html"), path.join(OUT, "offscreen.html"));

  await mkdir(path.join(OUT, "ort"), { recursive: true });
  for (const f of ORT_FILES) {
    if (existsSync(path.join(ORT_DIST, f))) {
      await cp(path.join(ORT_DIST, f), path.join(OUT, "ort", f));
    }
  }
  if (existsSync(path.join(SRC, "public"))) {
    await cp(path.join(SRC, "public"), OUT, { recursive: true });
  }
  const mf = JSON.parse(await readFile(path.join(SRC, `manifest.${target}.json`), "utf8"));
  await writeFile(path.join(OUT, "manifest.json"), JSON.stringify(mf, null, 2));
}

if (!watch) await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

if (watch) {
  for (const b of builds) {
    const ctx = await esbuild.context({ ...common, ...b });
    await ctx.watch();
  }
  await copyStatic();
  console.log(`\n  cordon: watching (${target}) → dist/\n`);
} else {
  await Promise.all(builds.map((b) => esbuild.build({ ...common, ...b })));
  await copyStatic();
  console.log(`\n  cordon: built for ${target} → dist/`);
  console.log(`  build stamp: ${STAMP}  — check this matches the side panel header\n`);
}
