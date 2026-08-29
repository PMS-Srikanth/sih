/**
 * E3 grounding and E4 execution, in the page's isolated world.
 *
 * Grounding is the check most browser agents skip: an element id resolved three
 * hundred milliseconds ago may now point at something else entirely. We re-derive
 * the stability signature and refuse to act on a mismatch.
 */
import type { AgentAction, RawElement } from "@/shared/types";
import { signature } from "@/perception/dom-graph";
import { actorAct, actorMoveTo, actorResult, setActorEnabled, takeVisualMs } from "./actor";

export interface ExecOutcome {
  ok: boolean;
  note?: string;
  postSig?: string;
  /** Milliseconds of deliberate animation, so the caller can subtract it. */
  visualMs?: number;
  /**
   * Post-condition for a fill: the field was read back and compared with what
   * we intended to type. Only the VERDICT travels — never the value, and never
   * the value's content in any form. A length is reported so a truncating
   * field (maxlength) is distinguishable from an ignored one.
   */
  ingest?: {
    verified: boolean;
    expectedLen: number;
    actualLen: number;
    reason: string;
  };
}

/** Element ids are only meaningful against the graph that produced them. */
let registry = new Map<string, Element>();
let registryMeta = new Map<string, RawElement>();

export function registerGraph(elements: RawElement[], nodes: Map<string, Element>): void {
  registry = nodes;
  registryMeta = new Map(elements.map((e) => [e.id, e]));
}

export function lookup(id: string): Element | undefined {
  return registry.get(id);
}

export async function execute(
  action: AgentAction,
  resolved?: string,
  expectSig?: string,
  showAgent = true,
): Promise<ExecOutcome> {
  // Fast mode promises the lowest latency it can manage, so it does not pay for
  // a visualisation nobody asked it to draw.
  setActorEnabled(showAgent);
  takeVisualMs(); // discard anything left over from a previous action
  const out = await run(action, resolved, expectSig);
  return { ...out, visualMs: takeVisualMs() };
}

async function run(action: AgentAction, resolved?: string, expectSig?: string): Promise<ExecOutcome> {
  if (action.kind === "wait") {
    await sleep(Number(action.value) || 400);
    return { ok: true, note: "waited" };
  }

  if (action.kind === "scroll") {
    const by = Number(action.value) || 600;
    window.scrollBy({ top: by, behavior: "instant" as ScrollBehavior });
    await sleep(120);
    return { ok: true, note: `scrolled ${by}px` };
  }

  if (action.kind === "navigate") {
    if (!action.value) return { ok: false, note: "no URL" };
    location.href = action.value;
    return { ok: true, note: "navigating" };
  }

  if (action.kind === "done" || action.kind === "extract") {
    return { ok: true, note: action.kind };
  }

  const id = action.target;
  if (!id && action.kind !== "clear") return { ok: false, note: "action has no target" };

  const el = id ? registry.get(id) : undefined;
  const meta = id ? registryMeta.get(id) : undefined;
  if (id && (!el || !meta)) return { ok: false, note: `${id} is not in the current graph` };
  if (id && el && !el.isConnected) return { ok: false, note: `${id} has been removed from the document` };

  // ── E3 · grounding ───────────────────────────────────────────────────────
  let nowSig: string | undefined;
  if (el && meta) {
    const r = el.getBoundingClientRect();
    nowSig = signature({
      role: meta.role,
      name: meta.name,
      tag: meta.tag,
      bbox: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
    });
    const want = expectSig ?? meta.sig;
    if (want && nowSig !== want) {
      return { ok: false, note: "grounding failed — the page changed, re-perceiving instead of clicking", postSig: nowSig };
    }
  }

  // ── E4 · execute ─────────────────────────────────────────────────────────
  switch (action.kind) {
    case "click": {
      if (!el) return { ok: false, note: "click needs a target" };
      (el as HTMLElement).scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
      await sleep(40);

      // Show the move before making it. The cursor arriving is what tells a
      // watcher which control the agent chose, and why the page then changed.
      const label = meta?.name || id || "control";
      await actorMoveTo(el, "click", label);
      await actorAct("tap");

      (el as HTMLElement).focus?.();
      (el as HTMLElement).click();
      await sleep(160);
      await actorResult(true, "clicked", label);
      return { ok: true, note: `clicked ${meta?.name || id}`, postSig: nowSig };
    }

    case "fill": {
      if (!el) return { ok: false, note: "fill needs a target" };
      if (resolved == null) return { ok: false, note: "fill without a resolved value" };

      // The caption names the FIELD, never the value. The point of the
      // visualiser is to show the agent working, not to put someone’s Aadhaar
      // number on a projector.
      const label = meta?.name || id || "field";
      (el as HTMLElement).scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
      await sleep(40);
      await actorMoveTo(el, "fill", label);
      await actorAct("type");

      const ok = setFieldValue(el, resolved);
      if (!ok) {
        await actorResult(false, "failed", `${label} is not fillable`);
        return { ok: false, note: "element is not a fillable field" };
      }

      // Let any framework re-render settle before believing what we read.
      await sleep(90);
      const ingest = checkIngestion(el, resolved);
      await actorResult(
        ingest.verified,
        ingest.verified ? "verified" : "not stored",
        ingest.verified ? `${label} — read back and matched` : `${label} — ${ingest.reason}`,
      );

      return {
        ok: ingest.verified,
        note: ingest.verified
          ? `filled ${meta?.name || id} — value verified in the field`
          : `fill did not stick in ${meta?.name || id}: ${ingest.reason}`,
        postSig: nowSig,
        ingest,
      };
    }

    case "select": {
      if (!el) return { ok: false, note: "select needs a target" };
      if (resolved == null) return { ok: false, note: "select without a value" };
      const sel = el as HTMLSelectElement;
      if (sel.tagName !== "SELECT") return { ok: false, note: "target is not a <select>" };
      const opt = Array.from(sel.options).find(
        (o) => o.value === resolved || o.text.trim().toLowerCase() === resolved.trim().toLowerCase(),
      );
      if (!opt) return { ok: false, note: `no option matching "${resolved}"` };
      const label = meta?.name || id || "list";
      await actorMoveTo(el, "select", label);
      await actorAct("tap");
      sel.value = opt.value;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      await actorResult(true, "selected", `${label} → ${opt.text}`);
      return { ok: true, note: `selected ${opt.text}`, postSig: nowSig };
    }

    case "clear": {
      // "Remove my data from this form" has to mean all of it. The previous
      // selector took inputs and textareas only, so dropdowns, checkboxes and
      // radios kept their values and the form still held personal data after
      // the agent reported success.
      const targets = el
        ? [el]
        : Array.from(
            document.querySelectorAll<HTMLElement>(
              "input:not([type='hidden']):not([type='submit']):not([type='button'])" +
                ":not([type='reset']):not([type='image'])," +
                "textarea, select",
            ),
          );

      let cleared = 0;
      let failed = 0;
      let skipped = 0;

      for (const t of targets) {
        const tag = t.tagName.toLowerCase();
        const type = (t as HTMLInputElement).type;

        // A disabled or read-only field is not ours to change, and counting it
        // as a failure would report a problem that does not exist.
        if ((t as HTMLInputElement).disabled || (t as HTMLInputElement).readOnly) {
          skipped++;
          continue;
        }

        if (type === "checkbox" || type === "radio") {
          const box = t as HTMLInputElement;
          if (box.checked) {
            box.checked = false;
            box.dispatchEvent(new Event("input", { bubbles: true }));
            box.dispatchEvent(new Event("change", { bubbles: true }));
            cleared++;
          }
          continue;
        }

        if (tag === "select") {
          const sel = t as HTMLSelectElement;
          if (!sel.value) continue; // already on its placeholder
          // Prefer an explicit empty-valued option; otherwise the first one,
          // which is the conventional "Select…" placeholder.
          const blank = Array.from(sel.options).find((o) => o.value === "");
          sel.selectedIndex = blank ? blank.index : 0;
          sel.dispatchEvent(new Event("input", { bubbles: true }));
          sel.dispatchEvent(new Event("change", { bubbles: true }));
          cleared++;
          continue;
        }

        if (!(t as HTMLInputElement).value) continue; // nothing to remove
        if (setFieldValue(t, "")) {
          const ingest = checkIngestion(t, "");
          if (ingest.verified) cleared++;
          else failed++;
        } else {
          failed++;
        }
      }

      const note =
        cleared === 0 && failed === 0
          ? "nothing to clear — every field was already empty"
          : `cleared ${cleared} field${cleared === 1 ? "" : "s"}` +
            (failed ? `, ${failed} would not clear` : "") +
            (skipped ? `, ${skipped} read-only` : "");

      return { ok: failed === 0, note, postSig: nowSig };
    }

    default:
      return { ok: false, note: `unsupported action ${action.kind}` };
  }
}

