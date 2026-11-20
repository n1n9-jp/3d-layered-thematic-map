import { describe, expect, it } from 'vitest';
import type { BoundaryData, Position } from '../types';
import { BOUNDARY_DRAW_TOLERANCE, boundaryPaths, cachedBoundaryPaths, clipBoundaryPaths } from './boundaryLines';

const ring = (pts: Position[]): Position[] => [...pts, pts[0]];
/** 各辺の途中に、辺から 1 m だけ膨らんだ頂点を足した 1000 m 四方の正方形 */
const square: Position[] = ring([
  [0, 0], [500, -1], [1000, 0], [1001, 500], [1000, 1000], [500, 1001], [0, 1000], [-1, 500],
]);

const boundary = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: { code: '13101', name: '千代田区' }, geometry: { type: 'Polygon', coordinates: [square] } },
    {
      type: 'Feature',
      properties: { code: '13102', name: '中央区' },
      geometry: {
        type: 'MultiPolygon',
        coordinates: [
          [ring([[2000, 0], [3000, 0], [3000, 1000], [2000, 1000]])],
          [ring([[4000, 0], [4500, 0], [4500, 500], [4000, 500]]), ring([[4100, 100], [4200, 100], [4200, 200], [4100, 200]])],
        ],
      },
    },
  ],
} as unknown as BoundaryData;

describe('boundaryPaths', () => {
  const paths = boundaryPaths(boundary);

  it('Polygon / MultiPolygon のリングごとに1本の線にする', () => {
    expect(paths).toHaveLength(1 + 1 + 2);
  });
  it('許容誤差内の頂点を間引き、四隅は残して閉じたまま', () => {
    expect(1).toBeLessThanOrEqual(BOUNDARY_DRAW_TOLERANCE);
    const p = paths[0];
    expect(p).toHaveLength(5);
    expect(p[0]).toEqual(p[p.length - 1]);
    for (const c of [[0, 0], [1000, 0], [1000, 1000], [0, 1000]]) expect(p).toContainEqual(c);
  });
  it('元の境界データは書き換えない', () => {
    expect(boundary.features[0].geometry.coordinates[0]).toHaveLength(9);
  });
});

describe('clipBoundaryPaths', () => {
  const paths = boundaryPaths(boundary);

  it('円の中にある部分だけを残し、円の外へ出る頂点は縁の上の点になる', () => {
    // 千代田区の正方形（0〜1000 m）を、中心 (500, 500)・半径 300 m の円で切ると、円の中に線は残らない
    expect(clipBoundaryPaths(paths, 500, 500, 300)).toEqual([]);
    // 中心 (0, 500)・半径 300 m の円では、左辺（x=0 付近）の部分が残る
    const out = clipBoundaryPaths(paths, 0, 500, 300);
    expect(out.length).toBeGreaterThan(0);
    for (const piece of out) for (const [x, y] of piece) expect(Math.hypot(x - 0, y - 500)).toBeLessThanOrEqual(300 + 1e-6);
  });

  it('円が輪郭を全部含むなら、頂点列はそのまま（リングの数も変わらない）', () => {
    const out = clipBoundaryPaths(paths, 500, 500, 5000);
    expect(out.filter((p) => p[0][0] < 1500)).toHaveLength(1);
    expect(out).toHaveLength(paths.length);
  });

  it('円の外にある区の線は含まない', () => {
    const out = clipBoundaryPaths(paths, 2500, 500, 600);
    // 中央区の最初のポリゴン（2000〜3000 m）の辺だけが円の中に入る（四隅は円の外なので、辺ごとに4本に分かれる）
    expect(out).toHaveLength(4);
    expect(out.every((piece) => piece.every(([x]) => x >= 2000 - 1e-6 && x <= 3000 + 1e-6))).toBe(true);
  });

  it('円を何度も出入りする線は、複数の線に分かれる', () => {
    const wavy: Position[] = [[0, 0], [100, 0], [200, 400], [300, 0], [400, 0], [500, 400], [600, 0]];
    const out = clipBoundaryPaths([wavy], 300, 0, 120);
    expect(out.length).toBeGreaterThanOrEqual(1);
    const total = clipBoundaryPaths([wavy], 300, 0, 1000);
    expect(total).toHaveLength(1);
    expect(total[0]).toEqual(wavy);
  });

  it('入力の線は変更しない', () => {
    const before = JSON.stringify(paths);
    clipBoundaryPaths(paths, 0, 500, 300);
    expect(JSON.stringify(paths)).toBe(before);
  });
});

describe('cachedBoundaryPaths', () => {
  it('同じ境界データなら同じ結果（参照）を返す', () => {
    expect(cachedBoundaryPaths(boundary)).toBe(cachedBoundaryPaths(boundary));
    expect(cachedBoundaryPaths(boundary)).toEqual(boundaryPaths(boundary));
  });
});
