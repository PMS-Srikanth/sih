/**
 * Tells you why Cordon is not working on this machine.
 *
 *   npm run doctor
 *
 * Written because "I followed the README and it does not work" is not a bug
 * report anyone can act on, and the difference between a working checkout and a
 * broken one is almost never the code — it is machine state the README cannot
 * see: a build that was never run, a stale dist Chrome is still holding, the
 * wrong folder loaded, servers that are not up, or a vault that exists on one
 * laptop and not another.
 *
 * Every check says what is wrong AND the exact command that fixes it. Nothing
 * here changes anything; it only looks.
 */
import { existsSync, statSync, readdirSync } from "node:fs";
import path from "node:path";

const R = "\x1b[31m", G = "\x1b[32m", Y = "\x1b[33m", D = "\x1b[2m", X = "\x1b[0m", B = "\x1b[1m";

let broken = 0;
let warned = 0;

const ok = (m, d = "") => console.log(`  ${G}ok${X}    ${m}${d ? `  ${D}${d}${X}` : ""}`);
const bad = (m, fix) => {
  console.log(`  ${R}FAIL${X}  ${m}`);
  console.log(`        ${B}fix:${X} ${fix}`);
  broken++;
};
const warn = (m, fix) => {
  console.log(`  ${Y}note${X}  ${m}`);
  if (fix) console.log(`        ${D}${fix}${X}`);
  warned++;
};
const head = (t) => console.log(`\n${B}${t}${X}`);

const root = process.cwd();
const DIST = path.join(root, "dist");
const newest = (dir, exts) => {
  let t = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (!exts || exts.some((x) => e.name.endsWith(x))) t = Math.max(t, statSync(p).mtimeMs);
    }
  };
  try { walk(dir); } catch { /* missing directory is reported elsewhere */ }
  return t;
};
const reach = async (url, ms = 1500) => {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), ms);
    const r = await fetch(url, { signal: c.signal });
    clearTimeout(t);
    return r.ok ? await r.json().catch(() => ({})) : null;
  } catch {
    return null;
  }
};

console.log(`\n${B}  Cordon doctor${X}  ${D}${root}${X}`);

// ── 1 · toolchain ──────────────────────────────────────────────────────────
head("Toolchain");

const major = Number(process.versions.node.split(".")[0]);
if (major >= 20) ok("Node version", `v${process.versions.node}`);
else bad(`Node v${process.versions.node} is too old — this needs v20+`, "install Node 20 or newer from nodejs.org");

if (existsSync(path.join(root, "node_modules", "esbuild"))) ok("dependencies installed");
else bad("node_modules is missing or incomplete", "npm install");

// ── 2 · the build ──────────────────────────────────────────────────────────
head("The build — this is what Chrome loads");

const REQUIRED = [
  "manifest.json", "background.js", "content.js",
  "sidepanel.html", "sidepanel.js", "sidepanel.css",
  "offscreen.html", "offscreen.js",
];

if (!existsSync(DIST)) {
  bad("dist/ does not exist — Chrome has nothing to load", "npm run build");
} else {
  const missing = REQUIRED.filter((f) => !existsSync(path.join(DIST, f)));
  if (missing.length) bad(`dist/ is incomplete — missing ${missing.join(", ")}`, "npm run build");
  else ok("dist/ has every file it needs", `${REQUIRED.length} files`);

  // The single most common cause of "my teammate has features I do not".
  const srcT = newest(path.join(root, "extension", "src"));
  const distT = newest(DIST, [".js", ".css", ".html"]);
  if (srcT && distT && srcT > distT + 1000) {
    bad(
      `dist/ is OLDER than the source — you are running stale code` +
        `\n        source changed ${new Date(srcT).toLocaleTimeString()},` +
        ` dist built ${new Date(distT).toLocaleTimeString()}`,
      "npm run build   (then click Reload on the extension card in chrome://extensions)",
    );
  } else if (distT) {
    ok("dist/ is up to date with the source", `built ${new Date(distT).toLocaleTimeString()}`);
  }

  // Two model-shaped things, with very different consequences.
  if (existsSync(path.join(DIST, "models", "ultraface-320.onnx"))) ok("face detector bundled", "1.2 MB, committed");
  else bad("the face detector is missing from dist/models", "npm run build   (it is committed, so this means the build did not finish)");

  const ortDir = path.join(DIST, "ort");
  const wasm = existsSync(ortDir) ? readdirSync(ortDir).filter((f) => f.endsWith(".wasm")).length : 0;
  if (wasm) ok("ONNX Runtime WASM bundled", `${wasm} file(s)`);
  else bad("dist/ort is missing — the vision model cannot start", "npm install && npm run build");

  if (existsSync(path.join(DIST, "models", "vit-base-patch16-224"))) {
    ok("ViT classifier bundled", "Thorough mode will use it");
  } else {
    warn(
      "the ViT classifier is not present — this is expected and fine",
      "84 MB, deliberately not committed. Fast and Balanced are unaffected; Thorough falls back to the face detector alone. Run `npm run fetch-models` only if you want it.",
    );
  }
}

