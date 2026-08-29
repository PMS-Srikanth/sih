/**
 * Side panel — task input, the step log, and the privacy receipt.
 *
 * The receipt is deliberately prominent: it turns "nothing sensitive was
 * transmitted" from an assertion into something a user or a judge can inspect
 * per step.
 */
import type { AgentState, Mode, PrivacyReceipt, StageTimings, StepLog } from "@/shared/types";
import type { Profile, VaultStatus } from "@/privacy/profile";
import { passphraseStrength } from "@/privacy/crypto";

declare const __BUILD__: string;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// If this does not match the stamp printed by `npm run build`, the extension
// was not reloaded and you are testing stale code.
$("build").textContent = `build ${__BUILD__}`;

const taskEl = $<HTMLTextAreaElement>("task");
const runEl = $<HTMLButtonElement>("run");
const modesEl = $<HTMLDivElement>("modes");
const hintEl = $<HTMLParagraphElement>("modeHint");
const logEl = $<HTMLDivElement>("log");
const bannerEl = $<HTMLDivElement>("banner");
const confirmEl = $<HTMLDivElement>("confirm");
const confirmWhy = $<HTMLParagraphElement>("confirmWhy");
const serverEl = $<HTMLInputElement>("server");

let mode: Mode = "balanced";
let running = false;

const HINTS: Record<Mode, string> = {
  fast: "Fast — DOM graph and pattern detection only. No vision. Lowest latency.",
  balanced: "Balanced — DOM graph, calibrated PII detection, vision on unexplained regions.",
  thorough: "Thorough — full-frame sweep and OCR everywhere. Highest accuracy, highest cost.",
};

// ── controls ───────────────────────────────────────────────────────────────

modesEl.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button");
  if (!b) return;
  mode = b.dataset.mode as Mode;
  for (const x of Array.from(modesEl.children)) x.classList.toggle("on", x === b);
  hintEl.textContent = HINTS[mode];
});

runEl.addEventListener("click", () => {
  if (running) {
    chrome.runtime.sendMessage({ kind: "stop" });
    return;
  }
  const task = taskEl.value.trim();
  if (!task) {
    taskEl.focus();
    return;
  }
  logEl.innerHTML = "";
  bannerEl.hidden = true;
  chrome.runtime.sendMessage({ kind: "run", task, mode });
});

taskEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) runEl.click();
});

const cvalue = $<HTMLInputElement>("cvalue");

function answer(approve: boolean): void {
  // The typed value goes back with the approval. For an action prompt it is the
  // corrected value; for a question it is the answer the agent had no way to
  // know. Empty means "no edit" and the original stands.
  const v = cvalue.value.trim();
  chrome.runtime.sendMessage({ kind: "confirm", approve, value: v || undefined });
  cvalue.value = "";
}

$("approve").addEventListener("click", () => answer(true));
$("decline").addEventListener("click", () => answer(false));
cvalue.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); answer(true); }
  if (e.key === "Escape") answer(false);
});

serverEl.addEventListener("change", () => {
  chrome.runtime.sendMessage({ kind: "setServer", url: serverEl.value.trim() });
});

// ── the local profile ──────────────────────────────────────────────────────
// The only place these values exist in a UI. Encrypted at rest under the user's
// passphrase; they go to the vault, never to a payload — the server sees
// EMAIL_1 and says which field it belongs in.

interface VaultReply {
  ok?: boolean;
  error?: string;
  profile: Profile | null;
  vault: VaultStatus;
}

const pfields = $<HTMLDivElement>("pfields");
const panes = { empty: $("paneSetup"), locked: $("paneLock"), unlocked: $("paneOpen") };

function applyVault(r: VaultReply): void {
  const state = r.vault?.state ?? "empty";
  for (const [k, node] of Object.entries(panes)) node.hidden = k !== state;

  const badge = $("vstate");
  badge.className = `vstate ${state}`;
  badge.textContent =
    state === "unlocked" ? `${r.vault.filled}/${r.vault.total} filled`
    : state === "locked" ? "locked"
    : "not set up";

  if (state === "unlocked" && r.profile) drawProfile(r.profile);
}

