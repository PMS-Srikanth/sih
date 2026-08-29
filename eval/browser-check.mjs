/**
 * Loads the built extension into a real browser and drives it.
 *
 *   npm run browser-check
 *
 * Everything else in eval/ runs the logic with the browser absent. That leaves
 * the half of this project that only exists in a browser — the service worker,
 * the content script, the shadow-root overlays, the side panel — verified only
 * by "it compiled". This closes that gap: real browser, real extension, real
 * page, real messages across the real boundaries.
 *
 * It needs Edge or Chrome installed and the extension built (`npm run build`). It starts
 * the demo page server and the agent server itself.
 *
 * Headful by default because an extension service worker is more reliable that
 * way and because you can watch it happen. Pass --headless for CI.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer-core";

const HEADLESS = process.argv.includes("--headless");
const KEEP = process.argv.includes("--keep");
const SHOTS = path.resolve("eval/screenshots");
const DIST = path.resolve("dist");

/**
 * Which browser to drive.
 *
 * Edge comes first, and that is not a preference — Chrome 137 removed the
 * --load-extension switch, so Chrome 138+ cannot load an unpacked extension for
 * automation at all. The usual answer is Chrome for Testing, which this machine's
 * Application Control policy refuses to execute. Edge is the same Chromium with
 * the same chrome.* extension APIs and still accepts the switch, so it is what
 * actually exercises the code. Chrome entries stay as fallbacks for machines
 * running an older build or a permitted Chrome for Testing.
 */
