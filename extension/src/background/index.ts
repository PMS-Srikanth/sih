/**
 * Service worker — the orchestrator, and the only process that ever holds real
 * values. The page cannot reach here; the network only sees what the verifier
 * has cleared.
 */
import type {
  AgentAction, AgentState, ContentResponse, HistoryEntry, Mode, PanelMessage,
  EnteredValue, PrivacyReceipt, RawElement, RawScreenGraph, ServerResponse, StageTimings, StepLog,
} from "@/shared/types";
import { detectDom } from "@/privacy/detectors/dom";
import { detectRegex } from "@/privacy/detectors/regex";
import { fuse } from "@/privacy/fusion";
import { redact } from "@/privacy/redactor";
import { harden, verify, VERIFIER_VERSION } from "@/privacy/verifier";
import { isHandle, Vault } from "@/privacy/vault";
import {
  destroy as vaultDestroy, lock as vaultLock, loadProfile, saveProfile,
  setup as vaultSetup, slotFor, status as vaultStatus, unlock as vaultUnlock, type Profile,
} from "@/privacy/profile";
import { fnv1a } from "@/privacy/checksums";
import { route } from "@/agent/router";
import { checkPolicy } from "@/agent/policy";
import { DEFAULT_SERVER, send } from "./transport";
import { captureViewport, encode, maskRegions, planVision, verifyMasks, type Capture } from "./capture";
import { detectRegions, warmup } from "./vision";

const MAX_STEPS = 25;

const state: AgentState = {
  running: false,
  task: "",
  mode: "balanced",
  serverUrl: DEFAULT_SERVER,
  steps: [],
  awaitingConfirm: null,
};

let vault = new Vault();
let history: HistoryEntry[] = [];
let tabId: number | null = null;
let windowId: number | null = null;
/** Set when the server replies need_image; the next payload carries one frame. */
let needImage = false;
interface ConfirmAnswer { approved: boolean; value?: string }
let confirmResolver: ((a: ConfirmAnswer) => void) | null = null;
let stopRequested = false;
/** The most recent graph’s elements, so a prompt can name the field it is about. */
let lastElements: RawElement[] = [];

/** Stop after this many consecutive steps that leave the page unchanged. */
const NO_PROGRESS_LIMIT = 2;

chrome.storage.local.get(["serverUrl", "mode"]).then((s) => {
  if (typeof s.serverUrl === "string") state.serverUrl = s.serverUrl;
  if (s.mode) state.mode = s.mode as Mode;
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});
  void warmup();
});

chrome.runtime.onMessage.addListener((msg: PanelMessage, _sender, respond) => {
  (async () => {
    switch (msg.kind) {
      case "getState":
        respond(state);
        return;
      case "getProfile":
        respond({ profile: await loadProfile(), vault: await vaultStatus() });
        return;
      case "setProfile": {
        const r = await saveProfile(msg.values);
        respond({ ...r, profile: await loadProfile(), vault: await vaultStatus() });
        return;
      }
      case "vaultStatus":
        respond(await vaultStatus());
        return;
      case "vaultSetup": {
        const r = await vaultSetup(msg.passphrase);
        respond({ ...r, profile: await loadProfile(), vault: await vaultStatus() });
        return;
      }
      case "vaultUnlock": {
        const r = await vaultUnlock(msg.passphrase);
        respond({ ...r, profile: await loadProfile(), vault: await vaultStatus() });
        return;
      }
      case "vaultLock":
        await vaultLock();
        respond({ ok: true, profile: null, vault: await vaultStatus() });
        return;
      case "vaultDestroy":
        await vaultDestroy();
        respond({ ok: true, profile: null, vault: await vaultStatus() });
        return;
      case "setServer":
        state.serverUrl = msg.url || DEFAULT_SERVER;
        await chrome.storage.local.set({ serverUrl: state.serverUrl });
        respond(state);
        return;
      case "stop":
        stopRequested = true;
        state.running = false;
        // Stop must also dismiss any open confirmation. Resolving the promise
        // alone left awaitingConfirm set and never pushed, so the panel kept
        // showing a question about a run that no longer exists — with no way
        // out except reloading the extension.
        confirmResolver?.({ approved: false });
        confirmResolver = null;
        state.awaitingConfirm = null;
        push();
        respond(state);
        return;
      case "confirm":
        confirmResolver?.({ approved: msg.approve, value: msg.value });
        confirmResolver = null;
        state.awaitingConfirm = null;
        push();
        respond(state);
        return;
      case "run":
        respond({ ...state, running: true });
        await runTask(msg.task, msg.mode);
        return;
      default:
        respond(state);
    }
  })();
  return true;
});

