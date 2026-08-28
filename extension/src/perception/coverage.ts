/**
 * DOM-coverage-guided vision — the scheduling idea the resource metric turns on.
 *
 * Running a vision model over every frame loses metric 4 outright. Instead we
 * rasterise every element the accessibility layer already explains, then look
 * only at what is left: canvas, images, iframes, closed shadow roots — anything
 * carrying visual content the DOM cannot describe.
 *
 * Pure functions over plain arrays so this is testable without a browser.
 */
import type { BBox, RawElement } from "@/shared/types";

export const CELL = 32;

export interface CoverageStats {
  cols: number;
  rows: number;
  /** 1 = the DOM explains this cell. */
  covered: Uint8Array;
  /** Per-cell luma variance from the captured frame. */
  variance: Float32Array;
  coveredCells: number;
  totalCells: number;
}

/**
 * Elements whose pixels the DOM *cannot* account for. An <img> occupies space
 * the layout engine knows about, but what is inside it is opaque — that is
 * precisely the region a vision model has to look at.
 */
const OPAQUE_TAGS = new Set(["img", "canvas", "svg", "video", "iframe", "object", "embed", "picture"]);

export function isOpaqueToDom(el: RawElement): boolean {
  return OPAQUE_TAGS.has(el.tag) || el.role === "image";
}

/** Marks cells covered by elements the DOM fully explains. */
export function buildCoverage(
  elements: RawElement[],
  viewport: { w: number; h: number },
  cell = CELL,
): { cols: number; rows: number; covered: Uint8Array } {
  const cols = Math.max(1, Math.ceil(viewport.w / cell));
  const rows = Math.max(1, Math.ceil(viewport.h / cell));
  const covered = new Uint8Array(cols * rows);

  for (const el of elements) {
    if (!el.visible) continue;
    if (isOpaqueToDom(el)) continue; // explained in layout, opaque in content
    if (el.role === "other") continue;

    const b = el.bbox;
    // A huge container "covering" the page would hide everything inside it.
    if (b.w * b.h > viewport.w * viewport.h * 0.6) continue;

    const x0 = Math.max(0, Math.floor(b.x / cell));
    const y0 = Math.max(0, Math.floor(b.y / cell));
    const x1 = Math.min(cols - 1, Math.floor((b.x + b.w) / cell));
    const y1 = Math.min(rows - 1, Math.floor((b.y + b.h) / cell));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) covered[y * cols + x] = 1;
    }
  }
  return { cols, rows, covered };
}

/**
 * Per-cell luma variance. A flat background has near-zero variance and is not
 * worth a model pass; a photograph or a rendered chart does not.
 */
export function cellVariance(
  pixels: Uint8ClampedArray,
  imgW: number,
  imgH: number,
  cols: number,
  rows: number,
): Float32Array {
  const out = new Float32Array(cols * rows);
  const cw = imgW / cols;
  const ch = imgH / rows;

  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const x0 = Math.floor(cx * cw);
      const y0 = Math.floor(cy * ch);
      const x1 = Math.min(imgW, Math.floor((cx + 1) * cw));
      const y1 = Math.min(imgH, Math.floor((cy + 1) * ch));

      let n = 0;
      let sum = 0;
      let sumSq = 0;
      // Sample every other pixel: variance does not need every one.
      for (let y = y0; y < y1; y += 2) {
        for (let x = x0; x < x1; x += 2) {
          const i = (y * imgW + x) * 4;
          const luma = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
          sum += luma;
          sumSq += luma * luma;
          n++;
        }
      }
      if (n > 1) {
        const mean = sum / n;
        out[cy * cols + cx] = Math.max(0, sumSq / n - mean * mean);
      }
    }
  }
  return out;
}

/**
 * Cells that carry visual content the DOM cannot explain, merged into
 * rectangles. These — not the whole frame — are what a model would run on.
 */
export function unexplainedRegions(
  stats: Pick<CoverageStats, "cols" | "rows" | "covered" | "variance">,
  cell = CELL,
  minVariance = 120,
): BBox[] {
  const { cols, rows, covered, variance } = stats;
  const candidate = new Uint8Array(cols * rows);
  for (let i = 0; i < candidate.length; i++) {
    candidate[i] = !covered[i] && variance[i] >= minVariance ? 1 : 0;
  }

  const seen = new Uint8Array(cols * rows);
  const out: BBox[] = [];

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      if (!candidate[i] || seen[i]) continue;

      // Flood fill this connected component.
      let minX = x, maxX = x, minY = y, maxY = y, count = 0;
      const stack = [i];
      seen[i] = 1;
      while (stack.length) {
        const k = stack.pop()!;
        const kx = k % cols;
        const ky = (k - kx) / cols;
        count++;
        if (kx < minX) minX = kx;
        if (kx > maxX) maxX = kx;
        if (ky < minY) minY = ky;
        if (ky > maxY) maxY = ky;

        const neighbours = [
          kx > 0 ? k - 1 : -1,
          kx < cols - 1 ? k + 1 : -1,
          ky > 0 ? k - cols : -1,
          ky < rows - 1 ? k + cols : -1,
        ];
        for (const n of neighbours) {
          if (n >= 0 && candidate[n] && !seen[n]) {
            seen[n] = 1;
            stack.push(n);
          }
        }
      }

      if (count < 2) continue; // a single noisy cell is not a region
      out.push({
        x: minX * cell,
        y: minY * cell,
        w: (maxX - minX + 1) * cell,
        h: (maxY - minY + 1) * cell,
      });
    }
  }

  // Largest first — a budget-limited pass should take the most informative.
  return out.sort((a, b) => b.w * b.h - a.w * a.h);
}

/** Regions the DOM says are opaque — images, canvases — always worth a look. */
export function opaqueRegions(elements: RawElement[]): Array<{ id: string; bbox: BBox }> {
  return elements
    .filter((e) => e.visible && isOpaqueToDom(e) && e.bbox.w >= 24 && e.bbox.h >= 24)
    .map((e) => ({ id: e.id, bbox: e.bbox }));
}
