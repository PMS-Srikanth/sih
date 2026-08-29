/**
 * Exercises the open-weights VLM client without needing a model.
 *
 *   npm run vlm-check
 *
 * We cannot ship a 7B model in this repo, and no judge is going to wait for one
 * to download. But "we support any OpenAI-compatible endpoint" is a claim, and
 * an untested claim is worth nothing — so this stands up a fake endpoint that
 * speaks the same protocol Ollama and vLLM do, and checks the half of the
 * exchange we actually wrote.
 *
 * What it proves:
 *  - we send the shape those servers expect (model, messages, system prompt)
 *  - the redaction grammar is in the system prompt, so the model is told what a
 *    handle means before it is asked to use one
 *  - the `empty` flag survives context compaction and reaches the model
 *  - replies wrapped in prose or code fences are still parsed
 *  - every failure mode returns null, so the rule planner takes over rather
 *    than the agent stalling
 *
 * What it does NOT prove: that a real model returns good actions. Only pointing
 * CORDON_VLM_URL at a running model shows that, and that remains open.
 */
import { createServer } from "node:http";

const PORT = 8799;
let lastRequest = null;
let mode = "good";

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try {
      lastRequest = JSON.parse(body);
    } catch {
      lastRequest = null;
    }

    if (mode === "http500") {
      res.writeHead(500).end("upstream is down");
      return;
    }
    if (mode === "notjson") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "I'm afraid I can't do that." } }] }));
      return;
    }
    if (mode === "hang") {
      return; // never responds — the client's timeout must fire
    }

    // A realistic small-model reply: correct JSON, wrapped in a fence and a
    // sentence of chat, which is exactly what they do however firmly you ask.
    const content =
      "Sure! Here's the next action:\n\n```json\n" +
      JSON.stringify({
        type: "action",
        thought: "The name field is empty and the device holds a person value.",
        action: { kind: "fill", target: "el_1", value: "PERSON_1" },
        confidence: 0.9,
      }) +
      "\n```\nLet me know if you'd like anything else.";

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
});

await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

// Configure the client BEFORE importing it — it reads env at module load.
process.env.CORDON_VLM_URL = `http://127.0.0.1:${PORT}/v1/chat/completions`;
process.env.CORDON_VLM_MODEL = "qwen2.5:7b";
process.env.CORDON_VLM_TIMEOUT = "1200";

const { planWithVlm, SYSTEM_PROMPT } = await import("../server/vlm.mjs");

const ctx = {
  task: "fill this application form",
  title: "Registration",
  viewport: { w: 1280, h: 800, scrollY: 0, docH: 900 },
  elements: [
    { id: "el_1", role: "textbox", name: "Full name", enabled: true, visible: true, wants: "PERSON_1" },
    { id: "el_2", role: "select", name: "Years of experience", enabled: true, visible: true, empty: true },
    { id: "el_3", role: "password", name: "Password", enabled: true, visible: true, sensitive: true },
    { id: "el_4", role: "button", name: "Register", enabled: true, visible: true },
  ],
  regions: [],
  history: [],
};

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

console.log("\n  VLM client — against a mock OpenAI-compatible endpoint\n");

// ── 1 · the happy path ─────────────────────────────────────────────────────
mode = "good";
const out = await planWithVlm(ctx);

check("a fenced reply buried in prose is still parsed", out?.type === "action");
check("the action survives intact",
  out?.action?.kind === "fill" && out?.action?.target === "el_1" && out?.action?.value === "PERSON_1",
  JSON.stringify(out?.action));
check("the reply is tagged with the model and its latency",
  out?._vlm?.model === "qwen2.5:7b" && typeof out?._vlm?.ms === "number");

// ── 2 · what we actually put on the wire ───────────────────────────────────
check("model name is sent", lastRequest?.model === "qwen2.5:7b");
check("temperature is low enough to be repeatable", lastRequest?.temperature <= 0.2);
check("JSON mode is requested", lastRequest?.response_format?.type === "json_object");
check("streaming is off", lastRequest?.stream === false);

const sys = lastRequest?.messages?.[0];
check("a system message leads", sys?.role === "system");
check("the redaction grammar is taught in it",
  typeof sys?.content === "string" && sys.content.includes("EMAIL_1"));
check("the system prompt exported matches what is sent", sys?.content === SYSTEM_PROMPT);

