import { describe, expect, it } from 'vitest';
import type { RailCollection, StationCollection } from '../types';
import { RAIL_DRAW_TOLERANCE, buildTransitData, sampleTransit, subsetTransit, summarizeTransit } from './transitModel';

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

describe('subsetTransit / summarizeTransit', () => {
  // 円：中心 (0, 0)、半径 1000
  const sub = subsetTransit(data, 0, 0, 1000);

  it('円で切った路線と、円の中の駅', () => {
    // 東西線 (-5000..5000, 0) と南北線 (0, -5000..5000) は円を通る。環状線は外
    const names = sub.rail.features.map((f) => f.properties.line).sort();
    expect(names).toEqual(['東西線', '南北線'].sort());
    expect(sub.railPaths).toHaveLength(2);
    expect(sub.railPaths).toContainEqual([[-1000, 0], [1000, 0]]);
    expect(sub.railPaths).toContainEqual([[0, -1000], [0, 1000]]);
    // 中央（2駅）は円の中、東駅 (3000, 0) と 北 (0, 4000) は外
    expect(sub.stations.features.map((f) => f.properties.name)).toEqual(['中央', '中央']);
    expect(sub.stationPoints).toEqual([[0, 0], [10, 0]]);
  });

  it('駅は縁の上なら中', () => {
    const edge = subsetTransit(data, 3000 - 500, 0, 500);
    expect(edge.stations.features.map((f) => f.properties.name)).toEqual(['東駅']);
  });

  it('描画用の形は、間引く前の元の形から作る', () => {
    const wavy: RailCollection = {
      type: 'FeatureCollection',
      features: [rail('波線', [[0, 0], [500, 1], [1000, 0], [1500, 0]])],
    };
    const d = buildTransitData(wavy, { type: 'FeatureCollection', features: [] });
    expect(d.railPaths[0]).toHaveLength(2);
    expect(subsetTransit(d, 500, 0, 5000).railPaths[0]).toEqual([[0, 0], [500, 1], [1000, 0], [1500, 0]]);
  });

  it('全体のデータは変えない', () => {
    expect(data.rail.features).toHaveLength(3);
    expect(data.stations.features).toHaveLength(4);
  });

  it('sample：円の中の地点では全体と同じ値、円の外では値なし', () => {
    expect(sampleTransit(sub, 0, 200)).toEqual(sampleTransit(data, 0, 200));
    expect(value(sampleTransit(sub, 0, 200), '最寄り駅')).toBe('中央駅（東西線・南北線、200m）');
    // 円の外：全体のデータなら東駅が近い
    expect(value(sampleTransit(data, 2900, 0), '最寄り駅')).not.toBeNull();
    expect(sampleTransit(sub, 2900, 0)).toEqual([
      { label: '最寄り駅', value: null },
      { label: '通る路線', value: null },
    ]);
  });

  it('summarize：同じ駅名は1つ、路線は路線名の種類', () => {
    expect(summarizeTransit(sub)).toEqual([
      { label: '駅', value: 1, unit: '駅' },
      { label: '路線', value: 2, unit: '路線' },
    ]);
    const all = subsetTransit(data, 0, 0, 100000);
    expect(summarizeTransit(all)).toEqual([
      { label: '駅', value: 3, unit: '駅' },
      { label: '路線', value: 3, unit: '路線' },
    ]);
  });

  it('同じ路線名が円の中で複数の線に分かれても、路線は1つ', () => {
    // 同じ路線の線が、円の中で2回出入りする
    const f: RailCollection = {
      type: 'FeatureCollection',
      features: [rail('蛇行線', [[-2000, 0], [2000, 0], [2000, 500], [-2000, 500]])],
    };
    const d = buildTransitData(f, { type: 'FeatureCollection', features: [] });
    const s = subsetTransit(d, 0, 0, 1000);
    expect(s.rail.features).toHaveLength(2);
    expect(summarizeTransit(s)).toEqual([
      { label: '駅', value: 0, unit: '駅' },
      { label: '路線', value: 1, unit: '路線' },
    ]);
  });

  it('何もなければ 0', () => {
    expect(summarizeTransit(subsetTransit(data, 50000, 50000, 100))).toEqual([
      { label: '駅', value: 0, unit: '駅' },
      { label: '路線', value: 0, unit: '路線' },
    ]);
  });
});
