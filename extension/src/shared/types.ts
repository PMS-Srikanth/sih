/** Cordon — shared types across content script, service worker and side panel. */

export type Role =
  | "button" | "textbox" | "password" | "link" | "checkbox" | "radio"
  | "select" | "image" | "heading" | "text" | "list" | "table" | "form" | "other";

export interface BBox { x: number; y: number; w: number; h: number }

export type GroupKind = "form" | "nav" | "modal" | "table" | "card" | "list";

export interface Group {
  id: string;
  kind: GroupKind;
  name?: string;
  children: string[];
  bbox: BBox;
}

/**
 * An element as the content script sees it. `value` and `text` hold REAL page
 * content and must never be serialised onto the network — the redactor strips
 * them before a payload is built.
 */
export interface RawElement {
  id: string;
  role: Role;
  tag: string;
  type?: string;
  name: string;
  value?: string;
  text?: string;
  bbox: BBox;
  /** In the viewport and not covered by anything. */
  visible: boolean;
  /** Outside the viewport — real and clickable, just needs scrolling to. */
  offscreen: boolean;
  enabled: boolean;
  parent?: string;
  autocomplete?: string;
  placeholder?: string;
  label?: string;
  /** role|name|rounded-bbox hash — re-checked before every action (grounding). */
  sig: string;
  conf: number;
  src: "dom" | "vision" | "dom+vision";
}

export interface RawScreenGraph {
  url: string;
  urlClass: string;
  title: string;
  viewport: { w: number; h: number; scrollY: number; docH: number };
  elements: RawElement[];
  groups: Group[];
  readingOrder: string[];
  focus?: string;
  capturedAt: number;
  /** Wall-clock ms spent building this graph. */
  perceiveMs: number;
}

// ── privacy ────────────────────────────────────────────────────────────────

export type PiiClass =
  | "password" | "otp" | "apikey"
  | "email" | "phone" | "person" | "address"
  | "card" | "aadhaar" | "pan" | "ifsc" | "upi" | "dob"
  | "face" | "id_document";

export type Fate = "drop" | "substitute" | "mask" | "keep";
export type DetectorSource = "dom" | "regex" | "ner" | "vision";

/** One detector's opinion about one span of one element. */
export interface Detection {
  elementId: string;
  /** Character span inside the element's value/text. Absent = whole element. */
  start?: number;
  end?: number;
  field: "value" | "text" | "element";
  cls: PiiClass;
  /** Calibrated probability this span is genuinely sensitive. */
  p: number;
  source: DetectorSource;
  evidence: string;
}

/** A fused decision over one span, after noisy-OR and the context tie-break. */
export interface Finding {
  elementId: string;
  start?: number;
  end?: number;
  field: "value" | "text" | "element";
  cls: PiiClass;
  p: number;
  sources: DetectorSource[];
  fate: Fate;
  /** Populated for `substitute`. */
  handle?: string;
  /** Why the tie-break landed where it did — shown in the receipt. */
  reason: string;
}

// ── sanitized wire format ──────────────────────────────────────────────────

export interface SafeElement {
  id: string;
  role: Role;
  tag: string;
  type?: string;
  name?: string;
  bbox: [number, number, number, number];
  visible: boolean;
  offscreen?: boolean;
  enabled: boolean;
  parent?: string;
  conf: number;
  src: "dom" | "vision" | "dom+vision";
  /** A handle this element's value was replaced with. */
  holds?: string;
  /**
   * The field is empty, and the user's local profile has a value of the right
   * type available for it. The server may propose filling this handle; the
   * client resolves it from the profile without the value ever being sent.
   */
  wants?: string;
  /** Set when the value was dropped outright — no handle, no value. */
  sensitive?: boolean;
  /** Non-sensitive visible text, kept verbatim. */
  text?: string;
}

export interface SafeRegion {
  bbox: [number, number, number, number];
  cls: PiiClass;
  state: "masked";
}

export interface HistoryEntry {
  action: string;
  target?: string;
  result: "ok" | "failed" | "blocked";
  note?: string;
}

export interface SanitizedContext {
  schema: string;
  task: string;
  mode: Mode;
  urlClass: string;
  title: string;
  viewport: { w: number; h: number; scrollY: number; docH: number };
  elements: SafeElement[];
  groups: Group[];
  regions: SafeRegion[];
  /** Base64 masked bitmap. Null unless the server asked for it. */
  image: string | null;
  history: HistoryEntry[];
}

// ── server protocol ────────────────────────────────────────────────────────

