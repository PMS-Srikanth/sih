/**
 * Headless exercise of the privacy engine — detectors → fusion → redaction →
 * verification, with no browser involved.
 *
 * This is the seed of the metric-2 harness: positives that must be caught, and
 * hard negatives that must NOT be, because precision is graded too.
 *
 *   npm run eval
 */
import type { Detection, RawElement, RawScreenGraph } from "@/shared/types";
import { detectDom } from "@/privacy/detectors/dom";
import { detectRegex } from "@/privacy/detectors/regex";
import { fuse } from "@/privacy/fusion";
import { redact } from "@/privacy/redactor";
import { verify } from "@/privacy/verifier";
import { Vault } from "@/privacy/vault";
import { verhoeff, luhn } from "@/privacy/checksums";
import { route } from "@/agent/router";
import type { Profile } from "@/privacy/profile";
import { createEnvelope, seal, unlockEnvelope, open as openSealed } from "@/privacy/crypto";
import { buildCoverage, cellVariance, opaqueRegions, unexplainedRegions } from "@/perception/coverage";
import { compareIngestion } from "@/content/executor";

// ── helpers ────────────────────────────────────────────────────────────────

let seq = 0;
function field(over: Partial<RawElement>): RawElement {
  const id = `el_${++seq}`;
  return {
    id, role: "textbox", tag: "input", name: "", bbox: { x: 0, y: seq * 40, w: 260, h: 32 },
    visible: true, offscreen: false, enabled: true, sig: `sig_${id}`, conf: 0.98, src: "dom", ...over,
  };
}
function text(t: string, name = ""): RawElement {
  const id = `el_${++seq}`;
  return {
    id, role: "text", tag: "p", name, text: t, bbox: { x: 0, y: seq * 40, w: 600, h: 22 },
    visible: true, offscreen: false, enabled: true, sig: `sig_${id}`, conf: 0.98, src: "dom",
  };
}

/** Smallest valid Aadhaar-shaped number ≥ a seed, for the demo fixtures. */
function validAadhaar(seed = 223456789010): string {
  for (let n = seed; n < seed + 500; n++) {
    const s = String(n);
    if (s.length === 12 && verhoeff(s)) return s;
  }
  throw new Error("none found");
}

// ── the fixture: mirrors demo-pages/application.html ───────────────────────

const AADHAAR = validAadhaar();
const CARD = "4111111111111111"; // Luhn-valid test PAN

const elements: RawElement[] = [
  // ── positives: must be caught ───────────────────────────────────────────
  field({ name: "Full name", label: "Full name", autocomplete: "name", value: "Srikar Gautam" }),
  field({ name: "Email address", label: "Email address", type: "email", autocomplete: "email", value: "srikar.gautam@gmail.com" }),
  field({ name: "Mobile number", label: "Mobile number", type: "tel", autocomplete: "tel", value: "9876543210" }),
  field({ name: "Password", label: "Password", role: "password", type: "password", autocomplete: "new-password", value: "Hunter2!SuperSecret" }),
  field({ name: "Verification code", label: "Verification code", autocomplete: "one-time-code", value: "482913" }),
  field({ name: "PAN", label: "PAN", value: "ABCPG1234K" }),
  field({ name: "Aadhaar number", label: "Aadhaar number", value: AADHAAR }),
  field({ name: "Card number", label: "Card number", autocomplete: "cc-number", value: CARD }),
  field({ name: "Street address", label: "Street address", autocomplete: "street-address", value: "42 Banjara Hills, Hyderabad 500034" }),
  text("Questions? Write to priya.raghavan@northwind-careers.com or call 9845017632.", "Before you apply"),
  text("Pay to srikar@okhdfcbank before Friday.", "Payment"),
  text("Bearer token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", "Debug"),

  // ── hard negatives: must NOT be redacted ────────────────────────────────
  text("Order number: 1234567890", "Order"),
  text("Your reference number for this posting is 4471902238.", "Reference"),
  text("Tracking ID 8123456789 — expected delivery 21/08/2026.", "Shipping"),
  text("PIN code 500034. Total 1299 rupees. Quantity 4471902238 units.", "Summary"),
  text("Aadhaar-shaped but invalid: 1234 5678 9012", "Invalid ID"),
  text("Card-shaped but invalid: 4111 1111 1111 1112", "Invalid card"),
  field({ name: "Years of experience", label: "Years of experience", tag: "select", role: "select", value: "2-4" }),
  field({ name: "Summary of experience", label: "Summary of experience", tag: "textarea", value: "Built design systems and a browser extension.", bbox: { x: 0, y: 900, w: 600, h: 140 } }),
  text("Sign in", "Sign in"),
];

