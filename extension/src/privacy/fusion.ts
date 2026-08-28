/**
 * Fuses detector opinions into decisions.
 *
 * The evaluation grades recall AND precision (metric 2), and redaction
 * precision separately (metric 3). A blind union that redacts anything
 * ambiguous maximises recall and loses both of the others, so this is a
 * calibrated combine with an explicit middle band.
 */
import type { Detection, DetectorSource, Finding, PiiClass, RawElement } from "@/shared/types";
import { luhn, verhoeff } from "./checksums";

export const TAU_HIGH = 0.8;
export const TAU_LOW = 0.35;

/** Fate per class. Passwords and secrets are never handled, only removed. */
const FATE: Record<PiiClass, Finding["fate"]> = {
  password: "drop",
  otp: "drop",
  apikey: "drop",
  email: "substitute",
  phone: "substitute",
  person: "substitute",
  address: "substitute",
  card: "substitute",
  aadhaar: "substitute",
  pan: "substitute",
  ifsc: "substitute",
  upi: "substitute",
  dob: "substitute",
  face: "mask",
  id_document: "mask",
  document: "mask",
  screenshot: "mask",
  signature: "mask",
};

type Key = string;
const keyOf = (d: Detection) => `${d.elementId}|${d.field}|${d.start ?? -1}|${d.end ?? -1}|${d.cls}`;

export interface FusionInput {
  elements: RawElement[];
  detections: Detection[];
  /** Element ids the current task plausibly refers to — feeds task relevance. */
  taskTargets?: Set<string>;
}

export function fuse({ elements, detections, taskTargets }: FusionInput): Finding[] {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const groups = new Map<Key, Detection[]>();
  for (const d of detections) {
    const k = keyOf(d);
    const g = groups.get(k);
    if (g) g.push(d);
    else groups.set(k, [d]);
  }

  // A value repeated all over the page is boilerplate, not somebody's data.
  const repeats = countRepeats(elements, detections);

  const findings: Finding[] = [];

  for (const [, ds] of groups) {
    const first = ds[0];
    const el = byId.get(first.elementId);

    // Visual classes are whole-element regions; the text tie-break features
    // (label proximity, checksums, repetition) do not apply to pixels.
    if (["face", "id_document", "document", "signature", "screenshot", "chart", "icon"].includes(first.cls)) {
      const pv = 1 - ds.reduce((q, d) => q * (1 - clamp(d.p)), 1);
      if (pv < TAU_LOW) continue;
      findings.push({
        elementId: first.elementId,
        field: "element",
        cls: first.cls,
        p: pv,
        sources: Array.from(new Set(ds.map((d) => d.source))) as DetectorSource[],
        fate: "mask",
        reason: `visual region, p=${pv.toFixed(2)}`,
        bbox: first.bbox,
      });
      continue;
    }

    // If there is no DOM element, we cannot run text tie-breaks.
    if (!el) {
      let q = 1;
      for (const d of ds) q *= 1 - clamp(d.p);
      const p = 1 - q;
      if (p < TAU_LOW) continue;
      findings.push({
        elementId: first.elementId,
        field: first.field,
        cls: first.cls,
        p,
        sources: Array.from(new Set(ds.map((d) => d.source))) as DetectorSource[],
        fate: FATE[first.cls] ?? "substitute",
        reason: `raw spatial Noisy-OR p=${p.toFixed(2)}`,
        bbox: first.bbox,
      });
      continue;
    }

    // Noisy-OR over independent detector opinions.
    let q = 1;
    for (const d of ds) q *= 1 - clamp(d.p);
    let p = 1 - q;

    const sources = Array.from(new Set(ds.map((d) => d.source))) as DetectorSource[];
    let reason = `noisy-OR ${p.toFixed(2)} from ${sources.join("+")}`;

    if (p < TAU_LOW) continue; // keep verbatim

    if (p < TAU_HIGH) {
      const tb = tieBreak(first, el, ds, repeats, taskTargets);
      p = clamp(p + tb.delta);
      reason = `${reason}; tie-break ${tb.delta >= 0 ? "+" : ""}${tb.delta.toFixed(2)} (${tb.why})`;
      if (p < TAU_HIGH) continue; // resolved as safe
    }

    findings.push({
      elementId: first.elementId,
      start: first.start,
      end: first.end,
      field: first.field,
      cls: first.cls,
      p,
      sources,
      fate: FATE[first.cls] ?? "substitute",
      reason,
      bbox: first.bbox,
    });
  }

  // Element-wide drops (a password field) subsume any span inside them.
  const dropped = new Set(findings.filter((f) => f.fate === "drop" && f.field === "value").map((f) => f.elementId));
  return findings.filter((f) => !(dropped.has(f.elementId) && f.field === "value" && f.fate !== "drop"));
}

