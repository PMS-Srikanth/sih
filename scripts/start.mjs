/**
 * Starts everything Cordon needs and keeps it running.
 *
 *   npm start
 *
 * `npm run setup` builds the project but leaves you to start two servers in two
 * more terminals. That last step is where people were falling over: with nothing
 * listening on 8788, the demo page simply fails to load and the failure looks
 * like the project is broken rather than like a server that was never started.
 *
 * So this runs both, waits until each actually answers, prints the URLs, and
 * stays in the foreground until Ctrl+C. If a port is already taken it works out
 * whether the thing holding it is ours — in which case it just uses it — or
 * something else, which it names instead of dying with EADDRINUSE.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const G = "\x1b[32m", R = "\x1b[31m", Y = "\x1b[33m", D = "\x1b[2m", B = "\x1b[1m", X = "\x1b[0m";
const C_AGENT = "\x1b[36m", C_DEMO = "\x1b[35m";

const AGENT_PORT = Number(process.env.PORT ?? 8787);
const DEMO_PORT = 8788;
const DIST = path.resolve("dist");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probe(url, ms = 800) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), ms);
    const r = await fetch(url, { signal: c.signal });
    clearTimeout(t);
    return r.ok ? r : null;
  } catch {
    return null;
  }
}

/** Is this port held by our own server, someone else's, or free? */
async function inspect(port, url, marker) {
  const r = await probe(url);
  if (!r) return "free";
  const body = await r.text().catch(() => "");
  return body.includes(marker) ? "ours" : "foreign";
}

console.log(`\n${B}  Cordon${X}  ${D}starting the agent server and the demo pages${X}\n`);

// A missing build is the other way the page "fails to load" — Chrome has
// nothing to load either. Say so before starting anything.
if (!existsSync(path.join(DIST, "manifest.json"))) {
  console.log(`  ${R}dist/ has not been built.${X}`);
  console.log(`  ${B}run:${X} npm run setup\n`);
  process.exit(1);
}

const children = [];

async function bring(name, colour, args, port, healthUrl, marker, env = {}) {
  const state = await inspect(port, healthUrl, marker);

  if (state === "ours") {
    console.log(`  ${Y}note${X}  ${name} is already running on ${port} — using it`);
    return true;
  }
  if (state === "foreign") {
    console.log(`  ${R}FAIL${X}  port ${port} is held by something that is not ${name}`);
    console.log(`        Close whatever is using it, or free the port, then run npm start again.`);
    return false;
  }

  const child = spawn(process.execPath, args, {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);

  const relay = (stream, isErr) => {
    let buf = "";
    stream.on("data", (chunk) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const l of lines) {
        if (!l.trim()) continue;
        console.log(`  ${colour}${name.padEnd(6)}${X} ${isErr ? R : ""}${l.trim()}${X}`);
      }
    });
  };
  relay(child.stdout, false);
  relay(child.stderr, true);

  child.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      console.log(`  ${R}${name} exited with code ${code}${X}`);
    }
  });

  for (let i = 0; i < 60; i++) {
    if (await probe(healthUrl)) return true;
    await sleep(150);
  }
  console.log(`  ${R}FAIL${X}  ${name} did not start listening on ${port}`);
  return false;
}

const agentOk = await bring(
  "agent",
  C_AGENT,
  ["server/index.mjs"],
  AGENT_PORT,
  `http://127.0.0.1:${AGENT_PORT}/health`,
  "cordon/redaction",
  { PORT: String(AGENT_PORT) },
);

const demoOk = await bring(
  "pages",
  C_DEMO,
  ["demo-pages/serve.mjs"],
  DEMO_PORT,
  `http://127.0.0.1:${DEMO_PORT}/job-form.html`,
  // Something specific to our own page. "<" would match any HTML server that
  // happened to hold the port, and we would then silently use it.
  "Candidate registration",
);

if (!agentOk || !demoOk) {
  for (const c of children) c.kill();
  console.log("");
  process.exit(1);
}

console.log(`\n  ${G}Both servers are up.${X}\n`);
console.log(`  ${B}Open${X}  http://127.0.0.1:${DEMO_PORT}/`);
console.log(`  ${D}        application.html · job-form.html · login.html${X}`);
console.log(`  ${D}        report.html — the evaluation metrics, rendered${X}\n`);
console.log(`  ${B}Load${X}  chrome://extensions → Developer mode → Load unpacked → ${DIST}`);
console.log(`  ${D}        then open the side panel and create your vault under My data${X}\n`);
console.log(`  ${D}Leave this terminal open. Ctrl+C stops both servers.${X}\n`);

// Take the children with us, however this process ends.
const shutdown = () => {
  console.log(`\n  ${D}stopping…${X}\n`);
  for (const c of children) c.kill();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.stdin.resume();
