/**
 * The on-device vision model.
 *
 * UltraFace RFB-320 — a 1.2 MB convolutional detector, run through ONNX Runtime
 * Web on WebGPU where available and WASM+SIMD where not. This is the component
 * the problem statement asks for: a local model that reads the screen, so that
 * faces and identity documents are found in PIXELS rather than guessed at from
 * alt text.
 *
 * It runs in an offscreen document, not the service worker, because WebGPU is
 * not exposed to service workers.
 */
import * as ort from "onnxruntime-web/webgpu";

export interface Detection {
  /** Normalised to the input frame: 0..1. */
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
}

export interface DetectorInfo {
  provider: string;
  loadMs: number;
  modelBytes: number;
}

// RFB-320 expects 320×240 RGB, normalised (px - 127) / 128.
const IN_W = 320;
const IN_H = 240;
const MEAN = 127;
const SCALE = 1 / 128;

const SCORE_THRESHOLD = 0.7;
const IOU_THRESHOLD = 0.4;

let session: ort.InferenceSession | null = null;
let info: DetectorInfo | null = null;

export async function load(modelUrl: string, wasmBase: string): Promise<DetectorInfo> {
  if (info) return info;
  const t0 = performance.now();

  ort.env.wasm.wasmPaths = wasmBase;
  ort.env.wasm.numThreads = 1; // extension pages are not cross-origin isolated
  ort.env.logLevel = "error";

  const bytes = new Uint8Array(await (await fetch(modelUrl)).arrayBuffer());

  // WebGPU first, WASM as a real fallback rather than an aspiration.
  let provider = "webgpu";
  try {
    session = await ort.InferenceSession.create(bytes, {
      executionProviders: ["webgpu"],
      graphOptimizationLevel: "all",
    });
  } catch {
    provider = "wasm";
    session = await ort.InferenceSession.create(bytes, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    });
  }

  info = { provider, loadMs: Math.round(performance.now() - t0), modelBytes: bytes.byteLength };
  return info;
}

export function ready(): boolean {
  return session !== null;
}

export function describe(): DetectorInfo | null {
  return info;
}

/**
 * Runs the detector over one RGBA frame. The caller supplies pixels already
 * scaled however it likes; we letterbox-free resize to the model's input, which
 * is fine for a detector trained on whole scenes.
 */
export async function detect(pixels: ImageData): Promise<{ boxes: Detection[]; inferMs: number }> {
  if (!session) return { boxes: [], inferMs: 0 };
  const t0 = performance.now();

  const input = preprocess(pixels);
  const feeds: Record<string, ort.Tensor> = {
    input: new ort.Tensor("float32", input, [1, 3, IN_H, IN_W]),
  };
  const out = await session.run(feeds);

  const scores = out.scores.data as Float32Array; // [1, N, 2]
  const boxes = out.boxes.data as Float32Array; // [1, N, 4] normalised x1 y1 x2 y2
  const n = scores.length / 2;

  const cand: Detection[] = [];
  for (let i = 0; i < n; i++) {
    const score = scores[i * 2 + 1]; // index 1 is "face"; 0 is background
    if (score < SCORE_THRESHOLD) continue;
    const x1 = boxes[i * 4];
    const y1 = boxes[i * 4 + 1];
    const x2 = boxes[i * 4 + 2];
    const y2 = boxes[i * 4 + 3];
    if (x2 <= x1 || y2 <= y1) continue;
    cand.push({ x: x1, y: y1, w: x2 - x1, h: y2 - y1, score });
  }

  return { boxes: nms(cand), inferMs: Math.round((performance.now() - t0) * 100) / 100 };
}

/** RGBA → normalised NCHW float32, resizing by nearest neighbour. */
function preprocess(img: ImageData): Float32Array {
  const out = new Float32Array(3 * IN_H * IN_W);
  const plane = IN_H * IN_W;
  const sx = img.width / IN_W;
  const sy = img.height / IN_H;

  for (let y = 0; y < IN_H; y++) {
    const srcY = Math.min(img.height - 1, (y * sy) | 0);
    for (let x = 0; x < IN_W; x++) {
      const srcX = Math.min(img.width - 1, (x * sx) | 0);
      const s = (srcY * img.width + srcX) * 4;
      const d = y * IN_W + x;
      out[d] = (img.data[s] - MEAN) * SCALE;
      out[plane + d] = (img.data[s + 1] - MEAN) * SCALE;
      out[2 * plane + d] = (img.data[s + 2] - MEAN) * SCALE;
    }
  }
  return out;
}

/** Greedy non-maximum suppression — the model emits ~4400 overlapping priors. */
function nms(boxes: Detection[]): Detection[] {
  const sorted = boxes.slice().sort((a, b) => b.score - a.score);
  const kept: Detection[] = [];
  for (const b of sorted) {
    if (kept.some((k) => iou(k, b) > IOU_THRESHOLD)) continue;
    kept.push(b);
    if (kept.length >= 24) break;
  }
  return kept;
}

function iou(a: Detection, b: Detection): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  if (inter <= 0) return 0;
  return inter / (a.w * a.h + b.w * b.h - inter);
}
