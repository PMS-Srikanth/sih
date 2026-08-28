/**
 * Pixel capture and masking. Runs in the service worker, which has
 * OffscreenCanvas and createImageBitmap but no document — the page never sees
 * any of this, and the un-masked bitmap never leaves this module.
 *
 * The critical rule: masks are COMPOSITED INTO the bitmap and re-encoded. We
 * never send an original frame with a list of boxes for the server to politely
 * ignore, and we never use CSS blur, which is reversible.
 */
import type { BBox, Mode, RawElement, SafeRegion } from "@/shared/types";
import {
  buildCoverage, cellVariance, opaqueRegions, unexplainedRegions, CELL,
} from "@/perception/coverage";

/** Longest edge of the frame we are willing to reason about or transmit. */
const MAX_EDGE = 768;

export interface Capture {
  canvas: OffscreenCanvas;
  ctx: OffscreenCanvasRenderingContext2D;
  /** imagePx / cssPx — element bboxes are CSS px, the bitmap is not. */
  scale: number;
  width: number;
  height: number;
  captureMs: number;
}

export interface VisionPlan {
  /** Regions the DOM cannot explain — what a model would actually run on. */
  regions: BBox[];
  /** Of the viewport, how much the DOM already accounts for. */
  coveragePct: number;
  cells: number;
  analyseMs: number;
}

export async function captureViewport(windowId: number): Promise<Capture | null> {
  const t0 = performance.now();
  let dataUrl: string;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  } catch {
    return null; // no activeTab grant, or a restricted page
  }
  if (!dataUrl) return null;

  const blob = await (await fetch(dataUrl)).blob();
  const bmp = await createImageBitmap(blob);

  const scaleDown = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
  const width = Math.max(1, Math.round(bmp.width * scaleDown));
  const height = Math.max(1, Math.round(bmp.height * scaleDown));

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    bmp.close();
    return null;
  }
  ctx.drawImage(bmp, 0, 0, width, height);
  const cssWidth = bmp.width; // captureVisibleTab returns device pixels
  bmp.close();

  return {
    canvas,
    ctx,
    scale: width / cssWidth,
    width,
    height,
    captureMs: Math.round((performance.now() - t0) * 100) / 100,
  };
}

/**
 * Where would a vision model actually need to look? Everywhere the DOM already
 * explains is skipped; what is left is images, canvases, and any high-variance
 * area no element accounts for.
 */
export function planVision(
  cap: Capture,
  elements: RawElement[],
  viewport: { w: number; h: number },
  mode: Mode,
): VisionPlan {
  const t0 = performance.now();
  const { cols, rows, covered } = buildCoverage(elements, viewport);

  const img = cap.ctx.getImageData(0, 0, cap.width, cap.height);
  const variance = cellVariance(img.data, cap.width, cap.height, cols, rows);

  // Thorough sweeps the whole frame; balanced trusts the coverage map.
  const minVar = mode === "thorough" ? 40 : 120;
  const regions = unexplainedRegions({ cols, rows, covered, variance }, CELL, minVar);

  // Anything the DOM calls an image or a canvas is opaque by definition, so it
  // joins the list even if it happens to be low-variance.
  for (const o of opaqueRegions(elements)) {
    if (!regions.some((r) => overlaps(r, o.bbox))) regions.push(o.bbox);
  }

  const coveredCells = covered.reduce((n, v) => n + v, 0);
  return {
    regions: regions.slice(0, mode === "fast" ? 0 : 20),
    coveragePct: Math.round((coveredCells / (cols * rows)) * 100),
    cells: cols * rows,
    analyseMs: Math.round((performance.now() - t0) * 100) / 100,
  };
}

/**
 * Paints solid blocks over sensitive regions, IN the bitmap. After this returns
 * the original pixels of those areas no longer exist in the buffer.
 */
export function maskRegions(cap: Capture, regions: Array<{ bbox: BBox }>, pad = 4): number {
  cap.ctx.save();
  cap.ctx.fillStyle = "#000000";
  let painted = 0;
  for (const r of regions) {
    const x = (r.bbox.x - pad) * cap.scale;
    const y = (r.bbox.y - pad) * cap.scale;
    const w = (r.bbox.w + pad * 2) * cap.scale;
    const h = (r.bbox.h + pad * 2) * cap.scale;
    if (w <= 0 || h <= 0) continue;
    cap.ctx.fillRect(x, y, w, h);
    painted++;
  }
  cap.ctx.restore();
  return painted;
}

/**
 * Verifier check V3, for real. Re-reads the masked bitmap and asserts every
 * region it was told to cover is actually flat black. If a mask silently failed
 * to paint, this is what catches it before the frame is transmitted.
 */
export function verifyMasks(
  cap: Capture,
  regions: Array<{ bbox: BBox }>,
): { ok: boolean; checked: number; failed: number } {
  let failed = 0;
  for (const r of regions) {
    const x = Math.max(0, Math.round(r.bbox.x * cap.scale));
    const y = Math.max(0, Math.round(r.bbox.y * cap.scale));
    const w = Math.min(cap.width - x, Math.round(r.bbox.w * cap.scale));
    const h = Math.min(cap.height - y, Math.round(r.bbox.h * cap.scale));
    if (w <= 1 || h <= 1) continue;

    const { data } = cap.ctx.getImageData(x, y, w, h);
    // Sample rather than scan: any non-black pixel means the mask did not land.
    const step = Math.max(4, Math.floor((w * h) / 400)) * 4;
    for (let i = 0; i < data.length; i += step) {
      if (data[i] > 8 || data[i + 1] > 8 || data[i + 2] > 8) {
        failed++;
        break;
      }
    }
  }
  return { ok: failed === 0, checked: regions.length, failed };
}

/** Base64 WebP of the masked frame — the only form pixels may be transmitted in. */
export async function encode(cap: Capture, quality = 0.7): Promise<string> {
  const blob = await cap.canvas.convertToBlob({ type: "image/webp", quality });
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  for (let i = 0; i < buf.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, Array.from(buf.subarray(i, i + 0x8000)));
  }
  return `data:image/webp;base64,${btoa(s)}`;
}

export function toSafeRegions(regions: Array<{ bbox: BBox; cls: SafeRegion["cls"] }>): SafeRegion[] {
  return regions.map((r) => ({
    bbox: [r.bbox.x, r.bbox.y, r.bbox.w, r.bbox.h],
    cls: r.cls,
    state: "masked" as const,
  }));
}

function overlaps(a: BBox, b: BBox): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}
