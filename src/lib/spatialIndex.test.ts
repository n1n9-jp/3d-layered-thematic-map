import { describe, expect, it } from 'vitest';
import {
  closestPointOnSegment,
  createPointIndex,
  createPolygonIndex,
  createSegmentIndex,
  pointInPolygon,
  segmentsFromLines,
} from './spatialIndex';
import type { Segment } from './spatialIndex';
import type { Position } from '../types';

/** 再現できる擬似乱数（LCG）。 */
function rng(seed: number) {
  let s = seed;
  return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
}

describe('PointIndex', () => {
  const rand = rng(1);
  const points: Position[] = Array.from({ length: 500 }, () => [rand() * 10000 - 5000, rand() * 10000 - 5000]);
  const idx = createPointIndex(points, 400);

  it('within は総当たりと一致する', () => {
    for (let t = 0; t < 30; t++) {
      const x = rand() * 12000 - 6000;
      const y = rand() * 12000 - 6000;
      const r = rand() * 1500;
      const expected = points
        .map((p, i) => ({ i, d: Math.hypot(p[0] - x, p[1] - y) }))
        .filter((e) => e.d <= r)
        .map((e) => e.i)
        .sort((a, b) => a - b);
      expect(
        idx
          .within(x, y, r)
          .map((h) => h.index)
          .sort((a, b) => a - b),
      ).toEqual(expected);
    }
  });

  it('nearest は総当たりと一致する（範囲外の問い合わせを含む）', () => {
    for (let t = 0; t < 50; t++) {
      const x = rand() * 30000 - 15000;
      const y = rand() * 30000 - 15000;
      let bi = -1;
      let bd = Infinity;
      points.forEach((p, i) => {
        const d = Math.hypot(p[0] - x, p[1] - y);
        if (d < bd) {
          bd = d;
          bi = i;
        }
      });
      const hit = idx.nearest(x, y);
      expect(hit?.index).toBe(bi);
      expect(hit?.distance).toBeCloseTo(bd, 6);
    }
  });

  it('maxDistance を超えると null', () => {
    const one = createPointIndex([[0, 0]]);
    expect(one.nearest(100, 0, 50)).toBeNull();
    expect(one.nearest(100, 0, 100)?.index).toBe(0);
  });

  it('空の索引', () => {
    const empty = createPointIndex([]);
    expect(empty.nearest(0, 0)).toBeNull();
    expect(empty.within(0, 0, 10)).toEqual([]);
  });

  it('within の結果は距離の昇順', () => {
    const hits = createPointIndex([[3, 0], [1, 0], [2, 0]]).within(0, 0, 10);
    expect(hits.map((h) => h.index)).toEqual([1, 2, 0]);
  });
});

describe('SegmentIndex', () => {
  it('closestPointOnSegment', () => {
    const c = closestPointOnSegment(5, 3, [0, 0, 10, 0]);
    expect(c).toEqual({ x: 5, y: 0, distance: 3 });
    expect(closestPointOnSegment(-4, 3, [0, 0, 10, 0])).toEqual({ x: 0, y: 0, distance: 5 });
    expect(closestPointOnSegment(1, 1, [2, 2, 2, 2]).distance).toBeCloseTo(Math.SQRT2);
  });

  it('nearest は総当たりと一致する', () => {
    const rand = rng(7);
    const segs: Segment[] = Array.from({ length: 400 }, () => {
      const x = rand() * 10000 - 5000;
      const y = rand() * 10000 - 5000;
      return [x, y, x + rand() * 600 - 300, y + rand() * 600 - 300];
    });
    const idx = createSegmentIndex(segs, 300);
    for (let t = 0; t < 60; t++) {
      const x = rand() * 16000 - 8000;
      const y = rand() * 16000 - 8000;
      let bd = Infinity;
      for (const s of segs) bd = Math.min(bd, closestPointOnSegment(x, y, s).distance);
      const hit = idx.nearest(x, y);
      expect(hit?.distance).toBeCloseTo(bd, 6);
      const direct = closestPointOnSegment(x, y, segs[hit!.index]);
      expect(direct.distance).toBeCloseTo(bd, 6);
      expect(hit!.x).toBeCloseTo(direct.x, 6);
    }
  });

  it('長い線分でも最近の線分を見つける', () => {
    const idx = createSegmentIndex(
      [
        [-1000, 0, 1000, 0],
        [0, 500, 10, 500],
      ],
      50,
    );
    expect(idx.nearest(500, 30)?.index).toBe(0);
    expect(idx.nearest(500, 30)?.distance).toBe(30);
    expect(idx.nearest(500, 3000, 100)).toBeNull();
  });

  it('segmentsFromLines は隣り合う頂点ごとに線分を作る', () => {
    expect(
      segmentsFromLines([
        [[0, 0], [1, 0], [1, 1]],
        [[5, 5]],
      ]),
    ).toEqual([
      [0, 0, 1, 0],
      [1, 0, 1, 1],
    ]);
  });

  it('空の索引', () => {
    expect(createSegmentIndex([]).nearest(0, 0)).toBeNull();
  });
});

describe('PolygonIndex', () => {
  const square = [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] as Position[][];
  const donut = [
    [[20, 0], [40, 0], [40, 20], [20, 20], [20, 0]],
    [[25, 5], [35, 5], [35, 15], [25, 15], [25, 5]],
  ] as Position[][];

  it('pointInPolygon：内外と穴', () => {
    expect(pointInPolygon(5, 5, square)).toBe(true);
    expect(pointInPolygon(11, 5, square)).toBe(false);
    expect(pointInPolygon(22, 10, donut)).toBe(true);
    expect(pointInPolygon(30, 10, donut)).toBe(false); // 穴の中
  });

  it('containing は含む多角形の添字を返す', () => {
    const idx = createPolygonIndex([square, donut], 10);
    expect(idx.containing(5, 5)).toEqual([0]);
    expect(idx.containing(22, 10)).toEqual([1]);
    expect(idx.containing(30, 10)).toEqual([]);
    expect(idx.containing(-100, -100)).toEqual([]);
  });

  it('重なる多角形は複数返す', () => {
    const idx = createPolygonIndex([square, [[[5, 5], [15, 5], [15, 15], [5, 15], [5, 5]]] as Position[][]], 4);
    expect(idx.containing(7, 7)).toEqual([0, 1]);
    expect(idx.containing(12, 12)).toEqual([1]);
  });

  it('空の索引', () => {
    expect(createPolygonIndex([]).containing(0, 0)).toEqual([]);
  });
});
