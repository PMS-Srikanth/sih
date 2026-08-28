/**
 * The visual proof. Draws the ScreenGraph over the live page so the accuracy of
 * on-device perception (metric 1) and the reach of redaction (metric 3) are
 * things a judge can see rather than take on trust.
 *
 * Positions are recomputed from the live elements on every paint, and repainted
 * on scroll and resize. A ScreenGraph bbox is viewport-relative and goes stale
 * the moment the page moves — which it does, because the executor scrolls a
 * target into view before acting on it.
 */
import type { Finding, RawElement, Role } from "@/shared/types";

const HOST_ID = "__cordon_overlay__";
let host: HTMLDivElement | null = null;
let shadow: ShadowRoot | null = null;

/** Only controls an agent can act on get a text label; the rest just get a box. */
const LABELLED: ReadonlySet<Role> = new Set<Role>([
  "button", "link", "textbox", "password", "select", "checkbox", "radio",
]);

const COLOR: Partial<Record<Role, string>> = {
  button: "#4CC5D0",
  link: "#4CC5D0",
  textbox: "#7FD6A0",
  password: "#F08A7E",
  select: "#7FD6A0",
  checkbox: "#7FD6A0",
  radio: "#7FD6A0",
  image: "#9B93F5",
  heading: "#E39A57",
  text: "#5C6B6F",
};

export interface Fillable {
  id: string;
  handle: string;
}

interface Scene {
  elements: RawElement[];
  findings: Finding[];
  fillable: Fillable[];
  nodes: Map<string, Element>;
}
let scene: Scene | null = null;
let rafId = 0;

function ensure(): ShadowRoot {
  if (shadow) return shadow;
  host = document.createElement("div");
  host.id = HOST_ID;
  host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483646";
  shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `
    .b{position:fixed;border:1.5px solid;border-radius:2px;box-sizing:border-box}
    .t{position:fixed;font:600 9px/1.4 ui-monospace,Consolas,monospace;padding:1px 4px;
       border-radius:2px;white-space:nowrap;color:#0E1214}
    .redact{position:fixed;background:#0E1214;border:1.5px solid #F08A7E;border-radius:2px;
       display:flex;align-items:center;justify-content:center;overflow:hidden;
       font:700 9px/1 ui-monospace,Consolas,monospace;color:#F08A7E}
    .fill{position:fixed;border:1.5px dashed #4CC5D0;border-radius:2px;box-sizing:border-box;
       background:rgba(76,197,208,.10);display:flex;align-items:center;justify-content:center;
       overflow:hidden;font:600 9px/1 ui-monospace,Consolas,monospace;color:#0d6f78}
    .hl{position:fixed;border:3px solid #E39A57;border-radius:3px;box-sizing:border-box}
    .dim{opacity:.3}
  `;
  shadow.append(style);
  document.documentElement.append(host);

  // Repaint whenever the page moves under us. Capture phase catches scrolling
  // inside nested containers, not just the window.
  addEventListener("scroll", schedule, { passive: true, capture: true });
  addEventListener("resize", schedule, { passive: true });
  return shadow;
}

function schedule(): void {
  if (rafId || !scene) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    if (scene) paint(scene);
  });
}

export function clearOverlay(): void {
  scene = null;
  if (!shadow) return;
  for (const n of Array.from(shadow.querySelectorAll(".b,.t,.redact,.fill,.hl"))) n.remove();
}

export function drawGraph(elements: RawElement[], nodes: Map<string, Element>): void {
  scene = { elements, findings: scene?.findings ?? [], fillable: scene?.fillable ?? [], nodes };
  paint(scene);
}

export function drawRedactions(findings: Finding[], fillable: Fillable[], nodes: Map<string, Element>): void {
  scene = { elements: scene?.elements ?? [], findings, fillable, nodes };
  paint(scene);
}

// ── painting ───────────────────────────────────────────────────────────────

