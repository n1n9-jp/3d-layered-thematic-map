import { describe, expect, it } from 'vitest';
import { gridCell, sampleGrid } from './grid';
import type { ElevationData } from '../types';

// 3列×2行、cellSize 10。x: 0..30, y: 0..20。行は北（y=20側）から。
const grid: ElevationData = {
  width: 3,
  height: 2,
  cellSize: 10,
  minX: 0,
  minY: 0,
  maxX: 30,
  maxY: 20,
  min: 1,
  max: 6,
  values: new Float32Array([1, 2, 3, 4, NaN, 6]),
};

describe('sampleGrid', () => {
  it('北西隅が先頭の値', () => {
    expect(sampleGrid(grid, 5, 15)).toBe(1);
    expect(sampleGrid(grid, 25, 15)).toBe(3);
  });
  it('南の行は y が小さい側', () => {
    expect(sampleGrid(grid, 5, 5)).toBe(4);
    expect(sampleGrid(grid, 25, 5)).toBe(6);
  });
  it('セル境界は東・南側のセルに属する（floor）', () => {
    expect(gridCell(grid, 10, 20)).toEqual({ col: 1, row: 0 });
    expect(gridCell(grid, 0, 10)).toEqual({ col: 0, row: 1 });
  });
  it('NaN は null', () => {
    expect(sampleGrid(grid, 15, 5)).toBeNull();
  });
  it('範囲外は null', () => {
    expect(sampleGrid(grid, -1, 5)).toBeNull();
    expect(sampleGrid(grid, 30, 5)).toBeNull();
    expect(sampleGrid(grid, 5, 21)).toBeNull();
    expect(sampleGrid(grid, 5, 0)).toBeNull();
    expect(sampleGrid(grid, NaN, 5)).toBeNull();
  });
});
