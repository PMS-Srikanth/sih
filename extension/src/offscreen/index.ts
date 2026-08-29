/**
 * Offscreen document — the only context in an MV3 extension that has both a DOM
 * and WebGPU. The service worker owns orchestration and the vault; this owns the
 * model and nothing else.
 *
 * It receives frames, returns boxes. It never sees the vault, never touches the
 * network, and its results are coordinates — no pixels travel back.
 */
import { detect, load, ready } from "@/vision/detector";
import { pipeline, env, ImageClassificationPipeline } from "@xenova/transformers";

const MODEL_URL = chrome.runtime.getURL("models/ultraface-320.onnx");
const WASM_BASE = chrome.runtime.getURL("ort/");

/**
 * Both models are bundled in the extension. Transformers.js will happily fetch
 * weights from the Hugging Face hub, which would make this document phone home
 * on first use — breaking the guarantee in the header above, failing on a
 * venue's wifi, and being blocked by our own CSP anyway. So remote models are
 * switched OFF explicitly and the local path is pinned.
 */
env.allowLocalModels = true;
env.allowRemoteModels = false;
env.localModelPath = chrome.runtime.getURL("models/");
env.backends.onnx.wasm.wasmPaths = WASM_BASE;

const VIT_MODEL = "vit-base-patch16-224";

export interface VisionRequest {
  target: "offscreen";
  kind: "warmup" | "detect";
  /** Raw RGBA for `detect`, with its dimensions. */
  width?: number;
  height?: number;
  buffer?: ArrayBuffer;
  /** Sub-regions, in frame pixels, to run at higher effective resolution. */
  crops?: Array<{ x: number; y: number; w: number; h: number }>;
  /**
   * Run the ViT classifier as well as the detector. It is ~88 MB against
   * UltraFace's 1.2 MB, so it is reserved for Thorough mode — that is the
   * latency-versus-accuracy dial the problem statement asks us to expose.
   */
  useVit?: boolean;
}

export interface VisionReply {
  ok: boolean;
  error?: string;
  provider?: string;
  loadMs?: number;
  inferMs?: number;
  passes?: number;
  /** Boxes in FRAME pixel coordinates with their assigned visual class. */
  regions?: Array<{ x: number; y: number; w: number; h: number; score: number; cls: string; model: string }>;
  /** Peak offscreen memory usage in MB if available. */
  memoryMB?: number;
  /**
   * Which models are loaded right now, and their state. Surfaced because "is
   * the ViT actually running?" was previously unanswerable from the UI — it is
   * gated to Thorough mode and degrades silently when the weights are absent,
   * which together look identical to it not existing.
   */
  models?: Array<{ name: string; state: "loaded" | "unavailable" | "not requested"; note?: string }>;
}

let vit: ImageClassificationPipeline | null = null;
let vitLoadMs = 0;
let vitError = "";

const VIT_MAP: Record<string, string> = {
  "envelope": "document",
  "web site, website, internet site, site": "screenshot",
  "comic book": "document",
  "menu": "document",
  "crossword puzzle, crossword": "document",
  "book jacket, dust cover, dust jacket, dust wrapper": "document",
  "monitor": "screenshot",
  "screen, CRT screen": "screenshot",
  "monitor, display": "screenshot",
  "television, television system": "screenshot",
  "ballpoint, ballpoint pen, ballpen, Biro": "signature",
};

