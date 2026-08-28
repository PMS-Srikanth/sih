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

$("approve").addEventListener("click", () => chrome.runtime.sendMessage({ kind: "confirm", approve: true }));
$("decline").addEventListener("click", () => chrome.runtime.sendMessage({ kind: "confirm", approve: false }));

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

  confirmEl.hidden = !s.awaitingConfirm;
  if (s.awaitingConfirm) confirmWhy.textContent = s.awaitingConfirm.why;

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
  const net = s.steps.filter((x) => x.receipt).length;
  const bytes = s.steps.reduce((n, x) => n + (x.receipt?.payloadBytes ?? 0), 0);
  $("sSteps").textContent = String(s.steps.length);
  $("sLocal").textContent = String(local);
  $("sNet").textContent = String(net);
  $("sBytes").textContent = bytes > 9999 ? `${(bytes / 1024).toFixed(1)}k` : String(bytes);

  drawEntered(s.steps);
  drawLog(s.steps);
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
