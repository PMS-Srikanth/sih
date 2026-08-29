/**
 * The agent, made visible.
 *
 * Until now the only thing on screen during a run was the redaction overlay,
 * which shows what we hide — not what we do. To a spectator that reads as "the
 * page flickered and some boxes appeared", and the actual work (find this
 * control, move to it, type into it, confirm it landed) was invisible.
 *
 * This draws that work: a cursor travels to the target, a ring closes on it, a
 * caption names the action in plain language, and the result flashes green or
 * red. It is deliberately a little slower than the machine needs — the pauses
 * are what make the sequence legible to a human watching.
 *
 * It is presentation only. It never reads a value, never decides anything, and
 * lives in its own shadow root so no page stylesheet can reach it.
 */

const HOST_ID = "__cordon_actor__";

/** Total travel time for the cursor, ms. Long enough to follow with the eye. */
const TRAVEL_MS = 380;

let root: ShadowRoot | null = null;
let cursor: HTMLElement | null = null;
let ring: HTMLElement | null = null;
let caption: HTMLElement | null = null;
let at = { x: -60, y: -60 };
let enabled = true;

/**
 * Time spent purely on animation since the last read.
 *
 * This matters for honesty, not bookkeeping. The pauses below are a presentation
 * aid, and they sit inside the execute stage — so without subtracting them the
 * reported end-to-end latency would be about a second worse per action than the
 * agent actually is. A demo aid must not be allowed to corrupt the number the
 * problem statement grades.
 */
let visualMs = 0;

export function takeVisualMs(): number {
  const v = Math.round(visualMs);
  visualMs = 0;
  return v;
}

