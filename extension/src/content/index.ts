/**
 * Content script — the page-facing half.
 *
 * Perception and execution need the DOM, so they live here. Detection, the
 * vault, redaction, verification and transport all live in the service worker,
 * which the page has no access to at all.
 */
import type { ContentRequest, Finding, RawElement } from "@/shared/types";
import { buildScreenGraph } from "@/perception/dom-graph";
import { execute, registerGraph } from "./executor";
import { clearOverlay, drawGraph, drawRedactions, highlight, type Fillable } from "./overlay";

let nodes = new Map<string, Element>();
let lastElements: RawElement[] = [];

type OverlayRequest = { kind: "showRedactions"; findings: Finding[]; fillable: Fillable[] };

chrome.runtime.onMessage.addListener((msg: ContentRequest | OverlayRequest, _s, send) => {
  (async () => {
    try {
      switch (msg.kind) {
        case "ping":
          send({ ok: true });
          return;

        case "perceive": {
          const { graph, nodes: n } = buildScreenGraph();
          nodes = n;
          lastElements = graph.elements;
          registerGraph(graph.elements, n);
          drawGraph(graph.elements, n);
          send({ ok: true, graph });
          return;
        }

        case "execute": {
          // The overlay is pointer-events:none, so it never intercepts the click.
          // Leaving it up means a human can actually watch what the agent is
          // doing instead of seeing it flash past.
          const out = await execute(msg.action, msg.resolved, msg.expectSig);
          send(out.ok
            ? { ok: true, executed: true, note: out.note, postSig: out.postSig, ingest: out.ingest }
            : { ok: false, error: out.note ?? "failed", ingest: out.ingest });
          return;
        }

        case "showRedactions": {
          drawGraph(lastElements, nodes);
          drawRedactions(msg.findings, msg.fillable ?? [], nodes);
          send({ ok: true });
          return;
        }

        case "highlight":
          highlight(msg.ids, nodes);
          send({ ok: true });
          return;

        case "clearHighlight":
          clearOverlay();
          send({ ok: true });
          return;

        default:
          send({ ok: false, error: "unknown request" });
      }
    } catch (e) {
      send({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  })();
  return true; // async response
});
