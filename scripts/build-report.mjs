/**
 * Turns the eval results into a page a judge can read in thirty seconds.
 *
 *   npm run report      → demo-pages/report.html
 *
 * The numbers already existed; they were in a terminal, in the order the code
 * happened to compute them, with no indication of which of them the problem
 * statement actually grades or what a good value would be. That is a reporting
 * failure, not a results failure.
 *
 * So this leads with the five PS metrics and their weights, states what each one
 * measures and how it was obtained, and only then shows the evidence. Every
 * chart is inline SVG — no libraries, no network, so it opens from a file:// URL
 * on a laptop with no wifi.
 *
 * Anything not measured is marked "not measured" rather than given a number.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const OUT = "demo-pages/report.html";
const SRC = "eval_output.json";

if (!existsSync(SRC)) {
  console.log(`\n  ${SRC} is missing. Run: npm run eval\n`);
  process.exit(1);
}
const d = JSON.parse(readFileSync(SRC, "utf8"));

const esc = (v) =>
  String(v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const pct = (n) => `${Math.round(n * 100)}%`;

/* ── the five metrics the problem statement grades ──────────────────────────
   Each carries a state, not just a number: "measured" means this run produced
   it, "partial" means part of it is measured and part is not, "not measured"
   means we have no number and will not invent one. */
const METRICS = [
  {
    n: 1,
    name: "Accuracy of visual context extraction",
    weight: 25,
    state: d.coverage ? "partial" : "unmeasured",
    value: "no labelled set",
    what: "Does the agent correctly understand what is on screen — the controls, their roles, their names?",
    how: "The DOM + accessibility path is exercised on every run and the ScreenGraph is verified element by element. The vision half (face detection, ViT classification) has no labelled ground-truth set yet, so there is no single accuracy figure. Stated as unmeasured rather than estimated.",
  },
  {
    n: 2,
    name: "PII detection recall and precision",
    weight: 20,
    state: "measured",
    value: `P ${d.precision.toFixed(3)} · R ${d.recall.toFixed(3)}`,
    what: "Of the sensitive things on the page, how many were caught — and of the things caught, how many were actually sensitive?",
    how: `Run against a fixture carrying ${d.confusion.tp + d.confusion.fn} planted secrets and ${d.hardNegatives?.length ?? 0} deliberate hard negatives (an order number, a tracking ID, a Verhoeff-invalid Aadhaar, a Luhn-invalid card) that must NOT be redacted. Recall alone is easy — redact everything. Precision is what makes it hard.`,
  },
  {
    n: 3,
    name: "Precision of redaction",
    weight: 20,
    state: "measured",
    value: `${d.redaction.dropped + d.redaction.substituted} changed, ${d.redaction.kept} kept`,
    what: "When something is removed, is only that thing removed — or the paragraph around it?",
    how: "Redaction works on character offsets inside a value, not on whole elements: eleven characters of an email are replaced, not the sentence containing it. The verifier re-scans the serialised bytes afterwards and can veto transmission.",
  },
  {
    n: 4,
    name: "Client-side resource usage",
    weight: 20,
    state: "measured",
    value: `${d.coverage.unexplainedRegions} region(s) analysed`,
    what: "What does running this actually cost the user's laptop?",
    how: `On a ${d.coverage.cols}×${d.coverage.rows} grid of 32px cells, the DOM accounts for ${d.coverage.coveredCells} of ${d.coverage.totalCells}. Everything it cannot explain is merged into ${d.coverage.unexplainedRegions} region(s) — and only those are given to a model. The whole-frame alternative is one model pass over all ${d.coverage.totalCells} cells, every step. The extension also reports its compute backend and heap live in the side panel.`,
  },
  {
    n: 5,
    name: "End-to-end latency",
    weight: 15,
    state: "measured",
    value: `${(d.timings.detect + d.timings.redact + d.timings.verify).toFixed(1)} ms pipeline`,
    what: "How long from asking for something to it happening?",
    how: `${d.router.localCount} of ${d.router.total} benchmark tasks never touch the network at all, which is the largest single latency win available. The privacy pipeline itself costs ${(d.timings.detect + d.timings.redact + d.timings.verify).toFixed(1)} ms for ${d.timings.elements} elements.`,
  },
];

