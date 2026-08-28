# Cordon — Architecture & Build Plan

**SIH26171 — On-device Visual Perception for Light-weight Browser Agents**

A browser extension where a **local vision model reads the screen and decides**, escalating to a
server-side VLM only when it must — and never sending a pixel, a password, or a name when it does.

| Layer | Stack |
|---|---|
| Client | WebExtension MV3 · Chrome + Firefox · TypeScript · Vite · ONNX Runtime Web (WebGPU → WASM/SIMD fallback) |
| Boundary | Local redaction + independent verify-before-send |
| Server | Open-weights VLM (Qwen2.5-VL / Llama-3.2-Vision) behind guided JSON decoding |

---

## §00 — Read the rubric first, then design

The grading is explicit and weighted. **65% of the marks are accuracy, 35% are efficiency.**
Every design decision below is traceable to a row here.

| # | Metric | Weight | Where it is earned |
|---|---|---|---|
| 1 | **Accuracy of visual context from screen** | **25%** | §02 — the Screen Understanding Graph. *Largest single metric.* |
| 2 | Recall **and precision** for PII detection | 20% | §03 — calibrated fusion with two thresholds, not blind over-redaction |
| 3 | **Precision** of redaction | 20% | §04 — tight per-span / per-box masks, measured by IoU and over-redaction rate |
| 4 | Client resource utilisation | 20% | §02 coverage-guided vision · §05 local-first routing · quantised models |
| 5 | End-to-end latency | 15% | §05 — most steps never touch the network at all |

> **The trap:** metric 2 grades precision *equally* with recall, and metric 3 grades redaction
> precision outright. A "redact everything ambiguous" policy scores well on recall and destroys
> 40% of the marks. Calibration, not paranoia.

---

## §01 — The two ideas

### Idea 1 — Local-first. The server is an escalation path, not a step.

The problem statement says: *"a local ViT ... reads the user's screen and takes decision based on
that. **If it requires** the visual context to be sent to server, it shall sanitize..."*

So the local agent decides whether the server is needed at all. A **Router** sits after perception:

- **Resolvable locally** — "click the button labelled Submit", "scroll to the form", "fill the field
  I identified as `email` with high confidence" → execute on device. **Zero network. ~0 ms.**
- **Needs reasoning** — ambiguous target, multi-step planning, unfamiliar layout, natural-language
  judgement → sanitize and escalate.

This single decision is worth most of metrics 4 and 5.

### Idea 2 — Substitution, so the server can reason without seeing.

The client keeps a private vault mapping opaque, **typed** handles to real values. The server
receives handles, reasons in handles, returns actions written in handles. The client resolves
locally at the last moment. The PS requires the server be *"aware of this redaction scheme"* —
the handle grammar is exactly that scheme, versioned and sent in the system prompt.

| Stays on device | Crosses the boundary |
|---|---|
| `"srikar@gmail.com"` | `EMAIL_1` |
| `"Hunter2!"` | `{ "sensitive": true }` — value never read into the payload |
| 1920×1080 screenshot | 768px, faces & IDs tightly masked — **optional, on request** |
| `<input id="user_email">` | `{ id:"el_12", role:"textbox", name:"Email", holds:"EMAIL_1" }` |

Handles are **typed and stable** — the same value always gets the same handle, so the model can
still see that two fields hold the *same* email without learning the email.

---

## §02 — Visual context: the 25% metric

This is the largest metric and the heart of the PS. The output is a **Screen Understanding
Graph** — not a screenshot description, a structured, grounded model of the screen.

```
ScreenGraph {
  elements: [{ id, role, name, bbox, state, source, confidence }]
  groups:   [{ kind: form | nav | modal | table | card, children, bbox }]
  reading_order: [id]
  focus: id
  viewport: { w, h, scrollY, docH }
}
```

### Two evidence channels, one fused graph

| Channel | Gives | Strength | Blind to |
|---|---|---|---|
| **DOM + accessibility tree** | role, accessible name, type, state, bbox | Near-certain, ~0 ms | canvas apps, images, custom widgets, closed shadow DOM, visually-hidden-but-present nodes |
| **Local vision — detector + ViT** | element boxes, element class, text regions | Sees what is actually rendered | fine-grained state, exact values |

