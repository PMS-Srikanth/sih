/**
 * Cordon server — phase 1.
 *
 * A rule-based stand-in for the open-weights VLM that lands in phase 4. It is
 * written against the same contract the real model will be given, so swapping
 * it out changes one function and nothing else:
 *
 *   - it is AWARE OF THE REDACTION SCHEME (cordon/redaction@1)
 *   - it reasons only over the sanitized context
 *   - it emits a constrained action, referencing handles, never literals
 *   - its own output is screened for anything resembling real PII
 *
 * No dependencies — `npm run server`.
 */
import { createServer } from "node:http";
import { planWithVlm, vlmConfigured, VLM_MODEL, VLM_URL } from "./vlm.mjs";

const PORT = Number(process.env.PORT ?? 8787);
const SCHEMA = "cordon/redaction@1";

/** The grammar the model is told about. Phase 4 puts this in the system prompt. */
const HANDLE_RE = /\b(SECRET|OTP|EMAIL|PHONE|PERSON|ADDR|CARD|AADHAAR|PAN|IFSC|UPI|DOB|FACE|IDDOC)_\d+\b/;

const SYSTEM_PROMPT = `You are the reasoning half of a privacy-preserving browser agent.

You never receive raw page content. You receive a sanitized ScreenGraph in which:
  - every element has a stable id (el_12) and an accessible name
  - a field holding personal data carries a HANDLE, e.g. "holds": "EMAIL_1"
  - a handle is opaque: EMAIL_1 means "an email address", not any particular one
  - the same handle always denotes the same underlying value
  - "wants": "EMAIL_1" means the field is EMPTY and the user's device holds a
    value of that type which could fill it. Your job is to decide which slot
    belongs in which field; the device resolves the value locally.
  - "sensitive": true means the value was REMOVED entirely and has no handle
  - "offscreen": true means below the fold — usable, the client scrolls first
  - "regions" lists visual areas already masked on the client

Return exactly one JSON object, one action at a time. When filling a field with
personal data you MUST write the handle, never a literal value. The client
resolves handles locally; you never learn what they contain.

The action kinds allowed are: click, fill, select, scroll, clear, navigate, wait, done.`;

// ── the planner ────────────────────────────────────────────────────────────

