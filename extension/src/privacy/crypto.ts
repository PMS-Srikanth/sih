/**
 * Encryption for the local profile.
 *
 * PBKDF2-SHA256 → AES-256-GCM. The passphrase is never stored. The derived key
 * lives in `chrome.storage.session`, which is memory-backed and cleared when the
 * browser closes — so the profile is encrypted at rest on disk, and the key is
 * gone the moment Chrome exits.
 *
 * The key is marked extractable so it can be cached in session storage across
 * service-worker restarts (MV3 kills the worker after ~30s idle, and re-typing a
 * passphrase every 30 seconds is the kind of friction that makes people turn
 * encryption off). Session storage is never written to disk and is not reachable
 * from content scripts.
 */

const ITERATIONS = 310_000; // OWASP guidance for PBKDF2-SHA256
const SALT_BYTES = 16;
const IV_BYTES = 12;
const CHECK_PLAINTEXT = "cordon-unlock-ok";

export interface Sealed {
  iv: string;
  ct: string;
}

export interface VaultEnvelope {
  v: 1;
  salt: string;
  iterations: number;
  /** Encrypts a known constant, so a wrong passphrase fails fast and cleanly. */
  check: Sealed;
  data: Sealed | null;
}

// ── base64 ─────────────────────────────────────────────────────────────────

function toB64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ── key derivation ─────────────────────────────────────────────────────────

export async function deriveKey(passphrase: string, salt: Uint8Array, iterations = ITERATIONS): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
}

export function randomSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(SALT_BYTES));
}

// ── seal / open ────────────────────────────────────────────────────────────

export async function seal(key: CryptoKey, plaintext: string): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    new TextEncoder().encode(plaintext),
  );
  return { iv: toB64(iv), ct: toB64(ct) };
}

/** Returns null when the key is wrong — GCM authentication fails, it does not
 *  silently produce garbage. */
export async function open(key: CryptoKey, sealed: Sealed): Promise<string | null> {
  try {
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromB64(sealed.iv) as BufferSource },
      key,
      fromB64(sealed.ct) as BufferSource,
    );
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

// ── envelope ───────────────────────────────────────────────────────────────

export async function createEnvelope(passphrase: string): Promise<{ envelope: VaultEnvelope; key: CryptoKey }> {
  const salt = randomSalt();
  const key = await deriveKey(passphrase, salt);
  return {
    key,
    envelope: {
      v: 1,
      salt: toB64(salt),
      iterations: ITERATIONS,
      check: await seal(key, CHECK_PLAINTEXT),
      data: null,
    },
  };
}

export async function unlockEnvelope(envelope: VaultEnvelope, passphrase: string): Promise<CryptoKey | null> {
  const key = await deriveKey(passphrase, fromB64(envelope.salt), envelope.iterations);
  const check = await open(key, envelope.check);
  return check === CHECK_PLAINTEXT ? key : null;
}

// ── session-cached key ─────────────────────────────────────────────────────

export async function exportKey(key: CryptoKey): Promise<string> {
  return toB64(await crypto.subtle.exportKey("raw", key));
}

export async function importKey(raw: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    fromB64(raw) as BufferSource,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
}

/** Rough strength signal for the setup UI. Not a policy, just feedback. */
export function passphraseStrength(p: string): { score: 0 | 1 | 2 | 3; label: string } {
  let bits = 0;
  if (/[a-z]/.test(p)) bits += 26;
  if (/[A-Z]/.test(p)) bits += 26;
  if (/[0-9]/.test(p)) bits += 10;
  if (/[^a-zA-Z0-9]/.test(p)) bits += 32;
  const entropy = p.length * Math.log2(Math.max(bits, 2));
  if (p.length < 8 || entropy < 40) return { score: 0, label: "too short" };
  if (entropy < 60) return { score: 1, label: "weak" };
  if (entropy < 80) return { score: 2, label: "good" };
  return { score: 3, label: "strong" };
}
