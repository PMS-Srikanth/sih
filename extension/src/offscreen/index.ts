/**
 * Offscreen document — the only context in an MV3 extension that has both a DOM
 * and WebGPU. The service worker owns orchestration and the vault; this owns the
 * model and nothing else.
 *
 * It receives frames, returns boxes. It never sees the vault, never touches the
 * network, and its results are coordinates — no pixels travel back.
 */
import { detect, load, ready } from "@/vision/detector";

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
  /** Boxes in FRAME pixel coordinates. */
  faces?: Array<{ x: number; y: number; w: number; h: number; score: number }>;
}

chrome.runtime.onMessage.addListener((msg: VisionRequest, _sender, respond) => {
  if (msg?.target !== "offscreen") return false;

  (async () => {
    try {
      const info = await load(MODEL_URL, WASM_BASE);

      if (msg.kind === "warmup") {
        respond({ ok: true, provider: info.provider, loadMs: info.loadMs } satisfies VisionReply);
        return;
      }

      if (!ready() || !msg.buffer || !msg.width || !msg.height) {
        respond({ ok: false, error: "no frame supplied" } satisfies VisionReply);
        return;
      }

      const full = new ImageData(new Uint8ClampedArray(msg.buffer), msg.width, msg.height);
      const faces: NonNullable<VisionReply["faces"]> = [];
      let inferMs = 0;
      let passes = 0;

      // Pass 1 — the whole frame. Catches anything reasonably large.
      const whole = await detect(full);
      inferMs += whole.inferMs;
      passes++;
      for (const b of whole.boxes) {
        faces.push({
          x: b.x * msg.width,
          y: b.y * msg.height,
          w: b.w * msg.width,
          h: b.h * msg.height,
          score: b.score,
        });
      }

      // Pass 2 — only the regions the coverage map could not explain. A face in
      // a small avatar is a handful of pixels at 320x240 and would be missed;
      // run those crops at their own scale instead of upscaling the whole frame.
      for (const c of (msg.crops ?? []).slice(0, 6)) {
        const cw = Math.min(Math.round(c.w), msg.width - Math.round(c.x));
        const ch = Math.min(Math.round(c.h), msg.height - Math.round(c.y));
        if (cw < 24 || ch < 24) continue;

        const crop = cropOf(full, Math.round(c.x), Math.round(c.y), cw, ch);
        const r = await detect(crop);
        inferMs += r.inferMs;
        passes++;
        for (const b of r.boxes) {
          faces.push({
            x: c.x + b.x * cw,
            y: c.y + b.y * ch,
            w: b.w * cw,
            h: b.h * ch,
            score: b.score,
          });
        }
      }

      respond({
        ok: true,
        provider: info.provider,
        faces: dedupe(faces),
        inferMs: Math.round(inferMs * 100) / 100,
        passes,
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

/** The two passes overlap; keep the higher-scoring box for the same face. */
function dedupe(boxes: NonNullable<VisionReply["faces"]>): NonNullable<VisionReply["faces"]> {
  const sorted = boxes.slice().sort((a, b) => b.score - a.score);
  const kept: typeof sorted = [];
  for (const b of sorted) {
    const dup = kept.some((k) => {
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