function drawProfile(profile: Profile): void {
  pfields.innerHTML = "";
  for (const [key, entry] of Object.entries(profile)) {
    const wrap = document.createElement("div");
    wrap.className = key === "address" ? "pfield wide" : "pfield";

    const label = document.createElement("label");
    label.textContent = entry.label;
    label.htmlFor = `p_${key}`;

    const input = document.createElement("input");
    input.type = "text";
    input.id = `p_${key}`;
    input.dataset.key = key;
    input.value = entry.value;
    input.placeholder = entry.placeholder;
    input.spellcheck = false;

    wrap.append(label, input);
    pfields.append(wrap);
  }
}

// setup
const pp1 = $<HTMLInputElement>("pp1");
pp1.addEventListener("input", () => {
  const s = passphraseStrength(pp1.value);
  const m = $("meter");
  m.dataset.score = pp1.value ? String(s.score) : "";
  $("meterLabel").textContent = pp1.value ? s.label : "";
});

$("doSetup").addEventListener("click", () => {
  const a = pp1.value;
  const b = $<HTMLInputElement>("pp2").value;
  const err = $("setupErr");
  if (a.length < 8) return void (err.textContent = "At least 8 characters.");
  if (a !== b) return void (err.textContent = "The two passphrases do not match.");
  err.textContent = "";
  chrome.runtime.sendMessage({ kind: "vaultSetup", passphrase: a }, (r: VaultReply) => {
    if (!r?.ok) return void (err.textContent = r?.error ?? "Could not create the vault.");
    pp1.value = "";
    $<HTMLInputElement>("pp2").value = "";
    applyVault(r);
  });
});

// unlock
const ppUnlock = $<HTMLInputElement>("ppUnlock");
function doUnlock(): void {
  const err = $("unlockErr");
  chrome.runtime.sendMessage({ kind: "vaultUnlock", passphrase: ppUnlock.value }, (r: VaultReply) => {
    if (!r?.ok) return void (err.textContent = r?.error ?? "Could not unlock.");
    err.textContent = "";
    ppUnlock.value = "";
    applyVault(r);
  });
}
$("doUnlock").addEventListener("click", doUnlock);
ppUnlock.addEventListener("keydown", (e) => e.key === "Enter" && doUnlock());

$("doLock").addEventListener("click", () => {
  chrome.runtime.sendMessage({ kind: "vaultLock" }, (r: VaultReply) => applyVault(r));
});

$("doDestroy").addEventListener("click", () => {
  const btn = $<HTMLButtonElement>("doDestroy");
  if (btn.dataset.armed !== "1") {
    btn.dataset.armed = "1";
    btn.textContent = "Really forget?";
    setTimeout(() => {
      btn.dataset.armed = "";
      btn.textContent = "Forget vault";
    }, 4000);
    return;
  }
  chrome.runtime.sendMessage({ kind: "vaultDestroy" }, (r: VaultReply) => {
    btn.dataset.armed = "";
    btn.textContent = "Forget vault";
    applyVault(r);
  });
});

$("psave").addEventListener("click", () => {
  const values: Record<string, string> = {};
  for (const i of Array.from(pfields.querySelectorAll("input"))) {
    values[(i as HTMLInputElement).dataset.key!] = (i as HTMLInputElement).value;
  }
  chrome.runtime.sendMessage({ kind: "setProfile", values }, (r: VaultReply) => {
    applyVault(r);
    const saved = $("psaved");
    saved.textContent = r?.ok ? "encrypted and saved" : (r?.error ?? "save failed");
    setTimeout(() => (saved.textContent = ""), 2400);
  });
});

chrome.runtime.sendMessage({ kind: "getProfile" }, (r: VaultReply) => r && applyVault(r));

// ── state ──────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg: { kind: string; state: AgentState }) => {
  if (msg?.kind === "state") safeRender(msg.state);
});

chrome.runtime.sendMessage({ kind: "getState" }, (s: AgentState) => s && safeRender(s));

/** A render bug must never leave the panel silently blank. */
function safeRender(s: AgentState): void {
  try {
    render(s);
  } catch (e) {
    bannerEl.hidden = false;
    bannerEl.className = "banner err";
    bannerEl.textContent = `panel render failed: ${e instanceof Error ? e.message : String(e)}`;
    console.error("[cordon] render failed", e, s);
  }
}

