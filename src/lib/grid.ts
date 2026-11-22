import type { ElevationData } from '../types';

/** 格子の位置の定義（標高も、浸水想定も、これを持つ）。 */
export type GridGeometry = Pick<ElevationData, 'minX' | 'maxY' | 'cellSize' | 'width' | 'height'>;

/** 格子上の (列, 行)。範囲外は null。col = floor((x - minX) / cellSize), row = floor((maxY - y) / cellSize)。 */
export function gridCell(grid: GridGeometry, x: number, y: number): { col: number; row: number } | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const col = Math.floor((x - grid.minX) / grid.cellSize);
  const row = Math.floor((grid.maxY - y) / grid.cellSize);
  if (col < 0 || col >= grid.width || row < 0 || row >= grid.height) return null;
  return { col, row };
}

/** 地点 (x, y) の標高（m）。範囲外・データなし（NaN）は null。 */
export function sampleGrid(grid: ElevationData, x: number, y: number): number | null {
  const cell = gridCell(grid, x, y);
  if (!cell) return null;
  const v = grid.values[cell.row * grid.width + cell.col];
  return Number.isNaN(v) ? null : v;
}
