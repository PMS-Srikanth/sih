/**
 * The gate. Shares no detection code path with the redactor by design — it
 * inspects the SERIALISED BYTES that are about to be sent, not the object model
 * the redactor produced. If the redactor has a bug, this is what catches it.
 *
 * PS: "Only this anonymized, unidentifiable data should be transmitted."
 */
import type { SanitizedContext, VerifierCheck } from "@/shared/types";
import { entropy, fnv1a } from "./checksums";
import { scanPatterns } from "./patterns";
import { HANDLE_RE, Vault } from "./vault";

export const VERIFIER_VERSION = "v1.0";

/** Keys permitted on the wire. Deny-by-default: a field added later cannot leak. */
const ALLOWED_KEYS = new Set([
  "schema", "task", "mode", "urlClass", "title", "viewport",
  "w", "h", "scrollY", "docH",
  "elements", "id", "role", "tag", "type", "name", "bbox", "visible", "offscreen", "enabled",
  "parent", "conf", "src", "holds", "wants", "sensitive", "text",
  "groups", "kind", "children", "x", "y",
  "regions", "cls", "state",
  "image", "history", "action", "target", "result", "note",
]);

export interface VerifyResult {
  passed: boolean;
  checks: VerifierCheck[];
  payload: string;
  bytes: number;
  hash: string;
}

/** Outcome of re-reading the masked bitmap, from the capture module. */
export interface MaskAudit {
  ok: boolean;
  checked: number;
  failed: number;
}

export function verify(context: SanitizedContext, vault: Vault, masks?: MaskAudit | null): VerifyResult {
  const payload = JSON.stringify(context);
  const checks: VerifierCheck[] = [];

  // ── V1 · re-scan the serialised bytes ────────────────────────────────────
  // Deliberately over the string, not the object: anything the redactor forgot
  // to walk — a URL, a title, an alt attribute — is inside this string too.
  const hits = scanPatterns(stripHandles(payload)).filter((h) => {
    if (h.p >= 0.85) return true;
    if (h.cls === "phone" && h.p >= 0.70) {
      // Look for "call/phone" in the 60 bytes preceding the hit in the payload
      const ctx = stripHandles(payload).slice(Math.max(0, h.start - 60), h.start).toLowerCase();
      return /phone|mobile|contact|tel|whatsapp|call/.test(ctx);
    }
    return false;
  });
  checks.push({
    id: "V1",
    name: "Re-scan serialised bytes",
    passed: hits.length === 0,
    detail: hits.length ? `${hits.length} pattern hit(s): ${hits.slice(0, 3).map((h) => h.cls).join(", ")}` : "clean",
  });

  // ── V2 · vault cross-check ───────────────────────────────────────────────
  const leaked = vault.values().filter((v) => payload.includes(v));
  checks.push({
    id: "V2",
    name: "Vault cross-check",
    passed: leaked.length === 0,
    detail: leaked.length ? `${leaked.length} vault value(s) present verbatim` : `${vault.size()} handle(s), none leaked`,
  });

  // ── V3 · re-read the masked bitmap ───────────────────────────────────────
  // Every region we were told to cover is sampled again in the OUTGOING buffer.
  // A mask that silently failed to paint is caught here, before transmission.
  checks.push({
    id: "V3",
    name: "Masks verified on the bitmap",
    passed: masks ? masks.ok : true,
    detail: masks
      ? masks.ok
        ? `${masks.checked} region(s) re-read, all opaque`
        : `${masks.failed} of ${masks.checked} region(s) still show pixels`
      : "no frame captured this step",
  });

  // ── V4 · entropy sweep ───────────────────────────────────────────────────
  const secrets = highEntropyStrings(payload);
  checks.push({
    id: "V4",
    name: "Entropy sweep",
    passed: secrets.length === 0,
    detail: secrets.length ? `${secrets.length} unexplained high-entropy string(s)` : "clean",
  });

  // ── V5 · deny-by-default serialiser ──────────────────────────────────────
  const unknown = unknownKeys(context);
  checks.push({
    id: "V5",
    name: "Key whitelist",
    passed: unknown.length === 0,
    detail: unknown.length ? `unexpected key(s): ${unknown.slice(0, 5).join(", ")}` : "all keys expected",
  });

  return {
    passed: checks.every((c) => c.passed),
    checks,
    payload,
    bytes: new TextEncoder().encode(payload).length,
    hash: fnv1a(payload),
  };
}

/** Handles are supposed to be there; don't let them trip the pattern scan. */
function stripHandles(s: string): string {
  HANDLE_RE.lastIndex = 0;
  return s.replace(HANDLE_RE, " ");
}

function highEntropyStrings(payload: string): string[] {
  const out: string[] = [];
  const re = /"([A-Za-z0-9_\-+/=.]{20,})"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(payload))) {
    const s = m[1];
    if (isHandleLike(s)) continue;
    if (/^cordon\//.test(s)) continue;
    if (/^(el|g)_\d+$/.test(s)) continue;
    if (/\s/.test(s)) continue;
    if (entropy(s) >= 4.2) out.push(s);
  }
  return out;
}

function isHandleLike(s: string): boolean {
  HANDLE_RE.lastIndex = 0;
  return HANDLE_RE.test(s);
}

function unknownKeys(obj: unknown, depth = 0): string[] {
  if (depth > 6 || obj === null || typeof obj !== "object") return [];
  const out: string[] = [];
  if (Array.isArray(obj)) {
    for (const v of obj) out.push(...unknownKeys(v, depth + 1));
    return out;
  }
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (!ALLOWED_KEYS.has(k)) out.push(k);
    out.push(...unknownKeys(v, depth + 1));
  }
  return Array.from(new Set(out));
}

/**
 * V6 · escalation. On failure the redaction is hardened — every substitution
 * becomes a removal — and the payload is re-verified. Two attempts, then refuse.
 */
export function harden(context: SanitizedContext): SanitizedContext {
  return {
    ...context,
    elements: context.elements.map((e) => {
      if (!e.holds) return e;
      return { ...e, holds: undefined, sensitive: true };
    }),
    task: context.task,
  };
}