function plan(ctx) {
  const task = (ctx.task || "").toLowerCase();
  // Offscreen elements are usable — the client scrolls to them before acting.
  // Only occluded ones (in the viewport, covered by something) are excluded.
  const els = (ctx.elements || []).filter((e) => e.enabled && (e.visible || e.offscreen));

  const fields = els.filter((e) => e.role === "textbox" || e.role === "password" || e.role === "select");
  const buttons = els.filter((e) => e.role === "button" || e.role === "link");

  // 1 · A question about the page is answered from the sanitized context.
  if (/^(what|which|how many|is there|does|find|tell me|show me|read)\b/.test(task)) {
    return answer(ctx, task);
  }

  // 1.5 · A request to clear/reset the form
  if (/\b(clear|empty|reset)\b/i.test(task)) {
    return {
      type: "action",
      thought: "The user is asking to clear or reset the form fields.",
      action: { kind: "clear" },
      confidence: 0.95,
    };
  }

  // 2 · Fill the first EMPTY field the client says its local profile can serve.
  //     `wants` means: this field is blank, and a value of the right type is
  //     available on the device. We choose the pairing; we never see the value.
  const needsFill = fields.find((e) => e.wants && HANDLE_RE.test(e.wants));
  if (needsFill && wantsFill(task)) {
    return {
      type: "action",
      thought: `"${needsFill.name ?? needsFill.id}" is empty and the device has a ${needsFill.wants.split("_")[0].toLowerCase()} available.`,
      action: { kind: "fill", target: needsFill.id, value: needsFill.wants.match(HANDLE_RE)[0] },
      confidence: 0.92,
    };
  }

  // 3 · A password field is never filled by us — the value does not exist here.
  //     Ask once. If the user has already been asked about this field, move on:
  //     re-asking about an unchanged page is an infinite loop, not a strategy.
  const asked = new Set(
    (ctx.history || []).filter((h) => h.action === "ask_user" && h.target).map((h) => h.target),
  );
  const secret = fields.find((e) => e.sensitive && !asked.has(e.id));
  if (secret && wantsFill(task)) {
    return {
      type: "ask_user",
      target: secret.id,
      question: `"${secret.name ?? secret.id}" needs a secret. The server has no access to it — fill it yourself, then continue.`,
    };
  }

  // 3.5 · A blank field the device cannot serve — years of experience, notice
  //       period, why you want the role. None of that is identity data sitting
  //       in a vault, and the server must not invent it: an agent that makes up
  //       an employment history is worse than one that stops. So ask, and the
  //       client fills the answer in locally. Asked at most once per field.
  const unanswerable = fields.find((e) => e.empty && !asked.has(e.id));
  if (unanswerable && wantsFill(task)) {
    const name = unanswerable.name ?? unanswerable.id;
    return {
      type: "ask_user",
      target: unanswerable.id,
      question: `"${name}" is blank and nothing on your device answers it. What should go here?`,
    };
  }

  // 4 · Otherwise pick the button whose name best matches the task.
  const scored = buttons
    .map((e) => ({ e, s: score(task, e.name ?? "") }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);

  if (scored.length && scored[0].s >= 0.5) {
    const top = scored[0];

    // Already done it. The client keeps a repeat guard too, but the planner
    // should not be proposing work it can see has succeeded.
    const hist = ctx.history || [];
    if (hist.some((h) => h.action === "click" && h.target === top.e.id && h.result === "ok")) {
      return {
        type: "action",
        thought: `"${top.e.name}" was already clicked successfully — the task is complete.`,
        action: { kind: "done" },
        confidence: 0.95,
      };
    }

    if (scored.length > 1 && scored[1].s >= top.s - 0.05) {
      return {
        type: "ask_user",
        question: `Several controls match: ${scored.slice(0, 3).map((x) => `"${x.e.name}"`).join(", ")}. Which one?`,
        options: scored.slice(0, 3).map((x) => x.e.name ?? x.e.id),
      };
    }
    return {
      type: "action",
      thought: `"${top.e.name}" is the closest match to the task.`,
      action: { kind: "click", target: top.e.id },
      confidence: Math.min(0.95, 0.5 + top.s * 0.45),
    };
  }

  // 5 · Nothing matched above the fold — scroll if there is more page.
  if (ctx.viewport && ctx.viewport.scrollY + ctx.viewport.h < ctx.viewport.docH - 40) {
    return {
      type: "action",
      thought: "No matching control in view; the page continues below.",
      action: { kind: "scroll", value: "600" },
      confidence: 0.6,
    };
  }

  return { type: "data", answer: "I could not find a control matching that task on this page." };
}

function wantsFill(task) {
  return /\b(fill|enter|type|complete|apply|sign ?in|log ?in|register|submit|form)\b/.test(task);
}

function answer(ctx, task) {
  const els = ctx.elements || [];
  const handles = els.filter((e) => e.holds && HANDLE_RE.test(e.holds));
  const secrets = els.filter((e) => e.sensitive);
  const masked = ctx.regions || [];

  if (/handle|redact|privac|sensitive|pii|mask/.test(task)) {
    const kinds = [...new Set(handles.map((e) => e.holds.match(HANDLE_RE)[0].split("_")[0]))];
    return {
      type: "data",
      answer:
        `I can see ${els.length} element${els.length === 1 ? "" : "s"}. ` +
        `${handles.length} carr${handles.length === 1 ? "ies" : "y"} a handle` +
        (kinds.length ? ` (${kinds.join(", ")})` : "") +
        `, ${secrets.length} ${secrets.length === 1 ? "was" : "were"} removed entirely` +
        (masked.length
          ? `, and ${masked.length} visual region${masked.length === 1 ? "" : "s"} arrived already masked`
          : ", and no visual regions needed masking") +
        `. I know the types, not the values.`,
      cite: handles.slice(0, 5).map((e) => e.id),
    };
  }

  const forms = (ctx.groups || []).filter((g) => g.kind === "form").length;
  const buttons = els.filter((e) => e.role === "button").length;
  const inputs = els.filter((e) => e.role === "textbox" || e.role === "password").length;
  return {
    type: "data",
    answer: `"${ctx.title}" — ${forms} form(s), ${inputs} input(s), ${buttons} button(s). ${handles.length} field(s) hold personal data I cannot see.`,
    cite: els.slice(0, 4).map((e) => e.id),
  };
}

/** Token overlap, with a bonus for a verbatim name in the task. */
function score(task, name) {
  const n = name.toLowerCase().trim();
  if (!n || n.length < 2) return 0;
  if (task.includes(n) && n.length >= 3) return 1;
  const stop = new Set(["the", "a", "an", "to", "on", "in", "my", "and", "of", "for", "please", "button"]);
  const tt = task.replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 1 && !stop.has(w));
  const nn = n.replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 1 && !stop.has(w));
  if (!nn.length) return 0;
  return nn.filter((w) => tt.includes(w)).length / nn.length;
}

