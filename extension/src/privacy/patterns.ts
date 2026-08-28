/**
 * Pattern detectors. Every pattern that has a checksum uses it, because the
 * evaluation grades precision as heavily as recall.
 */
import type { PiiClass } from "@/shared/types";
import { luhn, verhoeff, panValid, ifscValid, indianMobile, entropy } from "./checksums";

export interface PatternHit {
  cls: PiiClass;
  start: number;
  end: number;
  text: string;
  /** Base probability before context. Checksum-backed patterns start high. */
  p: number;
  evidence: string;
}

interface Rule {
  cls: PiiClass;
  re: RegExp;
  /** Return null to reject the match outright (checksum failed). */
  score: (m: string) => { p: number; evidence: string } | null;
}

const RULES: Rule[] = [
  {
    cls: "email",
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    score: () => ({ p: 0.97, evidence: "email pattern" }),
  },
  {
    cls: "upi",
    re: /\b[a-zA-Z0-9._-]{3,}@(?:okhdfcbank|okicici|oksbi|okaxis|paytm|ybl|ibl|axl|upi|apl)\b/g,
    score: () => ({ p: 0.95, evidence: "UPI handle" }),
  },
  {
    cls: "aadhaar",
    re: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,
    score: (m) =>
      verhoeff(m)
        ? { p: 0.96, evidence: "12 digits, Verhoeff valid" }
        : null, // fails the UIDAI checksum — not an Aadhaar
  },
  {
    cls: "pan",
    re: /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g,
    score: (m) => (panValid(m) ? { p: 0.95, evidence: "PAN format + holder type" } : null),
  },
  {
    cls: "ifsc",
    re: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g,
    score: (m) => (ifscValid(m) ? { p: 0.9, evidence: "IFSC format" } : null),
  },
  {
    cls: "card",
    re: /\b(?:\d[ -]?){12,19}\b/g,
    score: (m) => {
      const d = m.replace(/\D/g, "");
      if (d.length < 13 || d.length > 19) return null;
      return luhn(d) ? { p: 0.94, evidence: `${d.length} digits, Luhn valid` } : null;
    },
  },
  {
    cls: "phone",
    re: /(?:\+?91[\s-]?)?\b[6-9]\d{9}\b|\+\d{1,3}[\s-]?\d{6,12}\b/g,
    score: (m) =>
      indianMobile(m)
        ? { p: 0.72, evidence: "IN mobile, starts 6-9" } // context decides; order IDs collide
        : { p: 0.55, evidence: "E.164-ish" },
  },
  {
    cls: "dob",
    re: /\b(?:0?[1-9]|[12]\d|3[01])[\/\-.](?:0?[1-9]|1[0-2])[\/\-.](?:19|20)\d{2}\b/g,
    score: () => ({ p: 0.6, evidence: "date, DOB-shaped" }),
  },
  {
    cls: "apikey",
    re: /\b(?:sk|pk|api|key|token|bearer)[-_][A-Za-z0-9_-]{16,}\b/gi,
    score: () => ({ p: 0.93, evidence: "prefixed secret" }),
  },
  {
    cls: "apikey",
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g,
    score: () => ({ p: 0.97, evidence: "JWT" }),
  },
  {
    cls: "otp",
    re: /\b\d{4,8}\b/g,
    // Only ever fires via context (a nearby "OTP"/"code" label). Base is low
    // enough that it can never redact on its own.
    score: () => ({ p: 0.18, evidence: "short numeric, OTP-shaped" }),
  },
];

/** Generic high-entropy secret sweep — catches what no pattern names. */
export function entropyHits(text: string): PatternHit[] {
  const out: PatternHit[] = [];
  const re = /\b[A-Za-z0-9_\-+/=]{24,}\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const h = entropy(m[0]);
    if (h >= 3.9) {
      out.push({
        cls: "apikey",
        start: m.index,
        end: m.index + m[0].length,
        text: m[0],
        p: 0.6,
        evidence: `entropy ${h.toFixed(2)} bits/char`,
      });
    }
  }
  return out;
}

/** Longest-match-wins so a card inside a longer digit run doesn't double-fire. */
export function scanPatterns(text: string): PatternHit[] {
  if (!text) return [];
  const hits: PatternHit[] = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(text))) {
      const s = rule.score(m[0]);
      if (!s) continue;
      hits.push({
        cls: rule.cls,
        start: m.index,
        end: m.index + m[0].length,
        text: m[0],
        p: s.p,
        evidence: s.evidence,
      });
      if (m[0].length === 0) rule.re.lastIndex++;
    }
  }
  hits.push(...entropyHits(text));

  hits.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const kept: PatternHit[] = [];
  for (const h of hits) {
    const overlap = kept.find((k) => h.start < k.end && k.start < h.end);
    if (!overlap) kept.push(h);
    else if (h.p > overlap.p + 0.1 && h.end - h.start >= overlap.end - overlap.start) {
      kept[kept.indexOf(overlap)] = h;
    }
  }
  return kept;
}
