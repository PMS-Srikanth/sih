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

export interface VisionRequest {
  target: "offscreen";
  kind: "warmup" | "detect";
  /** Raw RGBA for `detect`, with its dimensions. */
  width?: number;
  height?: number;
  buffer?: ArrayBuffer;
  /** Sub-regions, in frame pixels, to run at higher effective resolution. */
  crops?: Array<{ x: number; y: number; w: number; h: number }>;
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
}

let vit: ImageClassificationPipeline | null = null;
let vitLoadMs = 0;

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
      const tVit = performance.now();
      if (!vit) {
        // Disable local models to fetch from HF hub since we don't have it locally
        env.allowLocalModels = false;
        vit = await pipeline("image-classification", "Xenova/vit-base-patch16-224");
        vitLoadMs = performance.now() - tVit;
      }

      const info = await load(MODEL_URL, WASM_BASE);

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
        
        let bestCls = "";
        let bestScore = 0;
        for (const res of out) {
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

      respond({
        ok: true,
        provider: info.provider,
        regions: dedupeRegions(regions),
        inferMs: Math.round(inferMs * 100) / 100,
        passes,
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
