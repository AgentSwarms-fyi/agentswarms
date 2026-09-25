// Where rows and columns sit on screen: sizes that vary (a row made taller,
// a column widened, one hidden), scaled by the zoom, as prefix sums so the
// grid can go from a pixel to a cell and back in O(log n).

export class AxisGeometry {
  private readonly offsets: Float64Array;

  constructor(
    readonly count: number,
    size: (i: number) => number,
  ) {
    this.offsets = new Float64Array(count + 1);
    for (let i = 0; i < count; i++) this.offsets[i + 1] = this.offsets[i] + size(i);
  }

  /** Where item i starts. */
  start(i: number): number {
    return this.offsets[Math.max(0, Math.min(this.count, i))];
  }

  /** How big item i is (0 when hidden). */
  size(i: number): number {
    if (i < 0 || i >= this.count) return 0;
    return this.offsets[i + 1] - this.offsets[i];
  }

  /** The end of item i (its start plus its size). */
  end(i: number): number {
    return this.start(i + 1);
  }

  get total(): number {
    return this.offsets[this.count];
  }

  /**
   * The item under a pixel: the last one starting at or before it that has a
   * size (a hidden item is never under the pointer).
   */
  indexAt(px: number): number {
    if (this.count === 0) return 0;
    let lo = 0;
    let hi = this.count - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.offsets[mid] <= px) lo = mid;
      else hi = mid - 1;
    }
    while (lo > 0 && this.size(lo) === 0) lo--;
    return lo;
  }
}

export const ZOOM_LEVELS = [50, 75, 90, 100, 110, 125, 150, 200] as const;
export const MIN_ZOOM = 25;
export const MAX_ZOOM = 400;

export function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return 100;
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(z)));
}

/** The next zoom step in or out, as Excel's +/- buttons go (10 points at a time). */
export function stepZoom(z: number, dir: 1 | -1): number {
  const next = dir > 0 ? Math.floor(z / 10) * 10 + 10 : Math.ceil(z / 10) * 10 - 10;
  return clampZoom(next);
}