chrome.runtime.onMessage.addListener((msg: VisionRequest, _sender, respond) => {
  if (msg?.target !== "offscreen") return false;

  (async () => {
    try {
      // The detector is small and always loaded. The ViT is loaded lazily, and
      // only when a step actually asks for it, so Fast and Balanced never pay
      // its 88 MB.
      const info = await load(MODEL_URL, WASM_BASE);

      if (msg.useVit && !vit) {
        const tVit = performance.now();
        try {
          vit = await pipeline("image-classification", VIT_MODEL);
          vitLoadMs = Math.round(performance.now() - tVit);
        } catch (e) {
          // A missing or corrupt bundle must not take the detector down with it.
          vitError = e instanceof Error ? e.message : String(e);
          console.warn("[cordon] ViT unavailable, continuing with the detector only:", e);
          vit = null;
        }
      }

      if (msg.kind === "warmup") {
        respond({ ok: true, provider: info.provider, loadMs: info.loadMs + vitLoadMs } satisfies VisionReply);
        return;
      }

      if (!ready() || !msg.buffer || !msg.width || !msg.height) {
        respond({ ok: false, error: "no frame supplied" } satisfies VisionReply);
        return;
      }

      const full = new ImageData(new Uint8ClampedArray(msg.buffer), msg.width, msg.height);
      const regions: NonNullable<VisionReply["regions"]> = [];
      let inferMs = 0;
      let passes = 0;

      // Helper to process ViT for a crop
      const classifyCrop = async (cropData: ImageData, bx: number, by: number, bw: number, bh: number) => {
        if (!vit) return;
        const t0 = performance.now();
        // Convert ImageData to canvas to get dataURL for ViT
        const cvs = new OffscreenCanvas(cropData.width, cropData.height);
        const ctx = cvs.getContext("2d")!;
        ctx.putImageData(cropData, 0, 0);
        const blob = await cvs.convertToBlob({ type: "image/jpeg" });
        const url = URL.createObjectURL(blob);
        
        const out = await vit(url, { topk: 3 });
        URL.revokeObjectURL(url);
        inferMs += performance.now() - t0;

        // Transformers.js types this as a union of one result or many; normalise
        // to an array before reading, rather than casting the whole thing away.
        const preds: Array<{ label: string; score: number }> =
          Array.isArray(out) ? (out as Array<{ label: string; score: number }>)
                             : [out as unknown as { label: string; score: number }];

        let bestCls = "";
        let bestScore = 0;
        for (const res of preds) {
          const mapped = VIT_MAP[res.label];
          if (mapped && res.score > bestScore) {
            bestCls = mapped;
            bestScore = res.score;
          }
        }
        if (bestCls && bestScore > 0.1) {
          regions.push({ x: bx, y: by, w: bw, h: bh, score: bestScore, cls: bestCls, model: "vit" });
        }
      };

      // Pass 1 — the whole frame for UltraFace. Catches anything reasonably large.
      const whole = await detect(full);
      inferMs += whole.inferMs;
      passes++;
      for (const b of whole.boxes) {
        regions.push({
          x: b.x * msg.width,
          y: b.y * msg.height,
          w: b.w * msg.width,
          h: b.h * msg.height,
          score: b.score,
          cls: "face",
          model: "ultraface",
        });
      }

      // Pass 2 — only the regions the coverage map could not explain.
      // Run both UltraFace and ViT on these crops.
      for (const c of (msg.crops ?? []).slice(0, 6)) {
        const cw = Math.min(Math.round(c.w), msg.width - Math.round(c.x));
        const ch = Math.min(Math.round(c.h), msg.height - Math.round(c.y));
        if (cw < 24 || ch < 24) continue;

        const crop = cropOf(full, Math.round(c.x), Math.round(c.y), cw, ch);
        const r = await detect(crop);
        inferMs += r.inferMs;
        passes++;
        for (const b of r.boxes) {
          regions.push({
            x: c.x + b.x * cw,
            y: c.y + b.y * ch,
            w: b.w * cw,
            h: b.h * ch,
            score: b.score,
            cls: "face",
            model: "ultraface",
          });
        }
        
        await classifyCrop(crop, c.x, c.y, cw, ch);
      }

      const mem = (performance as any).memory;
      const models: NonNullable<VisionReply["models"]> = [
        { name: "UltraFace RFB-320", state: "loaded", note: "1.2 MB face detector, every mode" },
        vit
          ? { name: "ViT base patch16-224", state: "loaded", note: "84 MB classifier, Thorough mode" }
          : msg.useVit
            ? { name: "ViT base patch16-224", state: "unavailable", note: vitError || "weights not bundled — run npm run fetch-models" }
            : { name: "ViT base patch16-224", state: "not requested", note: "Thorough mode only" },
      ];

      respond({
        ok: true,
        provider: info.provider,
        regions: dedupeRegions(regions),
        inferMs: Math.round(inferMs * 100) / 100,
        passes,
        models,
        memoryMB: mem ? Math.round(mem.usedJSHeapSize / 1048576) : undefined,
      } satisfies VisionReply);
    } catch (e) {
      respond({ ok: false, error: e instanceof Error ? e.message : String(e) } satisfies VisionReply);
    }
  })();

  return true; // async response
});

function cropOf(src: ImageData, x: number, y: number, w: number, h: number): ImageData {
  const out = new ImageData(w, h);
  for (let row = 0; row < h; row++) {
    const s = ((y + row) * src.width + x) * 4;
    out.data.set(src.data.subarray(s, s + w * 4), row * w * 4);
  }
  return out;
}

/** The two passes overlap; keep the higher-scoring box for the same face/class. */
function dedupeRegions(boxes: NonNullable<VisionReply["regions"]>): NonNullable<VisionReply["regions"]> {
  const sorted = boxes.slice().sort((a, b) => b.score - a.score);
  const kept: typeof sorted = [];
  for (const b of sorted) {
    const dup = kept.some((k) => {
      if (k.cls !== b.cls) return false;
      const x1 = Math.max(k.x, b.x);
      const y1 = Math.max(k.y, b.y);
      const x2 = Math.min(k.x + k.w, b.x + b.w);
      const y2 = Math.min(k.y + k.h, b.y + b.h);
      const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
      return inter > 0.35 * Math.min(k.w * k.h, b.w * b.h);
    });
    if (!dup) kept.push(b);
  }
  return kept;
}