const graph: RawScreenGraph = {
  url: "http://127.0.0.1:8788/application.html",
  urlClass: "127.0.0.1:8788/application.html",
  title: "Northwind Careers — Application",
  viewport: { w: 1280, h: 720, scrollY: 0, docH: 2400 },
  elements,
  groups: [],
  readingOrder: elements.map((e) => e.id),
  capturedAt: Date.now(),
  perceiveMs: 4.2,
};

// ── expectations ───────────────────────────────────────────────────────────

const EXPECT_SENSITIVE = new Set([
  "Full name", "Email address", "Mobile number", "Password", "Verification code",
  "PAN", "Aadhaar number", "Card number", "Street address",
  "Before you apply", "Payment", "Debug",
]);
const EXPECT_SAFE = new Set([
  "Order", "Reference", "Shipping", "Summary", "Invalid ID", "Invalid card",
  "Years of experience", "Summary of experience", "Sign in",
]);

// ── run ────────────────────────────────────────────────────────────────────

const t0 = performance.now();
const detections: Detection[] = [...detectDom(elements), ...detectRegex(elements)];
const findings = fuse({ elements, detections });
const detectMs = performance.now() - t0;

const vault = new Vault();
const t1 = performance.now();
const { context, stats } = redact({ graph, findings, vault, task: "Fill this application from my profile", mode: "balanced", history: [] });
const redactMs = performance.now() - t1;

const t2 = performance.now();
const v = verify(context, vault);
const verifyMs = performance.now() - t2;

// ── report ─────────────────────────────────────────────────────────────────

const bar = "─".repeat(74);
const byName = new Map(elements.map((e) => [e.id, e.name || e.label || e.id]));
const flagged = new Set(findings.map((f) => f.elementId));

console.log(`\n${bar}\n  CORDON — privacy engine smoke test\n${bar}\n`);

console.log("  DETECTIONS\n");
for (const f of findings.sort((a, b) => b.p - a.p)) {
  const name = byName.get(f.elementId) ?? f.elementId;
  console.log(
    `  ${f.fate.toUpperCase().padEnd(11)} ${String(f.cls).padEnd(10)} ` +
    `p=${f.p.toFixed(2)}  ${name.slice(0, 26).padEnd(28)} [${f.sources.join("+")}]`,
  );
}

console.log(`\n${bar}\n  PRECISION / RECALL — metric 2\n`);
let tp = 0, fn = 0, fp = 0, tn = 0;
const misses: string[] = [];
const falsePos: string[] = [];
for (const e of elements) {
  const name = e.name || e.label || e.id;
  const hit = flagged.has(e.id);
  if (EXPECT_SENSITIVE.has(name)) { hit ? tp++ : (fn++, misses.push(name)); }
  else if (EXPECT_SAFE.has(name)) { hit ? (fp++, falsePos.push(name)) : tn++; }
}
const precision = tp / (tp + fp || 1);
const recall = tp / (tp + fn || 1);
const f1 = (2 * precision * recall) / (precision + recall || 1);
console.log(`  true positives   ${tp}`);
console.log(`  false negatives  ${fn}${misses.length ? `   ← MISSED: ${misses.join(", ")}` : ""}`);
console.log(`  false positives  ${fp}${falsePos.length ? `   ← OVER-REDACTED: ${falsePos.join(", ")}` : ""}`);
console.log(`  true negatives   ${tn}`);
console.log(`\n  precision ${precision.toFixed(3)}   recall ${recall.toFixed(3)}   F1 ${f1.toFixed(3)}`);

