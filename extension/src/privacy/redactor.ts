/**
 * Turns a RawScreenGraph + findings into a SanitizedContext.
 *
 * Precision is the graded property (metric 3), so redaction is tight by
 * construction: a matched span is replaced at exactly its character offsets,
 * never by blanking the whole element.
 */
import type {
  Finding, HistoryEntry, Mode, PiiClass, RawElement, RawScreenGraph,
  SafeElement, SafeRegion, SanitizedContext,
} from "@/shared/types";
import { Vault } from "./vault";
import { slotFor, type Profile } from "./profile";
import { detectDom } from "./detectors/dom";

export const SCHEMA = "cordon/redaction@1";

export interface RedactResult {
  context: SanitizedContext;
  /**
   * Only the findings that actually changed the payload. A detector firing on an
   * EMPTY field is a correct classification but not a redaction — reporting it
   * as one would overstate what was removed.
   */
  applied: Finding[];
  stats: {
    dropped: number;
    substituted: number;
    masked: number;
    kept: number;
    counts: Partial<Record<PiiClass, number>>;
  };
}

export interface RedactInput {
  graph: RawScreenGraph;
  findings: Finding[];
  vault: Vault;
  task: string;
  mode: Mode;
  history: HistoryEntry[];
  image?: string | null;
  /** The user's local profile — used to advertise fillable slots, never sent.
   *  Null when the vault is locked. */
  profile?: Profile | null;
}

export function redact({ graph, findings, vault, task, mode, history, image, profile }: RedactInput): RedactResult {
  const stats = { dropped: 0, substituted: 0, masked: 0, kept: 0, counts: {} as Partial<Record<PiiClass, number>> };
  const bump = (c: PiiClass) => (stats.counts[c] = (stats.counts[c] ?? 0) + 1);

  const byElement = new Map<string, Finding[]>();
  for (const f of findings) {
    const g = byElement.get(f.elementId);
    if (g) g.push(f);
    else byElement.set(f.elementId, [f]);
  }

  const regions: SafeRegion[] = [];
  const elements: SafeElement[] = [];
  const applied: Finding[] = [];

  // What kind of value does each field want? Reuses the DOM classifier, so an
  // EMPTY field still gets a type — which is what makes filling a blank form
  // possible without the server ever seeing profile data.
  const wantedClass = new Map<string, PiiClass>();
  if (profile) {
    for (const d of detectDom(graph.elements)) {
      if (d.field === "value" && !wantedClass.has(d.elementId)) wantedClass.set(d.elementId, d.cls);
    }
  }

  for (const el of graph.elements) {
    const fs = byElement.get(el.id) ?? [];
    const safe: SafeElement = {
      id: el.id,
      role: el.role,
      tag: el.tag,
      type: el.type,
      name: el.name || undefined,
      bbox: [el.bbox.x, el.bbox.y, el.bbox.w, el.bbox.h],
      visible: el.visible,
      offscreen: el.offscreen || undefined,
      enabled: el.enabled,
      parent: el.parent,
      conf: el.conf,
      src: el.src,
    };

    // ── the element's value ────────────────────────────────────────────────
    const valueFindings = fs.filter((f) => f.field === "value" || f.field === "element");
    const drop = valueFindings.find((f) => f.fate === "drop");

    if (drop) {
      // Removed completely. No handle, no value, nothing to reverse.
      safe.sensitive = true;
      // Only counts as a removal if there was in fact something to remove.
      if (el.value) {
        stats.dropped++;
        bump(drop.cls);
        applied.push(drop);
      }
    } else if (valueFindings.length && el.value) {
      const whole = valueFindings.find((f) => f.start == null);
      if (whole && whole.fate === "substitute") {
        const h = vault.mint(el.value, whole.cls, el.id);
        whole.handle = h;
        safe.holds = h;
        stats.substituted++;
        bump(whole.cls);
        applied.push(whole);
      } else {
        const { out, used } = applySpans(el.value, valueFindings, vault, el.id);
        if (used.length === 1 && out.trim() === used[0]) {
          safe.holds = used[0];
        } else if (used.length) {
          safe.holds = out;
        }
        stats.substituted += used.length;
        for (const f of valueFindings) {
          if (!f.handle) continue;
          bump(f.cls);
          applied.push(f);
        }
      }
    } else if (el.value && isSafeToEcho(el)) {
      // A non-sensitive value the agent may legitimately need to see.
      safe.holds = el.value.slice(0, 120);
      stats.kept++;
    } else if (profile && !el.value && /^(input|textarea)$/.test(el.tag)) {
      // Empty field the user's profile can fill. Mint the handle now so the
      // server can reference it — the value stays on the device.
      const cls = wantedClass.get(el.id);
      const slot = cls ? slotFor(profile, cls) : null;
      if (slot) safe.wants = vault.mint(slot.entry.value, cls!, el.id);
    }

    // ── the element's visible text ─────────────────────────────────────────
    const textFindings = fs.filter((f) => f.field === "text");
    if (el.text) {
      if (textFindings.length) {
        const { out, used } = applySpans(el.text, textFindings, vault, el.id);
        safe.text = out;
        stats.substituted += used.length;
        for (const f of textFindings) {
          if (!f.handle) continue;
          bump(f.cls);
          applied.push(f);
        }
      } else {
        safe.text = el.text.slice(0, 240);
        stats.kept++;
      }
    }

    // ── visual regions (populated by the vision channel in phase 2) ────────
    for (const f of fs) {
      if (f.fate !== "mask") continue;
      regions.push({ bbox: [el.bbox.x, el.bbox.y, el.bbox.w, el.bbox.h], cls: f.cls, state: "masked" });
      stats.masked++;
      bump(f.cls);
      applied.push(f);
    }

    elements.push(safe);
  }

  const context: SanitizedContext = {
    schema: SCHEMA,
    task: scrubTask(task, vault),
    mode,
    urlClass: graph.urlClass,
    title: graph.title,
    viewport: graph.viewport,
    elements,
    groups: graph.groups,
    regions,
    image: image ?? null,
    history,
  };

  return { context, applied, stats };
}

