# Cordon — Build Tracker

**Living document. Updated on every change.** Last updated: 2026-08-28, build `23:41`.

The rule for this file: nothing is marked ✅ unless it runs and there is a way to check it.
Aspirations live in the roadmap, not in the status column.

---

## 1. The problem statement, line by line

| PS requirement | Status | Where / evidence |
|---|---|---|
| Client-side extension, **Chrome** | ✅ | `dist/` loads unpacked, tested |
| Client-side extension, **Firefox** | ⚠️ | `manifest.firefox.json` builds; **never loaded once** |
| Local **ViT or equivalent CV model** reads the screen | ✅ | UltraFace RFB-320, 1.2 MB ONNX. `npm run model-check` |
| ...running **via WebGPU** | ✅ | ORT `executionProviders: ["webgpu"]`, WASM+SIMD fallback |
| ...and **takes decision based on that** | ✅ | `agent/router.ts` — local-first; server only on escalation |
| Sanitize **before any network request** | ✅ | `privacy/verifier.ts` gates `transport.send()` |
| Detect PII via **DOM tags or any other method** | ⚠️ | DOM + regex/checksums + vision. **NER and OCR missing** |
| **Dynamically** detect and redact | ✅ | Per-step, on the live page, incl. content added after load |
| Blur faces / black out passwords / mask PII | ✅ | Solid masks composited into the bitmap; passwords removed outright |
| Only **anonymized, unidentifiable** data transmitted | ✅ | V1–V6; payload inspector shows the literal bytes |
| Server **aware of the redaction scheme** | ✅ | `cordon/redaction@1` handle grammar in the system prompt |
| Server returns **data or a UI action** | ✅ | 4 response types: action / plan / data / ask_user |
| Server model: **offline-deployable open-weights** | ❌ | Rule-based Node planner. **Llama / Qwen not wired** |
| **End-to-end task** demonstrated | ⚠️ | Works on demo pages; not yet on a real third-party site |
| Balance **latency vs accuracy** | ✅ | Fast / Balanced / Thorough change real behaviour |

### Evaluation metrics

| # | Metric | Weight | State |
|---|---|---|---|
| 1 | Accuracy of visual context | 25% | ⚠️ DOM ✅ + face detection ✅. **No labelled eval set yet** |
| 2 | PII recall + precision | 20% | ✅ P 1.000 / R 1.000 on fixture. 2 of 4 detectors |
| 3 | Precision of redaction | 20% | ✅ span-offset text, tight bboxes, V3 verified |
| 4 | Client resource use | 20% | ✅ 92% of frame never analysed (measured) |
| 5 | End-to-end latency | 15% | ✅ most steps 0 network; per-stage timings shown |

---

## 2. Architecture — what runs where

| Layer | Runs | Holds |
|---|---|---|
| Content script | Perception, execution, overlay | Live DOM refs. **No vault** |
| Service worker | Orchestration, detection, redaction, verification, transport | **The vault.** Only process with real values |
| Offscreen document | The vision model (WebGPU) | Model weights. **No vault, no network** |
| Side panel | Task UI, receipts, profile editor | Nothing persistent |
| Server | Reasoning over sanitized context | **Never a real value** |

**Deliberately NOT on the client:** the LLM. The PS states the local system cannot host a
full pipeline; that is the premise, not a limitation to work around.

---

## 3. Component status

### Perception
- ✅ ScreenGraph from DOM + computed accessible names
- ✅ Occluded vs offscreen distinguished (offscreen is clickable, occluded is not)
- ✅ **Media elements** — `img, svg, canvas, video, iframe, picture, object, embed`
- ✅ Stability signatures for grounding
- ✅ Coverage map — 32px cells, luma variance, flood-fill into regions
- ❌ Accessibility tree API proper (we compute accessible names by hand)
- ❌ MutationObserver / IntersectionObserver delta re-perception

### Vision
- ✅ UltraFace RFB-320 via ONNX Runtime Web
- ✅ WebGPU with real WASM fallback
- ✅ Two-pass: whole frame, then unexplained crops at native scale
- ✅ NMS, 4420 priors → ≤24 boxes
- ❌ ViT-Tiny crop classifier (id_document / signature / QR)
- ❌ OCR on document-like crops

