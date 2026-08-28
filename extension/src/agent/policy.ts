/**
 * E1 sink resolution and E2 policy — the checks that run before anything is
 * clicked, on device, after the server has spoken.
 */
import type { AgentAction, RawElement } from "@/shared/types";
import { isAllowedSink } from "@/privacy/detectors/dom";
import { Vault, isHandle } from "@/privacy/vault";

export interface PolicyVerdict {
  allow: boolean;
  /** The literal to type, after handle resolution. */
  resolved?: string;
  /** Set when the action needs explicit human approval before it runs. */
  confirm?: string;
  reason: string;
}

/** Irreversible or costly. Always stops for a human, whatever the confidence. */
const IRREVERSIBLE = /\b(pay|payment|purchase|buy|order|checkout|confirm|delete|remove|cancel|send|submit|apply|transfer|withdraw|book|subscribe)\b/i;

const MAX_STEPS = 25;

export function checkPolicy(
  action: AgentAction,
  el: RawElement | undefined,
  vault: Vault,
  stepsTaken: number,
  autofillSecrets: boolean,
): PolicyVerdict {
  if (stepsTaken >= MAX_STEPS) {
    return { allow: false, reason: `step cap reached (${MAX_STEPS})` };
  }

  if (action.kind === "navigate") {
    const url = action.value ?? "";
    if (!/^https?:\/\//i.test(url)) {
      return { allow: false, reason: "navigate target is not an http(s) URL" };
    }
    return { allow: true, confirm: `Navigate to ${new URL(url).host}?`, reason: "navigation needs approval" };
  }

  if (action.kind === "scroll" || action.kind === "wait" || action.kind === "done" || action.kind === "extract") {
    return { allow: true, reason: "non-mutating action" };
  }

  if (!el) {
    return { allow: false, reason: `target ${action.target ?? "(none)"} not present in the current ScreenGraph` };
  }
  // Offscreen is fine — the executor scrolls to the target first, as a person
  // would. Occluded is not: the click would land on whatever is on top.
  if (!el.visible && !el.offscreen) {
    return { allow: false, reason: "target is covered by another element — refusing to click through it" };
  }
  if (!el.enabled) {
    return { allow: false, reason: "target is disabled" };
  }

  // ── E1 · resolve a handle, and check this element may receive it ─────────
  let resolved = action.value;
  if (action.kind === "fill" || action.kind === "select") {
    if (resolved && isHandle(resolved)) {
      const entry = vault.get(resolved.trim());
      if (!entry) {
        return { allow: false, reason: `unknown handle ${resolved}` };
      }
      if ((entry.cls === "password" || entry.cls === "otp" || entry.cls === "apikey") && !autofillSecrets) {
        return { allow: false, reason: "secret autofill is off for this origin" };
      }
      if (!isAllowedSink(entry.cls, el)) {
        return {
          allow: false,
          reason: `"${el.name || el.id}" is not an allowed sink for a ${entry.cls} value — refusing (possible injection)`,
        };
      }
      resolved = entry.value;
    } else if (resolved && looksLikePii(resolved)) {
      // The server is only ever allowed to send handles or text it composed.
      return { allow: false, reason: "server response contained a literal that looks like PII" };
    }
  }

  // ── E2 · irreversible actions always stop for a human ────────────────────
  const label = `${el.name} ${el.text ?? ""}`.trim();
  if (action.kind === "click" && IRREVERSIBLE.test(label)) {
    return {
      allow: true,
      resolved,
      confirm: `Click "${el.name || el.id}"? This looks irreversible.`,
      reason: "irreversible action requires confirmation",
    };
  }

  return { allow: true, resolved, reason: "ok" };
}

function looksLikePii(s: string): boolean {
  return /@[\w.-]+\.\w{2,}/.test(s) || /\b\d{10,}\b/.test(s.replace(/[\s-]/g, ""));
}