console.log(`\n${bar}\n  CHECKSUM ARBITRATION\n`);
console.log(`  ${AADHAAR}      Verhoeff ${verhoeff(AADHAAR) ? "valid   → treated as Aadhaar" : "invalid"}`);
console.log(`  123456789012      Verhoeff ${verhoeff("123456789012") ? "valid" : "invalid → rejected, not an Aadhaar"}`);
console.log(`  ${CARD}  Luhn     ${luhn(CARD) ? "valid   → treated as a card" : "invalid"}`);
console.log(`  4111111111111112  Luhn     ${luhn("4111111111111112") ? "valid" : "invalid → rejected, not a card"}`);

console.log(`\n${bar}\n  REDACTION — metric 3\n`);
console.log(`  removed      ${stats.dropped}`);
console.log(`  substituted  ${stats.substituted}`);
console.log(`  masked       ${stats.masked}`);
console.log(`  kept         ${stats.kept}`);
console.log(`  vault        ${vault.size()} handle(s)`);
console.log(`\n  by class     ${Object.entries(stats.counts).map(([k, n]) => `${k}×${n}`).join("  ")}`);

console.log(`\n${bar}\n  WHAT ACTUALLY CROSSES THE WIRE\n`);
for (const e of context.elements.filter((x) => x.holds || x.sensitive).slice(0, 12)) {
  const label = e.name ?? e.id;
  const shown = e.sensitive ? "sensitive: true  (value removed, no handle)" : e.holds;
  console.log(`  ${e.id.padEnd(7)} ${label.slice(0, 24).padEnd(26)} → ${shown}`);
}
const proseSample = context.elements.find((e) => e.name === "Before you apply");
if (proseSample?.text) console.log(`\n  prose → "${proseSample.text}"`);

console.log(`\n${bar}\n  VERIFIER — the gate\n`);
for (const c of v.checks) {
  console.log(`  ${c.passed ? "PASS" : "FAIL"}  ${c.id}  ${c.name.padEnd(28)} ${c.detail ?? ""}`);
}
console.log(`\n  verdict      ${v.passed ? "PASS — cleared for transmission" : "FAIL — transmission refused"}`);
console.log(`  payload      ${v.bytes} bytes   hash #${v.hash}`);

console.log(`\n${bar}\n  LATENCY — metrics 4 and 5\n`);
console.log(`  detect  ${detectMs.toFixed(2)} ms`);
console.log(`  redact  ${redactMs.toFixed(2)} ms`);
console.log(`  verify  ${verifyMs.toFixed(2)} ms`);
console.log(`  total   ${(detectMs + redactMs + verifyMs).toFixed(2)} ms  for ${elements.length} elements`);

// ── ingestion check ───────────────────────────────────────────────────────

console.log(`${bar}
  INGESTION — did the value we typed actually land?
`);

const INGEST_CASES: Array<[string, string, string, boolean]> = [
  ["exact", "srikar.gautam@gmail.com", "srikar.gautam@gmail.com", true],
  ["formatted by an input mask", "98765 43210", "9876543210", true],
  ["reverted by the framework", "", "Srikar Gautam", false],
  ["truncated by maxlength", "Srikar Ga", "Srikar Gautam", false],
  ["field holds something else", "placeholder text", "Srikar Gautam", false],
  ["dashed card mask", "4111-1111-1111-1111", "4111111111111111", true],
];

let ingestFails = 0;
for (const [label, actual, expected, want] of INGEST_CASES) {
  const r = compareIngestion(actual, expected);
  const pass = r.verified === want;
  if (!pass) ingestFails++;
  console.log(
    `  ${pass ? "PASS" : "FAIL"}  ${(r.verified ? "VERIFIED" : "REJECTED").padEnd(9)} ` +
    `${label.padEnd(28)} ${r.reason}`,
  );
}
console.log(`
  The verdict travels; the value never does.`);
const ingestOk = ingestFails === 0;

// ── visual PII ────────────────────────────────────────────────────────────

