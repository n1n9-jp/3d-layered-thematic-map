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

/* ------------------------------------------------------------------ */
/* nearest の走査：終了時間と、総当たりとの一致                          */
/* ------------------------------------------------------------------ */

/** fn を一度呼んで、結果と所要時間（ms）を返す。 */
function timed<T>(fn: () => T): { result: T; ms: number } {
  const t0 = performance.now();
  const result = fn();
  return { result, ms: performance.now() - t0 };
}

const LIMIT_MS = 50;

describe('nearest は入力によらず短時間で返る', () => {
  const rand = rng(3);
  const cluster: Position[] = Array.from({ length: 100 }, () => [rand() * 10, rand() * 10]);
  const scattered: Position[] = Array.from({ length: 600 }, () => [rand() * 20000 - 10000, rand() * 20000 - 10000]);

  it('座標が NaN / Infinity なら、すぐ null を返す', () => {
    const pts = createPointIndex([[0, 0], [5, 5]]);
    const seg = createSegmentIndex([[0, 0, 5, 5]]);
    for (const [x, y] of [
      [NaN, 0],
      [0, NaN],
      [NaN, NaN],
      [Infinity, 0],
      [0, -Infinity],
      [-Infinity, Infinity],
    ]) {
      for (const run of [() => pts.nearest(x, y), () => seg.nearest(x, y), () => pts.nearest(x, y, 100)]) {
        const { result, ms } = timed(run);
        expect(result).toBeNull();
        expect(ms).toBeLessThan(LIMIT_MS);
      }
    }
  });

  it('maxDistance が NaN・負なら null（点の上でも）', () => {
    const pts = createPointIndex([[0, 0]]);
    const seg = createSegmentIndex([[0, 0, 1, 0]]);
    expect(pts.nearest(0, 0, NaN)).toBeNull();
    expect(pts.nearest(0, 0, -1)).toBeNull();
    expect(seg.nearest(0, 0, NaN)).toBeNull();
    expect(seg.nearest(0, 0, -1)).toBeNull();
    expect(pts.nearest(0, 0, 0)?.index).toBe(0);
  });

  it('空のデータ（点・線分）で遠方を問い合わせる', () => {
    const p = timed(() => createPointIndex([]).nearest(17000, 17000));
    const s = timed(() => createSegmentIndex([]).nearest(17000, 17000));
    expect(p.result).toBeNull();
    expect(s.result).toBeNull();
    expect(p.ms).toBeLessThan(LIMIT_MS);
    expect(s.ms).toBeLessThan(LIMIT_MS);
  });

  it('1点だけの索引で、格子から遠い点を問い合わせる', () => {
    const { result, ms } = timed(() => createPointIndex([[0, 0]]).nearest(-19000, 17000));
    expect(result?.index).toBe(0);
    expect(result?.distance).toBeCloseTo(Math.hypot(19000, 17000), 6);
    expect(ms).toBeLessThan(LIMIT_MS);
  });

  it('10m 四方に100点が集まったデータで 5km 先を問い合わせる', () => {
    const idx = createPointIndex(cluster);
    const { result, ms } = timed(() => idx.nearest(5000, 0));
    expect(result?.index).toBe(bruteNearestPoint(cluster, 5000, 0)?.index);
    expect(ms).toBeLessThan(LIMIT_MS);
  });

  it('長さ0の線分1本で 5km 先を問い合わせる', () => {
    const idx = createSegmentIndex([[3, 3, 3, 3]]);
    const { result, ms } = timed(() => idx.nearest(5000, 0));
    expect(result?.index).toBe(0);
    expect(result?.distance).toBeCloseTo(Math.hypot(4997, 3), 6);
    expect(ms).toBeLessThan(LIMIT_MS);
  });

  it('600点が広く散らばったデータで nearest(1e7, 0)', () => {
    const idx = createPointIndex(scattered);
    const { result, ms } = timed(() => idx.nearest(1e7, 0));
    expect(result?.index).toBe(bruteNearestPoint(scattered, 1e7, 0)?.index);
    expect(ms).toBeLessThan(LIMIT_MS);
  });

  it('桁外れの遠方（1e300, 1e308）でも終わる', () => {
    const pIdx = createPointIndex(scattered);
    const sIdx = createSegmentIndex([[0, 0, 5, 5]]);
    for (const [x, y] of [
      [1e300, 0],
      [-1e300, 1e300],
      [1e308, -1e308],
      [Number.MAX_VALUE, Number.MAX_VALUE],
    ]) {
      const a = timed(() => pIdx.nearest(x, y));
      const b = timed(() => sIdx.nearest(x, y));
      expect(a.ms).toBeLessThan(LIMIT_MS);
      expect(b.ms).toBeLessThan(LIMIT_MS);
    }
    expect(pIdx.nearest(1e300, 0)?.index).toBe(bruteNearestPoint(scattered, 1e300, 0)?.index);
  });

  it('遠方でも maxDistance があれば、すぐ null', () => {
    const idx = createPointIndex(scattered);
    const { result, ms } = timed(() => idx.nearest(1e7, 0, 100));
    expect(result).toBeNull();
    expect(ms).toBeLessThan(LIMIT_MS);
  });

  it('座標が有限でない点・線分は索引に載らず、添字は元のまま', () => {
    const pts = createPointIndex([[NaN, 0], [Infinity, 1], [10, 10], [0, 0]]);
    expect(pts.nearest(9, 9)?.index).toBe(2);
    expect(pts.nearest(1, 1)?.index).toBe(3);
    const segs = createSegmentIndex([[NaN, 0, 1, 1], [0, 0, Infinity, 5], [10, 10, 20, 10], [0, 0, 1, 0]]);
    expect(segs.nearest(15, 12)?.index).toBe(2);
    expect(segs.nearest(0.5, 1)?.index).toBe(3);
  });
});