**Fusion rule.** Match visual detections to DOM nodes by IoU. Then:

- **Both agree** → confidence 1.0. The overwhelming majority of elements.
- **DOM only, not visible in pixels** → element is occluded / offscreen / `visibility:hidden`.
  Mark `visible:false`. *This alone kills a whole class of agent errors — clicking a node that
  exists but isn't on screen.*
- **Vision only, no DOM node** → canvas/image/custom widget. Vision is authoritative; synthesise
  a virtual element with a vision-derived label.
- **Disagreement on role** → prefer DOM for `input`/`button`/`a`, prefer vision for anything
  inside a `<canvas>` or image.

### Coverage-guided vision — why we don't run the ViT on every frame

Rasterise every known element bbox into a coverage map. Vision runs **only on the complement**:
`<canvas>`, `<img>`, `<svg>`, `<video>`, `<iframe>`, CSS background images, closed shadow roots,
and any high-entropy region no DOM node explains. Typically **5–20 crops instead of a full frame**.

This is the honest answer to *"if I have a ViT, why do I need DOM?"* — and it is where metric 4
is won without giving up metric 1.

### The model cascade

```
proposals                                   classification
─────────                                   ──────────────
Small UI detector, int8 ONNX        →       ViT-Tiny / MobileViT, 224×224, batched
(YOLO-nano or RT-DETR-tiny                  ↓
 fine-tuned on a UI corpus)                 button · input · link · icon · image
                                            face · id_document · signature · qr
                                            chart · text_block · plain_ui
```

Batched on WebGPU via ONNX Runtime Web. WASM+SIMD+threads is the fallback. **OCR runs only on
crops the ViT flags as text-bearing**, and its output is fed *back through the text detectors* —
text lifted out of an image is still text.

### How we prove metric 1

Build `eval/screens/` — 40–60 labelled pages (real sites saved offline + our demo pages).
Ground truth: every interactive element's bbox, role, and accessible name.
Report, in the README and the demo:

- **Element detection** — precision / recall / F1 at IoU ≥ 0.5
- **Role accuracy** — confusion matrix over button / input / link / select / checkbox
- **Bbox quality** — mean IoU
- **Task-relevant hit rate** — of the elements a task actually needs, how many did we find

A number on a slide beats a claim. This harness is Phase 1 work, not an afterthought.

---

## §03 — PII detection: recall **and** precision

> **Correction to the earlier draft.** I previously said "union-fuse, fail closed, redact
> anything ambiguous." That is wrong against this rubric — it maximises recall while wrecking
> precision on metric 2 and over-masking on metric 3. Replace it with calibrated fusion.

### Four detectors, calibrated

| Detector | Finds | Cost | Calibrated conf. |
|---|---|---|---|
| **DOM & AX rules** | `type=password`, `autocomplete` tokens (`cc-number`, `tel`, `one-time-code`, `street-address`), label/aria keyword match | ~0 ms | 0.95 – 1.0 |
| **Regex + checksum** | Email, phone, **Aadhaar (Verhoeff)**, **PAN**, **card (Luhn)**, IFSC, UPI VPA, JWT / high-entropy keys, DOB | ~1 ms | 0.55 – 0.98 |
| **Local NER** | PERSON, LOCATION, ORG in free text the rules missed | ~15 ms / chunk | 0.5 – 0.9 |
| **Vision + OCR** | Faces, ID cards, signatures, QR, text baked into images | ~30 ms / step | 0.5 – 0.95 |

### Fusion: noisy-OR with two thresholds

```
p = 1 − Π(1 − pᵢ)                       combine detector confidences

p ≥ τ_high  (0.80)   → REDACT
τ_low ≤ p < τ_high   → CONTEXT TIE-BREAK
p < τ_low   (0.35)   → KEEP
```

The tie-break is what buys precision back. Cheap, high-signal features:

- **Label proximity** — nearest preceding label / `aria-label` / placeholder. `Order number:
  1234567890` and `Phone: 9876543210` are identical to a regex; their labels are not.
