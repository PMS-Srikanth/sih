/**
 * Finds regexes whose backslashes were eaten in transit.
 *
 *   npm run check-escapes
 *
 * Twice now an edit made through a shell has silently destroyed a regex:
 * `\b` became a literal backspace byte, and `\s` `\d` `\D` `\.` lost their
 * backslashes entirely. Both read as plausible code in a diff and both were
 * only found by a user hitting the symptom — a valid email rejected because
 * `[^@\s]` had become `[^@s]`, which excludes the letter s.
 *
 * These are cheap to detect and expensive to miss, so they get their own check.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOTS = ["extension/src", "server", "eval", "scripts", "demo-pages", "build.mjs"];
const EXT = /\.(ts|mjs|js|html|css)$/;

/** Patterns that are almost certainly a mangled escape, with what was meant. */
const SUSPECT = [
  [/\[\^@s\]/g, "[^@s] — should be [^@\\s]; this excludes the letter s"],
  [/\/\^d\{/g, "/^d{ — should be /^\\d{; this matches literal 'd' characters"],
  [/\.replace\(\/D\/g/g, "/D/g — should be /\\D/g"],
  [/\.replace\(\/s\+\/g/g, "/s+/g — should be /\\s+/g"],
  [/\.split\(\/s\+\//g, "/s+/ — should be /\\s+/"],
  [/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "a raw control byte, almost certainly a mangled \\b or \\t"],
];

let hits = 0;
const walk = (dir) => {
  let st;
  try {
    st = statSync(dir);
  } catch {
    return;
  }
  if (st.isFile()) return check(dir);
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (EXT.test(e.name)) check(p);
  }
};

function check(file) {
  // This file necessarily contains the patterns it looks for.
  if (path.basename(file) === "check-escapes.mjs") return;
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  for (const [re, why] of SUSPECT) {
    re.lastIndex = 0;
    lines.forEach((line, i) => {
      const m = line.match(re);
      if (!m) return;
      hits++;
      const shown = line.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "␈").trim();
      console.log(`  ${file}:${i + 1}`);
      console.log(`    ${shown.slice(0, 110)}`);
      console.log(`    → ${why}\n`);
    });
  }
}

console.log("\n  Checking for regexes with eaten backslashes\n");
for (const r of ROOTS) walk(r);

if (hits) {
  console.log(`  ${hits} suspicious pattern(s). Each is almost certainly a broken regex.\n`);
  process.exitCode = 1;
} else {
  console.log("  Clean — no mangled escapes found.\n");
}