console.log(`${bar}
  VISUAL PII — images the DOM cannot read into
`);

seq = 300;
const media: RawElement[] = [
  field({ role: "image", tag: "img", name: "Uploaded identity document", bbox: { x: 60, y: 200, w: 150, h: 150 } }),
  field({ role: "image", tag: "img", name: "Profile photo", bbox: { x: 240, y: 200, w: 96, h: 96 } }),
  field({ role: "image", tag: "img", name: "Company logo", bbox: { x: 10, y: 10, w: 120, h: 40 } }),
  field({ role: "image", tag: "canvas", name: "", bbox: { x: 400, y: 200, w: 300, h: 200 } }),
];
const mediaFindings = fuse({ elements: media, detections: detectDom(media) });
for (const m of media) {
  const f = mediaFindings.find((x) => x.elementId === m.id);
  console.log(
    `  ${(m.name || `<${m.tag}>`).slice(0, 26).padEnd(28)} ` +
    `${f ? `${f.fate.toUpperCase()} ${f.cls}  p=${f.p.toFixed(2)}` : "no DOM signal — vision decides"}`,
  );
}
const idMasked = mediaFindings.some((f) => f.cls === "id_document" && f.fate === "mask");
const photoMasked = mediaFindings.some((f) => f.cls === "face" && f.fate === "mask");
const logoKept = !mediaFindings.some((f) => f.elementId === media[2].id);
console.log(`
  ID document masked  ${idMasked ? "yes" : "NO"}`);
console.log(`  profile photo masked ${photoMasked ? "yes" : "NO"}`);
console.log(`  logo left alone      ${logoKept ? "yes" : "NO — over-redacting"}`);
console.log(`  bare <canvas>        no DOM signal, so it goes to the model as a crop`);
const visualOk = idMasked && photoMasked && logoKept;

// ── coverage-guided vision ────────────────────────────────────────────────

console.log(`${bar}\n  DOM-COVERAGE-GUIDED VISION — metric 4\n`);

const VW = 640, VH = 480;
seq = 200;

// A page whose top half is ordinary DOM content, with one image the DOM cannot
// see inside — plus a decorative flat panel that must NOT trigger a model pass.
const pageEls: RawElement[] = [
  field({ role: "heading", tag: "h1", name: "Your details", bbox: { x: 0, y: 0, w: 620, h: 40 } }),
  field({ name: "Full name", bbox: { x: 0, y: 48, w: 300, h: 32 } }),
  field({ name: "Email", bbox: { x: 320, y: 48, w: 300, h: 32 } }),
  field({ role: "text", tag: "p", name: "", text: "All fields required", bbox: { x: 0, y: 88, w: 620, h: 24 } }),
  field({ role: "button", tag: "button", name: "Submit", bbox: { x: 0, y: 400, w: 140, h: 40 } }),
  // Opaque to the DOM: layout knows where it is, nothing knows what is in it.
  field({ role: "image", tag: "img", name: "Uploaded identity document", bbox: { x: 200, y: 160, w: 160, h: 120 } }),
];

// Synthetic frame: flat background, noise only where the photo sits.
const px = new Uint8ClampedArray(VW * VH * 4).fill(210);
for (let y = 160; y < 280; y++) {
  for (let x = 200; x < 360; x++) {
    const i = (y * VW + x) * 4;
    const n = (x * 7 + y * 13) % 255;
    px[i] = n; px[i + 1] = 255 - n; px[i + 2] = (n * 3) % 255;
  }
}

const cov = buildCoverage(pageEls, { w: VW, h: VH });
const varr = cellVariance(px, VW, VH, cov.cols, cov.rows);
const unexplained = unexplainedRegions({ ...cov, variance: varr });
const coveredCells = cov.covered.reduce((n, v) => n + v, 0);
const totalCells = cov.cols * cov.rows;

console.log(`  grid                ${cov.cols}×${cov.rows} = ${totalCells} cells of 32px`);
console.log(`  DOM explains        ${coveredCells}/${totalCells} cells (${Math.round((coveredCells / totalCells) * 100)}%)`);
console.log(`  unexplained regions ${unexplained.length}`);
for (const r of unexplained) console.log(`    → ${r.w}×${r.h} at (${r.x}, ${r.y})`);
console.log(`  opaque per DOM      ${opaqueRegions(pageEls).length} (the <img>)`);