- **Checksum outcome** — a 12-digit string failing Verhoeff is *not* Aadhaar. A 16-digit string
  failing Luhn is *not* a card. Hard negative evidence.
- **Container role** — inside a `<form>`, or a `role="cell"` in a data table, vs. body prose.
- **Repetition** — a value appearing in 50 places on the page is boilerplate, not personal.
- **Task relevance** — if the element is nowhere near the task's target, redaction is free
  (no accuracy cost); if it *is* the target, demand higher confidence.

### How we prove metric 2

`eval/pii/` — a labelled corpus of realistic Indian-context pages (Aadhaar, PAN, UPI, IFSC, IN
phone formats) plus hard negatives (order IDs, tracking numbers, PIN codes, prices, dates).
Report **precision, recall, F1 per class**, and tune `τ_high` / `τ_low` on it. Ship the numbers.

---

## §04 — Redaction: precision is the metric

> **Correction:** "mask the region" is not good enough. Metric 3 grades *precision of redaction*
> — masking pixels that were never sensitive costs marks the same way missing sensitive ones does.

### Tight by construction

- **Text spans** → `Range.getClientRects()` over the matched substring only. Mask the eleven
  characters of the email, **not** the paragraph, **not** the `<div>`.
- **Faces / IDs** → the detector's own box, dilated by a fixed small margin (4 px) — enough to
  cover boundary error, not enough to swallow neighbours.
- **Never** mask a whole element, a whole region, or the whole frame as a shortcut.

### Per-class policy

| Class | Action | What the server sees | Why |
|---|---|---|---|
| Password, OTP, API key, token | **DROP** | `{type:"password", sensitive:true}` | Value never read into the payload — absent, not masked |
| Email | **SUBSTITUTE** | `EMAIL_1` | Model knows the type and which fields share it |
| Phone / Name / Address | **SUBSTITUTE** | `PHONE_1` `PERSON_2` `ADDR_1` | Page meaning survives; value doesn't |
| Card number | **SUBSTITUTE** | `CARD_1` — no last-4 | Last-4 is still identifying |
| Face, ID document, signature | **TIGHT BBOX MASK** | solid fill + class + box | Solid, not blur — blur and pixelation are recoverable |
| Off-task sensitive region | **CROP OUT** | *excluded from frame* | Cheapest privacy is not sending it |
| Buttons, links, headings, layout | **KEEP** | verbatim | The agent cannot operate without them |

### The vault

```ts
Map<handle, { value, class, originElementId, ttl, allowedSinks }>
```

Service-worker memory only. Never serialised to network, never written to `storage` unencrypted,
destroyed when the task ends or the tab closes.

`allowedSinks` stops the obvious attack: a handle minted from the email field may only ever be
typed back into a field the policy recognises as an email sink — **never into a public comment
box the model was talked into choosing by a prompt-injected page.**

### How we prove metric 3

`eval/redaction/` — ground-truth sensitive regions per screenshot. Report:

- **Mask IoU** against ground truth
- **Over-redaction rate** — % of safe pixels / characters masked
- **Leak rate** — % of sensitive pixels / characters left exposed

Side-by-side raw vs. sanitized viewer in the side panel makes this visible live.

---

## §05 — The Router: local-first, and the latency knob

After perception, before any network thought:

```
                    ScreenGraph + task
                            │
                    ┌───────┴────────┐
                    │  ROUTER        │
                    └───────┬────────┘
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
  LOCAL EXECUTE        NEED SERVER          ASK USER
  deterministic        sanitize →           ambiguous or
  match, conf ≥ 0.9    verify → send        irreversible
  0 ms, no network
```

Local-resolvable cases — a large fraction of real steps:

- Target named unambiguously in the task and found in the ScreenGraph with confidence ≥ 0.9
- Continuation of a plan the server already returned and the page matches expectations
- Mechanical steps: scroll, wait for load, dismiss a cookie banner, focus next field
- Filling a field whose slot was confidently classified, from the local profile vault

### The accuracy / latency trade-off, made explicit

The PS asks participants to *"balance the trade-offs between inference latency and accuracy."*
Make it a visible control, not a hidden constant:

