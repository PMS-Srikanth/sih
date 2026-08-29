# Cordon

**SIH26171 — On-device Visual Perception for Light-weight Browser Agents**

A browser extension where perception and privacy enforcement run on the user's device.
The server reasons about the page without ever receiving a pixel, a password, or a name.

> The full loop is implemented: DOM + accessibility-tree perception, coverage-guided
> vision (UltraFace always, a ViT classifier in Thorough mode), calibrated PII detection,
> redaction, a verifier with a veto, local-first routing, and grounded execution with a
> read-back check. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Run it

You need **Node 20+** and Chrome or Edge. Nothing else — no Python, no GPU, no API key.
(Python is only for rebuilding the slide deck; see `requirements.txt`.)

```bash
git clone https://github.com/PMS-Srikanth/sih.git
cd sih
npm run setup
```

`npm run setup` installs, builds, checks its own work, runs the evaluation and writes
the report. Then start it:

```bash
npm start
```

That runs the agent server and the demo pages together and prints the URLs. Leave the
terminal open; Ctrl+C stops both. If a port is already in use it works out whether the
thing holding it is ours — and just uses it — or something else, which it names.

Two things a script cannot do for you:

**1 · Load the extension.** `chrome://extensions` → Developer mode → **Load unpacked** →
select the **`dist`** folder inside the repo. Not the repo root, not `extension/`.

**2 · Create your vault.** Open the side panel, expand **My data**, choose a passphrase
and fill in a few fields. It is encrypted on your own machine and deliberately not in
git, so every teammate does this once.

Then open <http://127.0.0.1:8788/> and pick a page — including `report.html`, which is
the evaluation metrics rendered as charts rather than terminal output.

### If something does not work

```bash
npm run doctor
```

It inspects your machine and names the cause with the command that fixes it — no build,
a build older than the source, servers down, missing models, no browser. It changes
nothing. **Send its output** if you are asking someone else for help; "it doesn't work"
is not something anyone can act on.

### Three things that catch everyone

These are the reason one person sees a feature and someone else on the same commit
does not. If something looks missing, it is almost always one of these.

**1 · Load `dist/`, not `extension/`.** `dist/` is gitignored and does not exist until
you run `npm run build`. Pointing Chrome at the repo root or at `extension/` gives you
an extension that loads but does nothing.

**2 · Reload the extension after every build.** Chrome keeps the old copy until you click
Reload on the card. The side-panel header prints a build stamp — if it does not match what
`npm run build` just printed, none of your changes are live and you are debugging code
that is not running.

**3 · Set up *My data* on your own machine.** The profile is encrypted with a passphrase
you choose and stored only on your device, so it is deliberately not in git. Until you
open the side panel, expand **My data** and create a vault, "fill this form from my
profile" has nothing to fill from and will look like it silently does nothing. Every
teammate has to do this once, on their own laptop. Saved drafts work the same way —
they live in that browser's `localStorage`.

### If it still is not working

```bash
npm run doctor
```

Checks this machine and names what is wrong, with the command that fixes it: missing
build, stale build, servers down, missing models, no browser. It changes nothing.

Optional, and only if you want Thorough mode's ViT classifier:

```bash
npm run fetch-models   # 84 MB, one-off
```

Everything works without it — Thorough mode simply falls back to the face detector
alone, which is why it is not in the repository.

Now open <http://127.0.0.1:8788/application.html>, click the Cordon icon, and try:

| Task | What it demonstrates |
|---|---|
| `Click "Save draft"` | **Local route.** Resolved on device — 0 network calls, no redaction work |
| `What sensitive data is on this page?` | **Server route** returning *data* rather than an action |
| `Fill this application from my profile` | Full loop — detect, redact, verify, transmit, resolve, ground, execute |
| `Submit application` | **Human confirmation** before an irreversible action — and the value is editable before you approve it |
| `Fill this form` on `job-form.html` | The agent hits **Years of experience**, which no stored data can answer, and asks you. What you type is filled in locally and never sent |

While it runs, a cursor travels to each control the agent chose, a ring closes on it, and
a caption names the action — so the work is visible, not just its result. The captions name
the *field*, never the value.

The side panel carries four things worth showing:

- **Your view / Server's view** — the same page with your real data in it, and with
  everything sensitive already gone. Both are true; the overlay is only one of them.
- **Network traffic** — every request that left the machine, both bodies, both sizes,
  round trip. A local-only run leaves this list empty.
- **Resources** — which processor ran the model, model memory, how much of the frame the
  DOM already explained so no model had to look at it, and where the time went.