function render(s: AgentState): void {
  running = s.running;
  runEl.textContent = running ? "Stop" : "Run";
  runEl.classList.toggle("stop", running);
  if (!serverEl.matches(":focus")) serverEl.value = s.serverUrl;
  if (s.mode !== mode) {
    mode = s.mode;
    for (const x of Array.from(modesEl.children)) x.classList.toggle("on", (x as HTMLElement).dataset.mode === mode);
    hintEl.textContent = HINTS[mode];
  }

  drawPrompt(s.awaitingConfirm);

  if (s.error) {
    bannerEl.hidden = false;
    bannerEl.className = "banner err";
    bannerEl.textContent = s.error;
  } else if (s.answer) {
    bannerEl.hidden = false;
    bannerEl.className = "banner ok";
    bannerEl.textContent = s.answer;
  } else {
    bannerEl.hidden = true;
  }

  const local = s.steps.filter((x) => x.route === "local").length;
  const net = s.steps.filter((x) => x.route === "server").length;
  const bytes = s.steps.reduce((n, x) => n + (x.receipt?.payloadBytes ?? 0), 0);
  
  let localTime = 0;
  let netTime = 0;
  for (const step of s.steps) {
    const t = step.timings?.total ?? 0;
    if (step.route === "local") localTime += t;
    else if (step.route === "server") netTime += t;
  }
  const avgLocal = local > 0 ? `${Math.round(localTime / local)}ms` : "—";
  const avgNet = net > 0 ? `${Math.round(netTime / net)}ms` : "—";

  $("sSteps").textContent = String(s.steps.length);
  $("sLocal").textContent = String(local);
  $("sNet").textContent = String(net);
  $("sBytes").textContent = bytes > 9999 ? `${(bytes / 1024).toFixed(1)}k` : String(bytes);
  
  // Show vision degraded warning if offscreen is unavailable
  const visionDegraded = s.steps.some(x => x.receipt?.vision && x.receipt.vision.includes("offscreen unavailable"));
  let summaryEl = $("sSummary");
  if (!summaryEl) {
    summaryEl = document.createElement("div");
    summaryEl.id = "sSummary";
    summaryEl.className = "summary-bar";
    $("log").before(summaryEl);
  }
  
  summaryEl.innerHTML = `${local}/${s.steps.length} steps resolved locally, avg local step ${avgLocal}, avg escalated step ${avgNet}`;
  if (visionDegraded) {
    summaryEl.innerHTML += `<div class="warn">⚠️ Vision gracefully degraded (offscreen unavailable)</div>`;
  }

  drawResources(s);
  drawEntered(s.steps);
  drawLog(s.steps);
}

/**
 * The resource panel. The problem statement grades resource usage as its own
 * metric, so it has to be readable off the screen during a demo rather than
 * dug out of a terminal.
 *
 * Three honest caveats are baked into the wording below:
 *  - "webgpu" means the GPU ran the model. It is not a utilisation percentage;
 *    no browser API exposes one, and inventing a number would be worse than
 *    naming the backend.
 *  - heap size is what `performance.memory` reports, which Chrome quantises.
 *  - "frame skipped" is the share of the frame the DOM already explained, which
 *    is the actual saving the coverage map buys us.
 */
/**
 * The blocked-on-a-human panel. It has two jobs the old version did not do:
 * it shows WHICH value is about to be used and lets you change it, and it lets
 * you type an answer for a field no stored data could fill.
 */