/** 総当たり：距離、同距離なら添字の小さい方。maxDistance を超えれば null。 */
function bruteNearestPoint(points: readonly Position[], x: number, y: number, maxDistance = Infinity) {
  let best: { index: number; distance: number } | null = null;
  points.forEach((p, i) => {
    const d = Math.hypot(p[0] - x, p[1] - y);
    if (!best || d < best.distance) best = { index: i, distance: d };
  });
  const b = best as { index: number; distance: number } | null;
  return b && b.distance <= maxDistance ? b : null;
}

function bruteNearestSegment(segs: readonly Segment[], x: number, y: number, maxDistance = Infinity) {
  let best: { index: number; distance: number; x: number; y: number } | null = null;
  segs.forEach((s, i) => {
    const c = closestPointOnSegment(x, y, s);
    if (!best || c.distance < best.distance) best = { index: i, ...c };
  });
  const b = best as { index: number; distance: number; x: number; y: number } | null;
  return b && b.distance <= maxDistance ? b : null;
}

describe('nearest は総当たりと一致する（乱数データ・格子の内側/外側/遠方）', () => {
  /** 問い合わせ点：格子の内側、すぐ外側、遠方。 */
  function queries(rand: () => number, span: number): [number, number][] {
    const out: [number, number][] = [];
    for (let i = 0; i < 60; i++) out.push([rand() * span, rand() * span]); // 内側
    for (let i = 0; i < 60; i++) out.push([rand() * span * 3 - span, rand() * span * 3 - span]); // 外側（近傍）
    for (let i = 0; i < 40; i++) {
      const far = [1e4, 1e5, 1e6, 1e8][i % 4];
      out.push([(rand() * 2 - 1) * far, (rand() * 2 - 1) * far]); // 遠方
    }
    return out;
  }
  const maxes = (rand: () => number, span: number) => [undefined, 0, span * 0.05, span * 0.5, span * 5, rand() * span];

  it('点：ばらつき・集中・重複・整数座標（同距離）', () => {
    const rand = rng(101);
    const span = 10000;
    const datasets: { points: Position[]; size?: number }[] = [
      { points: Array.from({ length: 300 }, () => [rand() * span, rand() * span]) },
      { points: Array.from({ length: 300 }, () => [rand() * span, rand() * span]), size: 250 },
      { points: Array.from({ length: 80 }, () => [rand() * 10, rand() * 10]) },
      { points: Array.from({ length: 50 }, (_, i) => (i % 2 ? [500, 500] : [rand() * span, rand() * span])) }, // 重複
      { points: Array.from({ length: 60 }, () => [Math.floor(rand() * 30), Math.floor(rand() * 30)]), size: 3 },
      { points: [[1234, 5678]] },
    ];
    for (const { points, size } of datasets) {
      const idx = createPointIndex(points, size);
      const s = points === datasets[2].points ? 10 : points === datasets[4].points ? 30 : span;
      for (const [x, y] of queries(rand, s)) {
        for (const max of maxes(rand, s)) {
          const got = idx.nearest(x, y, max);
          const want = bruteNearestPoint(points, x, y, max);
          expect(got).toEqual(want);
        }
      }
    }
  });

  it('線分：ばらつき・長短混在・長さ0・整数座標', () => {
    const rand = rng(202);
    const span = 10000;
    const make = (n: number, len: number, off = 0): Segment[] =>
      Array.from({ length: n }, () => {
        const x = rand() * span;
        const y = rand() * span;
        return [x, y, x + (rand() * 2 - 1) * len + off, y + (rand() * 2 - 1) * len + off];
      });
    const datasets: { segs: Segment[]; size?: number; span: number }[] = [
      { segs: make(250, 400), span },
      { segs: make(250, 400), size: 200, span },
      { segs: [...make(100, 100), [0, 0, span, span], [span, 0, 0, span]], span },
      { segs: Array.from({ length: 50 }, () => { const x = rand() * 10; const y = rand() * 10; return [x, y, x, y]; }), span: 10 },
      { segs: [[3, 3, 3, 3]], span: 10 },
      {
        segs: Array.from({ length: 60 }, () => {
          const x = Math.floor(rand() * 30);
          const y = Math.floor(rand() * 30);
          return [x, y, x + Math.floor(rand() * 5), y];
        }),
        size: 3,
        span: 30,
      },
    ];
    for (const { segs, size, span: s } of datasets) {
      const idx = createSegmentIndex(segs, size);
      for (const [x, y] of queries(rand, s)) {
        for (const max of maxes(rand, s)) {
          const got = idx.nearest(x, y, max);
          const want = bruteNearestSegment(segs, x, y, max);
          expect(got).toEqual(want);
        }
      }
    }
  });
});