/**
 * Did the value actually land, and is it the value we meant?
 *
 * Typing into a field is not the same as the field holding the value: React can
 * revert it, a controlled component can reformat it, `maxlength` can truncate
 * it, and an input mask can rewrite it entirely. An agent that assumes success
 * fills half a form wrongly and submits it.
 *
 * The comparison happens here, in the page's isolated world, and only the
 * verdict leaves. The value itself is never put into a message or a log.
 */
function checkIngestion(el: Element, expected: string): NonNullable<ExecOutcome["ingest"]> {
  return compareIngestion(readFieldValue(el), expected);
}

/** Pure, so the failure modes can be tested without a browser. */
export function compareIngestion(actual: string, expected: string): NonNullable<ExecOutcome["ingest"]> {
  const base = { expectedLen: expected.length, actualLen: actual.length };

  if (actual === expected) {
    return { ...base, verified: true, reason: "exact match" };
  }
  if (actual.length === 0) {
    return { ...base, verified: false, reason: "field is still empty — the framework reverted it" };
  }
  // Masked and formatted inputs legitimately differ: "9876543210" may become
  // "98765 43210". Compare on alphanumerics before calling it a failure.
  const strip = (s: string) => s.replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (strip(actual) === strip(expected)) {
    return { ...base, verified: true, reason: "match after formatting" };
  }
  if (expected.startsWith(actual) && actual.length > 0) {
    return { ...base, verified: false, reason: `truncated to ${actual.length} of ${expected.length} chars` };
  }
  return { ...base, verified: false, reason: "field holds something different" };
}

function readFieldValue(el: Element): string {
  const tag = el.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") {
    return (el as HTMLInputElement).value ?? "";
  }
  if ((el as HTMLElement).isContentEditable) return (el as HTMLElement).textContent ?? "";
  return "";
}

/**
 * React and other frameworks track the value through a property descriptor, so a
 * plain `el.value = x` is silently reverted on the next render. Going through the
 * native setter and then dispatching input+change is what actually sticks.
 */
function setFieldValue(el: Element, value: string): boolean {
  const tag = el.tagName.toLowerCase();

  if (tag === "input" || tag === "textarea") {
    const proto = tag === "input" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    (el as HTMLElement).focus();
    if (setter) setter.call(el, value);
    else (el as HTMLInputElement).value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  if ((el as HTMLElement).isContentEditable) {
    (el as HTMLElement).focus();
    (el as HTMLElement).textContent = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }

  return false;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