function ensure(): ShadowRoot {
  if (root && document.getElementById(HOST_ID)) return root;

  const host = document.createElement("div");
  host.id = HOST_ID;
  // A very high z-index and pointer-events:none — the visualiser must never
  // intercept a click that the executor is about to make.
  host.style.cssText =
    "position:fixed;inset:0;z-index:2147483646;pointer-events:none;contain:layout style size";
  (document.body ?? document.documentElement).append(host);

  root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .cur {
        position: fixed; width: 22px; height: 22px; margin: -11px 0 0 -11px;
        border-radius: 50%; opacity: 0;
        background: radial-gradient(circle at 34% 34%, #7fe3ec, #199aa8 62%, #0d6a75);
        box-shadow: 0 0 0 3px rgba(76,197,208,.24), 0 4px 14px rgba(0,0,0,.42);
        transition: left var(--t,380ms) cubic-bezier(.32,.72,.28,1),
                    top  var(--t,380ms) cubic-bezier(.32,.72,.28,1),
                    opacity .18s, transform .16s;
      }
      .cur.on { opacity: 1; }
      .cur.tap { transform: scale(.62); }

      .ring {
        position: fixed; border-radius: 8px; opacity: 0;
        border: 2px solid #4cc5d0; box-shadow: 0 0 0 4px rgba(76,197,208,.16);
        transition: all .26s cubic-bezier(.32,.72,.28,1);
      }
      .ring.on { opacity: 1; }
      .ring.ok  { border-color: #5fc08f; box-shadow: 0 0 0 5px rgba(95,192,143,.22); }
      .ring.bad { border-color: #f08a7e; box-shadow: 0 0 0 5px rgba(240,138,126,.22); }

      /* A soft pulse while a field is being typed into. */
      .ring.busy { animation: pulse 1s ease-in-out infinite; }
      @keyframes pulse {
        0%,100% { box-shadow: 0 0 0 4px rgba(76,197,208,.16); }
        50%     { box-shadow: 0 0 0 9px rgba(76,197,208,.05); }
      }

      .cap {
        position: fixed; opacity: 0; max-width: 340px;
        display: flex; align-items: center; gap: 8px;
        padding: 7px 12px; border-radius: 8px;
        background: #0e1214ee; border: 1px solid #2d383c;
        color: #e6eced; font: 500 12.5px/1.35 "Segoe UI", system-ui, sans-serif;
        box-shadow: 0 6px 22px rgba(0,0,0,.4);
        transition: all .22s cubic-bezier(.32,.72,.28,1);
      }
      .cap.on { opacity: 1; }
      .cap b { font: 700 9px/1 ui-monospace, Consolas, monospace;
        letter-spacing: .1em; text-transform: uppercase; color: #4cc5d0;
        border: 1px solid #21474c; border-radius: 3px; padding: 3px 5px; }
      .cap.ok  b { color: #5fc08f; border-color: #1d4433; }
      .cap.bad b { color: #f08a7e; border-color: #4a221d; }
      .cap i { font-style: normal; color: #b3c0c3; }
    </style>
    <div class="cur"></div>
    <div class="ring"></div>
    <div class="cap"></div>`;

  cursor = root.querySelector(".cur");
  ring = root.querySelector(".ring");
  caption = root.querySelector(".cap");
  return root;
}

export function setActorEnabled(on: boolean): void {
  enabled = on;
  if (!on) hideActor();
}

const wait = (ms: number) => {
  visualMs += ms;
  return new Promise<void>((r) => setTimeout(r, ms));
};

/**
 * Move the cursor to an element and ring it. Resolves once the travel is done,
 * so the caller can act with the cursor already in place rather than typing
 * into a field the cursor has not reached yet.
 */
export async function actorMoveTo(el: Element, verb: string, detail: string): Promise<void> {
  if (!enabled) return;
  ensure();
  if (!cursor || !ring || !caption) return;

  const r = el.getBoundingClientRect();
  const tx = r.left + r.width / 2;
  const ty = r.top + r.height / 2;

  // Scale travel time with distance: a nudge to the next field should not take
  // as long as a jump across the page.
  const dist = Math.hypot(tx - at.x, ty - at.y);
  const ms = Math.max(150, Math.min(TRAVEL_MS, 120 + dist * 0.5));
  cursor.style.setProperty("--t", `${ms}ms`);

  cursor.style.left = `${tx}px`;
  cursor.style.top = `${ty}px`;
  cursor.classList.add("on");
  at = { x: tx, y: ty };

  ring.className = "ring on";
  ring.style.left = `${r.left - 3}px`;
  ring.style.top = `${r.top - 3}px`;
  ring.style.width = `${r.width + 6}px`;
  ring.style.height = `${r.height + 6}px`;

  say(verb, detail, "");
  placeCaption(r);

  await wait(ms);
}

/** The moment of contact — a click tap or the start of typing. */
export async function actorAct(kind: "tap" | "type"): Promise<void> {
  if (!enabled || !cursor || !ring) return;
  if (kind === "tap") {
    cursor.classList.add("tap");
    await wait(130);
    cursor.classList.remove("tap");
  } else {
    ring.classList.add("busy");
    await wait(200);
  }
}

/** Flash the outcome, then leave it on screen briefly so it can be read. */
export async function actorResult(ok: boolean, verb: string, detail: string): Promise<void> {
  if (!enabled || !ring || !caption) return;
  ring.classList.remove("busy");
  ring.classList.add(ok ? "ok" : "bad");
  say(verb, detail, ok ? "ok" : "bad");
  await wait(ok ? 420 : 700);
}

export function hideActor(): void {
  cursor?.classList.remove("on");
  ring?.classList.remove("on");
  caption?.classList.remove("on");
}

export function destroyActor(): void {
  document.getElementById(HOST_ID)?.remove();
  root = cursor = ring = caption = null;
}

function say(verb: string, detail: string, tone: string): void {
  if (!caption) return;
  caption.className = `cap on ${tone}`.trim();
  caption.textContent = "";
  const tag = document.createElement("b");
  tag.textContent = verb;
  const txt = document.createElement("i");
  txt.textContent = detail;
  caption.append(tag, txt);
}

/**
 * Keep the caption beside the target and inside the viewport.
 *
 * Placed to the SIDE by preference, not above. A form field almost always has
 * its own label directly above it, and the first version covered exactly that
 * label — hiding the one piece of context that makes the caption meaningful.
 * Above and below are fallbacks for when neither side has room.
 */
function placeCaption(r: DOMRect): void {
  if (!caption) return;
  const cw = Math.min(340, caption.offsetWidth || 240);
  const ch = caption.offsetHeight || 34;
  const gap = 12;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let x: number;
  let y = r.top + r.height / 2 - ch / 2;

  if (r.right + gap + cw <= vw - 8) {
    x = r.right + gap;                   // to the right
  } else if (r.left - gap - cw >= 8) {
    x = r.left - gap - cw;               // to the left
  } else if (r.top - gap - ch >= 8) {
    x = Math.min(r.left, vw - cw - 8);   // above, and accept covering the label
    y = r.top - gap - ch;
  } else {
    x = Math.min(r.left, vw - cw - 8);   // below
    y = r.bottom + gap;
  }

  caption.style.left = `${Math.max(8, Math.min(x, vw - cw - 8))}px`;
  caption.style.top = `${Math.max(8, Math.min(y, vh - ch - 8))}px`;
}