| Mode | Vision | Behaviour | Typical step |
|---|---|---|---|
| **Fast** | cached only | DOM/AX graph, regex+DOM PII, local routing only | ~15 ms |
| **Balanced** *(default)* | coverage-guided, int8 | + ViT on unexplained regions, NER on flagged text | ~90 ms |
| **Thorough** | full frame | + OCR everywhere, full-frame detector sweep | ~350 ms |

The HUD shows per-stage ms and the mode. Demoing the same task at all three, with the accuracy
numbers next to the latency numbers, *is* the answer to that requirement.

---

## §06 — The gate: independent privacy verification

The redactor could have a bug. A second component, **sharing no code with it**, inspects the
serialised payload immediately before `fetch` and can veto the send.

| # | Check | What it does |
|---|---|---|
| **V1** | Re-scan the bytes | Full regex + checksum battery over the outgoing JSON **string**, not the object the redactor built |
| **V2** | Vault cross-check | No vault plaintext appears anywhere in the payload — including URLs, alt text, class names |
| **V3** | Re-detect on masked image | Run the face/ID detector on the **redacted** bitmap. Still finds a face? A mask failed to paint. Fail. |
| **V4** | Entropy sweep | Any high-entropy string > 20 chars that isn't a known handle |
| **V5** | Deny-by-default serialiser | Only whitelisted keys reach the wire. A field added later cannot leak by being forgotten. |
| **V6** | Escalate, then refuse | On failure: re-redact harder, re-verify, max 2 retries, then abort the step and tell the user. Never send. |

**Privacy receipt** per step in the side panel: counts by class, which detector caught what, mask
count, payload bytes, verifier version, payload hash. It turns an invisible guarantee into
something a judge watches happen, live.

---

## §07 — The wire contract

> **Correction:** the PS says the server returns *"processed data to be again ingested by local
> client **or** a UI action."* The earlier draft only modelled actions. Both paths exist.

### Client → Server

```json
{
  "schema": "cordon/redaction@1",
  "task": "Download my latest invoice",
  "mode": "balanced",
  "url_class": "billing.example.com",
  "viewport": { "w": 1280, "h": 720, "scrollY": 0, "docH": 2400 },
  "elements": [
    { "id": "el_12", "role": "textbox", "name": "Email", "bbox": [40,180,300,32],
      "holds": "EMAIL_1", "visible": true, "conf": 0.98, "src": "dom+vision" },
    { "id": "el_13", "role": "textbox", "type": "password", "sensitive": true },
    { "id": "el_14", "role": "button", "name": "Sign in", "bbox": [40,260,120,40] }
  ],
  "groups": [ { "kind": "form", "children": ["el_12","el_13","el_14"] } ],
  "regions": [ { "bbox": [100,80,150,150], "class": "face", "state": "masked" } ],
  "image": null,
  "history": [ { "action": "click", "target": "el_9", "result": "ok" } ]
}
```

`"image": null` by default — the structure channel usually carries the task. The server may reply
`{"type":"need_image"}` and the client sends the masked bitmap on the next turn only.

### Server → Client — four response types

```json
{ "type": "action", "thought": "Email field empty; fill before sign-in.",
  "action": { "kind": "fill", "target": "el_12", "value": "EMAIL_1" }, "confidence": 0.91 }

{ "type": "data",   "answer": "Your last invoice is dated 12 Aug 2026, total 4,820.",
  "cite": ["el_31","el_33"] }

{ "type": "plan",   "steps": [ ...up to 3 actions the client may run locally... ] }

{ "type": "ask_user", "question": "Two accounts are listed. Which one?", "options": [...] }
```

**Action kinds:** `click` · `fill` · `select` · `scroll` · `navigate` · `wait` · `extract` · `done`

`value` must be **either a handle or a string the server composed itself**. A server-side guard
regex-rejects anything resembling real PII in the response — so a prompt-injected page cannot
turn the model into an exfiltration channel.

### What exactly crosses the wire — the question you will be asked

Sensitive content has **three different fates**, not one. Only the sanitized artefact is ever
transmitted; the original is never sent alongside it.

