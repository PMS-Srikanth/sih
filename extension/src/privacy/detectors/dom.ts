/**
 * DOM / accessibility-tree detector.
 *
 * The cheapest and most certain of the four. `<input type="password">` needs no
 * AI to classify, and running a vision model to discover it would waste the
 * resource budget the evaluation grades.
 */
import type { Detection, PiiClass, RawElement } from "@/shared/types";

/** autocomplete tokens are a spec-defined, unambiguous signal. */
const AUTOCOMPLETE: Record<string, PiiClass> = {
  "current-password": "password",
  "new-password": "password",
  "one-time-code": "otp",
  email: "email",
  tel: "phone",
  "tel-national": "phone",
  "tel-local": "phone",
  name: "person",
  "given-name": "person",
  "family-name": "person",
  "additional-name": "person",
  "cc-number": "card",
  "cc-csc": "card",
  "cc-exp": "card",
  "cc-name": "person",
  "street-address": "address",
  "address-line1": "address",
  "address-line2": "address",
  "postal-code": "address",
  bday: "dob",
};

/** Keyword → class, matched against name / label / placeholder / id / type. */
const KEYWORDS: Array<[RegExp, PiiClass, number]> = [
  [/\b(pass(word|wd|phrase)|pwd)\b/i, "password", 0.97],
  [/\b(otp|one[\s-]?time|verification\s*code|auth\s*code)\b/i, "otp", 0.93],
  [/\b(api[\s-]?key|secret|token|access[\s-]?key|private[\s-]?key)\b/i, "apikey", 0.93],
  [/\b(e[\s-]?mail|email\s*address)\b/i, "email", 0.9],
  [/\b(phone|mobile|contact\s*(no|number)|whatsapp)\b/i, "phone", 0.88],
  [/\b(full\s*name|first\s*name|last\s*name|your\s*name|applicant\s*name|surname)\b/i, "person", 0.85],
  [/\b(address|street|city|pin\s*code|postal|zip)\b/i, "address", 0.8],
  [/\b(card\s*(no|number)|credit\s*card|debit\s*card|cvv|cvc)\b/i, "card", 0.93],
  [/\b(aadhaar|aadhar|uid(ai)?)\b/i, "aadhaar", 0.94],
  [/\b(pan(\s*card|\s*number)?)\b/i, "pan", 0.9],
  [/\b(ifsc)\b/i, "ifsc", 0.9],
  [/\b(upi(\s*id)?|vpa)\b/i, "upi", 0.9],
  [/\b(date\s*of\s*birth|dob|birth\s*date)\b/i, "dob", 0.88],
];

/**
 * Images whose surrounding semantics say "identity document" or "photo of a
 * person". The DOM cannot see inside an <img> — this is a deliberately
 * conservative stand-in until the vision model lands, and it is why the PS
 * allows "DOM tags or any other method". A ViT replaces the guesswork; these
 * keywords never become the whole story.
 */
const IMAGE_CONTEXT: Array<[RegExp, PiiClass, number]> = [
  [/\b(aadhaar|aadhar|pan\s*card|passport|licen[cs]e|voter\s*id|identity|id\s*(card|proof)|kyc)\b/i, "id_document", 0.86],
  [/\b(photo|photograph|portrait|selfie|profile\s*(pic|picture|photo)|avatar|headshot)\b/i, "face", 0.8],
  [/\b(signature|signed)\b/i, "id_document", 0.82],
];

export function detectDom(elements: RawElement[]): Detection[] {
  const out: Detection[] = [];
  const byId = new Map(elements.map((e) => [e.id, e]));

  for (const el of elements) {
    // ── images: classify from surrounding semantics, mask the whole region ──
    if (el.role === "image" || el.tag === "img") {
      const near = [el.name, el.label, el.placeholder, byId.get(el.parent ?? "")?.name]
        .filter(Boolean)
        .join(" ");
      for (const [re, cls, p] of IMAGE_CONTEXT) {
        if (!re.test(near)) continue;
        out.push({
          elementId: el.id,
          field: "element",
          cls,
          p,
          source: "dom",
          evidence: `image context "${near.slice(0, 40)}"`,
        });
        break;
      }
      continue;
    }

    // 1. type="password" — the strongest signal on the web.
    if (el.role === "password" || el.type === "password") {
      out.push({
        elementId: el.id,
        field: "value",
        cls: "password",
        p: 1.0,
        source: "dom",
        evidence: 'input[type="password"]',
      });
      continue;
    }

    // 2. autocomplete tokens.
    const ac = (el.autocomplete || "").toLowerCase().split(/\s+/).pop() || "";
    if (AUTOCOMPLETE[ac]) {
      out.push({
        elementId: el.id,
        field: "value",
        cls: AUTOCOMPLETE[ac],
        p: 0.95,
        source: "dom",
        evidence: `autocomplete="${ac}"`,
      });
      continue;
    }

    // 3. input types that declare their own semantics.
    if (el.type === "email" || el.type === "tel") {
      out.push({
        elementId: el.id,
        field: "value",
        cls: el.type === "email" ? "email" : "phone",
        p: 0.93,
        source: "dom",
        evidence: `input[type="${el.type}"]`,
      });
      continue;
    }

    // 4. keyword match over the element's human-facing labels.
    const hay = [el.name, el.label, el.placeholder, el.type].filter(Boolean).join(" ");
    if (!hay) continue;
    for (const [re, cls, p] of KEYWORDS) {
      if (!re.test(hay)) continue;
      const isField = /^(input|textarea|select)$/.test(el.tag);
      out.push({
        elementId: el.id,
        field: isField ? "value" : "text",
        cls,
        p: isField ? p : p - 0.25, // a heading saying "Email" is a label, not a value
        source: "dom",
        evidence: `label match "${re.source.slice(0, 28)}"`,
      });
      break;
    }
  }

  return out;
}

/**
 * Where a handle of a given class is allowed to be written back.
 * Prevents a prompt-injected page from getting the agent to type your email
 * into a public comment box.
 */
export function isAllowedSink(cls: PiiClass, el: RawElement): boolean {
  if (!/^(input|textarea|select)$/.test(el.tag)) return false;
  if (el.role === "password") return cls === "password" || cls === "otp";

  const hay = [el.name, el.label, el.placeholder, el.autocomplete, el.type].filter(Boolean).join(" ").toLowerCase();
  const ac = (el.autocomplete || "").toLowerCase();
  if (AUTOCOMPLETE[ac] === cls) return true;

  const need: Partial<Record<PiiClass, RegExp>> = {
    email: /e[\s-]?mail/,
    phone: /phone|mobile|contact|tel|whatsapp/,
    person: /name/,
    address: /address|street|city|pin|postal|zip/,
    card: /card|cc-|cvv|cvc/,
    aadhaar: /aadhaar|aadhar|uid/,
    pan: /pan/,
    ifsc: /ifsc/,
    upi: /upi|vpa/,
    dob: /birth|dob/,
    otp: /otp|code/,
    password: /pass|pwd/,
  };
  const re = need[cls];
  if (!re) return false;
  // A large free-text area is never a typed-PII sink, whatever it is labelled.
  if (el.tag === "textarea" && el.bbox.h > 120) return false;
  return re.test(hay);
}
