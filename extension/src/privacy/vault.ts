/**
 * The vault. Lives only in service-worker memory — never chrome.storage, never
 * a network payload, cleared when the task ends.
 *
 * Handles are TYPED and STABLE: the same value always mints the same handle
 * within a task, so the server can see that two fields hold the same email
 * without ever learning the email.
 */
import type { PiiClass } from "@/shared/types";

export interface VaultEntry {
  handle: string;
  value: string;
  cls: PiiClass;
  originElementId: string;
  mintedAt: number;
}

const PREFIX: Record<PiiClass, string> = {
  password: "SECRET",
  otp: "OTP",
  apikey: "SECRET",
  email: "EMAIL",
  phone: "PHONE",
  person: "PERSON",
  address: "ADDR",
  card: "CARD",
  aadhaar: "AADHAAR",
  pan: "PAN",
  ifsc: "IFSC",
  upi: "UPI",
  dob: "DOB",
  face: "FACE",
  id_document: "IDDOC",
  document: "DOC",
  screenshot: "SCREEN",
  signature: "SIGN",
};

export class Vault {
  private byHandle = new Map<string, VaultEntry>();
  private byValue = new Map<string, string>();
  private counters = new Map<string, number>();

  /** Returns an existing handle for an identical value, or mints a new one. */
  mint(value: string, cls: PiiClass, originElementId: string): string {
    const k = `${cls}::${value}`;
    const existing = this.byValue.get(k);
    if (existing) return existing;

    const prefix = PREFIX[cls] ?? "PII";
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    const handle = `${prefix}_${n}`;

    this.byHandle.set(handle, { handle, value, cls, originElementId, mintedAt: Date.now() });
    this.byValue.set(k, handle);
    return handle;
  }

  get(handle: string): VaultEntry | undefined {
    return this.byHandle.get(handle);
  }

  /** Every stored plaintext — used by verifier check V2. */
  values(): string[] {
    return Array.from(this.byHandle.values()).map((e) => e.value).filter((v) => v.length >= 4);
  }

  entries(): VaultEntry[] {
    return Array.from(this.byHandle.values());
  }

  size(): number {
    return this.byHandle.size;
  }

  clear(): void {
    this.byHandle.clear();
    this.byValue.clear();
    this.counters.clear();
  }
}

/** `EMAIL_1` — the grammar the server is told about in its system prompt. */
export const HANDLE_RE = /\b(SECRET|OTP|EMAIL|PHONE|PERSON|ADDR|CARD|AADHAAR|PAN|IFSC|UPI|DOB|FACE|IDDOC)_\d+\b/g;

export function isHandle(s: string): boolean {
  HANDLE_RE.lastIndex = 0;
  const m = HANDLE_RE.exec(s);
  return !!m && m[0] === s.trim();
}