export type ActionKind =
  | "click" | "fill" | "select" | "scroll" | "navigate" | "wait" | "extract" | "done";

export interface AgentAction {
  kind: ActionKind;
  target?: string;
  /** Either a handle (`EMAIL_1`) or a literal the server composed itself. */
  value?: string;
}

export type ServerResponse =
  | { type: "action"; thought: string; action: AgentAction; confidence: number }
  | { type: "plan"; thought: string; steps: AgentAction[]; confidence: number }
  | { type: "data"; answer: string; cite?: string[] }
  | { type: "ask_user"; question: string; options?: string[] }
  | { type: "need_image"; reason: string }
  | { type: "error"; message: string };

// ── telemetry & receipts ───────────────────────────────────────────────────

export type Mode = "fast" | "balanced" | "thorough";

export interface StageTimings {
  capture: number;
  perceive: number;
  detect: number;
  redact: number;
  verify: number;
  network: number;
  execute: number;
  total: number;
}

export interface PrivacyReceipt {
  step: number;
  at: number;
  counts: Partial<Record<PiiClass, number>>;
  bySource: Partial<Record<DetectorSource, number>>;
  dropped: number;
  substituted: number;
  masked: number;
  kept: number;
  payloadBytes: number;
  payloadHash: string;
  /** What the coverage map concluded this step, when a frame was captured. */
  vision?: string;
  /** The exact JSON that crossed the boundary, for inspection. Already
   *  sanitized and verifier-cleared — this is the point of showing it. */
  payload?: string;
  /** Whether a masked frame was included in that payload. */
  imageBytes?: number;
  verifier: { version: string; passed: boolean; checks: VerifierCheck[]; retries: number };
}

export interface VerifierCheck {
  id: "V1" | "V2" | "V3" | "V4" | "V5";
  name: string;
  passed: boolean;
  detail?: string;
}

export interface StepLog {
  step: number;
  /** "done" is the terminating check — it re-read the page and stopped. */
  route: "local" | "server" | "ask_user" | "done";
  thought?: string;
  action?: AgentAction;
  result: "ok" | "failed" | "blocked" | "pending";
  note?: string;
  timings: StageTimings;
  receipt?: PrivacyReceipt;
  /** Did the value we typed actually land, and is it the value we meant? */
  ingest?: IngestCheck;
  /**
   * What the agent actually typed, so the user can audit their own run.
   * This lives ONLY in the side panel over extension-internal messaging — it is
   * never part of a SanitizedContext, and the verifier's key whitelist would
   * reject it if it ever were.
   */
  entered?: EnteredValue;
}

export interface EnteredValue {
  /** The field's human label, e.g. "Email address". */
  field: string;
  /** Which profile slot it came from, e.g. "email". */
  cls: string;
  /** The real value. Masked in the UI until the user chooses to reveal it. */
  value: string;
  /** Where it came from: the page itself, or the user's encrypted profile. */
  source: "profile" | "page";
}

// ── messages ───────────────────────────────────────────────────────────────

export type ContentRequest =
  | { kind: "perceive"; mode: Mode }
  | { kind: "execute"; action: AgentAction; resolved?: string; expectSig?: string }
  | { kind: "highlight"; ids: string[] }
  | { kind: "clearHighlight" }
  | { kind: "ping" };

/** Verdict of reading a filled field back. Never carries the value itself. */
export interface IngestCheck {
  verified: boolean;
  expectedLen: number;
  actualLen: number;
  reason: string;
}

export type ContentResponse =
  | { ok: true; graph: RawScreenGraph }
  | { ok: true; executed: true; note?: string; postSig?: string; ingest?: IngestCheck }
  | { ok: true }
  | { ok: false; error: string; ingest?: IngestCheck };

export type PanelMessage =
  | { kind: "run"; task: string; mode: Mode }
  | { kind: "stop" }
  | { kind: "getState" }
  | { kind: "confirm"; approve: boolean }
  | { kind: "setServer"; url: string }
  | { kind: "getProfile" }
  | { kind: "setProfile"; values: Record<string, string> }
  | { kind: "vaultStatus" }
  | { kind: "vaultSetup"; passphrase: string }
  | { kind: "vaultUnlock"; passphrase: string }
  | { kind: "vaultLock" }
  | { kind: "vaultDestroy" };

export interface AgentState {
  running: boolean;
  task: string;
  mode: Mode;
  serverUrl: string;
  steps: StepLog[];
  awaitingConfirm: null | { action: AgentAction; why: string };
  answer?: string;
  error?: string;
}
