/**
 * The server-side reasoning model.
 *
 * The PS requires an offline-deployable open-weights model. We speak the
 * OpenAI-compatible chat API, which is what vLLM, Ollama, Groq, Together and
 * llama.cpp all expose — so the same code runs against a laptop with Ollama, a
 * self-hosted vLLM box, or a cloud endpoint during the hackathon. No proprietary
 * SDK, no vendor lock-in.
 *
 *   CORDON_VLM_URL     http://127.0.0.1:11434/v1/chat/completions   (Ollama)
 *                      http://127.0.0.1:8000/v1/chat/completions    (vLLM)
 *   CORDON_VLM_MODEL   qwen2.5:3b (verified)  |  qwen2.5:7b  |  qwen2.5vl:7b
 *                      |  llama3.2-vision:11b
 *   CORDON_VLM_KEY     only if the endpoint wants one
 *
 * Unset any of these and the server falls back to the rule-based planner, so
 * the demo never hard-depends on a model being up.
 */

import { SYSTEM_PROMPT as PROMPT } from "./prompt.mjs";

export const VLM_URL = process.env.CORDON_VLM_URL ?? "";
// Defaults to the model this repo has actually been verified against, not the
// largest one it could plausibly use. A default naming a model nobody has
// pulled fails at the worst moment — the first time someone tries it.
export const VLM_MODEL = process.env.CORDON_VLM_MODEL ?? "qwen2.5:3b";
const VLM_KEY = process.env.CORDON_VLM_KEY ?? "";
const TIMEOUT_MS = Number(process.env.CORDON_VLM_TIMEOUT ?? 25_000);

export const vlmConfigured = () => VLM_URL.length > 0;

// The prompt lives in its own module: it is the piece most likely to need
// tuning, and tuning it should not mean touching transport code.
export { SYSTEM_PROMPT } from "./prompt.mjs";

/** Trim the context so a small local model is not swamped by a large page. */
function compact(ctx) {
  const keep = (ctx.elements || [])
    .filter((e) => e.enabled && (e.visible || e.offscreen))
    .filter((e) => ["button", "link", "textbox", "password", "select", "checkbox", "radio"].includes(e.role))
    .slice(0, 60)
    .map((e) => {
      const o = { id: e.id, role: e.role, name: e.name || undefined };
      if (e.holds) o.holds = e.holds;
      if (e.wants) o.wants = e.wants;
      if (e.sensitive) o.sensitive = true;
      if (e.empty) o.empty = true;
      if (e.offscreen) o.offscreen = true;
      return o;
    });

  return {
    task: ctx.task,
    page: ctx.title,
    viewport: ctx.viewport,
    elements: keep,
    regions: (ctx.regions || []).map((r) => ({ cls: r.cls, state: r.state })),
    history: (ctx.history || []).slice(-6),
  };
}

/** Models wrap JSON in prose or fences however much you ask them not to. */
function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < body.length; i++) {
    if (body[i] === "{") depth++;
    else if (body[i] === "}" && --depth === 0) {
      try {
        return JSON.parse(body.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Ask the model for one action. Returns null on any failure so the caller can
 * fall back to the rule-based planner rather than stalling the agent.
 */
export async function planWithVlm(ctx) {
  if (!vlmConfigured()) return null;

  const messages = [
    { role: "system", content: PROMPT },
    { role: "user", content: JSON.stringify(compact(ctx)) },
  ];

  // The masked frame, if the client chose to send one. It has already had
  // faces and documents painted out, in the bitmap, before transmission.
  if (ctx.image) {
    messages[1].content = [
      { type: "text", text: JSON.stringify(compact(ctx)) },
      { type: "image_url", image_url: { url: ctx.image } },
    ];
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  const t0 = Date.now();

  try {
    const res = await fetch(VLM_URL, {
      method: "POST",
      signal: ctl.signal,
      headers: {
        "content-type": "application/json",
        ...(VLM_KEY ? { authorization: `Bearer ${VLM_KEY}` } : {}),
      },
      body: JSON.stringify({
        model: VLM_MODEL,
        messages,
        temperature: 0.1,
        max_tokens: 400,
        // Honoured by vLLM and Ollama; harmless where it is not.
        response_format: { type: "json_object" },
        stream: false,
      }),
    });

    if (!res.ok) {
      console.warn(`  [vlm] ${res.status} ${res.statusText} — falling back to rules`);
      return null;
    }

    const body = await res.json();
    const text = body?.choices?.[0]?.message?.content ?? "";
    const parsed = extractJson(typeof text === "string" ? text : JSON.stringify(text));
    if (!parsed?.type) {
      console.warn("  [vlm] unparseable reply — falling back to rules");
      return null;
    }

    parsed._vlm = { model: VLM_MODEL, ms: Date.now() - t0 };
    return parsed;
  } catch (e) {
    console.warn(`  [vlm] ${e.name === "AbortError" ? "timeout" : e.message} — falling back to rules`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