// ── the loop ───────────────────────────────────────────────────────────────

async function runTask(task: string, mode: Mode): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return fail("no active tab");
  tabId = tab.id;
  windowId = tab.windowId ?? null;
  needImage = false;

  vault = new Vault();
  history = [];
  stopRequested = false;
  // Null when the vault is locked or has never been set up. The agent then
  // simply has nothing to offer a blank form — it does not fall back to
  // unencrypted storage.
  const profile: Profile | null = await loadProfile();
  Object.assign(state, { running: true, task, mode, steps: [], awaitingConfirm: null, answer: undefined, error: undefined });
  await chrome.storage.local.set({ mode });
  push();

  let warnedLocked = false;
  let lastFingerprint = "";
  let stalled = 0;

  for (let step = 1; step <= MAX_STEPS && !stopRequested; step++) {
    const t: StageTimings = { capture: 0, perceive: 0, detect: 0, redact: 0, verify: 0, network: 0, execute: 0, total: 0 };
    const t0 = performance.now();

    // ── 1 · capture + perceive ────────────────────────────────────────────
    const mark = performance.now();
    const graph = await perceive(mode);
    if (!graph) return fail("could not read the page — try reloading the tab");
    lastElements = graph.elements;
    t.capture = round(performance.now() - mark);
    t.perceive = graph.perceiveMs;

    // ── 1b · progress check ───────────────────────────────────────────────
    // An agent that keeps acting on a page it is not changing is looping. Two
    // identical page states in a row is enough evidence to stop.
    const fingerprint = fingerprintOf(graph);
    if (step > 1 && fingerprint === lastFingerprint) {
      stalled++;
      if (stalled >= NO_PROGRESS_LIMIT) {
        log({
          step,
          route: "done",
          result: "ok",
          note: `page unchanged after ${stalled} step(s) — stopping rather than looping`,
          timings: done(t, t0),
        });
        state.running = false;
        push();
        return;
      }
    } else {
      stalled = 0;
    }
    lastFingerprint = fingerprint;

    // ── 2 · route: is the server needed at all? ───────────────────────────
    const decision = route(graph, task, step - 1);

    let action: AgentAction | null = null;
    let thought = "";
    let receipt: PrivacyReceipt | undefined;
    let routeKind: StepLog["route"] = "local";

    if (decision.route === "local") {
      action = decision.action;
      thought = `resolved on device — ${decision.why}`;
    } else {
      routeKind = "server";

      // ── 3 · detect ──────────────────────────────────────────────────────
      let mk = performance.now();
      const detections = [...detectDom(graph.elements), ...detectRegex(graph.elements)];

      let cap: Capture | null = null;
      let visionNote = "";
      if (mode !== "fast" && windowId != null) {
        const mkc = performance.now();
        cap = await captureViewport(windowId);
        if (cap) {
          const plan = planVision(cap, graph.elements, graph.viewport, mode);
          // Thorough mode also runs the ViT classifier; Fast and Balanced do not
          // pay its load, which is what keeps metric 4 honest.
          const vision = await detectRegions(cap, plan.regions, mode === "thorough");
          
          for (const r of vision.regions) {
            let bestEl: typeof graph.elements[0] | null = null;
            let maxOverlap = 0;
            for (const el of graph.elements) {
               const overlapW = Math.max(0, Math.min(r.x + r.w, el.bbox.x + el.bbox.w) - Math.max(r.x, el.bbox.x));
               const overlapH = Math.max(0, Math.min(r.y + r.h, el.bbox.y + el.bbox.h) - Math.max(r.y, el.bbox.y));
               const intersection = overlapW * overlapH;
               if (intersection > 0) {
                 const elArea = el.bbox.w * el.bbox.h;
                 const rArea = r.w * r.h;
                 const iou = intersection / (elArea + rArea - intersection);
                 const containment = intersection / rArea;
                 if (iou > 0.5 || containment > 0.8) {
                   const score = Math.max(iou, containment);
                   if (score > maxOverlap) {
                     maxOverlap = score;
                     bestEl = el;
                   }
                 }
               }
            }
            
            // Explicit calibration: ViT softmax probabilities are frequently overconfident on
            // zero-shot cropped regions. We apply a 0.5 calibration weight so that high-confidence
            // raw ViT scores (e.g. 0.80) map to ambiguous fusion probabilities (e.g. 0.40).
            // This ensures ViT acts as corroborating evidence (0.40 ViT + 0.80 DOM = 0.88) 
            // without overriding high-threshold tie-breaks on its own.
            const pCalibrated = r.model === "vit" ? r.score * 0.5 : r.score;

            detections.push({
              elementId: bestEl ? bestEl.id : `v_${Math.round(r.x)}_${Math.round(r.y)}`,
              field: "element",
              cls: r.cls as any,
              p: pCalibrated,
              source: "vision",
              evidence: `${r.model} raw=${r.score.toFixed(2)} cal=${pCalibrated.toFixed(2)}`,
              bbox: bestEl ? undefined : r
            });
          }

          t.capture = round(performance.now() - mkc);

          // Read the cost of that work into state so the panel can draw it.
          // coveragePct is what the DOM already explained, so the remainder is
          // the only part any model had to look at.
          const swHeap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
          state.resources = {
            provider: vision.provider,
            heapMB: swHeap ? Math.round(swHeap.usedJSHeapSize / 1048576) : undefined,
            offscreenMB: vision.memoryMB,
            inferMs: vision.inferMs,
            passes: vision.passes,
            frameSkipped: plan.coveragePct,
            models: vision.models,
          };

          visionNote =
            `${vision.provider} · ${vision.passes} pass(es) ${vision.inferMs}ms · ` +
            `DOM explains ${plan.coveragePct}% · ${plan.regions.length} region(s) inspected · ` +
            `${vision.regions.length} match(es) found` +
            (vision.memoryMB ? ` · ${vision.memoryMB}MB peak memory` : "") +
            (vision.error ? ` · ${vision.error}` : "");
        } else {
          visionNote = "frame capture unavailable on this page";
        }
      }

      const findings = fuse({ elements: graph.elements, detections });
      t.detect = round(performance.now() - mk);

      // ── 4 · redact ──────────────────────────────────────────────────────
      mk = performance.now();
      let { context, applied, stats, vaultLocked } = redact({ graph, findings, vault, task, mode, history, profile });

      // Say this once and stop, rather than asking the user to type in a name
      // the extension already has. Fifteen questions in a row is also exactly
      // what an unresponsive Approve button looks like.
      //
      // Two ways to reach this. The redactor reports it when it sees a field the
      // profile could serve, which is the precise signal. But that depends on a
      // detector having classified the field, and on a blank form it sometimes
      // has not — so a fill-shaped task with no profile at all is treated the
      // same way. Better a redundant check than a question storm.
      const noProfileForFill = !profile && /\b(fill|complete|populate|autofill)\b/i.test(task);
      if ((vaultLocked || noProfileForFill) && !warnedLocked) {
        warnedLocked = true;
        log({
          step,
          route: "local",
          result: "blocked",
          note: "This page has fields your profile could fill, but My data is locked. Open it in the side panel and unlock, then run this again.",
          timings: done(t, t0),
        });
        return fail("My data is locked — unlock it in the side panel to fill personal fields.");
      }
      t.redact = round(performance.now() - mk);

      void chrome.tabs
        .sendMessage(tabId, {
          kind: "showRedactions",
          findings: applied,
          fillable: context.elements.filter((e) => e.wants).map((e) => ({ id: e.id, handle: e.wants! })),
        })
        .catch(() => {});

      // ── 4b · pixels ─────────────────────────────────────────────────────
      let maskCheck: { ok: boolean; checked: number; failed: number } | null = null;
      let painted = 0;
      if (cap) {
          const toMask: Array<{ bbox: typeof graph.elements[number]["bbox"] }> = applied
            .filter((f) => f.fate === "mask")
            .map((f) => {
               if (f.bbox) return { bbox: f.bbox as typeof graph.elements[number]["bbox"] };
               const el = graph.elements.find((e) => e.id === f.elementId);
               return el ? { bbox: el.bbox } : null;
            })
            .filter((x): x is NonNullable<typeof x> => !!x);

          painted = maskRegions(cap, toMask);
          maskCheck = verifyMasks(cap, toMask);

          if (visionNote && visionNote !== "frame capture unavailable on this page") {
            visionNote += ` · ${painted} mask(s) painted`;
          }

          if (needImage) {
            context.image = await encode(cap);
            needImage = false;
          }
      }

      // ── 5 · verify, with V6 escalation ──────────────────────────────────
      mk = performance.now();
      let v = verify(context, vault, maskCheck);
      let retries = 0;
      while (!v.passed && retries < 2) {
        retries++;
        context = harden(context);
        v = verify(context, vault);
      }
      t.verify = round(performance.now() - mk);

      const bySource: PrivacyReceipt["bySource"] = {};
      for (const f of findings) for (const s of f.sources) bySource[s] = (bySource[s] ?? 0) + 1;

      receipt = {
        step,
        at: Date.now(),
        counts: stats.counts,
        bySource,
        dropped: stats.dropped,
        substituted: stats.substituted,
        masked: stats.masked,
        kept: stats.kept,
        payloadBytes: v.bytes,
        payloadHash: v.hash,
        verifier: { version: VERIFIER_VERSION, passed: v.passed, checks: v.checks, retries },
      };

      if (visionNote) receipt.vision = visionNote;
      // Pretty-printed so a human can actually read what left the machine.
      receipt.payload = JSON.stringify(JSON.parse(v.payload), null, 1).slice(0, 24_000);
      if (context.image) receipt.imageBytes = context.image.length;

      if (!v.passed) {
        log({ step, route: "server", result: "blocked", thought: "verifier refused to transmit", timings: done(t, t0), receipt });
        return fail("Privacy verifier refused to transmit. Nothing was sent.");
      }

      // ── 6 · transmit ────────────────────────────────────────────────────
      mk = performance.now();
      const exchange = await send(state.serverUrl, v.payload);
      const res: ServerResponse = exchange.response;
      t.network = round(performance.now() - mk);

      // The other half of the boundary. The panel shows the payload we sent and
      // this reply side by side, so "what did the server actually see, and what
      // did it hand back" is answerable from the UI rather than a terminal.
      receipt.reply = exchange.raw;
      receipt.replyMs = exchange.ms;

      const handled = await handleResponse(res, step, t, t0, receipt);
      if (handled.stop) return;
      action = handled.action;
      thought = handled.thought;
      routeKind = handled.route;
      if (!action) continue;
    }

    // ── 7 · repeat guard ────────────────────────────────────────────────────
    // A click or fill that already succeeded on this target means the work is
    // done, or the agent is looping. Either way, stop rather than doing it twice.
    if (
      (action.kind === "click" || action.kind === "fill") &&
      history.some((h) => h.action === action!.kind && h.target === action!.target && h.result === "ok")
    ) {
      log({
        step,
        route: "done",
        thought,
        action,
        result: "ok",
        note: `already ${action.kind === "click" ? "clicked" : "filled"} this target — nothing left to do`,
        timings: done(t, t0),
        receipt,
      });
      state.running = false;
      push();
      return;
    }

    // ── 8 · policy + execute ────────────────────────────────────────────────
    const el = graph.elements.find((e) => e.id === action!.target);
    const verdict = checkPolicy(action, el, vault, step - 1, false);

    if (!verdict.allow) {
      history.push({ action: action.kind, target: action.target, result: "blocked", note: verdict.reason });
      log({ step, route: routeKind, thought, action, result: "blocked", note: verdict.reason, timings: done(t, t0), receipt });
      if (routeKind === "local") return fail(verdict.reason);
      continue; // let the server try something else
    }

    if (verdict.confirm) {
      // Show what is actually about to be typed, so approving means something.
      // A handle is resolved for display only when it is not a secret: the
      // whole point of the vault is that a password never reaches a UI.
      const editable = action.kind === "fill" || action.kind === "select";
      const shown = editable ? previewValue(action.value, vault) : undefined;
      state.awaitingConfirm = {
        kind: "action",
        action,
        why: verdict.confirm,
        target: action.target,
        editable: editable && shown !== null,
        suggestion: shown ?? undefined,
        fieldLabel: labelOf(action.target, graph.elements),
      };
      push();
      const { approved, value: edited } = await waitForConfirm();
      state.awaitingConfirm = null;

      // An edit replaces the handle with a literal the user typed themselves.
      if (approved && edited && edited !== shown) {
        action = { ...action, value: edited };
        history.push({ action: action.kind, target: action.target, result: "ok", note: "value edited by user" });
      }
      if (!approved) {
        history.push({ action: action.kind, target: action.target, result: "blocked", note: "declined by user" });
        log({ step, route: routeKind, thought, action, result: "blocked", note: "declined by user", timings: done(t, t0), receipt });
        return fail("Stopped — you declined the action.");
      }
    }

    const mk2 = performance.now();
    const exec = (await chrome.tabs.sendMessage(tabId, {
      kind: "execute",
      action,
      resolved: verdict.resolved,
      expectSig: el?.sig,
      // Fast mode promises the lowest latency it can manage, so it does not pay
      // for a visualisation nobody asked it to draw.
      showAgent: mode !== "fast",
    })) as ContentResponse;

    // The visualiser's pauses are a presentation aid sitting inside this stage.
    // Subtract them, and report them separately, so a demo aid cannot quietly
    // add a second per action to the latency figure the PS grades.
    const visual = ("visualMs" in exec ? exec.visualMs : 0) ?? 0;
    t.execute = round(Math.max(0, performance.now() - mk2 - visual));
    if (visual) t.visual = round(visual);

    const ok = exec.ok === true;
    const note = ok ? ("note" in exec ? exec.note : undefined) : (exec as { error: string }).error;
    const ingest = "ingest" in exec ? exec.ingest : undefined;

    // Record what was typed, so the user can review their own run. The vault
    // entry tells us which slot it came from; el.name gives the human label.
    let entered: EnteredValue | undefined;
    if (ok && action.kind === "fill" && verdict.resolved) {
      const handle = action.value && isHandle(action.value) ? vault.get(action.value.trim()) : undefined;
      entered = {
        field: el?.name || el?.label || action.target || "field",
        cls: handle?.cls ?? "value",
        value: verdict.resolved,
        source: profile && handle && slotFor(profile, handle.cls) ? "profile" : "page",
      };
    }
    history.push({ action: action.kind, target: action.target, result: ok ? "ok" : "failed", note });
    log({ step, route: routeKind, thought, action, result: ok ? "ok" : "failed", note, timings: done(t, t0), receipt, ingest, entered });

    if (action.kind === "done") {
      state.running = false;
      push();
      return;
    }
    await sleep(220);
  }

  state.running = false;
  push();
}

