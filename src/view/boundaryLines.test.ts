import { describe, expect, it } from 'vitest';
import type { BoundaryData, Position } from '../types';
import { BOUNDARY_DRAW_TOLERANCE, boundaryPaths } from './boundaryLines';

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
