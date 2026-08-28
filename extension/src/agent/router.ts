/**
 * The Router — local-first.
 *
 * PS: "a local ViT ... reads the user's screen and takes decision based on that.
 *      IF IT REQUIRES the visual context to be sent to server, it shall sanitize..."
 *
 * So the server is an escalation path, not a mandatory step. Every step that
 * resolves here costs no network round trip, no redaction work and no server
 * inference — which is most of metrics 4 and 5.
 */
import type { AgentAction, RawElement, RawScreenGraph } from "@/shared/types";

export type RouteDecision =
  | { route: "local"; action: AgentAction; why: string; confidence: number }
  | { route: "server"; why: string }
  | { route: "done"; why: string };

const CLICK_VERBS =
  /\b(click|press|tap|hit|choose|select|open|go to|submit|save|sign ?in|log ?in|continue|next|apply|send|search|download|upload|add|edit|create)\b/i;
const SCROLL_VERBS = /\b(scroll|page down|page up)\b/i;
const CLEAR_VERBS = /\b(clear|empty|reset)\b/i;

/** A bare control name ("save draft") must match far more tightly than a
 *  verb phrase ("click save draft") before we act without the server. */
const THRESHOLD_WITH_VERB = 0.6;
const THRESHOLD_BARE = 0.85;

export function route(graph: RawScreenGraph, task: string, stepsTaken: number): RouteDecision {
  if (!task.trim()) {
    return { route: "done", why: "empty task" };
  }

  if (stepsTaken === 0 && SCROLL_VERBS.test(task) && !CLICK_VERBS.test(task)) {
    return {
      route: "local",
      action: { kind: "scroll", value: /up/i.test(task) ? "-600" : "600" },
      why: "task is a bare scroll instruction",
      confidence: 0.99,
    };
  }

  if (stepsTaken === 0 && CLEAR_VERBS.test(task) && !CLICK_VERBS.test(task)) {
    return {
      route: "local",
      action: { kind: "clear" },
      why: "task is a bare clear instruction",
      confidence: 0.99,
    };
  }

  const quoted = task.match(/["'“]([^"'”]{2,40})["'”]/);
  // Offscreen controls count: the executor scrolls to a target before clicking
  // it, exactly as a person would. Only an OCCLUDED control is unusable.
  const clickable = graph.elements.filter(
    (e) => e.enabled && !occluded(e) && (e.role === "button" || e.role === "link"),
  );

  // Case 1 — the task names a target in quotes and exactly one visible control
  // carries that accessible name. No ambiguity for a model to resolve.
  if (quoted) {
    const needle = quoted[1].toLowerCase().trim();
    const exact = clickable.filter((e) => e.name.toLowerCase().trim() === needle);
    if (exact.length === 1) {
      return {
        route: "local",
        action: { kind: "click", target: exact[0].id },
        why: `exactly one visible control named "${quoted[1]}"`,
        confidence: 0.97,
      };
    }
    const partial = clickable.filter((e) => e.name.toLowerCase().includes(needle));
    if (partial.length === 1) {
      return {
        route: "local",
        action: { kind: "click", target: partial[0].id },
        why: `one visible control matching "${quoted[1]}"`,
        confidence: 0.9,
      };
    }
  }

  // Case 2 — a name match against the visible controls. A click verb lowers the
  // bar; without one, only a near-verbatim control name is enough.
  const hasVerb = CLICK_VERBS.test(task) || CLEAR_VERBS.test(task);
  const need = hasVerb ? THRESHOLD_WITH_VERB : THRESHOLD_BARE;

  const scored = clickable
    .map((e) => ({ e, s: nameScore(task, e) }))
    .filter((x) => x.s >= need)
    .sort((a, b) => b.s - a.s);

  if (scored.length && (scored.length === 1 || scored[0].s - scored[1].s >= 0.25)) {
    return {
      route: "local",
      action: { kind: "click", target: scored[0].e.id },
      why: `unambiguous name match: "${scored[0].e.name}" (${scored[0].s.toFixed(2)}${hasVerb ? "" : ", bare name"})`,
      confidence: Math.min(0.95, 0.6 + scored[0].s * 0.35),
    };
  }

  return {
    route: "server",
    why: scored.length > 1
      ? `${scored.length} controls matched too closely to choose locally`
      : "no unambiguous local resolution",
  };
}

/** Inside the viewport but covered by something else — genuinely unclickable. */
const occluded = (e: RawElement) => !e.visible && !e.offscreen;

/** Token overlap between the task and an element's accessible name. */
function nameScore(task: string, el: RawElement): number {
  const name = el.name.toLowerCase().trim();
  if (!name || name.length < 2) return 0;

  const t = tokens(task);
  const n = tokens(name);
  if (!n.length) return 0;

  const hit = n.filter((w) => t.includes(w)).length;
  const cover = hit / n.length;

  // A whole short name appearing verbatim in the task is very strong evidence.
  if (name.length <= 24 && task.toLowerCase().includes(name)) return Math.max(cover, 0.95);
  return cover;
}

const STOP = new Set([
  "the", "a", "an", "on", "in", "to", "for", "my", "me", "and", "of", "with",
  "please", "click", "press", "tap", "hit", "go", "then", "button", "link", "this", "that",
]);

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
}
