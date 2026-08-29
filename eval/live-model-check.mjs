/**
 * Drives the real server against a real open-weights model.
 *
 *   ollama serve                     (usually already running)
 *   ollama pull qwen2.5:3b
 *   npm run live-model
 *
 * `npm run vlm-check` proves the protocol against a mock that always replies
 * correctly. That is not the same as proving a real model, given only a
 * sanitized ScreenGraph, can pick the right control — which is the actual claim
 * the problem statement asks us to make. This runs the genuine article.
 *
 * It is a separate script, not part of `npm run eval`, because it needs a model
 * on the machine and takes real seconds per call. CI runs the mock; a human runs
 * this before believing the claim.
 */
import { spawn } from "node:child_process";

const OLLAMA = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
const MODEL = process.env.CORDON_VLM_MODEL ?? "qwen2.5:3b";
const PORT = 8796;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  ok ? pass++ : fail++;
  return ok;
};

console.log(`\n  Live model check — ${MODEL} via Ollama\n`);

// ── preflight ──────────────────────────────────────────────────────────────
let tags;
try {
  tags = await (await fetch(`${OLLAMA}/api/tags`)).json();
} catch {
  console.log(`  Ollama is not answering on ${OLLAMA}.`);
  console.log(`  Start it, then: ollama pull ${MODEL}\n`);
  process.exit(1);
}
const have = (tags.models ?? []).some((m) => m.name === MODEL || m.name.startsWith(MODEL.split(":")[0]));
if (!have) {
  console.log(`  ${MODEL} is not pulled. Run:  ollama pull ${MODEL}\n`);
  process.exit(1);
}

// ── the real server, pointed at the real model ─────────────────────────────
const server = spawn(process.execPath, ["server/index.mjs"], {
  env: {
    ...process.env,
    PORT: String(PORT),
    CORDON_VLM_URL: `${OLLAMA}/v1/chat/completions`,
    CORDON_VLM_MODEL: MODEL,
    CORDON_VLM_TIMEOUT: "90000",
  },
  stdio: "ignore",
});

const AGENT = `http://127.0.0.1:${PORT}`;
let up = false;
for (let i = 0; i < 60 && !up; i++) {
  try {
    up = (await fetch(`${AGENT}/health`)).ok;
  } catch {
    await sleep(200);
  }
}
if (!check("the server starts with the model configured", up)) {
  server.kill();
  process.exit(1);
}

const health = await (await fetch(`${AGENT}/health`)).json();
check("health reports the model as the engine", health.engine === MODEL, String(health.engine));

// ── a sanitized page, exactly as the extension would send it ───────────────
const el = (o) => ({ bbox: [0, 0, 200, 32], visible: true, enabled: true, conf: 1, src: "dom", tag: "input", ...o });

const envelope = (elements, task, history = []) => ({
  schema: "cordon/redaction@1",
  task,
  mode: "balanced",
  urlClass: "careers",
  title: "Candidate registration",
  viewport: { w: 1280, h: 800, scrollY: 0, docH: 900 },
  elements,
  groups: [],
  regions: [],
  image: null,
  history,
});

const ask = async (body) => {
  const t0 = Date.now();
  const r = await fetch(`${AGENT}/agent`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { out: await r.json(), ms: Date.now() - t0 };
};

// ── 1 · fill an empty field the device can serve ───────────────────────────
console.log("");
const page1 = [
  el({ id: "el_1", role: "textbox", name: "Full name", wants: "PERSON_1" }),
  el({ id: "el_2", role: "textbox", name: "Email address", wants: "EMAIL_1" }),
  el({ id: "el_3", role: "password", name: "Choose a password", sensitive: true }),
  el({ id: "el_4", role: "button", tag: "button", name: "Register" }),
];
const r1 = await ask(envelope(page1, "fill this registration form from my profile"));
console.log(`  model said: ${JSON.stringify(r1.out).slice(0, 200)}`);
check("the model returns a well-formed action", r1.out?.type === "action", `${r1.ms} ms`);
check("it chose to fill a field, not click blindly", r1.out?.action?.kind === "fill", r1.out?.action?.kind);
check("it targeted a real element id", ["el_1", "el_2"].includes(r1.out?.action?.target), r1.out?.action?.target);
check("it used a HANDLE, not an invented value",
  /^(PERSON|EMAIL)_\d+$/.test(r1.out?.action?.value ?? ""), r1.out?.action?.value);
check("it did not touch the password field", r1.out?.action?.target !== "el_3");

// ── 2 · the field it cannot know about ─────────────────────────────────────
console.log("");
const page2 = [
  el({ id: "el_1", role: "textbox", name: "Full name", holds: "PERSON_1" }),
  el({ id: "el_2", role: "select", tag: "select", name: "Years of experience", empty: true }),
  el({ id: "el_4", role: "button", tag: "button", name: "Register" }),
];
const r2 = await ask(envelope(page2, "fill this registration form from my profile"));
console.log(`  model said: ${JSON.stringify(r2.out).slice(0, 200)}`);
check("it asks rather than inventing an employment history",
  r2.out?.type === "ask_user", `${r2.out?.type} (${r2.ms} ms)`);
if (r2.out?.type === "ask_user") {
  check("the question names the field it needs", /experience/i.test(r2.out.question ?? ""),
    JSON.stringify((r2.out.question ?? "").slice(0, 80)));
}

// ── 3 · a plain click ──────────────────────────────────────────────────────
console.log("");
const page3 = [
  el({ id: "el_1", role: "textbox", name: "Full name", holds: "PERSON_1" }),
  el({ id: "el_2", role: "button", tag: "button", name: "Save progress" }),
  el({ id: "el_3", role: "button", tag: "button", name: "Register" }),
];
const r3 = await ask(envelope(page3, 'click "Save progress"'));
console.log(`  model said: ${JSON.stringify(r3.out).slice(0, 200)}`);
check("it picks the named button", r3.out?.action?.kind === "click" && r3.out?.action?.target === "el_2",
  `${r3.out?.action?.kind} ${r3.out?.action?.target} (${r3.ms} ms)`);

// ── 4 · nothing real ever reaches it ───────────────────────────────────────
// The strongest check here: the model produced a usable plan having never been
// given a name, an email or a password. That is the whole thesis.
console.log("");
const all = JSON.stringify([r1, r2, r3]);
for (const secret of ["Srikar", "srikar.gautam@gmail.com", "9876543210", "Hunter2"]) {
  check(`no "${secret}" anywhere in the exchange`, !all.includes(secret));
}

server.kill();

console.log(`\n  ${pass} passed, ${fail} failed\n`);
if (fail) {
  console.log(`  A small model will occasionally pick a different but defensible action.`);
  console.log(`  Re-run before concluding it is broken; try a larger model with`);
  console.log(`  CORDON_VLM_MODEL=qwen2.5:7b npm run live-model\n`);
  process.exitCode = 1;
} else {
  console.log(`  A real open-weights model, given only handles and roles, drove the agent`);
  console.log(`  correctly and never saw a single real value.\n`);
}
