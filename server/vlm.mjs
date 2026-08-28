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
 *   CORDON_VLM_MODEL   qwen2.5vl:7b  |  llama3.2-vision:11b  |  qwen2.5:7b
 *   CORDON_VLM_KEY     only if the endpoint wants one
 *
 * Unset any of these and the server falls back to the rule-based planner, so
 * the demo never hard-depends on a model being up.
 */

export const VLM_URL = process.env.CORDON_VLM_URL ?? "";
export const VLM_MODEL = process.env.CORDON_VLM_MODEL ?? "qwen2.5:7b";
const VLM_KEY = process.env.CORDON_VLM_KEY ?? "";
const TIMEOUT_MS = Number(process.env.CORDON_VLM_TIMEOUT ?? 25_000);

export const vlmConfigured = () => VLM_URL.length > 0;

/** The redaction scheme, taught to the model. The PS requires it be aware of this. */
export const SYSTEM_PROMPT = `You are the reasoning half of a privacy-preserving browser agent.

You never receive raw page content. You receive a sanitized ScreenGraph where:
- every element has a stable id ("el_12"), a role, and an accessible name
- "holds": "EMAIL_1" means the field CONTAINS a value of that type. EMAIL_1 is an
  opaque handle: it means "an email address", never a particular one.
- "wants": "PERSON_1" means the field is EMPTY and the user's device holds a
  value of that type ready to fill it.
- the same handle always denotes the same underlying value, so if two fields
  both say EMAIL_1 they hold the same email — you may rely on that.
- "sensitive": true means the value was REMOVED entirely. It has no handle and
  you must never attempt to supply one.
- "offscreen": true means below the fold. Still usable; the client scrolls first.
- "regions" lists visual areas the client already masked before sending.

Reply with EXACTLY ONE JSON object and nothing else. No prose, no code fences.

  {"type":"action","thought":"...","action":{"kind":"click|fill|select|scroll|clear|navigate|wait|done","target":"el_12","value":"EMAIL_1"},"confidence":0.9}
  {"type":"data","answer":"..."}
  {"type":"ask_user","question":"..."}

Rules you must not break:
1. For personal data, "value" MUST be a handle such as EMAIL_1. Never invent or
   guess a real name, email, number or address. You do not know them.
2. Never try to fill a field marked "sensitive": true.
3. Prefer a field whose "wants" handle matches its label. One action per reply.
4. If the task is already complete, reply {"kind":"done"}.
5. If two controls match equally well, use ask_user rather than guessing.`;

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
    { role: "system", content: SYSTEM_PROMPT },
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