const hitsPhoto = unexplained.some(
  (r) => r.x <= 208 && r.y <= 168 && r.x + r.w >= 352 && r.y + r.h >= 272,
);
const skipsFlat = !unexplained.some((r) => r.y > 300);
const savings = 1 - unexplained.reduce((a, r) => a + r.w * r.h, 0) / (VW * VH);

console.log(`\n  finds the photo     ${hitsPhoto ? "yes" : "NO — would miss visual PII"}`);
console.log(`  skips flat areas    ${skipsFlat ? "yes" : "NO — wasted model passes"}`);
console.log(`  frame not analysed  ${(savings * 100).toFixed(1)}%  ← the resource saving`);

const coverageOk = hitsPhoto && skipsFlat && savings > 0.5;

// ── encryption of the local profile ───────────────────────────────────────

console.log(`${bar}\n  PROFILE ENCRYPTION — AES-256-GCM, PBKDF2-SHA256\n`);

const secretJson = JSON.stringify({ fullName: "Srikar Gautam", aadhaar: AADHAAR });
const tEnc = performance.now();
const { envelope, key: goodKey } = await createEnvelope("correct horse battery staple");
const deriveMs = performance.now() - tEnc;
envelope.data = await seal(goodKey, secretJson);

const rightKey = await unlockEnvelope(envelope, "correct horse battery staple");
const wrongKey = await unlockEnvelope(envelope, "correct horse battery stapler");
const roundTrip = rightKey ? await openSealed(rightKey, envelope.data) : null;

const blob = JSON.stringify(envelope);
console.log(`  key derivation      ${deriveMs.toFixed(0)} ms  (310,000 PBKDF2 iterations)`);
console.log(`  correct passphrase  ${rightKey ? "unlocks" : "FAILED"}`);
console.log(`  wrong passphrase    ${wrongKey === null ? "rejected — GCM auth fails, no garbage returned" : "ACCEPTED — BUG"}`);
console.log(`  round trip          ${roundTrip === secretJson ? "exact" : "MISMATCH"}`);
console.log(`  plaintext on disk   ${blob.includes("Srikar") || blob.includes(AADHAAR) ? "LEAKED" : "none — ciphertext only"}`);
console.log(`\n  stored envelope: ${blob.slice(0, 96)}…`);

const cryptoOk =
  !!rightKey && wrongKey === null && roundTrip === secretJson &&
  !blob.includes("Srikar") && !blob.includes(AADHAAR);

// ── filling a BLANK form from the local profile ───────────────────────────

console.log(`${bar}\n  LOCAL PROFILE → BLANK FORM\n`);

const myProfile: Profile = {
  fullName: { cls: "person", label: "Full name", placeholder: "", value: "Srikar Gautam" },
  email: { cls: "email", label: "Email", placeholder: "", value: "srikar.gautam@gmail.com" },
  phone: { cls: "phone", label: "Mobile", placeholder: "", value: "9876543210" },
  aadhaar: { cls: "aadhaar", label: "Aadhaar", placeholder: "", value: AADHAAR },
};

seq = 100;
const blank: RawElement[] = [
  field({ name: "Full name", label: "Full name", autocomplete: "name" }),
  field({ name: "Email address", label: "Email address", type: "email", autocomplete: "email" }),
  field({ name: "Mobile number", label: "Mobile number", type: "tel", autocomplete: "tel" }),
  field({ name: "Aadhaar number", label: "Aadhaar number" }),
  field({ name: "Comments", label: "Comments", tag: "textarea", bbox: { x: 0, y: 400, w: 600, h: 160 } }),
];
const blankGraph: RawScreenGraph = { ...graph, elements: blank, readingOrder: blank.map((e) => e.id) };

