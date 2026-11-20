import { describe, expect, it } from 'vitest';
import elevation, { roundTo1 } from './elevation';
import type { ElevationLayerData } from './elevation';

function grid(values: number[]): ElevationLayerData {
  return {
    minX: 0,
    minY: 0,
    maxX: values.length * 50,
    maxY: 50,
    cellSize: 50,
    width: values.length,
    height: 1,
    values: new Float32Array(values),
    image: null as unknown as ImageData,
  } as ElevationLayerData;
}

describe('roundTo1', () => {
  it('-0.05 から 0 の間は -0 でなく 0 になる', () => {
    for (const v of [-0.04, -0.01, -0.05, -1e-9, -0]) {
      expect(Object.is(roundTo1(v), 0)).toBe(true);
    }
  });
  it('通常の丸め', () => {
    expect(roundTo1(3.64)).toBe(3.6);
    expect(roundTo1(-0.35)).toBe(-0.3);
    expect(roundTo1(-0.06)).toBe(-0.1);
    expect(roundTo1(0)).toBe(0);
  });
});

describe('elevation.sample', () => {
  it('-0.03 m のセルは 0 m と表示される', () => {
    const [row] = elevation.sample(grid([-0.03]), 10, 10);
    expect(Object.is(row.value, 0)).toBe(true);
    expect(row.unit).toBe('m');
  });
  it('範囲外は値なし', () => {
    expect(elevation.sample(grid([1]), 1000, 10)[0].value).toBeNull();
  });
});