- **What the agent entered** — the values that landed in the page, hidden until you
  reveal them, so you can audit your own run.

---

## Live demo — a run order that works

Three terminals, then load `dist/` unpacked. Check the build stamp in the panel
header matches what `npm run build` printed; if it does not, hit reload on the
extension card.

**1 · The agent is real, and it is visible.**
Open `job-form.html` — every field is blank. Unlock your profile in *My data*,
then run `Fill this form from my profile`. A cursor travels to each field, a ring
closes on it, and a caption says what it is doing. The captions name the *field*,
never the value.

**2 · It stops when it does not know.**
The same run reaches **Years of experience**. Nothing in an identity vault answers
that, so it asks instead of inventing an employment history. Type an answer — it
is filled in locally and never sent. This is the honest half of the pitch.

**3 · The value is yours to change.**
Run `Submit application` on `application.html`. The confirmation shows the value
and lets you edit it before approving. Passwords and OTPs are confirmed blind on
purpose — those never reach a screen.

**4 · Both views are true.**
Switch *Your view* / *Server's view* in the panel. Same page: yours with your data
in it, the server's with it already gone.

**5 · Show the traffic.**
Open **Network traffic**. Every request, both bodies, both sizes, the round trip.
Then run `Click "Save draft"` — it resolves on device and the list stays empty.
That is the strongest version of the claim.

**6 · Show the cost.**
Open **Resources**: which processor ran the model, model memory, how much of the
frame the DOM already explained so nothing had to look at it, and where the time
went. The animation time is listed separately and excluded from every figure.

**7 · Prove it without the browser.**

```bash
npm run eval          # PII precision/recall, redaction, verifier, router
npm run vlm-check     # the open-weights server path, against a mock endpoint
npm run model-check   # the ONNX model loads and its shapes match
npm run browser-check # the extension in a real browser — 53 assertions
npm run check-escapes # regexes whose backslashes were eaten by a shell edit
npm run report        # regenerate demo-pages/report.html from the last eval
npm run live-model    # against a real model (needs: ollama pull qwen2.5:3b)
```

**If the server is down**, the demo still runs — the planner falls back to rules,
and `vlm-check` proves that fallback. Say so rather than hiding it.

---

## Prove the engine without a browser

```bash
npm run eval
```

Runs the detectors, fusion, redaction and the verifier over a fixture that mirrors the
demo page — with deliberate **hard negatives** (order numbers, tracking IDs, a
Verhoeff-invalid Aadhaar, a Luhn-invalid card) that must *not* be redacted, because the
evaluation grades precision as heavily as recall.

Current result on the fixture:

```
precision 1.000   recall 1.000   F1 1.000
detect 8.79 ms · redact 1.66 ms · verify 2.24 ms   for 21 elements
verdict: PASS — cleared for transmission
```

Sample of what actually crosses the wire:

```
el_2   Email address    → EMAIL_1
el_4   Password         → sensitive: true   (value removed, no handle)
el_7   Aadhaar number   → AADHAAR_1

prose → "Questions? Write to EMAIL_2 or call PHONE_2."
```

That last line is the point: the eleven characters of the email are replaced at their
exact offsets — not the sentence, not the paragraph, not the element.

---

## Your data stays on your device

Open **My data** in the side panel and fill in your name, email, mobile, Aadhaar and so on.
It is stored in extension-local storage, which the page cannot read, and it is **never put
into a payload**.

When the agent meets a blank form, the client classifies each empty field and tells the
server only what *type* it can supply:

```json
{ "id": "el_101", "role": "textbox", "name": "Full name", "wants": "PERSON_1" }
```

The server does the genuinely hard part — deciding which slot belongs in which field, across
multi-page forms and conditional sections — and replies `fill el_101 with PERSON_1`. The
client resolves `PERSON_1` from local storage at the last moment. The name never leaves.

This works on **any** site, not just the demo pages: the content script runs on all URLs, so
a Google Form or a real job application is filled the same way. Anything the extension
detects as PII on the page is still detected and redacted before transmission.

`allowedSinks` still applies. In the harness a blank form yields:

```
el_101  Full name       wants: PERSON_1
el_102  Email address   wants: EMAIL_1
el_105  Comments        wants: —        ← a big free-text box is never a PII sink
profile values in the payload: NONE
```

> **Honest limitation.** Extension-local storage is isolated from web pages but is not
> encrypted at rest. A passphrase-derived key is the right next step; today the guarantee is
> "the page and the network cannot see it", not "an attacker with your disk cannot".