/**
 * Replaces matched spans in place, right-to-left so earlier offsets stay valid.
 * This is the "tight by construction" rule: eleven characters of an email are
 * replaced, not the paragraph containing it.
 */
function applySpans(
  raw: string,
  findings: Finding[],
  vault: Vault,
  elementId: string,
): { out: string; used: string[] } {
  const spans = findings
    .filter((f) => f.start != null && f.end != null)
    .sort((a, b) => b.start! - a.start!);

  let out = raw;
  const used: string[] = [];

  for (const f of spans) {
    const original = raw.slice(f.start!, f.end!);
    let replacement: string;
    if (f.fate === "drop") {
      replacement = "[REMOVED]";
    } else {
      replacement = vault.mint(original, f.cls, elementId);
      f.handle = replacement;
      used.push(replacement);
    }
    out = out.slice(0, f.start!) + replacement + out.slice(f.end!);
  }

  return { out: out.slice(0, 240), used };
}

/** Values the agent needs and that carry no personal information. */
function isSafeToEcho(el: RawElement): boolean {
  if (el.role === "password") return false;
  if (el.tag === "select") return true;
  if (el.type === "checkbox" || el.type === "radio") return true;
  if (el.type === "search") return true;
  return false;
}

/** The task string is user-authored and can contain PII too. */
function scrubTask(task: string, vault: Vault): string {
  // Deliberately conservative: only replace values already known to the vault,
  // so we never mangle the instruction itself.
  let out = task;
  for (const e of vault.entries()) {
    if (e.value.length < 4) continue;
    out = out.split(e.value).join(e.handle);
  }
  return out.slice(0, 500);
}