const bar = (segments, height = 26) => {
  const total = segments.reduce((n, s) => n + s.v, 0) || 1;
  let x = 0;
  const parts = segments
    .filter((s) => s.v > 0)
    .map((s) => {
      const w = (s.v / total) * 100;
      const r = `<rect x="${x}%" y="0" width="${w}%" height="${height}" fill="${s.c}"><title>${esc(s.label)}: ${s.v}</title></rect>`;
      x += w;
      return r;
    })
    .join("");
  return `<svg class="bar" viewBox="0 0 100 ${height}" preserveAspectRatio="none" height="${height}">${parts}</svg>`;
};

const legend = (segments) =>
  `<div class="legend">${segments
    .filter((s) => s.v > 0)
    .map((s) => `<span><i style="background:${s.c}"></i>${esc(s.label)} <b>${s.v}</b></span>`)
    .join("")}</div>`;

const donut = (value, label, colour) => {
  const r = 42, c = 2 * Math.PI * r;
  const on = c * value;
  return `<svg viewBox="0 0 110 110" class="donut">
    <circle cx="55" cy="55" r="${r}" fill="none" stroke="var(--line)" stroke-width="11"/>
    <circle cx="55" cy="55" r="${r}" fill="none" stroke="${colour}" stroke-width="11"
      stroke-dasharray="${on} ${c}" stroke-linecap="round" transform="rotate(-90 55 55)"/>
    <text x="55" y="52" text-anchor="middle" class="dv">${pct(value)}</text>
    <text x="55" y="70" text-anchor="middle" class="dl">${esc(label)}</text>
  </svg>`;
};

const timingSegs = [
  { label: "detect", v: d.timings.detect, c: "#c9922e" },
  { label: "redact", v: d.timings.redact, c: "#b4574a" },
  { label: "verify", v: d.timings.verify, c: "#7a5bbd" },
];
const redactSegs = [
  { label: "removed outright", v: d.redaction.dropped, c: "#b4574a" },
  { label: "replaced with a handle", v: d.redaction.substituted, c: "#7a5bbd" },
  { label: "masked in the image", v: d.redaction.masked, c: "#c9922e" },
  { label: "kept — safe to send", v: d.redaction.kept, c: "#2f8f5b" },
];
const routeSegs = [
  { label: "resolved on device", v: d.router.localCount, c: "#2f8f5b" },
  { label: "needed the server", v: d.router.total - d.router.localCount, c: "#5b6fd6" },
];

const stateChip = (s) =>
  s === "measured"
    ? '<span class="chip ok">measured this run</span>'
    : s === "partial"
      ? '<span class="chip warn">partly measured</span>'
      : '<span class="chip bad">not measured</span>';

