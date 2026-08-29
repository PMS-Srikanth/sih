/** Static file server for the demo pages — `npm run demo`. No dependencies. */
import { createServer } from "node:http";
import { readFile, readdir, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { extname, join, normalize } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const PORT = Number(process.env.PORT ?? 8788);
const ROOT = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let path = decodeURIComponent(url.pathname);

  if (path === "/") {
    const files = (await readdir(ROOT)).filter((f) => f.endsWith(".html"));
    const list = files.map((f) => `<li><a href="/${f}">${f.replace(".html", "")}</a></li>`).join("");
    return void html(res, 200, `<!doctype html><meta charset="utf-8"><title>Cordon demo pages</title>
      <style>body{background:#0e1214;color:#e6eced;font:15px/1.6 "Segoe UI",system-ui,sans-serif;padding:48px}
      a{color:#4cc5d0}h1{font-size:20px}li{margin:6px 0}</style>
      <h1>Cordon demo pages</h1><ul>${list}</ul>`);
  }

  // The evaluation report is generated, not authored. Serving a committed copy
  // meant it could show numbers and a timestamp from whenever it was last built
  // — which is worse than no report, because it looks current. Rebuild it here
  // whenever the results it is derived from are newer than it is.
  if (path === "/report.html") await refreshReport();

  const file = join(ROOT, normalize(path).replace(/^(\.\.[/\\])+/, ""));
  try {
    const buf = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(buf);
  } catch {
    if (path === "/report.html") {
      return void html(res, 404, `<!doctype html><meta charset="utf-8"><title>No report yet</title>
        <style>body{background:#0e1214;color:#e6eced;font:15px/1.6 "Segoe UI",system-ui,sans-serif;padding:48px;max-width:44rem}
        code{background:#1d2528;padding:3px 7px;border-radius:5px;font-family:ui-monospace,Consolas,monospace}
        h1{font-size:20px}a{color:#4cc5d0}</style>
        <h1>No evaluation report yet</h1>
        <p>The report is generated from a real run, never committed, so it cannot go stale.
        Build it with:</p>
        <p><code>npm run eval &amp;&amp; npm run report</code></p>
        <p>Or just <code>npm run setup</code>, which does both.
        <a href="/">Back to the demo pages</a></p>`);
    }
    html(res, 404, "<h1>404</h1>");
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`\n  cordon demo pages  →  http://127.0.0.1:${PORT}/\n`);
});

const REPORT = join(ROOT, "report.html");
const RESULTS = join(ROOT, "..", "eval_output.json");
const BUILDER = join(ROOT, "..", "scripts", "build-report.mjs");

async function mtime(f) {
  try {
    return (await stat(f)).mtimeMs;
  } catch {
    return 0;
  }
}

async function refreshReport() {
  const [report, results, builder] = await Promise.all([
    mtime(REPORT),
    mtime(RESULTS),
    mtime(BUILDER),
  ]);
  if (!results) return; // no eval has been run; the 404 page explains what to do
  if (report && report >= results && report >= builder) return; // already current

  try {
    await run(process.execPath, [BUILDER], { cwd: join(ROOT, "..") });
    console.log("  report regenerated from the latest evaluation");
  } catch (e) {
    console.log(`  could not regenerate the report: ${e.message.split("\n")[0]}`);
  }
}

function html(res, code, body) {
  res.writeHead(code, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
}