const v2 = new Vault();
const r2 = redact({
  graph: blankGraph,
  findings: fuse({ elements: blank, detections: detectDom(blank) }),
  vault: v2,
  task: "Fill this form from my profile",
  mode: "balanced",
  history: [],
  profile: myProfile,
});

for (const e of r2.context.elements) {
  console.log(`  ${e.id.padEnd(7)} ${(e.name ?? "").slice(0, 22).padEnd(24)} wants: ${e.wants ?? "—"}`);
}

const payload2 = JSON.stringify(r2.context);
const leaks = Object.values(myProfile).filter((p) => p.value && payload2.includes(p.value));
const ver2 = verify(r2.context, v2);

console.log(`\n  The large "Comments" textarea gets no handle — it is not an allowed sink.`);
console.log(`  profile values in the payload: ${leaks.length === 0 ? "NONE" : leaks.map((l) => l.label).join(", ")}`);
console.log(`  verifier: ${ver2.passed ? "PASS" : "FAIL"}   payload ${ver2.bytes} bytes`);
console.log(`\n  The server is told which fields can be filled and with what TYPE.`);
console.log(`  It replies "fill el_101 with PERSON_1". The name never leaves the device.`);

// ── router: which tasks avoid the network entirely? ───────────────────────

console.log(`${bar}\n  ROUTER — local-first, metrics 4 and 5\n`);

const buttons: RawElement[] = [
  // Below the fold, exactly like the real demo page: offscreen, NOT occluded.
  // Regression guard — this used to be filtered out and sent to the server.
  { ...field({ name: "Save draft", role: "button", tag: "button", visible: false, offscreen: true }) },
  { ...field({ name: "Submit application", role: "button", tag: "button", visible: false, offscreen: true }) },
  // Covered by a modal — genuinely unusable, must never be chosen.
  { ...field({ name: "Hidden action", role: "button", tag: "button", visible: false, offscreen: false }) },
  { ...field({ name: "Sign in", role: "button", tag: "button" }) },
  { ...field({ name: "Sign in with SSO", role: "button", tag: "button" }) },
  // Two controls with the identical accessible name — genuinely unresolvable
  // without reasoning about the page, so it must escalate.
  { ...field({ name: "Download", role: "button", tag: "button" }) },
  { ...field({ name: "Download", role: "button", tag: "button" }) },
];
const navGraph: RawScreenGraph = { ...graph, elements: buttons, readingOrder: buttons.map((e) => e.id) };

const ROUTER_CASES: Array<[string, "local" | "server"]> = [
  ['Click "Save draft"', "local"],          // quoted, exact
  ["save draft", "local"],                  // bare name, near-verbatim
  ["Submit application", "local"],          // bare name, near-verbatim
  ["scroll down", "local"],                 // mechanical
  ["sign in", "local"],                     // "Sign in" 1.00 beats "Sign in with SSO" 0.50
  ["click download", "server"],             // two controls share the name — cannot choose
  ["hidden action", "server"],              // occluded — must not be actioned locally
  ["Fill this application from my profile", "server"],
  ["What sensitive data is on this page?", "server"],
];

let routerFails = 0;
for (const [task, want] of ROUTER_CASES) {
  const d = route(navGraph, task, 0);
  const got = d.route === "done" ? "server" : d.route;
  const pass = got === want;
  if (!pass) routerFails++;
  console.log(
    `  ${pass ? "PASS" : "FAIL"}  ${got.toUpperCase().padEnd(7)} ${`"${task}"`.slice(0, 42).padEnd(44)} ${d.why}`,
  );
}

console.log(
  `\n  ${ROUTER_CASES.filter(([, w]) => w === "local").length}/${ROUTER_CASES.length} of these tasks never touch the network.`,
);

console.log(`\n${bar}\n`);

const ok = v.passed && fn === 0 && fp === 0 && routerFails === 0 && leaks.length === 0 && ver2.passed && cryptoOk && coverageOk && visualOk && ingestOk;
if (!ok) {
  console.log(`  RESULT: needs work — ${fn} miss(es), ${fp} over-redaction(s)\n`);
  process.exit(1);
}
console.log(`  RESULT: all positives caught, no over-redaction, verifier passed\n`);