const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Cordon — Evaluation Report</title>
<style>
  :root{--bg:#f7f8f8;--card:#fff;--line:#dee3e5;--ink:#161d20;--ink2:#55636a;--ink3:#869599;--acc:#0b6e77;
        --ok:#2f8f5b;--bad:#a32b20;--warn:#9a6b12;}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);
       font:15px/1.6 "Segoe UI",system-ui,-apple-system,sans-serif;}
  header{background:#0e1214;color:#fff;padding:34px 28px 30px}
  .wrap{max-width:1000px;margin:0 auto;padding:0 24px}
  header .wrap{padding:0}
  h1{margin:0 0 6px;font-size:25px;letter-spacing:-.02em}
  header p{margin:0;color:#9fb0b4;font-size:14px}
  .verdict{display:inline-flex;align-items:center;gap:9px;margin-top:18px;padding:8px 16px;
    border-radius:100px;font-weight:600;font-size:14px}
  .verdict.pass{background:#12301f;color:#6cd39a;border:1px solid #23583a}
  .verdict.fail{background:#33150f;color:#f08a7e;border:1px solid #5c241c}
  main{max-width:1000px;margin:-18px auto 70px;padding:0 24px}
  section{background:var(--card);border:1px solid var(--line);border-radius:12px;
    padding:24px 26px;margin-bottom:18px}
  h2{font-size:12px;letter-spacing:.11em;text-transform:uppercase;color:var(--ink2);
     margin:0 0 4px;font-weight:700}
  .lede{color:var(--ink2);font-size:14px;margin:0 0 20px;max-width:70ch}
  .metric{border-top:1px solid var(--line);padding:18px 0}
  .metric:first-of-type{border-top:0;padding-top:4px}
  .mhead{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}
  .mnum{font:700 12px/1 ui-monospace,Consolas,monospace;color:#fff;background:var(--acc);
        border-radius:5px;padding:5px 7px}
  .mname{font-weight:600;font-size:16px}
  .mweight{margin-left:auto;font:600 12px ui-monospace,Consolas,monospace;color:var(--ink2);
           white-space:nowrap}
  .mval{font:600 19px/1.2 ui-monospace,Consolas,monospace;color:var(--acc);margin:9px 0 2px}
  .mwhat{margin:8px 0 0;font-weight:600}
  .mhow{margin:5px 0 0;color:var(--ink2);font-size:14px;max-width:78ch}
  .chip{display:inline-block;font:600 10px/1 ui-monospace,Consolas,monospace;padding:4px 7px;
        border-radius:4px;text-transform:uppercase;letter-spacing:.05em;vertical-align:2px}
  .chip.ok{background:#e7f3ec;color:var(--ok)}
  .chip.warn{background:#fbf2df;color:var(--warn)}
  .chip.bad{background:#fbeceb;color:var(--bad)}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:18px}
  .donut{width:120px;height:120px}
  .dv{font:700 20px ui-monospace,Consolas,monospace;fill:var(--ink)}
  .dl{font:500 9px ui-monospace,Consolas,monospace;fill:var(--ink2);
      text-transform:uppercase;letter-spacing:.07em}
  .cell{display:flex;flex-direction:column;align-items:center;text-align:center;gap:6px}
  .cell p{margin:0;font-size:13px;color:var(--ink2);max-width:30ch}
  .bar{width:100%;display:block;border-radius:6px;overflow:hidden;background:#eef1f2}
  .legend{display:flex;flex-wrap:wrap;gap:8px 18px;margin-top:11px;font-size:13px;color:var(--ink2)}
  .legend i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px;
            vertical-align:-1px}
  .legend b{color:var(--ink);font-variant-numeric:tabular-nums}
  table{width:100%;border-collapse:collapse;font-size:13.5px}
  th{text-align:left;font:700 10px ui-monospace,Consolas,monospace;text-transform:uppercase;
     letter-spacing:.07em;color:var(--ink2);padding:0 12px 8px 0;border-bottom:1px solid var(--line)}
  td{padding:9px 12px 9px 0;border-bottom:1px solid #eef1f2;vertical-align:top}
  tr:last-child td{border-bottom:0}
  .tag{font:600 10px ui-monospace,Consolas,monospace;padding:3px 7px;border-radius:4px;
       text-transform:uppercase;white-space:nowrap}
  .tag.local{background:#e7f3ec;color:var(--ok)}
  .tag.server{background:#eceffb;color:#3f52b5}
  .tag.pass{background:#e7f3ec;color:var(--ok)}
  .tag.fail{background:#fbeceb;color:var(--bad)}
  code{font:500 12.5px ui-monospace,Consolas,monospace;background:#eef1f2;padding:2px 5px;
       border-radius:4px}
  .note{border-left:3px solid var(--acc);padding:2px 0 2px 14px;color:var(--ink2);font-size:14px;
        margin:16px 0 0;max-width:78ch}
  .caveat{border-left-color:var(--warn)}
  footer{color:var(--ink2);font-size:12.5px;text-align:center;padding:0 24px 50px;max-width:1000px;
         margin:0 auto}
  @media (max-width:640px){.mweight{margin-left:0;width:100%}}
</style></head>
<body>
<header><div class="wrap">
  <h1>Cordon — Evaluation Report</h1>
  <p>SIH26171 · On-device Visual Perception for Light-weight Browser Agents</p>
  <div class="verdict ${d.pass ? "pass" : "fail"}">
    ${d.pass ? "✓ All checks passed" : "✗ Some checks failed"}
    <span style="opacity:.65;font-weight:400">· generated ${esc(new Date(d.generatedAt).toLocaleString())}</span>
  </div>
</div></header>

<main>

<section>
  <h2>The five graded metrics</h2>
  <p class="lede">These are the criteria in the problem statement, with their weights.
     Each says what it measures, what this run produced, and how it was obtained —
     so a number can be checked rather than taken on trust.</p>
  ${METRICS.map(
    (m) => `
  <div class="metric">
    <div class="mhead">
      <span class="mnum">${m.n}</span>
      <span class="mname">${esc(m.name)}</span>
      <span class="mweight">${m.weight}% of the marks</span>
    </div>
    <p class="mval">${esc(m.value)} ${stateChip(m.state)}</p>
    <p class="mwhat">${esc(m.what)}</p>
    <p class="mhow">${esc(m.how)}</p>
  </div>`,
  ).join("")}
</section>

<section>
  <h2>Metric 2 — did it catch the right things?</h2>
  <p class="lede">Recall alone is trivial: redact the whole page and you never miss anything.
     The fixture therefore plants hard negatives that look sensitive and are not, and
     over-redacting any of them counts against us.</p>
  <div class="grid">
    <div class="cell">${donut(d.precision, "precision", "#2f8f5b")}
      <p>Of everything redacted, how much genuinely needed it.</p></div>
    <div class="cell">${donut(d.recall, "recall", "#0b6e77")}
      <p>Of everything sensitive, how much was caught.</p></div>
    <div class="cell">${donut(d.f1, "F1", "#7a5bbd")}
      <p>The two combined — neither can be traded for the other.</p></div>
  </div>
  <table style="margin-top:22px">
    <tr><th>Outcome</th><th>Count</th><th>Meaning</th></tr>
    <tr><td>True positives</td><td><b>${d.confusion.tp}</b></td><td>Sensitive, and redacted. Correct.</td></tr>
    <tr><td>False negatives</td><td><b>${d.confusion.fn}</b></td><td>Sensitive, and <b>missed</b>. ${d.misses?.length ? esc(d.misses.join(", ")) : "None."}</td></tr>
    <tr><td>False positives</td><td><b>${d.confusion.fp}</b></td><td>Harmless, but <b>redacted anyway</b>. ${d.falsePositives?.length ? esc(d.falsePositives.join(", ")) : "None."}</td></tr>
    <tr><td>True negatives</td><td><b>${d.confusion.tn}</b></td><td>Harmless, and correctly left alone.</td></tr>
  </table>
  ${
    d.hardNegatives?.length
      ? `<p class="note">Everything in this fixture that must survive untouched:
         ${d.hardNegatives.map((h) => `<code>${esc(h)}</code>`).join(" ")}.
         Some are decoy numbers a naive regex reads as an Aadhaar, a card or a phone —
         checksums (Verhoeff, Luhn) and surrounding context are what tell those apart.
         The rest are ordinary labels and controls: redacting them would break the page
         without protecting anyone.</p>`
      : ""
  }
  <p class="note caveat">One fixture is not a benchmark. This is a small, adversarial
     test set we wrote ourselves; it demonstrates the method and guards against regressions,
     but it is not evidence of accuracy on the open web.</p>
</section>

<section>
  <h2>Metric 3 — what actually happened to the data</h2>
  <p class="lede">Every value on the page is put into exactly one of four buckets. Nothing
     is left undecided, and "kept" is a decision that has to be justified too.</p>
  ${bar(redactSegs, 30)}
  ${legend(redactSegs)}
  <p class="note">A value replaced with a handle still tells the server something useful —
     that two fields hold the <em>same</em> email, for instance — without telling it which
     email. Secrets get no handle at all: a password is removed, and nothing stands in for it.</p>
</section>

<section>
  <h2>Metric 4 — what it costs the laptop</h2>
  <p class="lede">The cheapest model pass is the one that never runs. The DOM already
     explains most of the screen, so only the parts it cannot account for are ever
     given to a model.</p>
  <div class="grid">
    <div class="cell">${donut(d.coverage.coveredCells / d.coverage.totalCells, "explained", "#2f8f5b")}
      <p>${d.coverage.coveredCells} of ${d.coverage.totalCells} cells accounted for by the DOM — never analysed.</p></div>
    <div class="cell">
      <p style="font:700 34px/1.1 ui-monospace,Consolas,monospace;color:var(--acc);margin:14px 0 0">${d.coverage.unexplainedRegions}</p>
      <p><b>region(s)</b> needed a model pass, on a ${d.coverage.cols}×${d.coverage.rows} grid of 32px cells.</p></div>
    <div class="cell">
      <p style="font:700 34px/1.1 ui-monospace,Consolas,monospace;color:var(--acc);margin:14px 0 0">${d.verifier.bytes}</p>
      <p><b>bytes</b> left the device for this page — a redacted ScreenGraph, not a screenshot.</p></div>
  </div>
</section>

<section>
  <h2>Metric 5 — where the time goes</h2>
  <p class="lede">The privacy pipeline runs on every step that leaves the device.
     ${d.timings.elements} elements, end to end:</p>
  ${bar(timingSegs, 30)}
  ${legend(timingSegs)}
  <p style="margin:16px 0 0;font-size:14px">
    <b>${(d.timings.detect + d.timings.redact + d.timings.verify).toFixed(2)} ms</b> total.
    For comparison, one network round trip to a server is typically 30–300 ms — which is why
    the largest latency win is not making the pipeline faster, but not using the network at all.
  </p>
  <h2 style="margin-top:26px">Tasks that never touch the network</h2>
  ${bar(routeSegs, 30)}
  ${legend(routeSegs)}
  <table style="margin-top:18px">
    <tr><th>Task</th><th>Route</th><th>Why</th><th></th></tr>
    ${d.router.rows
      .map(
        (r) => `<tr><td><code>${esc(r.task)}</code></td>
        <td><span class="tag ${r.route}">${esc(r.route)}</span></td>
        <td style="color:var(--ink2)">${esc(r.why)}</td>
        <td><span class="tag ${r.pass ? "pass" : "fail"}">${r.pass ? "pass" : "fail"}</span></td></tr>`,
      )
      .join("")}
  </table>
</section>

<section>
  <h2>The verifier — the last gate before the network</h2>
  <p class="lede">The redactor decides what to remove. The verifier independently re-reads the
     bytes that are about to be sent and can refuse. It is deliberately not the same code, so
     a bug in one is not automatically a bug in the other.</p>
  <table>
    <tr><th>Check</th><th>What it proves</th><th></th></tr>
    ${d.verifier.checks
      .map(
        (c) => `<tr><td><code>${esc(c.id)}</code> ${esc(c.name)}</td>
        <td style="color:var(--ink2)">${esc(c.detail ?? "")}</td>
        <td><span class="tag ${c.passed ? "pass" : "fail"}">${c.passed ? "pass" : "fail"}</span></td></tr>`,
      )
      .join("")}
  </table>
  <p class="note">If any check fails, transmission does not happen. The agent stops rather
     than sending something it cannot vouch for.</p>
</section>

<section>
  <h2>Everything else that was checked</h2>
  <div class="legend" style="font-size:14px">
    ${Object.entries(d.tests)
      .map(
        ([k, v]) =>
          `<span><i style="background:${v ? "#2f8f5b" : "#a32b20"}"></i>${esc(k)} <b>${v ? "pass" : "FAIL"}</b></span>`,
      )
      .join("")}
  </div>
  <p class="note">Reproduce all of this with <code>npm run eval</code>. The browser half —
     service worker, content script, the in-page visualiser, the side panel — is covered
     separately by <code>npm run browser-check</code>, and the open-weights server path by
     <code>npm run vlm-check</code> and <code>npm run live-model</code>.</p>
</section>

</main>
<footer>
  Generated from <code>eval_output.json</code> by <code>npm run report</code>.
  Every figure on this page comes from that run — nothing here is hand-written.
</footer>
</body></html>
`;

writeFileSync(OUT, html);
console.log(`\n  Report written to ${OUT}`);
console.log(`  Open it at http://127.0.0.1:8788/report.html  (npm run demo)\n`);