// ── 3 · what Chrome is actually holding ────────────────────────────────────
head("Loading it into the browser");
console.log(`  ${D}Load ${B}${DIST}${X}${D} — the dist folder, NOT extension/ and not the repo root.${X}`);
console.log(`  ${D}chrome://extensions → Developer mode → Load unpacked → select dist${X}`);
console.log(`  ${D}After every build, click Reload on the Cordon card. The side panel header${X}`);
console.log(`  ${D}prints a build stamp: if it does not match what npm run build printed, you${X}`);
console.log(`  ${D}are looking at stale code and none of your changes are live.${X}`);

// ── 4 · the servers ────────────────────────────────────────────────────────
head("Servers");

const health = await reach("http://127.0.0.1:8787/health");
if (health) {
  ok("agent server is up", `engine: ${health.engine ?? "?"}`);
  if (health.engine === "rules") {
    warn(
      "it is using the rule-based planner, not an open-weights model",
      "Everything works this way and the demo is honest. For the real model: install Ollama, `ollama pull qwen2.5:3b`, then start the server with CORDON_VLM_URL=http://127.0.0.1:11434/v1/chat/completions",
    );
  }
} else {
  bad("agent server is not running — any task needing the server will fail", "npm start   (starts both servers; leave that terminal open)");
}

if (await reach("http://127.0.0.1:8788/job-form.html")) ok("demo pages are being served");
else bad("demo pages are not being served — the demo URLs will not load", "npm start   (starts both servers; leave that terminal open)");

// ── 5 · optional model ─────────────────────────────────────────────────────
head("Open-weights model (optional)");
const tags = await reach("http://127.0.0.1:11434/api/tags");
if (!tags) {
  warn("Ollama is not running — the server falls back to rules", "Optional. Install Ollama, then: ollama pull qwen2.5:3b");
} else {
  const names = (tags.models ?? []).map((m) => m.name);
  if (names.length) ok("Ollama is running", names.join(", "));
  else warn("Ollama is running but has no models pulled", "ollama pull qwen2.5:3b");
}

// ── 6 · a browser to load it into ──────────────────────────────────────────
head("Browser");
const browsers = [
  ["Chrome", "C:/Program Files/Google/Chrome/Application/chrome.exe"],
  ["Edge", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"],
  ["Edge", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"],
  ["Chrome", "/usr/bin/google-chrome"],
  ["Chromium", "/usr/bin/chromium"],
  ["Chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
];
const present = browsers.filter(([, p]) => existsSync(p)).map(([n]) => n);
if (present.length) ok("a Chromium browser is installed", [...new Set(present)].join(", "));
else bad("no Chromium browser found", "install Chrome or Edge");

// ── 7 · per-machine state the repo cannot carry ────────────────────────────
head("Things that live on your machine, not in the repo");
console.log(`  ${D}These are per-laptop by design, and are the usual reason one person sees${X}`);
console.log(`  ${D}a feature and another does not:${X}\n`);
console.log(`  ${B}My data (the vault)${X}`);
console.log(`  ${D}  Encrypted with a passphrase you choose, stored only on your device, and${X}`);
console.log(`  ${D}  never in git. Until you open the side panel, expand ${X}My data${D} and create${X}`);
console.log(`  ${D}  one, "fill this form from my profile" has nothing to fill from and will${X}`);
console.log(`  ${D}  appear to do nothing. Each teammate must set up their own.${X}\n`);
console.log(`  ${B}Saved drafts${X}`);
console.log(`  ${D}  The demo pages use localStorage, so a draft saved on one machine is not${X}`);
console.log(`  ${D}  on another. That is the point of the feature, not a fault.${X}`);

// ── verdict ────────────────────────────────────────────────────────────────
console.log("");
if (broken === 0) {
  console.log(`  ${G}${B}Nothing is broken.${X} ${warned ? `${warned} optional thing(s) noted above.` : ""}`);
  console.log(`  ${D}If a feature still looks missing, it is almost certainly the vault or a${X}`);
  console.log(`  ${D}stale extension — reload it in chrome://extensions and check the build stamp.${X}\n`);
} else {
  console.log(`  ${R}${B}${broken} thing(s) need fixing.${X} Work top to bottom; later checks often`);
  console.log(`  depend on earlier ones.\n`);
  process.exitCode = 1;
}

