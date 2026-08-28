/**
 * Checksums are how precision is recovered cheaply.
 *
 * "Order number: 1234567890" and "Phone: 9876543210" are identical to a regex.
 * A 12-digit string that fails Verhoeff is NOT an Aadhaar; a 16-digit string
 * that fails Luhn is NOT a card. Hard negative evidence, ~0 cost.
 */

/** Luhn — payment card numbers. */
export function luhn(digits: string): boolean {
  const s = digits.replace(/\D/g, "");
  if (s.length < 12 || s.length > 19) return false;
  let sum = 0;
  let dbl = false;
  for (let i = s.length - 1; i >= 0; i--) {
    let d = s.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

// Verhoeff — the checksum the UIDAI actually uses for Aadhaar.
const D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

export function verhoeff(digits: string): boolean {
  const s = digits.replace(/\D/g, "");
  if (s.length !== 12) return false;
  if (s[0] === "0" || s[0] === "1") return false; // Aadhaar never starts 0 or 1
  let c = 0;
  const rev = s.split("").reverse();
  for (let i = 0; i < rev.length; i++) {
    c = D[c][P[i % 8][rev[i].charCodeAt(0) - 48]];
  }
  return c === 0;
}

/** PAN — AAAAA9999A, with a valid 4th-character holder type. */
export function panValid(s: string): boolean {
  const v = s.toUpperCase().trim();
  if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(v)) return false;
  return "ABCFGHLJPTK".includes(v[3]);
}

/** IFSC — 4 letters, a mandatory 0, then 6 alphanumerics. */
export function ifscValid(s: string): boolean {
  return /^[A-Z]{4}0[A-Z0-9]{6}$/.test(s.toUpperCase().trim());
}

/** Indian mobile numbers start 6–9 and are exactly 10 digits. */
export function indianMobile(s: string): boolean {
  const d = s.replace(/\D/g, "");
  const n = d.length > 10 && d.startsWith("91") ? d.slice(2) : d;
  return /^[6-9]\d{9}$/.test(n);
}

/** Shannon entropy per character — used to spot secrets no pattern covers. */
export function entropy(s: string): number {
  if (!s.length) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Non-cryptographic digest, only for receipt display and cache keys. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
