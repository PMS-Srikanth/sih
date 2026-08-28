/**
 * Builds the ScreenGraph from the DOM + accessibility tree.
 *
 * This is the structural half of "accuracy of visual context" (metric 1). It is
 * deliberately not a serialisation of the HTML — it is a flat, grounded list of
 * things a user can perceive or act on, ~40x smaller than the markup and far
 * more stable across re-renders.
 */
import type { BBox, Group, GroupKind, RawElement, RawScreenGraph, Role } from "@/shared/types";
import { fnv1a } from "@/privacy/checksums";

const INTERACTIVE = "a,button,input,select,textarea,summary,[role],[onclick],[tabindex],[contenteditable]";
/**
 * Elements whose pixels the DOM cannot describe. The layout engine knows where
 * they are and nothing about what is inside them — which is exactly why they
 * have to be in the graph: they are the anchors the vision model works from.
 */
const MEDIA = "img,svg,canvas,video,iframe,picture,object,embed";
const TEXTY = "h1,h2,h3,h4,h5,h6,p,li,td,th,label,legend,figcaption,dt,dd,span,div";

const MAX_ELEMENTS = 400;
const MAX_TEXT = 400;

export interface PerceiveResult {
  graph: RawScreenGraph;
  /** id → live Element. Stays in the content script; never serialised. */
  nodes: Map<string, Element>;
}

export function buildScreenGraph(): PerceiveResult {
  const t0 = performance.now();
  const seen = new Map<Element, string>();
  const nodes = new Map<string, Element>();
  const elements: RawElement[] = [];
  let n = 0;

  const push = (el: Element, forceText = false): string | undefined => {
    if (seen.has(el)) return seen.get(el);
    if (elements.length >= MAX_ELEMENTS) return undefined;
    const rec = describe(el, `el_${++n}`, forceText);
    if (!rec) return undefined;
    seen.set(el, rec.id);
    nodes.set(rec.id, el);
    elements.push(rec);
    return rec.id;
  };

  for (const el of Array.from(document.querySelectorAll(INTERACTIVE))) {
    push(el);
  }

  // Media before text: an <img> is far more consequential to the privacy engine
  // than a <span>, and the element budget should not be spent before we reach it.
  for (const el of Array.from(document.querySelectorAll(MEDIA))) {
    push(el);
  }

  let textCount = 0;
  for (const el of Array.from(document.querySelectorAll(TEXTY))) {
    if (textCount >= MAX_TEXT) break;
    if (seen.has(el)) continue;
    if (!hasOwnText(el)) continue;
    // Conditionally add non-interactive text nodes ONLY if they might contain PII
    if (!/\d{4,}|@/i.test(ownText(el))) continue;
    if (push(el, true)) textCount++;
  }

  // Parent links, restricted to elements that made it into the graph.
  for (const rec of elements) {
    const el = nodes.get(rec.id);
    if (!el) continue;
    let p = el.parentElement;
    while (p) {
      const pid = seen.get(p);
      if (pid && pid !== rec.id) {
        rec.parent = pid;
        break;
      }
      p = p.parentElement;
    }
  }

  const groups = buildGroups(seen, elements);
  const readingOrder = elements
    .slice()
    .sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x)
    .map((e) => e.id);

  const active = document.activeElement;
  const focus = active && active !== document.body ? seen.get(active) : undefined;

  const graph: RawScreenGraph = {
    url: location.href,
    urlClass: location.host + location.pathname.replace(/\/[0-9a-f-]{6,}/gi, "/:id"),
    title: document.title,
    viewport: {
      w: window.innerWidth,
      h: window.innerHeight,
      scrollY: Math.round(window.scrollY),
      docH: document.documentElement.scrollHeight,
    },
    elements,
    groups,
    readingOrder,
    focus,
    capturedAt: Date.now(),
    perceiveMs: Math.round((performance.now() - t0) * 100) / 100,
  };

  return { graph, nodes };
}

// ── one element ────────────────────────────────────────────────────────────

