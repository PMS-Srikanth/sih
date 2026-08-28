/**
 * Pattern detector. Runs over element values AND visible text, because PII on a
 * page is frequently not inside a labelled field — "Contact us at x@y.com" is
 * plain prose.
 */
import type { Detection, RawElement } from "@/shared/types";
import { scanPatterns } from "../patterns";

export function detectRegex(elements: RawElement[]): Detection[] {
  const out: Detection[] = [];

  for (const el of elements) {
    if (el.value) {
      for (const h of scanPatterns(el.value)) {
        out.push({
          elementId: el.id,
          start: h.start,
          end: h.end,
          field: "value",
          cls: h.cls,
          p: h.p,
          source: "regex",
          evidence: h.evidence,
        });
      }
    }
    if (el.text) {
      for (const h of scanPatterns(el.text)) {
        out.push({
          elementId: el.id,
          start: h.start,
          end: h.end,
          field: "text",
          cls: h.cls,
          p: h.p,
          source: "regex",
          evidence: h.evidence,
        });
      }
    }
  }

  return out;
}