| Fate | Applies to | Server receives | Reversible? |
|---|---|---|---|
| **Removed** | password, OTP, API key, token | `{"type":"password","sensitive":true}` | Nothing to reverse — no value entered the payload |
| **Replaced** | email, name, phone, address, card | `EMAIL_1` | No. The handle is opaque; the map exists only in the client vault |
| **Painted over** | face, ID card, signature | black pixels | No. The original pixels are destroyed, not covered |

Worked example. The page shows a name, an email, a password and a profile photo:

```json
{
  "elements": [
    { "id":"el_3",  "role":"textbox", "name":"Name",     "holds":"PERSON_1" },
    { "id":"el_7",  "role":"textbox", "name":"Email",    "holds":"EMAIL_1"  },
    { "id":"el_9",  "role":"textbox", "type":"password", "sensitive":true   },
    { "id":"el_14", "role":"button",  "name":"Submit"                        }
  ],
  "regions": [ { "bbox":[100,80,150,150], "class":"face", "state":"masked" } ]
}
```

`el_9` carries **no `holds` field at all** — the password never became a handle, because the
server has no legitimate reason to reference it.

### The implementation detail that decides whether this is real

**Masks must be composited into the bitmap and re-encoded — never drawn as an overlay on the
original.**

- Screenshot + a list of boxes the server is trusted not to look at → original pixels are in the file
- CSS `filter: blur()` on the live page, then screenshot → recoverable, and blur is reversible anyway
- **Correct:** draw the capture into an `OffscreenCanvas`, `fillRect` solid black over every box,
  **then** `convertToBlob()`. The face pixels do not exist in the buffer that is sent.

Verifier check **V3** exists precisely to catch a failure here: it re-runs the face detector on
the *outgoing* bitmap. If a face is still detectable, a mask did not paint, and the send is blocked.

### What the server does legitimately learn

Not nothing — and the design is honest about it:

- **that** a password field exists — not its value
- **that** an email exists, and which fields share the same one — not the email
- **that** a face occupies `[100,80,150,150]` — not whose face

This is unavoidable and intended: the PS requires the server to reason over *"structure of the
screen, application fields"*, and no agent can plan "fill the email box" without knowing one
exists. The guarantee is **unidentifiability**, which is the PS's own word — *"Only this
anonymized, unidentifiable data should be transmitted"* — not invisibility.

---

## §08 — Execution: four checks before anything is clicked

| # | Check | What it does |
|---|---|---|
| **E1** | Resolve | Handle → vault. Confirm the target is an **allowed sink** for that class. Password handles resolve only if the user opted into autofill for this origin. |
| **E2** | Policy | Origin allow-list for `navigate`. Step cap, rate limit. Irreversible actions — pay, confirm, delete, send — **always stop for explicit human confirmation**, regardless of confidence. |
| **E3** | Ground | Re-derive the element's stability signature (role + accessible name + bbox hash). If the page re-rendered and it moved, **discard and re-perceive** rather than clicking whatever now sits at that id. |
| **E4** | Execute, verify | Focus, then dispatch through the **native value setter** plus `input`/`change` so React-controlled inputs update. Then diff the ScreenGraph: did the value land, did the URL change, did the target disappear? The **post-condition** decides success, not the model's confidence. |

---

## §09 — Build order

Each phase is demonstrable alone. **Phase 1 is a complete end-to-end agent with zero models in
it** — build that first; a working loop you can extend beats four half-built subsystems.

### Phase 1 — The loop, without AI *(ship first)*

WebExtension MV3 · ScreenGraph from DOM + AX · DOM-rule and regex+checksum detectors · calibrated
fusion with thresholds · handle substitution and vault · verifier V1/V2/V4/V5 · Router with local
execution · mock server returning rule-based actions · executor with grounding · telemetry HUD ·
**the three eval harnesses** · demo pages.

### Phase 2 — Pixels, masks, and the vision channel

Screenshot → OffscreenCanvas → coverage map · ONNX Runtime Web session, WebGPU + WASM fallback ·
face/ID detector · **tight** canvas bbox masking · verifier V3 · fused ScreenGraph.

