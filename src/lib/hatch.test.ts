import { describe, expect, it } from 'vitest';
import { lineInsidePolygon } from './section';
import { hatchPolygon } from './hatch';

const square: [number, number][] = [[0, 0], [1000, 0], [1000, 1000], [0, 1000], [0, 0]];
const hole: [number, number][] = [[400, 400], [400, 600], [600, 600], [600, 400], [400, 400]];

describe('lineInsidePolygon', () => {
  it('外周の内側の区間。穴の中は除く（偶奇規則）', () => {
    const line = { ax: -100, ay: 500, bx: 1100, by: 500 };
    expect(lineInsidePolygon(line, [square])).toEqual([[100, 1100]]);
    const r = lineInsidePolygon(line, [square, hole]);
    expect(r).toHaveLength(2);
    expect(r[0][0]).toBeCloseTo(100, 6);
    expect(r[0][1]).toBeCloseTo(500, 6);
    expect(r[1][0]).toBeCloseTo(700, 6);
    expect(r[1][1]).toBeCloseTo(1100, 6);
  });
  it('多角形に届かない線は、区間なし', () => {
    expect(lineInsidePolygon({ ax: 2000, ay: 0, bx: 3000, by: 0 }, [square])).toEqual([]);
  });
});

describe('hatchPolygon：45 度の網掛け', () => {
  it('線は多角形の中に収まり、右上がりで、間隔はほぼ指定どおり', () => {
    const h = hatchPolygon([square], 100);
    expect(h.length).toBeGreaterThan(10);
    for (const [a, b] of h) {
      for (const [x, y] of [a, b]) {
        expect(x).toBeGreaterThanOrEqual(-1);
        expect(x).toBeLessThanOrEqual(1001);
        expect(y).toBeGreaterThanOrEqual(-1);
        expect(y).toBeLessThanOrEqual(1001);
      }
      expect(b[0] - a[0]).toBe(b[1] - a[1]); // 右上がり 45 度
    }
    // 線の数：一辺 1,000 m の正方形を、斜めに 100 m 間隔で切る → 対角線の長さ 1,414 m ÷ 100 ≒ 14 本
    expect(h.length).toBeGreaterThanOrEqual(13);
    expect(h.length).toBeLessThanOrEqual(16);
  });
  it('穴の中には線を引かない。同じ入力からは同じ線ができる', () => {
    const h = hatchPolygon([square, hole], 100);
    for (const [a, b] of h)
      for (const t of [0.25, 0.5, 0.75]) {
        const x = a[0] + (b[0] - a[0]) * t;
        const y = a[1] + (b[1] - a[1]) * t;
        expect(x > 405 && x < 595 && y > 405 && y < 595).toBe(false);
      }
    expect(hatchPolygon([square, hole], 100)).toEqual(h);
  });
  it('間隔が正でなければ、何も引かない', () => {
    expect(hatchPolygon([square], 0)).toEqual([]);
  });
});