### Privacy
- ✅ DOM rules — `type=password`, autocomplete tokens, label keywords, image semantics
- ✅ Regex + Verhoeff / Luhn / PAN / IFSC / UPI / JWT / entropy
- ✅ Calibrated fusion — noisy-OR, τ 0.80 / 0.35, context tie-break
- ✅ Typed stable handles, in-memory vault
- ✅ Span-offset redaction, tight bboxes
- ✅ Masks composited into the bitmap and re-encoded
- ✅ Verifier V1 V2 V3 V4 V5 + V6 escalation
- ✅ Encrypted profile — AES-256-GCM, PBKDF2 310k, key in session storage
- ❌ Local NER

### Agent
- ✅ Local-first router, 5 of 9 benchmark tasks never touch the network
- ✅ Allowed-sink enforcement
- ✅ Irreversible-action confirmation
- ✅ Grounding via stability signature
- ✅ Native-setter execution
- ✅ Loop termination — repeat guard, no-progress fingerprint, server `done`
- ✅ **Ingestion check** — value read back and compared after every fill

### Server
- ✅ Speaks `cordon/redaction@1`, handles only
- ✅ Output guard rejects literal PII
- ✅ 4 response types
- ❌ Open-weights VLM (Llama-3.2-Vision / Qwen2.5-VL via vLLM) — **Phase 4**
- ❌ Guided JSON decoding

### UI
- ✅ Step log with per-stage timing bars
- ✅ Privacy receipt — counts, detectors, verifier checks
- ✅ **Payload inspector** — the literal JSON that crossed
- ✅ Encrypted profile editor with lock states
- ✅ Live overlay tracking scroll
- ✅ Build stamp

---

## 4. Verification you can run

| Command | Checks |
|---|---|
| `npm run eval` | PII P/R, checksums, redaction, verifier, coverage map, encryption, router, visual PII |
| `npm run model-check` | ONNX model loads, output shapes match post-processing |
| `npm run typecheck` | Whole codebase |

Current: **all green.**

---

## 5. Changelog

| Date | Change | Why |
|---|---|---|
| 08-28 | Ingestion check after fill | "is the entered data correct" — read back and compare |
| 08-27 | **Media elements added to ScreenGraph** | `<img>` was in no selector; vision channel had nothing to anchor to |
| 08-27 | Payload inspector in receipt | Privacy claim must be checkable, not asserted |
| 08-27 | UltraFace + ORT + offscreen document | PS requires a local CV model reading the screen |
| 08-27 | Capture, coverage map, canvas masking, V3 real | Vision channel foundation |
| 08-27 | AES-256-GCM encrypted profile vault | Local data was plaintext in extension storage |
| 08-27 | `applied` findings | Overlay showed empty fields as redacted — overstated metric 3 |
| 08-27 | Live-tracking overlay | Boxes were a stale snapshot; page scrolls under them |
| 08-27 | offscreen vs occluded split | Below-fold buttons were treated as unusable |
| 08-27 | Loop guards + `done` pill | One Run fired 11 times |
| 08-27 | Router matches bare control names | "save draft" escalated to the server unnecessarily |
| 08-27 | Build stamp | Stale-code testing cost a full cycle |
| 08-27 | Demo pages use toasts not `alert()` | Modal blocked the thread, corrupting latency numbers |
| 08-27 | Phase 1 — full agent loop, no models | Working loop before adding the expensive parts |

---

## 6. Next, in order

1. **Open-weights VLM on the server** — the last hard PS requirement. Qwen2.5-VL or
   Llama-3.2-Vision behind vLLM, guided JSON. One function (`plan()`) changes.
2. **Labelled eval set for metric 1** — 40–60 pages with ground-truth boxes and roles.
   25% of the marks currently has no number attached to it.
3. **Local NER** — the third detector, for names in prose.
4. **Firefox** — load it once and find out what breaks.
5. **Delta re-perception** — observers instead of full re-scan each step.