## How it maps to the evaluation

| # | Metric | Weight | Where |
|---|---|---|---|
| 1 | Accuracy of visual context | 25% | `perception/dom-graph.ts` — ScreenGraph, occlusion-aware. Vision channel: phase 2 |
| 2 | PII recall **and** precision | 20% | `privacy/detectors/*`, `privacy/fusion.ts` — noisy-OR, two thresholds, context tie-break |
| 3 | Precision of redaction | 20% | `privacy/redactor.ts` — span-offset substitution; `content/overlay.ts` — `Range.getClientRects` |
| 4 | Client resource utilization | 20% | `agent/router.ts` — local-first; element caps; no model load on the local path |
| 5 | End-to-end latency | 15% | Most steps never reach the network. Per-stage timings in the side panel |

---

## Layout

```
extension/
  manifest.chrome.json · manifest.firefox.json
  src/
    perception/dom-graph.ts     DOM + AX tree → ScreenGraph, occlusion, grouping, signatures
    privacy/
      checksums.ts              Verhoeff · Luhn · PAN · IFSC · entropy
      patterns.ts               pattern rules, checksum-gated
      detectors/dom.ts          type=password, autocomplete tokens, label keywords, allowed sinks
      detectors/regex.ts        patterns over values AND prose
      fusion.ts                 noisy-OR, τ_high/τ_low, context tie-break
      vault.ts                  typed stable handles; service-worker memory only
      redactor.ts               drop · substitute · mask → SanitizedContext
      verifier.ts               V1–V6, independent of the redactor, has a veto
    agent/
      router.ts                 local-first: is the server needed at all?
      policy.ts                 handle resolution, allowed sinks, irreversible-action gate
    content/
      index.ts                  message handling in the page's isolated world
      executor.ts               grounding + native-setter execution + post-condition
      overlay.ts                the visual proof
    background/
      index.ts                  orchestrator — the only process holding real values
      transport.ts              the only place that performs a network request
    sidepanel/                  task UI, step log, privacy receipt, timings
server/index.mjs                rule-based planner; swap plan() for the VLM in phase 4
demo-pages/                     application.html · login.html
eval/smoke.ts                   headless P/R + latency
docs/                           ARCHITECTURE.md · DIAGRAMS.md · Cordon_SIH26171.pptx
```

---

## The privacy boundary, precisely

Sensitive content has three fates. Only the sanitized artefact is ever transmitted.

| Fate | Applies to | Server receives | Reversible |
|---|---|---|---|
| **Removed** | password, OTP, API key | `"sensitive": true` | Nothing to reverse — no value entered the payload |
| **Replaced** | email, name, phone, card, Aadhaar, PAN | `EMAIL_1` | No — the map exists only in the client vault |
| **Painted over** | face, ID card *(phase 2)* | black pixels | No — composited into the bitmap, not overlaid |

The server legitimately learns **that** a password field exists, **that** an email exists and
which fields share it, and **where** a masked region sits — never the values. That is
unidentifiability, which is the word the problem statement uses, not invisibility.

---

## Phase 1 status

- [x] ScreenGraph from DOM + accessibility tree, with occlusion detection
- [x] DOM-rule and pattern detectors, checksum-gated
- [x] Calibrated fusion — noisy-OR, two thresholds, context tie-break
- [x] Typed stable handles + in-memory vault
- [x] Span-offset redaction
- [x] Verifier V1, V2, V4, V5 + V6 escalation *(V3 needs the image channel)*
- [x] Local profile store + side-panel editor; blank-form filling via `wants` handles
- [x] Local-first router, with offscreen/occluded distinction
- [x] Loop termination — repeat guard, no-progress fingerprint, server `done`
- [x] Allowed-sink enforcement + irreversible-action confirmation
- [x] Grounding via stability signatures; native-setter execution
- [x] Rule-based server speaking the redaction schema, with an output guard
- [x] Side panel: step log, per-stage timings, privacy receipt
- [x] Headless P/R harness
- [ ] **Phase 2** — screenshot capture, coverage map, ONNX Runtime Web, face/ID detector,
      canvas bbox masking, verifier V3


## The open-weights path

```bash
npm run vlm-check
```

Stands up a mock OpenAI-compatible endpoint and drives the real server against it:
request shape, the redaction grammar in the system prompt, JSON extraction from a
fenced reply, and the fallback to the rule planner when the model is down.

To use a real model instead:

```bash
ollama pull qwen2.5:3b
CORDON_VLM_URL=http://127.0.0.1:11434/v1/chat/completions npm run server
```