function paint(s: Scene): void {
  const root = ensure();
  for (const n of Array.from(root.querySelectorAll(".b,.t,.redact,.fill"))) n.remove();

  const inView = (r: DOMRect) =>
    r.bottom > -40 && r.top < innerHeight + 40 && r.right > -40 && r.left < innerWidth + 40;

  // Labels are placed after boxes so they sit on top, and are skipped when they
  // would collide with one already placed.
  const placed: Array<{ x: number; y: number; w: number }> = [];

  for (const e of s.elements) {
    if (e.role === "other") continue;
    const node = s.nodes.get(e.id);
    if (!node || !node.isConnected) continue;

    const r = node.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || !inView(r)) continue;

    const c = COLOR[e.role] ?? "#5C6B6F";
    const offscreen = r.bottom < 0 || r.top > innerHeight;

    const box = document.createElement("div");
    box.className = offscreen ? "b dim" : "b";
    box.style.cssText += `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;border-color:${c}`;
    root.append(box);

    if (!LABELLED.has(e.role)) continue;
    if (r.width < 40 || r.height < 12) continue;

    const ly = Math.max(0, r.top - 13);
    const approxW = (e.id.length + e.role.length + 2) * 5.4 + 8;
    if (placed.some((p) => Math.abs(p.y - ly) < 12 && r.left < p.x + p.w + 4 && p.x < r.left + approxW + 4)) {
      continue;
    }
    placed.push({ x: r.left, y: ly, w: approxW });

    const tag = document.createElement("div");
    tag.className = "t";
    tag.style.cssText += `left:${r.left}px;top:${ly}px;background:${c}`;
    tag.textContent = `${e.id} ${e.role}`;
    root.append(tag);
  }

  // Blank fields the local profile can serve. Not a redaction — nothing was
  // removed here — so it reads as an offer, not a mask.
  for (const f of s.fillable) {
    const node = s.nodes.get(f.id);
    if (!node || !node.isConnected) continue;
    const r = node.getBoundingClientRect();
    if (!inView(r) || r.width < 2) continue;

    const d = document.createElement("div");
    d.className = "fill";
    d.style.cssText += `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`;
    if (r.width > 90) d.textContent = `${f.handle} · from your profile`;
    root.append(d);
  }

  for (const f of s.findings) {
    if (f.fate === "keep") continue;
    const node = s.nodes.get(f.elementId);
    if (!node || !node.isConnected) continue;

    for (const r of rectsFor(node, f)) {
      if (!inView(r)) continue;
      const d = document.createElement("div");
      d.className = "redact";
      d.style.cssText += `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`;
      if (r.width > 54) d.textContent = f.fate === "drop" ? "REMOVED" : (f.handle ?? f.cls.toUpperCase());
      root.append(d);
    }
  }
}

/**
 * Tight geometry. For a text span we ask the Range for the rectangles of exactly
 * those characters — that is what keeps redaction precision high instead of
 * blanking whole paragraphs.
 */
function rectsFor(el: Element, f: Finding): DOMRect[] {
  if (f.field === "text" && f.start != null && f.end != null) {
    const rects = rangeRects(el, f.start, f.end);
    if (rects.length) return rects;
  }
  return [el.getBoundingClientRect()];
}

function rangeRects(el: Element, start: number, end: number): DOMRect[] {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let offset = 0;
  let startNode: Text | null = null;
  let startOff = 0;
  let endNode: Text | null = null;
  let endOff = 0;

  let n: Node | null;
  while ((n = walker.nextNode())) {
    const t = n as Text;
    const len = t.data.length;
    if (!startNode && offset + len > start) {
      startNode = t;
      startOff = start - offset;
    }
    if (startNode && offset + len >= end) {
      endNode = t;
      endOff = end - offset;
      break;
    }
    offset += len;
  }
  if (!startNode || !endNode) return [];

  try {
    const range = document.createRange();
    range.setStart(startNode, Math.max(0, Math.min(startOff, startNode.data.length)));
    range.setEnd(endNode, Math.max(0, Math.min(endOff, endNode.data.length)));
    return Array.from(range.getClientRects()).filter((r) => r.width > 1 && r.height > 1);
  } catch {
    return [];
  }
}

export function highlight(ids: string[], nodes: Map<string, Element>): void {
  const root = ensure();
  for (const n of Array.from(root.querySelectorAll(".hl"))) n.remove();
  for (const id of ids) {
    const el = nodes.get(id);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    const d = document.createElement("div");
    d.className = "hl";
    d.style.cssText += `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`;
    root.append(d);
  }
}

export function destroyOverlay(): void {
  removeEventListener("scroll", schedule, true);
  removeEventListener("resize", schedule);
  host?.remove();
  host = null;
  shadow = null;
  scene = null;
}