// ── output guard ───────────────────────────────────────────────────────────

/**
 * The client checks this too, but the server refusing to emit PII is what stops
 * a prompt-injected page from turning the model into an exfiltration channel.
 */
const PII_LITERAL = [
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
  /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/,
  /\b(?:\d[ -]?){13,19}\b/,
  /\b[6-9]\d{9}\b/,
];

function guard(res) {
  const s = JSON.stringify(res);
  const withoutHandles = s.replace(new RegExp(HANDLE_RE.source, "g"), " ");
  for (const re of PII_LITERAL) {
    if (re.test(withoutHandles)) {
      return { type: "error", message: "response blocked by the server output guard: literal PII detected" };
    }
  }
  return res;
}

// ── http ───────────────────────────────────────────────────────────────────

const server = createServer((req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type");
  res.setHeader("access-control-allow-methods", "POST, OPTIONS");

  if (req.method === "OPTIONS") return void res.writeHead(204).end();

  if (req.method === "GET" && req.url === "/health") {
    return void json(res, 200, { ok: true, schema: SCHEMA, engine: vlmConfigured() ? VLM_MODEL : "rules", prompt: SYSTEM_PROMPT });
  }

  if (req.method !== "POST" || !req.url.startsWith("/agent")) {
    return void json(res, 404, { type: "error", message: "POST /agent" });
  }

  let body = "";
  req.on("data", (c) => {
    body += c;
    if (body.length > 4e6) req.destroy();
  });
  req.on("end", async () => {
    let ctx;
    try {
      ctx = JSON.parse(body);
    } catch {
      return void json(res, 400, { type: "error", message: "invalid JSON" });
    }

    if (ctx.schema !== SCHEMA) {
      return void json(res, 400, { type: "error", message: `unknown redaction schema "${ctx.schema}"` });
    }

    const t0 = Date.now();
    let out, engine = "rules";
    try {
      // The open-weights model first; the rule-based planner is the safety net,
      // so a model that is down or confused never stalls the agent.
      const fromModel = await planWithVlm(ctx);
      if (fromModel) {
        out = guard(fromModel);
        engine = fromModel._vlm ? `vlm:${fromModel._vlm.model}` : "vlm";
        delete out._vlm;
      } else {
        out = guard(plan(ctx));
      }
    } catch (e) {
      out = { type: "error", message: `planner failed: ${e.message}` };
    }

    const n = (ctx.elements || []).length;
    const h = (ctx.elements || []).filter((e) => e.holds).length;
    console.log(
      `[${new Date().toISOString().slice(11, 19)}] ${ctx.urlClass}  ${n} els, ${h} handles, ` +
      `${body.length} B  →  [${engine}] ${out.type}${out.action ? ` ${out.action.kind} ${out.action.target ?? ""}` : ""}  ${Date.now() - t0}ms`,
    );
    json(res, 200, out);
  });
});

function json(res, code, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(b) });
  res.end(b);
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n  cordon server  →  http://127.0.0.1:${PORT}/agent`);
  console.log(`  schema         →  ${SCHEMA}`);
  if (vlmConfigured()) {
    console.log(`  model          →  ${VLM_MODEL}`);
    console.log(`  endpoint       →  ${VLM_URL}`);
    console.log(`  fallback       →  rule-based planner, if the model fails or times out\n`);
  } else {
    console.log(`  model          →  none configured — using the rule-based planner`);
    console.log(`  to enable      →  set CORDON_VLM_URL and CORDON_VLM_MODEL`);
    console.log(`     Ollama      →  CORDON_VLM_URL=http://127.0.0.1:11434/v1/chat/completions`);
    console.log(`     vLLM        →  CORDON_VLM_URL=http://127.0.0.1:8000/v1/chat/completions\n`);
  }
});
