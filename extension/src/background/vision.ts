/**
 * Bridge from the service worker to the offscreen document that hosts the model.
 *
 * Frames go out as raw RGBA and coordinates come back. No pixels are ever
 * returned, nothing is cached, and the offscreen document has no access to the
 * vault or the network.
 */
import type { BBox } from "@/shared/types";
import type { Capture } from "./capture";

const OFFSCREEN_PATH = "offscreen.html";

export interface VisionResult {
  /** Face boxes in CSS pixels, viewport-relative — same space as element bboxes. */
  faces: Array<BBox & { score: number }>;
  provider: string;
  inferMs: number;
  passes: number;
  error?: string;
}

let creating: Promise<void> | null = null;

async function ensureOffscreen(): Promise<boolean> {
  if (!chrome.offscreen) return false;
  try {
    const existing = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType],
    });
    if (existing.length > 0) return true;

    if (!creating) {
      creating = chrome.offscreen.createDocument({
        url: OFFSCREEN_PATH,
        reasons: ["WORKERS" as chrome.offscreen.Reason],
        justification: "Runs the local vision model; WebGPU is not available to service workers.",
      });
    }
    await creating;
    creating = null;
    return true;
  } catch {
    creating = null;
    // Already exists is a benign race, anything else means no vision this step.
    return true;
  }
}

/** Loads the model ahead of the first real frame so step 1 is not the slow one. */
export async function warmup(): Promise<{ ok: boolean; provider?: string; loadMs?: number }> {
  if (!(await ensureOffscreen())) return { ok: false };
  try {
    const r = await chrome.runtime.sendMessage({ target: "offscreen", kind: "warmup" });
    return { ok: !!r?.ok, provider: r?.provider, loadMs: r?.loadMs };
  } catch {
    return { ok: false };
  }
}

/**
 * Runs the detector over the captured frame, plus any regions the coverage map
 * could not explain — a face inside a 96px avatar is invisible at the model's
 * 320x240 input, so those crops get their own pass.
 */
export async function detectFaces(cap: Capture, crops: BBox[]): Promise<VisionResult> {
  const empty: VisionResult = { faces: [], provider: "none", inferMs: 0, passes: 0 };
  if (!(await ensureOffscreen())) return { ...empty, error: "offscreen unavailable" };

  const img = cap.ctx.getImageData(0, 0, cap.width, cap.height);

  // Crops arrive in CSS px; the frame is in image px.
  const framedCrops = crops.slice(0, 6).map((c) => ({
    x: c.x * cap.scale,
    y: c.y * cap.scale,
    w: c.w * cap.scale,
    h: c.h * cap.scale,
  }));

  try {
    const reply = await chrome.runtime.sendMessage({
      target: "offscreen",
      kind: "detect",
      width: cap.width,
      height: cap.height,
      buffer: img.data.buffer,
      crops: framedCrops,
    });

    if (!reply?.ok) return { ...empty, error: reply?.error ?? "no reply from the model" };

    return {
      faces: (reply.faces ?? []).map((f: { x: number; y: number; w: number; h: number; score: number }) => ({
        x: f.x / cap.scale,
        y: f.y / cap.scale,
        w: f.w / cap.scale,
        h: f.h / cap.scale,
        score: f.score,
      })),
      provider: reply.provider ?? "wasm",
      inferMs: reply.inferMs ?? 0,
      passes: reply.passes ?? 0,
    };
  } catch (e) {
    return { ...empty, error: e instanceof Error ? e.message : String(e) };
  }
}