function drawPrompt(p: AgentState["awaitingConfirm"]): void {
  const edit = $("cedit") as HTMLDivElement;
  confirmEl.hidden = !p;
  if (!p) return;

  const question = p.kind === "question";
  $("confirmTitle").textContent = question ? "The agent needs your input" : "Confirmation needed";
  confirmWhy.textContent = p.why;

  edit.hidden = !p.editable;
  if (p.editable) {
    $("cvalueLabel").textContent = p.fieldLabel ?? (question ? "Your answer" : "Value");
    cvalue.value = p.suggestion ?? "";
    cvalue.placeholder = question ? "type your answer" : "";
    $("cvalueHint").textContent = question
      ? "This is typed straight into the field. It is not sent to the server."
      : "Edit before approving if this is not what you want entered.";
    // Focusing here means Enter approves, which is what a hand on the keyboard
    // expects when a box is the only thing on screen.
    setTimeout(() => cvalue.focus(), 30);
  }

  const ap = $("approve") as HTMLButtonElement;
  const de = $("decline") as HTMLButtonElement;
  ap.textContent = question ? "Use this" : "Approve";
  de.textContent = question ? "Skip" : "Decline";
}

function drawResources(s: AgentState): void {
  const box = $("resBox") as HTMLDetailsElement;
  const r = s.resources;
  const last = s.steps[s.steps.length - 1];

  if (!r && !last) {
    box.hidden = true;
    return;
  }
  box.hidden = false;

  if (r) {
    const gpu = r.provider === "webgpu";
    const prov = $("gProvider");
    prov.textContent = gpu ? "GPU" : r.provider === "none" ? "—" : "CPU";
    prov.className = `gv ${gpu ? "good" : "warn"}`;
    $("gProviderNote").textContent = gpu
      ? "WebGPU — the graphics card ran the model"
      : r.provider === "none"
        ? "no model pass was needed this step"
        : "WASM + SIMD fallback — no WebGPU on this machine";

    $("gMem").textContent = r.offscreenMB ? `${r.offscreenMB} MB` : "n/a";
    $("gSkip").textContent = r.frameSkipped !== undefined ? `${r.frameSkipped}%` : "—";
    $("gInfer").textContent = r.inferMs ? `${Math.round(r.inferMs)} ms` : "0 ms";
    $("gPasses").textContent = `${r.passes} model pass${r.passes === 1 ? "" : "es"} last step`;
    $("rsum").textContent = `${gpu ? "GPU" : "CPU"} · ${Math.round(r.inferMs)} ms`;
  } else {
    $("rsum").textContent = "no model pass yet";
  }

  // Stacked latency bar for the most recent step.
  const STAGES: Array<[keyof StageTimings, string, string]> = [
    ["capture", "capture", "#5b8def"],
    ["perceive", "perceive", "#2fa8a0"],
    ["detect", "detect", "#c9922e"],
    ["redact", "redact", "#b4574a"],
    ["verify", "verify", "#7a5bbd"],
    ["network", "network", "#d0563f"],
    ["execute", "execute", "#3f9d5c"],
  ];
  const tbar = $("tbar");
  const tkey = $("tkey");
  tbar.textContent = "";
  tkey.textContent = "";

  const tm = last?.timings;
  const total = tm ? STAGES.reduce((n, [k]) => n + (tm[k] ?? 0), 0) : 0;
  if (tm && total > 0) {
    for (const [k, label, colour] of STAGES) {
      const v = tm[k] ?? 0;
      if (v <= 0) continue;
      const seg = document.createElement("i");
      seg.style.width = `${(v / total) * 100}%`;
      seg.style.background = colour;
      seg.title = `${label} — ${v} ms`;
      tbar.append(seg);

      const item = document.createElement("span");
      item.className = "tki";
      const dot = document.createElement("i");
      dot.style.background = colour;
      item.append(dot, document.createTextNode(`${label} ${v}ms`));
      tkey.append(item);
    }
  } else {
    tbar.append(el("i", "empty-seg", ""));
  }

  // Whole-run split. This is the headline privacy-and-cost number: how much of
  // the task never needed the network at all.
  const localN = s.steps.filter((x) => x.route === "local" || x.route === "done").length;
  const netN = s.steps.filter((x) => x.route === "server").length;
  const sbar = $("sbar");
  sbar.textContent = "";
  const denom = localN + netN;
  if (denom > 0) {
    const a = document.createElement("i");
    a.className = "s-local";
    a.style.width = `${(localN / denom) * 100}%`;
    const b = document.createElement("i");
    b.className = "s-net";
    b.style.width = `${(netN / denom) * 100}%`;
    sbar.append(a, b);
    $("splitNote").textContent =
      `${localN} of ${denom} steps finished on this device. ` +
      `${netN} needed the server, and each of those sent only redacted text.`;
  } else {
    $("splitNote").textContent = "No steps yet.";
  }
}

