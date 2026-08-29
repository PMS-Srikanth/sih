/**
 * The only place in the extension that performs a network request. Everything
 * that reaches it has already passed the verifier.
 */
import type { SanitizedContext, ServerResponse } from "@/shared/types";

export const DEFAULT_SERVER = "http://127.0.0.1:8787/agent";

export interface Exchange {
  response: ServerResponse;
  /** The server’s reply verbatim, for the exchange view in the panel. */
  raw: string;
  /** Wall-clock round trip in ms. */
  ms: number;
}

export async function send(serverUrl: string, payload: string): Promise<Exchange> {
  const t0 = performance.now();
  const at = () => Math.round(performance.now() - t0);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30_000);
  try {
    const res = await fetch(serverUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
      signal: ctl.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      return { response: { type: "error", message: `server returned ${res.status}` }, raw: text.slice(0, 4000), ms: at() };
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { response: { type: "error", message: "reply was not JSON" }, raw: text.slice(0, 4000), ms: at() };
    }
    return { response: validate(json), raw: pretty(text), ms: at() };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // "Failed to fetch" is what the browser says and it explains nothing. The
    // overwhelmingly common cause is that the server was never started, so say
    // that and give the command rather than repeating the browser's phrasing.
    const unreachable = /failed to fetch|networkerror|load failed/i.test(msg);
    const message = unreachable
      ? `The server at ${serverUrl} is not answering. Start it with "npm start" in the project folder, then run this again.`
      : `cannot reach ${serverUrl} — ${msg}`;
    return { response: { type: "error", message }, raw: "", ms: at() };
  } finally {
    clearTimeout(timer);
  }
}

/** Re-indent for display. Falls back to the original text if it will not parse. */
function pretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2).slice(0, 4000);
  } catch {
    return text.slice(0, 4000);
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
      return {
        type: "ask_user",
        question: String(o.question ?? ""),
        // Carried through deliberately: the client records which field was asked
        // about so the planner is not handed the same question next step.
        target: o.target ? String(o.target) : undefined,
        options: Array.isArray(o.options) ? (o.options as string[]) : undefined,
      };
    case "need_image":
      return { type: "need_image", reason: String(o.reason ?? "") };
    default:
      return { type: "error", message: `unknown response type "${String(o.type)}"` };
  }
}

export type { SanitizedContext };