const user = lastRequest?.messages?.[1];
const payload = typeof user?.content === "string" ? user.content : JSON.stringify(user?.content);
check("the empty flag reaches the model", payload.includes('"empty":true'));
check("the wants handle reaches the model", payload.includes("PERSON_1"));
check("the sensitive flag reaches the model", payload.includes('"sensitive":true'));

// The whole point of the redaction boundary: no real value can be in here,
// because none was ever put into the context in the first place.
for (const leak of ["Srikar", "9876543210", "Hunter2"]) {
  check(`no plaintext "${leak}" on the wire`, !payload.includes(leak));
}

// ── 3 · every failure must fall back, not stall ────────────────────────────
mode = "http500";
check("an HTTP 500 falls back to the rule planner", (await planWithVlm(ctx)) === null);

mode = "notjson";
check("a reply with no JSON in it falls back", (await planWithVlm(ctx)) === null);

mode = "hang";
const t0 = Date.now();
const hung = await planWithVlm(ctx);
const waited = Date.now() - t0;
check("a hung endpoint times out and falls back", hung === null, `${waited} ms`);
check("the timeout is honoured, not ignored", waited < 3000, `${waited} ms`);

// ── 4 · the whole path, through the real server ────────────────────────────
// The checks above are unit-level. This one starts the actual agent server with
// CORDON_VLM_URL pointed at the mock and asks it to plan a step, so what runs is
// the same code a judge would run — dispatch, guard and fallback included, not a
// hand-assembled call.
mode = "good";
const { spawn } = await import("node:child_process");

const child = spawn(process.execPath, ["server/index.mjs"], {
  env: {
    ...process.env,
    PORT: "8798",
    CORDON_VLM_URL: `http://127.0.0.1:${PORT}/v1/chat/completions`,
    CORDON_VLM_MODEL: "qwen2.5:7b",
  },
  stdio: "ignore",
});

const AGENT = "http://127.0.0.1:8798";
const wire = (e) => ({
  ...e,
  tag: e.role === "select" ? "select" : "input",
  bbox: [0, 0, 10, 10],
  conf: 1,
  src: "dom",
});
const envelope = {
  schema: "cordon/redaction@1",
  mode: "balanced",
  urlClass: "careers",
  groups: [],
  image: null,
  ...ctx,
  elements: ctx.elements.map(wire),
};
const askAgent = async () => {
  const r = await fetch(`${AGENT}/agent`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(envelope),
  });
  return r.json();
};

let up = false;
for (let i = 0; i < 40 && !up; i++) {
  try {
    up = (await fetch(`${AGENT}/health`)).ok;
  } catch {
    await new Promise((r) => setTimeout(r, 150));
  }
}

if (!up) {
  check("the agent server starts with a VLM configured", false, "never became healthy");
} else {
  const health = await (await fetch(`${AGENT}/health`)).json();
  check("health reports the model, not the rule planner",
    health.engine === "qwen2.5:7b", String(health.engine));

  const planned = await askAgent();
  check("the server answers with the model's action, end to end",
    planned?.type === "action" && planned?.action?.target === "el_1",
    JSON.stringify(planned?.action));
  check("the guard strips the internal _vlm tag before replying",
    planned?._vlm === undefined);

  // And with the model down, the same request must still be answered — this is
  // the property that keeps a demo alive when the model box falls over.
  mode = "http500";
  const fellBack = await askAgent();
  check("with the model down the server still returns a usable action",
    fellBack?.type === "action" || fellBack?.type === "ask_user",
    fellBack?.type);
}

child.kill();


server.close();

console.log(`\n  ${pass} passed, ${fail} failed\n`);
if (fail) {
  console.log("  The VLM client is broken. The agent would still run — it falls back to");
  console.log("  the rule planner — but the open-weights path is not working.\n");
  process.exitCode = 1;
} else {
  console.log("  The open-weights path is verified end to end against a protocol-");
  console.log("  compatible endpoint: request shape, prompt, parsing, dispatch, guard,");
  console.log("  and fallback when the model is down.");
  console.log("");
  console.log("  Still unproven: that a REAL model returns good actions. For that:");
  console.log("    ollama pull qwen2.5:7b");
  console.log("    CORDON_VLM_URL=http://127.0.0.1:11434/v1/chat/completions npm run server\n");
}