// ── the tie-break: where precision is won ──────────────────────────────────

interface TieResult { delta: number; why: string }

function tieBreak(
  d: Detection,
  el: RawElement,
  all: Detection[],
  repeats: Map<string, number>,
  taskTargets?: Set<string>,
): TieResult {
  const parts: string[] = [];
  let delta = 0;

  const raw = (d.field === "value" ? el.value : el.text) ?? "";
  const span = d.start != null && d.end != null ? raw.slice(d.start, d.end) : raw;

  // 1. Label proximity — the single strongest cheap feature.
  //    "Order number: 1234567890" vs "Phone: 9876543210" are identical to a
  //    regex and completely different to a label.
  const context = [el.label, el.name, el.placeholder, leftOf(raw, d.start)].filter(Boolean).join(" ").toLowerCase();
  const pos = POSITIVE[d.cls];
  const neg = NEGATIVE[d.cls];
  if (pos && pos.test(context)) {
    delta += 0.3;
    parts.push("label supports");
  } else if (neg && neg.test(context)) {
    delta -= 0.4;
    parts.push("label contradicts");
  }

  // 2. Checksum outcome as hard evidence, either way.
  if (d.cls === "aadhaar") {
    if (verhoeff(span)) { delta += 0.25; parts.push("Verhoeff ok"); }
    else { delta -= 0.5; parts.push("Verhoeff fail"); }
  }
  if (d.cls === "card") {
    if (luhn(span)) { delta += 0.2; parts.push("Luhn ok"); }
    else { delta -= 0.5; parts.push("Luhn fail"); }
  }

  // 3. Container role — a form field is far more likely to hold real PII than
  //    a heading or a table of reference data.
  if (/^(input|textarea|select)$/.test(el.tag)) {
    delta += 0.12;
    parts.push("form field");
  } else if (el.role === "heading") {
    delta -= 0.15;
    parts.push("heading");
  }

  // 4. Repetition — boilerplate, not personal data.
  const n = repeats.get(norm(span)) ?? 1;
  if (n >= 4) {
    delta -= 0.25;
    parts.push(`repeated ${n}x`);
  }

  // 5. Task relevance — redacting something the task never touches is free, so
  //    lean toward redacting; being wrong about the actual target is costly.
  if (taskTargets?.size) {
    if (taskTargets.has(el.id)) { delta -= 0.08; parts.push("task target"); }
    else { delta += 0.06; parts.push("off-task"); }
  }

  // 6. Corroboration across independent detectors.
  const distinct = new Set(all.map((a) => a.source)).size;
  if (distinct >= 2) {
    delta += 0.1;
    parts.push(`${distinct} detectors`);
  }

  return { delta, why: parts.join(", ") || "no signal" };
}

const POSITIVE: Partial<Record<PiiClass, RegExp>> = {
  phone: /phone|mobile|contact|tel|whatsapp|call/,
  email: /e-?mail/,
  person: /name|applicant|candidate|holder|student/,
  address: /address|street|city|pin|postal|zip|residence/,
  card: /card|credit|debit|cvv|payment/,
  aadhaar: /aadhaar|aadhar|uid/,
  pan: /pan|income\s*tax/,
  dob: /birth|dob|born/,
  otp: /otp|code|verification|verify/,
  ifsc: /ifsc|bank|branch/,
  upi: /upi|vpa|pay/,
};

const NEGATIVE: Partial<Record<PiiClass, RegExp>> = {
  phone: /order|invoice|tracking|awb|reference|txn|transaction|ticket|receipt|gst|pin\s*code|serial/,
  card: /order|invoice|tracking|reference|awb|serial|imei/,
  aadhaar: /order|invoice|tracking|reference|serial|imei|account\s*number/,
  dob: /published|updated|posted|expires|valid|issued|delivery/,
  otp: /price|amount|qty|quantity|year|pin\s*code|rupees|total/,
  person: /company|organisation|organization|brand|product|department/,
};

function leftOf(text: string, start?: number): string {
  if (start == null) return "";
  return text.slice(Math.max(0, start - 40), start);
}

function countRepeats(elements: RawElement[], detections: Detection[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const d of detections) {
    const el = elements.find((e) => e.id === d.elementId);
    if (!el) continue;
    const raw = (d.field === "value" ? el.value : el.text) ?? "";
    const span = d.start != null && d.end != null ? raw.slice(d.start, d.end) : raw;
    const k = norm(span);
    if (!k) continue;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();
const clamp = (p: number) => Math.max(0, Math.min(1, p));
