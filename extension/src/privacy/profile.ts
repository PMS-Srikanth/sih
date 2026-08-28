/**
 * The user's own data — the thing the agent fills forms *from*.
 *
 * PS: "the actual sensitive values remain locally controlled."
 *
 * Encrypted at rest with AES-256-GCM under a key derived from the user's
 * passphrase. The ciphertext lives in extension-local storage, which the page
 * cannot reach; the key lives in session storage, which never touches disk and
 * dies with the browser. Values are never serialised into a payload — when a
 * form needs one, the vault mints a typed handle and only the handle crosses.
 */
import type { PiiClass } from "@/shared/types";
import {
  createEnvelope, exportKey, importKey, open, seal, unlockEnvelope,
  type VaultEnvelope,
} from "./crypto";

export interface ProfileEntry {
  cls: PiiClass;
  label: string;
  value: string;
  placeholder: string;
}

export type Profile = Record<string, ProfileEntry>;

export type LockState = "empty" | "locked" | "unlocked";

export interface VaultStatus {
  state: LockState;
  filled: number;
  total: number;
}

/** Slot order is the order shown in the side panel editor. */
export const PROFILE_SCHEMA: Array<Omit<ProfileEntry, "value"> & { key: string }> = [
  { key: "fullName", cls: "person", label: "Full name", placeholder: "Srikar Gautam" },
  { key: "email", cls: "email", label: "Email", placeholder: "you@example.com" },
  { key: "phone", cls: "phone", label: "Mobile", placeholder: "9876543210" },
  { key: "dob", cls: "dob", label: "Date of birth", placeholder: "14/03/2003" },
  { key: "address", cls: "address", label: "Address", placeholder: "42 Banjara Hills, Hyderabad 500034" },
  { key: "pan", cls: "pan", label: "PAN", placeholder: "ABCPG1234K" },
  { key: "aadhaar", cls: "aadhaar", label: "Aadhaar", placeholder: "2234 5678 9018" },
  { key: "upi", cls: "upi", label: "UPI ID", placeholder: "you@okhdfcbank" },
];

const ENVELOPE_KEY = "cordon.vault";
const SESSION_KEY = "cordon.sessionKey";

// ── envelope storage ───────────────────────────────────────────────────────

async function readEnvelope(): Promise<VaultEnvelope | null> {
  const s = await chrome.storage.local.get(ENVELOPE_KEY);
  return (s[ENVELOPE_KEY] as VaultEnvelope | undefined) ?? null;
}

async function writeEnvelope(env: VaultEnvelope): Promise<void> {
  await chrome.storage.local.set({ [ENVELOPE_KEY]: env });
}

async function cachedKey(): Promise<CryptoKey | null> {
  const s = await chrome.storage.session.get(SESSION_KEY);
  const raw = s[SESSION_KEY] as string | undefined;
  return raw ? importKey(raw) : null;
}

async function cacheKey(key: CryptoKey): Promise<void> {
  await chrome.storage.session.set({ [SESSION_KEY]: await exportKey(key) });
}

// ── lifecycle ──────────────────────────────────────────────────────────────

export async function status(): Promise<VaultStatus> {
  const total = PROFILE_SCHEMA.length;
  const env = await readEnvelope();
  if (!env) return { state: "empty", filled: 0, total };

  const key = await cachedKey();
  if (!key) return { state: "locked", filled: 0, total };

  const profile = await decrypt(env, key);
  return {
    state: "unlocked",
    filled: profile ? Object.values(profile).filter((e) => e.value).length : 0,
    total,
  };
}

/** First run — choose a passphrase. Fails if a vault already exists. */
export async function setup(passphrase: string): Promise<{ ok: boolean; error?: string }> {
  if (passphrase.length < 8) return { ok: false, error: "Use at least 8 characters." };
  if (await readEnvelope()) return { ok: false, error: "A vault already exists on this device." };

  const { envelope, key } = await createEnvelope(passphrase);
  await writeEnvelope(envelope);
  await cacheKey(key);
  return { ok: true };
}

export async function unlock(passphrase: string): Promise<{ ok: boolean; error?: string }> {
  const env = await readEnvelope();
  if (!env) return { ok: false, error: "No vault on this device yet." };

  const key = await unlockEnvelope(env, passphrase);
  if (!key) return { ok: false, error: "That passphrase does not match." };

  await cacheKey(key);
  return { ok: true };
}

/** Drops the key. The ciphertext stays; nothing can read it until unlocked. */
export async function lock(): Promise<void> {
  await chrome.storage.session.remove(SESSION_KEY);
}

/** Destroys the vault entirely — ciphertext, salt and key. Irreversible. */
export async function destroy(): Promise<void> {
  await chrome.storage.local.remove(ENVELOPE_KEY);
  await chrome.storage.session.remove(SESSION_KEY);
}

// ── read / write ───────────────────────────────────────────────────────────

function blank(): Profile {
  const out: Profile = {};
  for (const s of PROFILE_SCHEMA) {
    out[s.key] = { cls: s.cls, label: s.label, placeholder: s.placeholder, value: "" };
  }
  return out;
}

async function decrypt(env: VaultEnvelope, key: CryptoKey): Promise<Profile | null> {
  if (!env.data) return blank();
  const json = await open(key, env.data);
  if (json === null) return null;

  const saved = JSON.parse(json) as Record<string, string>;
  const out = blank();
  for (const s of PROFILE_SCHEMA) out[s.key].value = saved[s.key] ?? "";
  return out;
}

/** Returns null when the vault is locked or absent — never a partial profile. */
export async function loadProfile(): Promise<Profile | null> {
  const env = await readEnvelope();
  if (!env) return null;
  const key = await cachedKey();
  if (!key) return null;
  return decrypt(env, key);
}

export async function saveProfile(values: Record<string, string>): Promise<{ ok: boolean; error?: string }> {
  const env = await readEnvelope();
  if (!env) return { ok: false, error: "No vault — create a passphrase first." };
  const key = await cachedKey();
  if (!key) return { ok: false, error: "Vault is locked." };

  const clean: Record<string, string> = {};
  for (const s of PROFILE_SCHEMA) {
    const v = (values[s.key] ?? "").trim();
    if (v) clean[s.key] = v.slice(0, 200);
  }

  env.data = await seal(key, JSON.stringify(clean));
  await writeEnvelope(env);
  return { ok: true };
}

// ── lookup ─────────────────────────────────────────────────────────────────

/** The first filled slot matching a class — what a detected field should get. */
export function slotFor(profile: Profile, cls: PiiClass): { key: string; entry: ProfileEntry } | null {
  for (const [key, entry] of Object.entries(profile)) {
    if (entry.cls === cls && entry.value) return { key, entry };
  }
  return null;
}

export function filledCount(profile: Profile): number {
  return Object.values(profile).filter((e) => e.value).length;
}
