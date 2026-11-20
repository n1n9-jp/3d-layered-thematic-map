import type { ElevationData } from '../types';

/**
 * 標高格子から、円を囲む正方形の範囲を、格子のセルに合わせて切り出す。
 * - 範囲は、円に少しでもかかるセルを含む（全体の範囲をはみ出す分は切り詰める）。
 * - セルの中心が円の外（縁の上は中）にあるセルは NaN にする。
 * - 切り出した格子の `minX/minY/maxX/maxY` は、元の格子のセル境界に合わせる。`min` / `max` は切り出した有効値の最小・最大
 *   （有効なセルが無いときは NaN）。
 * - 円が格子と重ならないときは、範囲内のいちばん近いセル1個（NaN）の格子にする（幅・高さを 0 にしない）。
 * 切り出した格子にも、もう一度かけられる。
 */
export function subsetGrid(grid: ElevationData, cx: number, cy: number, radius: number): ElevationData {
  const { cellSize, width, height } = grid;
  const valid = Number.isFinite(cx) && Number.isFinite(cy) && radius >= 0;
  // 円を囲む正方形に、かかるセルの範囲（切り詰める前）
  const rawC0 = valid ? Math.floor((cx - radius - grid.minX) / cellSize) : 0;
  const rawC1 = valid ? Math.floor((cx + radius - grid.minX) / cellSize) : -1;
  const rawR0 = valid ? Math.floor((grid.maxY - (cy + radius)) / cellSize) : 0;
  const rawR1 = valid ? Math.floor((grid.maxY - (cy - radius)) / cellSize) : -1;
  const overlaps = rawC1 >= 0 && rawC0 <= width - 1 && rawR1 >= 0 && rawR0 <= height - 1;
  const c0 = Math.min(Math.max(rawC0, 0), width - 1);
  const r0 = Math.min(Math.max(rawR0, 0), height - 1);
  const c1 = overlaps ? Math.min(rawC1, width - 1) : c0;
  const r1 = overlaps ? Math.min(rawR1, height - 1) : r0;

  const w = c1 - c0 + 1;
  const h = r1 - r0 + 1;
  const values = new Float32Array(w * h).fill(NaN);
  let min = Infinity;
  let max = -Infinity;
  if (overlaps) {
    const r2 = radius * radius;
    for (let row = r0; row <= r1; row++) {
      const y = grid.maxY - (row + 0.5) * cellSize;
      const dy = y - cy;
      if (dy * dy > r2) continue;
      for (let col = c0; col <= c1; col++) {
        const dx = grid.minX + (col + 0.5) * cellSize - cx;
        if (dx * dx + dy * dy > r2) continue;
        const v = grid.values[row * width + col];
        if (Number.isNaN(v)) continue;
        values[(row - r0) * w + (col - c0)] = v;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
  }
  const minX = grid.minX + c0 * cellSize;
  const maxY = grid.maxY - r0 * cellSize;
  return {
    width: w,
    height: h,
    cellSize,
    minX,
    maxX: minX + w * cellSize,
    maxY,
    minY: maxY - h * cellSize,
    min: min === Infinity ? NaN : min,
    max: max === -Infinity ? NaN : max,
    values,
  };
}

/** 有効なセル（NaN でない）の数・最小・最大・平均。有効なセルが無ければ count 0、ほかは NaN。 */
export function gridStats(grid: Pick<ElevationData, 'values'>): { count: number; min: number; max: number; mean: number } {
  let count = 0;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const v of grid.values) {
    if (Number.isNaN(v)) continue;
    count++;
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return count === 0 ? { count, min: NaN, max: NaN, mean: NaN } : { count, min, max, mean: sum / count };
}