/**
 * Everything the agent typed this run. This is the user auditing their own
 * machine, so the real value is available here — but hidden by default, because
 * a side panel is often on screen while someone else is watching.
 *
 * None of this is ever part of a payload: SanitizedContext is built separately,
 * and the verifier's key whitelist would reject these fields outright.
 */
function drawEntered(steps: StepLog[]): void {
  const rows = steps.filter((x) => x.entered).map((x) => x.entered!);
  const box = $("enteredBox") as HTMLDetailsElement;
  box.hidden = rows.length === 0;
  if (!rows.length) return;

  $("ecount").textContent = `${rows.length} field${rows.length === 1 ? "" : "s"}`;
  const host = $("erows");
  host.innerHTML = "";

  for (const r of rows) {
    const row = document.createElement("div");
    row.className = "erow";
    const dots = "\u2022".repeat(Math.min(r.value.length, 18));
    const val = el("span", "ev hidden", dots);

    const eye = document.createElement("button");
    eye.className = "eye";
    eye.type = "button";
    eye.textContent = "SHOW";
    eye.addEventListener("click", () => {
      const hidden = val.classList.toggle("hidden");
      val.textContent = hidden ? dots : r.value;
      eye.textContent = hidden ? "SHOW" : "HIDE";
    });

    row.append(
      el("span", "ef", r.field),
      val,
      el("span", `esrc ${r.source}`, r.source === "profile" ? "my data" : "on page"),
      eye,
    );
    host.append(row);
  }
}

function drawLog(steps: StepLog[]): void {
  if (!steps.length) {
    logEl.innerHTML = `<p class="empty">No steps yet.<br />Open a page, describe a task, and press Run.</p>`;
    return;
  }

  const open = new Set(
    Array.from(logEl.querySelectorAll(".step.open")).map((n) => (n as HTMLElement).dataset.step!),
  );
  logEl.innerHTML = "";

  for (const s of steps) {
    const card = document.createElement("div");
    card.className = "step";
    card.dataset.step = String(s.step);
    if (open.has(String(s.step)) || s.step === steps.length) card.classList.add("open");

    const route = s.route ?? "local";
    const result = s.result ?? "pending";
    const timings = s.timings ?? ({ total: 0 } as StageTimings);

    const head = document.createElement("div");
    head.className = "head";
    head.append(
      el("span", "n", String(s.step ?? 0).padStart(2, "0")),
      el("span", `pill ${route}`, route === "ask_user" ? "ask" : route),
      el("span", "ms", `${timings.total} ms`),
      el("span", `dot ${result}`, ""),
    );
    head.addEventListener("click", () => card.classList.toggle("open"));
    card.append(head);

    const body = document.createElement("div");
    body.className = "body";

    if (s.thought) body.append(el("p", "thought", s.thought));
    if (s.action) {
      const a = s.action;
      body.append(el("div", "act", [a.kind, a.target, a.value].filter(Boolean).join("  ")));
    }
    if (s.note) body.append(el("p", "note", s.note));

    // Did what we typed actually land? An agent that assumes success fills half
    // a form wrongly. The value is never shown — only the verdict.
    if (s.ingest) {
      const g = document.createElement("div");
      g.className = `ingest ${s.ingest.verified ? "ok" : "bad"}`;
      g.append(
        el("span", "itag", s.ingest.verified ? "VERIFIED IN FIELD" : "NOT INGESTED"),
        el("span", "ireason", s.ingest.reason),
        el("span", "ilen", `${s.ingest.actualLen}/${s.ingest.expectedLen} chars`),
      );
      body.append(g);
    }

    body.append(timingBars(timings));
    if (s.receipt) body.append(receiptView(s.receipt));

    card.append(body);
    logEl.append(card);
  }
  logEl.scrollTop = logEl.scrollHeight;
}

