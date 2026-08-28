/** Static file server for the demo pages — `npm run demo`. No dependencies. */
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

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

  const file = join(ROOT, normalize(path).replace(/^(\.\.[/\\])+/, ""));
  try {
    const buf = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(buf);
  } catch {
    html(res, 404, "<h1>404</h1>");
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`\n  cordon demo pages  →  http://127.0.0.1:${PORT}/\n`);
});

function html(res, code, body) {
  res.writeHead(code, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
}
