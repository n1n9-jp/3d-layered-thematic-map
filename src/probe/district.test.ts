import { describe, expect, it } from 'vitest';
import type { BoundaryData } from '../types';
import { createDistrictLookup } from './district';

const sq = (x0: number, y0: number, x1: number, y1: number): [number, number][] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
  [x0, y0],
];

const boundary: BoundaryData = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: { code: '13101', name: '千代田区' }, geometry: { type: 'Polygon', coordinates: [sq(0, 0, 10, 10)] } },
    {
      type: 'Feature',
      properties: { code: '13102', name: '中央区' },
      geometry: { type: 'MultiPolygon', coordinates: [[sq(20, 0, 30, 10)], [sq(40, 0, 50, 10), sq(44, 4, 46, 6)]] },
    },
  ],
};

describe('createDistrictLookup', () => {
  const lookup = createDistrictLookup(boundary);
  it('Polygon / MultiPolygon の包含で区名を返す', () => {
    expect(lookup(5, 5)).toBe('千代田区');
    expect(lookup(25, 5)).toBe('中央区');
    expect(lookup(41, 1)).toBe('中央区');
  });
  it('穴の中と区の外は null', () => {
    expect(lookup(45, 5)).toBeNull();
    expect(lookup(15, 5)).toBeNull();
    expect(lookup(-100, 5)).toBeNull();
  });
});
