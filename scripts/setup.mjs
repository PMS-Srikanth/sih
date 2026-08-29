/**
 * One command that gets a fresh clone to a working state.
 *
 *   npm run setup
 *
 * The README asked people to run four things in the right order and then load
 * the right folder. Enough of them got it wrong that "I followed the README and
 * it does not work" became the common case — so this does the ordered part
 * itself, checks its own work, and prints only the steps a script genuinely
 * cannot do: loading the extension and creating a vault.
 *
 * Safe to run repeatedly.
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const G = "\x1b[32m", R = "\x1b[31m", D = "\x1b[2m", B = "\x1b[1m", X = "\x1b[0m";
const DIST = path.resolve("dist");

const step = (n, t) => console.log(`\n${B}${n}. ${t}${X}`);
const ok = (m) => console.log(`   ${G}ok${X}  ${m}`);
const die = (m, fix) => {
  console.log(`   ${R}failed${X}  ${m}`);
  if (fix) console.log(`   ${B}try:${X} ${fix}`);
  process.exit(1);
};

const run = (cmd, label) => {
  try {
    execSync(cmd, { stdio: "pipe" });
    ok(label);
  } catch (e) {
    const out = (e.stdout?.toString() ?? "") + (e.stderr?.toString() ?? "");
    console.log(out.split("\n").slice(-12).join("\n"));
    die(label, cmd);
  }
};

console.log(`\n${B}  Cordon setup${X}  ${D}${process.cwd()}${X}`);

const major = Number(process.versions.node.split(".")[0]);
if (major < 20) die(`Node v${process.versions.node} is too old`, "install Node 20+ from nodejs.org");

step(1, "Installing dependencies");
run("npm install --no-audit --no-fund", "node_modules ready");

step(2, "Building the extension");
run("npm run build", `dist/ built at ${DIST}`);

for (const f of ["manifest.json", "background.js", "content.js", "sidepanel.html", "sidepanel.js"]) {
  if (!existsSync(path.join(DIST, f))) die(`dist/${f} is missing after the build`, "npm run build");
}
if (!existsSync(path.join(DIST, "models", "ultraface-320.onnx"))) {
  die("the face detector did not reach dist/models", "npm run build");
}
ok("every file Chrome needs is present");

step(3, "Checking the code for mangled regexes");
run("npm run check-escapes", "no broken escapes");

step(4, "Running the evaluation and building its report");
run("npm run eval", "all privacy and router checks pass");
run("npm run report", "demo-pages/report.html written");

console.log(`\n${B}  Done. Three things a script cannot do for you:${X}\n`);
console.log(`  ${B}1 · Start the two servers${X}, each in its own terminal, and leave them running:`);
console.log(`      ${D}npm run server${X}     ${D}→ http://127.0.0.1:8787${X}`);
console.log(`      ${D}npm run demo${X}       ${D}→ http://127.0.0.1:8788${X}\n`);
console.log(`  ${B}2 · Load the extension${X} — chrome://extensions → Developer mode →`);
console.log(`      Load unpacked → select this exact folder:`);
console.log(`      ${B}${DIST}${X}`);
console.log(`      ${D}Not the repo root, not extension/. After every build, click Reload on${X}`);
console.log(`      ${D}the card and check the build stamp in the panel header matches.${X}\n`);
console.log(`  ${B}3 · Create your vault${X} — open the side panel, expand ${B}My data${X}, choose a`);
console.log(`      passphrase and fill in a few fields.`);
console.log(`      ${D}It is encrypted on your own machine and is deliberately not in git, so${X}`);
console.log(`      ${D}every teammate does this once. Until you do, "fill this form from my${X}`);
console.log(`      ${D}profile" has nothing to fill from and the agent will say so.${X}\n`);
console.log(`  ${D}Then open http://127.0.0.1:8788/ and pick a demo page.${X}`);
console.log(`  ${D}Something not working? Run ${X}npm run doctor${D} — it names the cause.${X}\n`);
