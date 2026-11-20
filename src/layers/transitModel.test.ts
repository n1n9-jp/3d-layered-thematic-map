import { describe, expect, it } from 'vitest';
import type { RailCollection, StationCollection } from '../types';
import { RAIL_DRAW_TOLERANCE, buildTransitData, sampleTransit } from './transitModel';

const rail = (line: string, coordinates: [number, number][]) => ({
  type: 'Feature' as const,
  geometry: { type: 'LineString' as const, coordinates },
  properties: { operator: 'A社', line },
});
const station = (name: string, line: string, xy: [number, number]) => ({
  type: 'Feature' as const,
  geometry: { type: 'Point' as const, coordinates: xy },
  properties: { name, operator: 'A社', line },
});

const railFc: RailCollection = {
  type: 'FeatureCollection',
  features: [
    rail('東西線', [[-5000, 0], [5000, 0]]),
    rail('南北線', [[0, -5000], [0, 5000]]),
    rail('環状線', [[3000, 3000], [4000, 3000], [4000, 4000]]),
  ],
};
const stationFc: StationCollection = {
  type: 'FeatureCollection',
  features: [
    station('中央', '東西線', [0, 0]),
    station('中央', '南北線', [10, 0]), // 乗換駅：同名で近接する駅は路線をまとめる
    station('東駅', '東西線', [3000, 0]), // 駅名がすでに「駅」で終わる
    station('北', '南北線', [0, 4000]),
  ],
};
const data = buildTransitData(railFc, stationFc);
const value = (v: ReturnType<typeof sampleTransit>, label: string) => v.find((e) => e.label === label)?.value;

describe('sampleTransit', () => {
  it('最寄り駅：同名の駅は路線をまとめる', () => {
    const v = sampleTransit(data, 0, 420);
    expect(value(v, '最寄り駅')).toBe('中央駅（東西線・南北線、420m）');
  });
  it('駅名が「駅」で終わっていればそのまま', () => {
    expect(value(sampleTransit(data, 3000, 250), '最寄り駅')).toBe('東駅（東西線、250m）');
  });
  it('1km を超える駅は null、ちょうど1kmは含む', () => {
    expect(value(sampleTransit(data, 3000, 1500), '最寄り駅')).toBeNull();
    expect(value(sampleTransit(data, 3000, 1000), '最寄り駅')).toBe('東駅（東西線、1.0km）');
  });
  it('通る路線：100m 以内の路線を近い順に', () => {
    expect(value(sampleTransit(data, 30, 40), '通る路線')).toBe('南北線、東西線');
    expect(value(sampleTransit(data, 80, 10), '通る路線')).toBe('東西線、南北線');
  });
  it('路線から 100m を超えると null', () => {
    expect(value(sampleTransit(data, 2000, 2000), '通る路線')).toBeNull();
    expect(value(sampleTransit(data, 500, 101), '通る路線')).toBeNull();
    expect(value(sampleTransit(data, 500, 99), '通る路線')).toBe('東西線');
  });
  it('駅も路線もないデータ', () => {
    const empty = buildTransitData(
      { type: 'FeatureCollection', features: [] },
      { type: 'FeatureCollection', features: [] },
    );
    expect(sampleTransit(empty, 0, 0)).toEqual([
      { label: '最寄り駅', value: null },
      { label: '通る路線', value: null },
    ]);
  });
});

describe('描画用の線の間引き', () => {
  const bump = buildTransitData(
    { type: 'FeatureCollection', features: [rail('緩曲線', [[0, 0], [500, 2], [1000, 0]])] },
    { type: 'FeatureCollection', features: [] },
  );
  it('描画用の railPaths は、許容誤差内の頂点を間引く', () => {
    expect(2).toBeLessThanOrEqual(RAIL_DRAW_TOLERANCE);
    expect(bump.railPaths).toEqual([[[0, 0], [1000, 0]]]);
  });
  it('探針の参照（lines）は元の線のまま', () => {
    expect(bump.lines).toHaveLength(1);
    expect(bump.lines[0].index.nearest(500, 12, 100)?.distance).toBeCloseTo(10, 6); // 間引いた線なら 12
  });
});