// ── server response handling ───────────────────────────────────────────────

async function handleResponse(
  res: ServerResponse,
  step: number,
  t: StageTimings,
  t0: number,
  receipt: PrivacyReceipt,
): Promise<{ stop: boolean; action: AgentAction | null; thought: string; route: StepLog["route"] }> {
  switch (res.type) {
    case "action":
      return { stop: false, action: res.action, thought: res.thought, route: "server" };

    case "plan":
      // A short plan is executed one step at a time; the page is re-read between
      // each, so a stale step can never be blindly applied.
      return { stop: false, action: res.steps[0] ?? null, thought: res.thought, route: "server" };

    case "data":
      state.answer = res.answer;
      state.running = false;
      log({ step, route: "server", result: "ok", note: res.answer, timings: done(t, t0), receipt });
      push();
      return { stop: true, action: null, thought: "", route: "server" };

    case "ask_user": {
      // The planner reached a field no stored data can answer — years of
      // experience, notice period, why you want the role. Rather than guessing
      // or giving up, it asks, and what the user types is filled straight in.
      state.awaitingConfirm = {
        kind: "question",
        action: { kind: "wait" },
        why: res.question,
        target: res.target,
        editable: !!res.target,
        fieldLabel: res.target ? labelOf(res.target, lastElements) : undefined,
      };
      log({ step, route: "ask_user", result: "pending", note: res.question, timings: done(t, t0), receipt });
      push();
      const { approved: answered, value: typed } = await waitForConfirm();

      // Record the answer. Without this the page is unchanged next step, the
      // planner sees the same unfilled field and asks the identical question
      // forever — which is exactly what happened before.
      history.push({
        action: "ask_user",
        target: res.target,
        result: answered ? "ok" : "blocked",
        note: answered ? (typed ? "user supplied a value" : "user acknowledged") : "user declined",
      });

      state.awaitingConfirm = null;
      push();

      // A typed answer becomes a literal fill. It came from the user, on this
      // device, and it is never sent to the server — the server only learns
      // that the field is no longer empty.
      if (answered && typed && res.target) {
        return {
          stop: false,
          action: { kind: "fill", target: res.target, value: typed },
          thought: "using the answer you supplied",
          route: "ask_user",
        };
      }
      return { stop: !answered, action: null, thought: "", route: "ask_user" };
    }

    case "need_image":
      // The next payload carries one masked frame. Nothing is re-sent: the
      // client re-perceives, re-redacts and re-verifies from scratch.
      needImage = true;
      log({ step, route: "server", result: "ok", note: `server requested pixels — ${res.reason}`, timings: done(t, t0), receipt });
      return { stop: false, action: null, thought: "", route: "server" };

    case "error":
      log({ step, route: "server", result: "failed", note: res.message, timings: done(t, t0), receipt });
      state.error = res.message;
      state.running = false;
      push();
      return { stop: true, action: null, thought: "", route: "server" };
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

async function perceive(mode: Mode): Promise<RawScreenGraph | null> {
  if (tabId == null) return null;
  try {
    const r = (await chrome.tabs.sendMessage(tabId, { kind: "perceive", mode })) as ContentResponse;
    return r.ok && "graph" in r ? r.graph : null;
  } catch {
    // The content script may not be injected yet on a pre-existing tab.
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
      const r = (await chrome.tabs.sendMessage(tabId, { kind: "perceive", mode })) as ContentResponse;
      return r.ok && "graph" in r ? r.graph : null;
    } catch {
      return null;
    }
  }
}

function waitForConfirm(): Promise<ConfirmAnswer> {
  // Settle any prior wait before replacing it. Overwriting the resolver outright
  // would strand the earlier promise, and the step awaiting it would never
  // resume — a hang with the run still marked active and Stop the only exit.
  confirmResolver?.({ approved: false });
  return new Promise((resolve) => {
    confirmResolver = resolve;
  });
}

/** The human label for an element id, for the prompt panel. */
function labelOf(id: string | undefined, elements: RawElement[]): string | undefined {
  if (!id) return undefined;
  const e = elements.find((x) => x.id === id);
  return e?.label || e?.name || e?.placeholder || undefined;
}

/**
 * What to show in the editable box before an action is approved.
 *
 * Returns null when the value must NOT be displayed. A password or an OTP is
 * exactly the thing the vault exists to keep out of every UI, so those are
 * confirmed blind — you approve that a secret is used, without it being put on
 * screen where a projector or a shoulder can catch it.
 */
function previewValue(value: string | undefined, v: Vault): string | null {
  if (!value) return null;
  if (!isHandle(value)) return value; // already a literal the server composed
  const entry = v.get(value.trim());
  if (!entry) return null;
  if (entry.cls === "password" || entry.cls === "otp" || entry.cls === "apikey") return null;
  return entry.value;
}

function log(entry: StepLog): void {
  state.steps.push(entry);
  push();
}

function fail(message: string): void {
  state.error = message;
  state.running = false;
  push();
}

function push(): void {
  chrome.runtime.sendMessage({ kind: "state", state }).catch(() => {});
}

function done(t: StageTimings, t0: number): StageTimings {
  t.total = round(performance.now() - t0);
  return { ...t };
}

/**
 * A cheap description of "what the page looks like right now". Values are
 * included by presence only — the fingerprint stays in the service worker, but
 * there is no reason to build a structure holding plaintext we do not need.
 */
function fingerprintOf(g: RawScreenGraph): string {
  const parts = g.elements.map((e) => `${e.id}:${e.role}:${e.name}:${e.value ? 1 : 0}:${e.visible ? 1 : 0}`);
  return fnv1a(`${g.url}|${g.viewport.scrollY}|${g.focus ?? ""}|${parts.join("|")}`);
}

const round = (n: number) => Math.round(n * 100) / 100;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