### Phase 3 — The ViT and the reader

UI element detector fine-tuned on a UI corpus · ViT-Tiny crop classifier · OCR on text-bearing
crops routed back through the text detectors · local NER · the three-mode latency knob.

### Phase 4 — Real reasoning

Open-weights VLM behind guided JSON decoding, redaction grammar in the system prompt, server-side
PII output guard. Firefox build. Final eval numbers.

### Repository shape

```
extension/
  manifest.chrome.json   manifest.firefox.json   vite.config.ts
  src/platform/          browser shim · webextension-polyfill
  src/background/        orchestrator · router · vault · transport
  src/content/           capture · executor · overlay
  src/perception/        dom-graph · ax-tree · coverage-map · screenshot · fusion
  src/privacy/           detectors/{dom,regex,ner,vision} · calibration · fusion
                         redactor · vault · verifier
  src/vision/            ort-session · preprocess · models/
  src/sidepanel/         task UI · privacy receipt · telemetry HUD · payload inspector
  src/shared/            types · ScreenGraph · action schema · redaction grammar
server/                  routes · prompt · guided-json · action guard
eval/
  screens/               labelled pages → metric 1
  pii/                   labelled corpus + hard negatives → metric 2
  redaction/             ground-truth regions → metric 3
  run.ts                 prints the scorecard
demo-pages/              login · profile · checkout · id-upload · canvas-app
docs/                    ARCHITECTURE.md · DIAGRAMS.md
```

---

## §10 — Decisions, corrected against the real PS

| Decision | Earlier draft | Corrected | Why |
|---|---|---|---|
| **Browsers** | Chrome only | **Chrome + Firefox**, behind `src/platform/` | The PS names both explicitly in the expected solution |
| **Server model** | Hosted proprietary API | **Open-weights VLM** — Qwen2.5-VL-7B or Llama-3.2-11B-Vision, cloud-hosted during SIH, vLLM-deployable offline | PS: *"free to use any offline deployable open-source/open-weights model... during SIH they can use cloud hosted version"* |
| **PII fusion** | Union, fail closed | **Calibrated noisy-OR, two thresholds, context tie-break** | Metric 2 grades precision equally with recall |
| **Redaction granularity** | "mask the region" | **Per-span `getClientRects()`, tight boxes** | Metric 3 grades redaction *precision* |
| **Server in the loop** | Every step | **Local-first Router; server on escalation** | PS says the local model decides; also metrics 4 and 5 |
| **Server response** | Actions only | **action \| data \| plan \| ask_user** | PS: *"processed data... or a UI action"* |
| **Image transmission** | Always | **Opt-in per step, server requests it** | Cheaper, more private, and the structure channel usually suffices |
| **Email alias / relay** | Proposed | **Dropped from scope** | Not in the PS and earns nothing on the rubric — see below |

### One end-to-end demo task

The PS requires *"an end-to-end task assisting the user"*. Pick one and make it excellent:

> **"Fill this job application from my profile."** — a multi-section form with a name, an email,
> a phone, a file upload, an experience textarea, *and* a photo/ID upload preview on the page.
> It exercises every subsystem: DOM perception, vision on the ID image, PII detection across
> both channels, tight redaction, handle substitution, server planning, local resolution,
> grounding, and human confirmation before submit.

---

## Appendix — Where the earlier thinking went wrong

Kept here deliberately; the corrections are the interesting part of the design story.

1. **The diagrams had no vision model.** The flow was Raw Form → PII Detection → Server. That is a
   *form-redaction* pipeline, not a *visual perception* pipeline — and metric 1, at 25%, is
   visual context accuracy. Vision is not the PII detector's helper; it is the primary product.
2. **"Recall is what's graded."** It isn't; precision is graded with equal weight, twice over.
3. **The server was assumed to always be in the loop.** The PS explicitly makes local the default
   and the server conditional.
4. **The scale diagram assumed one server round-trip per step.** With local-first routing, most
   steps never leave the device — which is a *better* slide, not a worse one.
5. **The email-alias idea was scope creep.** Genuinely nice product thinking, zero rubric points.
   Note it as future work in the writeup; do not build it.
