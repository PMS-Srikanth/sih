/**
 * Fetches the large on-device model that is too big to keep in git.
 *
 *   npm run fetch-models
 *
 * UltraFace (1.2 MB) is committed, because the extension is useless without it.
 * The ViT classifier (84 MB) is not — it is only used in Thorough mode, and the
 * offscreen document degrades to the detector alone when it is absent. So a
 * fresh clone works immediately, and this is a one-off extra for teams that
 * want the ViT running.
 *
 * Once fetched, nothing downloads at runtime: Transformers.js is pinned to the
 * local path with allowRemoteModels = false.
 */
import { mkdir, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const REPO = "Xenova/vit-base-patch16-224";
const BASE = `https://huggingface.co/${REPO}/resolve/main`;
const DEST = path.resolve("extension/public/models/vit-base-patch16-224");

const FILES = [
  { rel: "config.json", min: 1_000 },
  { rel: "preprocessor_config.json", min: 100 },
  { rel: "onnx/model_quantized.onnx", min: 10_000_000 },
];

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

async function fetchOne({ rel, min }) {
  const out = path.join(DEST, rel);
  if (existsSync(out)) {
    const { size } = await stat(out);
    if (size >= min) {
      console.log(`  have   ${rel.padEnd(28)} ${mb(size)}`);
      return true;
    }
    console.log(`  redo   ${rel} — only ${mb(size)}, expected at least ${mb(min)}`);
  }

  await mkdir(path.dirname(out), { recursive: true });
  process.stdout.write(`  fetch  ${rel.padEnd(28)} `);

  const res = await fetch(`${BASE}/${rel}`, { redirect: "follow" });
  if (!res.ok) {
    console.log(`FAILED — ${res.status} ${res.statusText}`);
    return false;
  }
  const buf = Buffer.from(await res.arrayBuffer());

  // A proxy or login wall returns an HTML page with a 200. Catch that here
  // rather than at runtime when the model fails to parse.
  if (buf.length < min || buf.subarray(0, 200).toString("utf8").trimStart().startsWith("<")) {
    console.log(`FAILED — got ${mb(buf.length)}, looks like an error page`);
    return false;
  }

  await writeFile(out, buf);
  console.log(mb(buf.length));
  return true;
}

console.log(`\n  Cordon — fetching the ViT classifier from ${REPO}\n`);
let ok = true;
for (const f of FILES) ok = (await fetchOne(f)) && ok;

if (ok) {
  console.log(`\n  Done. Run  npm run build  to bundle it into dist/.`);
  console.log(`  Thorough mode will now use the ViT; Fast and Balanced are unchanged.\n`);
} else {
  console.log(`\n  Some files did not download.`);
  console.log(`  The extension still works — Thorough mode simply falls back to`);
  console.log(`  the UltraFace detector alone. Re-run this when you have a connection.\n`);
  process.exitCode = 1;
}