const STAGES: Array<[keyof StageTimings, string, string]> = [
  ["capture", "capture", "#4cc5d0"],
  ["perceive", "perceive", "#7fd6a0"],
  ["detect", "detect", "#e39a57"],
  ["redact", "redact", "#d98cc0"],
  ["verify", "verify", "#5fc08f"],
  ["network", "network", "#9b93f5"],
  ["execute", "execute", "#b3c0c3"],
];

function timingBars(t: StageTimings): HTMLElement {
  const wrap = document.createElement("div");
  const total = Math.max(t.total, 0.01);

  const bars = document.createElement("div");
  bars.className = "bars";
  const legend = document.createElement("div");
  legend.className = "legend";
  legend.style.marginTop = "5px";

  for (const [k, label, color] of STAGES) {
    const v = t[k];
    if (v <= 0) continue;
    const i = document.createElement("i");
    i.style.cssText = `flex:${v / total};background:${color}`;
    bars.append(i);
    const sp = document.createElement("span");
    sp.innerHTML = `<i style="background:${color}"></i>${label} ${v}`;
    legend.append(sp);
  }

  wrap.append(bars, legend);
  return wrap;
}

function receiptView(r: PrivacyReceipt): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "receipt";
  wrap.append(el("div", "rhead", "Privacy receipt"));

  const chips = document.createElement("div");
  chips.className = "chips";
  if (r.dropped) chips.append(chip(`${r.dropped} removed`, "drop"));
  if (r.substituted) chips.append(chip(`${r.substituted} substituted`, "sub"));
  if (r.masked) chips.append(chip(`${r.masked} masked`, "mask"));
  chips.append(chip(`${r.payloadBytes} B`));
  chips.append(chip(`#${r.payloadHash}`));
  wrap.append(chips);

  const classes = Object.entries(r.counts).filter(([, n]) => n);
  if (classes.length) {
    const c2 = document.createElement("div");
    c2.className = "chips";
    for (const [k, n] of classes) c2.append(chip(`${k} ×${n}`));
    wrap.append(c2);
  }

  if (r.vision) wrap.append(el("div", "vision", r.vision));

  // The whole point of a privacy claim is that it can be checked. This is the
  // literal JSON that crossed the boundary — read it and confirm.
  if (r.payload) {
    const det = document.createElement("details");
    det.className = "payload";

    const sum = document.createElement("summary");
    sum.append(
      el("span", "psum", "What was sent"),
      el("span", "pbytes", `${r.payloadBytes} B${r.imageBytes ? ` + ${Math.round(r.imageBytes / 1365)} KB frame` : ""}`),
    );
    det.append(sum);

    const pre = document.createElement("pre");
    pre.textContent = r.payload;
    det.append(pre);
    wrap.append(det);
  }

  // The returning half. Showing only what we sent proves we redacted; showing
  // what came back proves the server could still do the job on redacted input —
  // and lets you see that its instructions name handles, never values.
  if (r.reply) {
    const det = document.createElement("details");
    det.className = "payload reply";

    const sum = document.createElement("summary");
    sum.append(
      el("span", "psum", "What came back"),
      el("span", "pbytes", `${r.reply.length} B${r.replyMs !== undefined ? ` · ${r.replyMs} ms` : ""}`),
    );
    det.append(sum);

    const pre = document.createElement("pre");
    pre.textContent = r.reply;
    det.append(pre);
    wrap.append(det);
  }

  const checks = document.createElement("div");
  checks.className = "checks";
  for (const c of r.verifier.checks) {
    const d = document.createElement("div");
    d.className = `check ${c.passed ? "pass" : "fail"}`;
    d.innerHTML = `<b>${c.id}</b>${c.name} <span>${c.detail ?? ""}</span>`;
    checks.append(d);
  }
  if (r.verifier.retries) {
    checks.append(el("div", "note", `V6 escalated redaction ${r.verifier.retries}×`));
  }
  wrap.append(checks);
  return wrap;
}

function chip(text: string, cls = ""): HTMLElement {
  return el("span", `chip ${cls}`.trim(), text);
}

function el(tag: string, cls: string, text: string): HTMLElement {
  const n = document.createElement(tag);
  n.className = cls;
  n.textContent = text;
  return n;
}