function describe(el: Element, id: string, textMode: boolean): RawElement | null {
  const style = getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return null;
  if (parseFloat(style.opacity || "1") < 0.05) return null;

  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return null;
  if (r.width > 4000 || r.height > 4000) return null;

  const bbox: BBox = {
    x: Math.round(r.left),
    y: Math.round(r.top),
    w: Math.round(r.width),
    h: Math.round(r.height),
  };

  const role = roleOf(el);
  if (textMode && role === "other") return null;

  const name = accessibleName(el);
  const text = textMode || role === "text" ? ownText(el) : undefined;
  if (textMode && (!text || text.length < 2)) return null;

  const input = el as HTMLInputElement;
  const isField = /^(input|textarea|select)$/i.test(el.tagName);
  const value = isField ? (input.value ?? undefined) : undefined;

  const rec: RawElement = {
    id,
    role,
    tag: el.tagName.toLowerCase(),
    type: isField ? (input.type || undefined) : undefined,
    name,
    value: value || undefined,
    text: text || undefined,
    bbox,
    ...visibility(el, r),
    enabled: !(el as HTMLButtonElement).disabled,
    autocomplete: el.getAttribute("autocomplete") || undefined,
    placeholder: el.getAttribute("placeholder") || undefined,
    label: labelText(el) || undefined,
    sig: "",
    conf: 0.98,
    src: "dom",
  };
  rec.sig = signature(rec);
  return rec;
}

/** Grounding key. Re-derived before every action; a mismatch forces re-perception. */
export function signature(e: Pick<RawElement, "role" | "name" | "tag" | "bbox">): string {
  const q = (v: number) => Math.round(v / 8) * 8;
  return fnv1a(`${e.tag}|${e.role}|${e.name}|${q(e.bbox.x)},${q(e.bbox.y)},${q(e.bbox.w)},${q(e.bbox.h)}`);
}

// ── roles ──────────────────────────────────────────────────────────────────

function roleOf(el: Element): Role {
  const explicit = (el.getAttribute("role") || "").toLowerCase();
  const map: Record<string, Role> = {
    button: "button", link: "link", textbox: "textbox", searchbox: "textbox",
    checkbox: "checkbox", radio: "radio", combobox: "select", listbox: "select",
    heading: "heading", img: "image", list: "list", table: "table", form: "form",
  };
  if (map[explicit]) return map[explicit];

  const tag = el.tagName.toLowerCase();
  switch (tag) {
    case "a": return (el as HTMLAnchorElement).href ? "link" : "text";
    case "button": return "button";
    case "select": return "select";
    case "textarea": return "textbox";
    case "img": case "svg": case "canvas": case "video":
    case "iframe": case "picture": case "object": case "embed":
      return "image";
    case "form": return "form";
    case "table": return "table";
    case "ul": case "ol": return "list";
    case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": return "heading";
    case "input": {
      const t = ((el as HTMLInputElement).type || "text").toLowerCase();
      if (t === "password") return "password";
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (["button", "submit", "reset", "image"].includes(t)) return "button";
      return "textbox";
    }
    case "p": case "li": case "td": case "th": case "label": case "legend":
    case "span": case "div": case "dt": case "dd": case "figcaption":
      return "text";
  }
  if (el.hasAttribute("contenteditable")) return "textbox";
  if (el.hasAttribute("onclick") || el.getAttribute("tabindex") === "0") return "button";
  return "other";
}

// ── accessible name (pragmatic subset of accname) ──────────────────────────

function accessibleName(el: Element): string {
  const aria = el.getAttribute("aria-label");
  if (aria?.trim()) return clean(aria);

  const by = el.getAttribute("aria-labelledby");
  if (by) {
    const txt = by
      .split(/\s+/)
      .map((r) => document.getElementById(r)?.textContent || "")
      .join(" ")
      .trim();
    if (txt) return clean(txt);
  }

  const lbl = labelText(el);
  if (lbl) return clean(lbl);

  const tag = el.tagName.toLowerCase();
  if (tag === "img") {
    const alt = el.getAttribute("alt");
    if (alt !== null) return clean(alt);
  }
  if (tag === "input") {
    const input = el as HTMLInputElement;
    if (["button", "submit", "reset"].includes(input.type)) return clean(input.value || input.type);
    const ph = el.getAttribute("placeholder");
    if (ph?.trim()) return clean(ph);
  }
  if (["button", "a", "summary", "h1", "h2", "h3", "h4", "h5", "h6", "label", "th"].includes(tag)) {
    const t = (el.textContent || "").trim();
    if (t) return clean(t);
  }
  const title = el.getAttribute("title");
  if (title?.trim()) return clean(title);
  const ph = el.getAttribute("placeholder");
  if (ph?.trim()) return clean(ph);
  return "";
}

