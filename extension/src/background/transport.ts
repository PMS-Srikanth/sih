/**
 * The only place in the extension that performs a network request. Everything
 * that reaches it has already passed the verifier.
 */
import type { SanitizedContext, ServerResponse } from "@/shared/types";

export const DEFAULT_SERVER = "http://127.0.0.1:8787/agent";

export async function send(serverUrl: string, payload: string): Promise<ServerResponse> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30_000);
  try {
    const res = await fetch(serverUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
      signal: ctl.signal,
    });
    if (!res.ok) return { type: "error", message: `server returned ${res.status}` };
    const json = (await res.json()) as ServerResponse;
    return validate(json);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { type: "error", message: `cannot reach ${serverUrl} — ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}

/** The server is not trusted to be well-behaved, only to be useful. */
function validate(r: unknown): ServerResponse {
  if (!r || typeof r !== "object") return { type: "error", message: "malformed response" };
  const o = r as Record<string, unknown>;
  switch (o.type) {
    case "action":
      if (!o.action || typeof o.action !== "object") return { type: "error", message: "action missing" };
      return {
        type: "action",
        thought: String(o.thought ?? ""),
        action: o.action as ServerResponse extends { action: infer A } ? A : never,
        confidence: Number(o.confidence ?? 0.5),
      } as ServerResponse;
    case "plan":
      return {
        type: "plan",
        thought: String(o.thought ?? ""),
        steps: Array.isArray(o.steps) ? (o.steps.slice(0, 3) as never) : [],
        confidence: Number(o.confidence ?? 0.5),
      } as ServerResponse;
    case "data":
      return { type: "data", answer: String(o.answer ?? ""), cite: Array.isArray(o.cite) ? (o.cite as string[]) : undefined };
    case "ask_user":
      return { type: "ask_user", question: String(o.question ?? ""), options: Array.isArray(o.options) ? (o.options as string[]) : undefined };
    case "need_image":
      return { type: "need_image", reason: String(o.reason ?? "") };
    default:
      return { type: "error", message: `unknown response type "${String(o.type)}"` };
  }
}

export type { SanitizedContext };
