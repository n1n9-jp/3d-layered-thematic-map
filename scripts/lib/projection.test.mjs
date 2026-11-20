import { describe, expect, it } from 'vitest';
import { PROJ, EXTENT, toLocal, toLocalRounded, toLonLat, inExtent } from './projection.mjs';

describe('projection', () => {
  it('exports PROJ and EXTENT', () => {
    expect(PROJ).toContain('+proj=tmerc');
    expect(EXTENT).toEqual({ minX: -19000, minY: -19000, maxX: 17000, maxY: 17000 });
  });

  it('原点は (0, 0)', () => {
    const [x, y] = toLocal(139.75, 35.68);
    expect(Math.abs(x)).toBeLessThan(1e-6);
    expect(Math.abs(y)).toBeLessThan(1e-6);
  });

  it('(139.56, 35.52) は x≈-17200, y≈-17750（誤差100m以内）', () => {
    const [x, y] = toLocal(139.56, 35.52);
    expect(Math.abs(x - -17200)).toBeLessThan(100);
    expect(Math.abs(y - -17750)).toBeLessThan(100);
  });

  it('往復変換の誤差は 1e-7 度未満', () => {
    for (const [lon, lat] of [[139.56, 35.52], [139.75, 35.68], [139.92, 35.82], [139.6, 35.7]]) {
      const [x, y] = toLocal(lon, lat);
      const [lon2, lat2] = toLonLat(x, y);
      expect(Math.abs(lon2 - lon)).toBeLessThan(1e-7);
      expect(Math.abs(lat2 - lat)).toBeLessThan(1e-7);
    }
  });

  it('toLocalRounded は 1m に丸める', () => {
    const [x, y] = toLocalRounded(139.56, 35.52);
    expect(Number.isInteger(x)).toBe(true);
    expect(Number.isInteger(y)).toBe(true);
  });

  it('inExtent は範囲内外を判定する', () => {
    expect(inExtent(0, 0)).toBe(true);
    expect(inExtent(-19000, 17000)).toBe(true);
    expect(inExtent(17001, 0)).toBe(false);
    expect(inExtent(0, -19001)).toBe(false);
  });
});