function labelText(el: Element): string {
  const id = el.getAttribute("id");
  if (id) {
    const esc = (window as any).CSS?.escape ? CSS.escape(id) : id.replace(/["\\]/g, "\\$&");
    const l = document.querySelector(`label[for="${esc}"]`);
    if (l?.textContent?.trim()) return l.textContent.trim();
  }
  const wrap = el.closest("label");
  if (wrap?.textContent?.trim()) return wrap.textContent.trim();

  // Common unlabelled pattern: a preceding sibling that reads like a label.
  const prev = el.previousElementSibling;
  if (prev && /^(label|span|div|dt|p|strong|b)$/i.test(prev.tagName)) {
    const t = (prev.textContent || "").trim();
    if (t && t.length <= 48) return t;
  }
  return "";
}

function clean(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, 120);
}

// ── text ───────────────────────────────────────────────────────────────────

function hasOwnText(el: Element): boolean {
  for (const n of Array.from(el.childNodes)) {
    if (n.nodeType === Node.TEXT_NODE && (n.textContent || "").trim().length > 1) return true;
  }
  return false;
}

/** Text belonging to this element, not to its element children. */
function ownText(el: Element): string {
  let out = "";
  for (const n of Array.from(el.childNodes)) {
    if (n.nodeType === Node.TEXT_NODE) out += n.textContent || "";
  }
  out = out.replace(/\s+/g, " ").trim();
  if (!out) out = (el.textContent || "").replace(/\s+/g, " ").trim();
  return out.slice(0, 500);
}

// ── visibility ─────────────────────────────────────────────────────────────

/**
 * Present in the DOM is not the same as visible on screen. Marking occluded and
 * offscreen elements is what stops the agent clicking something a user cannot
 * see — one of the most common browser-agent failure modes.
 */
function visibility(el: Element, r: DOMRect): { visible: boolean; offscreen: boolean } {
  const outside =
    r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth;
  if (outside) return { visible: false, offscreen: true };

  const cx = Math.min(Math.max(r.left + r.width / 2, 1), window.innerWidth - 1);
  const cy = Math.min(Math.max(r.top + r.height / 2, 1), window.innerHeight - 1);
  const hit = document.elementFromPoint(cx, cy);
  const clear = !!hit && (hit === el || el.contains(hit) || hit.contains(el));
  return { visible: clear, offscreen: false };
}

// ── groups ─────────────────────────────────────────────────────────────────

function buildGroups(seen: Map<Element, string>, elements: RawElement[]): Group[] {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const groups: Group[] = [];
  let g = 0;

  const containers: Array<[string, GroupKind]> = [
    ["form", "form"],
    ["nav,[role=navigation]", "nav"],
    ["dialog[open],[role=dialog],[role=alertdialog],[aria-modal=true]", "modal"],
    ["table", "table"],
  ];

  for (const [sel, kind] of containers) {
    for (const c of Array.from(document.querySelectorAll(sel))) {
      const children: string[] = [];
      for (const [el, id] of seen) if (c.contains(el) && el !== c) children.push(id);
      if (children.length < 2) continue;
      const boxes = children.map((id) => byId.get(id)!.bbox);
      groups.push({
        id: `g_${++g}`,
        kind,
        name: accessibleName(c) || undefined,
        children,
        bbox: union(boxes),
      });
    }
  }
  return groups;
}

function union(boxes: BBox[]): BBox {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const r = Math.max(...boxes.map((b) => b.x + b.w));
  const bm = Math.max(...boxes.map((b) => b.y + b.h));
  return { x, y, w: r - x, h: bm - y };
}