const BROWSER_CANDIDATES = [
  ["Edge", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"],
  ["Edge", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"],
  ["Chrome for Testing", "chrome/win64-152.0.7977.64/chrome-win64/chrome.exe"],
  ["Chrome", "C:/Program Files/Google/Chrome/Application/chrome.exe"],
  ["Chrome", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe"],
  ["Chromium", "/usr/bin/chromium"],
  ["Chrome", "/usr/bin/google-chrome"],
  ["Edge", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
  ["Chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
];

let pass = 0;
let fail = 0;
const warnings = [];

const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  ok ? pass++ : fail++;
  return ok;
};
const note = (m) => console.log(`        ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── preflight ──────────────────────────────────────────────────────────────

const found = BROWSER_CANDIDATES.map(([n, b]) => [n, path.resolve(b)]).find(([, b]) => existsSync(b));
if (!found) {
  console.log("\n  No Chromium-based browser found. Install Edge or Chrome.\n");
  process.exit(1);
}
const [browserName, chromePath] = found;
if (!existsSync(path.join(DIST, "manifest.json"))) {
  console.log("\n  dist/manifest.json is missing. Run `npm run build` first.\n");
  process.exit(1);
}

await mkdir(SHOTS, { recursive: true });

console.log(`\n  Browser check — real browser, real extension\n`);
note(`browser ${browserName}`);
note(`binary  ${chromePath}`);
note(`ext     ${DIST}`);
console.log("");

// ── servers ────────────────────────────────────────────────────────────────

const servers = [
  spawn(process.execPath, ["server/index.mjs"], { env: { ...process.env, PORT: "8787" }, stdio: "ignore" }),
  spawn(process.execPath, ["demo-pages/serve.mjs"], { stdio: "ignore" }),
];

const waitForHttp = async (url, tries = 40) => {
  for (let i = 0; i < tries; i++) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch {
      await sleep(150);
    }
  }
  return false;
};

check("agent server is up", await waitForHttp("http://127.0.0.1:8787/health"));
check("demo pages are served", await waitForHttp("http://127.0.0.1:8788/job-form.html"));

// ── launch ─────────────────────────────────────────────────────────────────

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: HEADLESS ? "new" : false,
  args: [
    `--disable-extensions-except=${DIST}`,
    `--load-extension=${DIST}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=DisableLoadExtensionCommandLineSwitch",
    "--enable-unsafe-extension-debugging",
    "--window-size=1280,900",
  ],
});

// Console errors anywhere in the extension are failures, not noise. A panel
// that throws while rendering still "builds" — this is how we find that out.
const pageErrors = [];
const missing = [];
const watch = (target, label) => {
  target.on?.("console", (m) => {
    if (m.type() === "error") pageErrors.push(`${label}: ${m.text()}`);
  });
  target.on?.("pageerror", (e) => pageErrors.push(`${label}: ${e.message}`));
  target.on?.("response", (r) => {
    if (r.status() === 404 && !/favicon/i.test(r.url())) missing.push(r.url());
  });
};

try {
  // ── the service worker ───────────────────────────────────────────────────
  // Its existence is the extension actually running, not merely installed.
  let sw = null;
  for (let i = 0; i < 60 && !sw; i++) {
    sw = browser.targets().find((t) => t.type() === "service_worker" && t.url().includes("background"));
    if (!sw) await sleep(200);
  }
  check("the service worker registered", Boolean(sw), sw ? new URL(sw.url()).host : "never appeared");

  const extId = sw ? new URL(sw.url()).host : null;
  if (!extId) throw new Error("cannot continue without the extension id");
  note(`extension id ${extId}`);

  const swTarget = await sw.worker();
  watch(swTarget, "service-worker");

  // ── the content script on a real page ────────────────────────────────────
  const page = await browser.newPage();
  watch(page, "page");
  await page.setViewport({ width: 1280, height: 860 });
  await page.goto("http://127.0.0.1:8788/job-form.html", { waitUntil: "domcontentloaded" });
  await sleep(700);

  const ping = await swTarget.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    try {
      return await chrome.tabs.sendMessage(tab.id, { kind: "ping" });
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });
  check("the content script answers a ping", ping?.ok === true, JSON.stringify(ping));

  // ── perception on the real DOM ───────────────────────────────────────────
  const perceived = await swTarget.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const r = await chrome.tabs.sendMessage(tab.id, { kind: "perceive", mode: "balanced" });
    return {
      ok: r?.ok,
      count: r?.graph?.elements?.length ?? 0,
      names: (r?.graph?.elements ?? []).map((e) => e.name).filter(Boolean).slice(0, 40),
      hasExperience: (r?.graph?.elements ?? []).some((e) => /years of experience/i.test(e.name ?? "")),
      roles: [...new Set((r?.graph?.elements ?? []).map((e) => e.role))],
    };
  });
  check("the ScreenGraph is built from the live DOM", perceived?.ok === true && perceived.count > 5,
    `${perceived?.count} elements`);
  check("it finds the Experience field added for the ask-the-user path", perceived?.hasExperience === true);
  note(`roles seen: ${(perceived?.roles ?? []).join(", ")}`);

  // ── the agent visualiser, in the page, for real ──────────────────────────
  // This is the piece that had never been seen rendering.
  const filled = await swTarget.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.tabs.sendMessage(tab.id, { kind: "perceive", mode: "balanced" });
    const r = await chrome.tabs.sendMessage(tab.id, {
      kind: "execute",
      action: { kind: "fill", target: "el_1", value: "x" },
      resolved: "Srikar Gautam",
      showAgent: true,
    });
    return r;
  });
  check("a fill executes through the real content script", filled?.ok === true, filled?.note ?? filled?.error);
  check("the fill is read back and verified", filled?.ingest?.verified === true,
    filled?.ingest ? `${filled.ingest.actualLen}/${filled.ingest.expectedLen} chars` : "no ingest report");
  check("the visualiser reports its own animation time so it can be subtracted",
    typeof filled?.visualMs === "number" && filled.visualMs > 0, `${filled?.visualMs} ms`);

  const landed = await page.$eval("#name", (n) => n.value).catch(() => null);
  check("the value actually landed in the page", landed === "Srikar Gautam", JSON.stringify(landed));

  // The actor's shadow host must exist, and must not be able to eat a click.
  const actor = await page.evaluate(() => {
    const host = document.getElementById("__cordon_actor__");
    if (!host) return { present: false };
    const cs = getComputedStyle(host);
    const sr = host.shadowRoot;
    return {
      present: true,
      pointerEvents: cs.pointerEvents,
      zIndex: cs.zIndex,
      hasCursor: Boolean(sr?.querySelector(".cur")),
      hasRing: Boolean(sr?.querySelector(".ring")),
      caption: sr?.querySelector(".cap")?.textContent ?? "",
    };
  });
  check("the agent visualiser rendered into the page", actor.present === true);
  check("its cursor and ring exist in the shadow root", actor.hasCursor && actor.hasRing);
  check("it cannot intercept a click", actor.pointerEvents === "none", actor.pointerEvents);
  check("its caption named the field", /full name/i.test(actor.caption || ""), JSON.stringify(actor.caption));
  check("the caption does not contain the value", !/Srikar/.test(actor.caption || ""),
    "captions name the field, never the value");

  await page.screenshot({ path: path.join(SHOTS, "01-agent-in-action.png") });

  // ── the redaction overlay and the view switch ────────────────────────────
  // The overlay lives in a CLOSED shadow root, on purpose: a page must not be
  // able to read what the extension is drawing over it. So this cannot count
  // boxes from the page — it compares what the screen actually looks like in
  // each view, which is the property that matters anyway.
  const hostBox = await page.evaluate(() => {
    const h = document.getElementById("__cordon_overlay__");
    if (!h) return null;
    const cs = getComputedStyle(h);
    return { pointerEvents: cs.pointerEvents, sealed: h.shadowRoot === null };
  });
  check("the overlay host is attached to the page", hostBox !== null);
  check("its shadow root is closed to the page", hostBox?.sealed === true,
    "a page must not be able to read what we draw over it");
  check("the overlay cannot intercept a click", hostBox?.pointerEvents === "none", hostBox?.pointerEvents);

  const shotServer = await page.screenshot({ path: path.join(SHOTS, "02-server-view.png") });

  await swTarget.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.tabs.sendMessage(tab.id, { kind: "setView", view: "user" });
  });
  await sleep(400);
  const shotUser = await page.screenshot({ path: path.join(SHOTS, "03-user-view.png") });

  check("the two views actually look different", !shotServer.equals(shotUser),
    `${shotServer.length} vs ${shotUser.length} bytes`);

  await swTarget.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.tabs.sendMessage(tab.id, { kind: "perceive", mode: "balanced" });
    await chrome.tabs.sendMessage(tab.id, { kind: "setView", view: "server" });
  });
  await sleep(400);
  const shotBack = await page.screenshot();
  check("switching back repaints the overlay", !shotBack.equals(shotUser));

  // ── the demo page's own buttons ──────────────────────────────────────────
  await page.evaluate(() => {
    document.getElementById("name").value = "Srikar Gautam";
    document.getElementById("email").value = "srikar.gautam@gmail.com";
    document.getElementById("mobile").value = "9876543210";
  });
  await page.click("#save");
  await sleep(250);
  const saved = await page.evaluate(() => {
    const raw = localStorage.getItem("fernco.registration");
    return { stored: Boolean(raw), banner: document.getElementById("banner")?.textContent ?? "" };
  });
  check("Save progress genuinely persists", saved.stored === true);
  check("and says so on the page", /progress saved/i.test(saved.banner), JSON.stringify(saved.banner.slice(0, 60)));

  await page.click("#register");
  await sleep(250);
  const blocked = await page.evaluate(() => document.getElementById("banner")?.textContent ?? "");
  check("Register refuses while required fields are blank", /cannot register/i.test(blocked),
    JSON.stringify(blocked.slice(0, 70)));

  // ── the side panel, rendered as a real page ──────────────────────────────
  const panel = await browser.newPage();
  watch(panel, "sidepanel");
  await panel.goto(`chrome-extension://${extId}/sidepanel.html`, { waitUntil: "domcontentloaded" });
  await sleep(600);

  const panelState = await panel.evaluate(() => {
    const q = (id) => document.getElementById(id);
    return {
      build: q("build")?.textContent ?? "",
      hasViews: Boolean(q("views")),
      hasNet: Boolean(q("netBox")),
      hasRes: Boolean(q("resBox")),
      hasEdit: Boolean(q("cvalue")),
      hasEntered: Boolean(q("enteredBox")),
      viewButtons: [...(q("views")?.querySelectorAll("button") ?? [])].map((b) => b.textContent.trim()),
      // A stylesheet that failed to load leaves the body unstyled and readable
      // as a bug only by eye — so assert a token that only our CSS defines.
      bg: getComputedStyle(document.body).backgroundColor,
    };
  });

  check("the side panel renders without throwing", Boolean(panelState.build), panelState.build);
  check("its stylesheet applied", panelState.bg === "rgb(14, 18, 20)", panelState.bg);
  check("the view switch is present", panelState.hasViews, panelState.viewButtons.join(" / "));
  check("the network traffic panel is present", panelState.hasNet);
  check("the resources panel is present", panelState.hasRes);
  check("the editable confirmation box is present", panelState.hasEdit);
  check("the entered-values audit panel is present", panelState.hasEntered);

  await panel.screenshot({ path: path.join(SHOTS, "04-side-panel.png"), fullPage: true });

  // Drive a whole task through the panel exactly as a click would.
  await page.bringToFront();
  await panel.evaluate(() => chrome.runtime.sendMessage({ kind: "run", task: "Save progress", mode: "balanced" }));

  let state = null;
  for (let i = 0; i < 50; i++) {
    state = await panel.evaluate(() => chrome.runtime.sendMessage({ kind: "getState" }));
    if (state && !state.running && state.steps?.length) break;
    await sleep(300);
  }

  check("a task run from the panel completes", Boolean(state) && !state.running,
    `${state?.steps?.length ?? 0} step(s)`);
  const routes = (state?.steps ?? []).map((s) => s.route);
  check("it resolved on device, with no network call", routes.includes("local") && !routes.includes("server"),
    routes.join(" → "));

  const t = state?.steps?.find((s) => s.timings)?.timings;
  if (t) {
    note(`stages: capture ${t.capture} perceive ${t.perceive} detect ${t.detect} ` +
         `redact ${t.redact} verify ${t.verify} network ${t.network} execute ${t.execute}`);
    check("execute excludes the animation time", (t.visual ?? 0) === 0 || t.execute < (t.visual ?? 0),
      `execute ${t.execute} ms, animation ${t.visual ?? 0} ms`);
  }

  await panel.reload({ waitUntil: "domcontentloaded" });
  await sleep(700);
  const rendered = await panel.evaluate(() => ({
    steps: document.querySelectorAll("#log .step, #log > *").length,
    netHidden: document.getElementById("netBox")?.hidden,
    resHidden: document.getElementById("resBox")?.hidden,
  }));
  check("the step log renders entries", rendered.steps > 0, `${rendered.steps} node(s)`);
  await panel.screenshot({ path: path.join(SHOTS, "05-panel-after-run.png"), fullPage: true });

  // ── a task that must escalate, so the network path runs for real ─────────
  // Everything above stayed on the device, which is the happy case and proves
  // nothing about redaction. This one has to leave the machine, so the payload
  // it builds is the actual artefact the privacy claim is about.
  await page.bringToFront();
  await page.evaluate(() => {
    // Put something worth redacting on the page first.
    document.getElementById("email").value = "srikar.gautam@gmail.com";
    document.getElementById("mobile").value = "9876543210";
    document.getElementById("pw").value = "Hunter2!SuperSecret";
  });

  await panel.evaluate(() =>
    chrome.runtime.sendMessage({
      kind: "run",
      task: "What sensitive data is on this page?",
      mode: "balanced",
    }),
  );

  let net = null;
  for (let i = 0; i < 60; i++) {
    net = await panel.evaluate(() => chrome.runtime.sendMessage({ kind: "getState" }));
    if (net && !net.running && net.steps?.length) break;
    await sleep(300);
  }

  const served = (net?.steps ?? []).find((x) => x.route === "server");
  check("a task that needs the server actually reaches it", Boolean(served),
    (net?.steps ?? []).map((x) => x.route).join(" → "));

  if (served?.receipt) {
    const r = served.receipt;
    note(`payload ${r.payloadBytes} B, hash #${r.payloadHash}, reply ${r.replyMs ?? "?"} ms`);
    check("the verifier cleared the payload before it left", r.verifier?.passed === true);
    check("the payload is captured for inspection", typeof r.payload === "string" && r.payload.length > 0);
    check("the server's reply is captured too", typeof r.reply === "string" && r.reply.length > 0);

    // The whole thesis, tested at the boundary in a real browser.
    for (const secret of ["srikar.gautam@gmail.com", "9876543210", "Hunter2!SuperSecret"]) {
      check(`no "${secret.slice(0, 22)}" in the payload`, !(r.payload ?? "").includes(secret));
    }
    check("handles were substituted in its place", /(EMAIL|PHONE|PERSON)_\d+/.test(r.payload ?? ""),
      (r.payload ?? "").match(/(EMAIL|PHONE|PERSON)_\d+/g)?.slice(0, 4).join(", ") ?? "none found");
  } else if (served) {
    check("the server step carries a privacy receipt", false, "no receipt on the server step");
  }

  // And the panel must actually render that traffic.
  await panel.reload({ waitUntil: "domcontentloaded" });
  await sleep(800);
  const netUi = await panel.evaluate(() => {
    const box = document.getElementById("netBox");
    return {
      hidden: box?.hidden,
      summary: document.getElementById("nsum")?.textContent ?? "",
      rows: document.querySelectorAll("#nrows .nrow").length,
    };
  });
  check("the network panel lists the request", netUi.rows > 0,
    `${netUi.rows} row(s), "${netUi.summary}"`);
  await panel.screenshot({ path: path.join(SHOTS, "06-network-traffic.png"), fullPage: true });

  // ── nothing threw anywhere ───────────────────────────────────────────────
  // Extension pages log benign noise on shutdown; only count real errors.
  const real = pageErrors.filter(
    (e) =>
      !/Extension context invalidated|message port closed|Receiving end does not exist|favicon/i.test(e) &&
      // A bare "Failed to load resource" names nothing; the response listener
      // above already reports any 404 that is not the demo server's favicon.
      !/Failed to load resource/i.test(e),
  );
  check("nothing 404s except the demo favicon", missing.length === 0, missing.slice(0, 3).join(" | "));
  check("no uncaught errors in any extension context", real.length === 0,
    real.length ? real.slice(0, 3).join(" | ") : "clean");
  if (real.length > 3) note(`...and ${real.length - 3} more`);
} catch (e) {
  check("the run completed without crashing", false, e.message);
  console.log(e.stack?.split("\n").slice(0, 6).join("\n") ?? "");
} finally {
  if (!KEEP) await browser.close();
  for (const s of servers) s.kill();
}

await writeFile(
  path.join(SHOTS, "README.md"),
  `# Browser check screenshots\n\nWritten by \`npm run browser-check\`. These are the panels and the\nin-page visualiser rendering in a real Chrome with the built extension loaded.\n\n- \`01-agent-in-action.png\` — the cursor, ring and caption during a fill\n- \`02-server-view.png\` — the ScreenGraph overlay\n- \`03-user-view.png\` — the same page with the overlay off\n- \`04-side-panel.png\` — the panel at rest\n- \`05-panel-after-run.png\` — after a completed task\n`,
);

console.log(`\n  ${pass} passed, ${fail} failed`);
console.log(`  screenshots → eval/screenshots/\n`);
for (const w of warnings) console.log(`  note: ${w}`);
if (fail) process.exitCode = 1;
