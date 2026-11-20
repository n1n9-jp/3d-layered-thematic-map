import { describe, expect, it } from 'vitest';
import type { RoadCollection, RoadProps } from '../types';
import { buildRoadData, roadDescription, sampleRoads } from './roadsModel';

const road = (coordinates: [number, number][], props: Partial<RoadProps>) => ({
  type: 'Feature' as const,
  geometry: { type: 'LineString' as const, coordinates },
  properties: { class: 'other' as const, name: null, ...props },
});

const fc: RoadCollection = {
  type: 'FeatureCollection',
  features: [
    road([[0, 0], [1000, 0], [1000, 1000]], { class: 'national', name: '国道1号' }),
    road([[0, 500], [1000, 500]], { class: 'other' }),
    road([[0, 5000], [1000, 5000]], { class: 'motorway', name: '首都高' }),
    road([[0, 0]], { class: 'other' }), // 頂点が1つ：無視
  ],
};
const data = buildRoadData(fc);

describe('buildRoadData', () => {
  it('種別ごとに線を振り分ける（頂点が足りない線は除く）', () => {
    expect(data.paths.national).toHaveLength(1);
    expect(data.paths.other).toHaveLength(1);
    expect(data.paths.motorway).toHaveLength(1);
    expect(data.paths.prefectural).toHaveLength(0);
  });
  it('未知の種別は other として扱う', () => {
    const d = buildRoadData({ type: 'FeatureCollection', features: [road([[0, 0], [1, 1]], { class: 'x' as never })] });
    expect(d.paths.other).toHaveLength(1);
  });
});

describe('sampleRoads', () => {
  it('名前つきの道路：種別・名前・距離', () => {
    expect(sampleRoads(data, 500, 35)).toEqual([{ label: '最寄りの道路', value: '国道 国道1号（35m）' }]);
  });
  it('名前のない道路は種別だけ', () => {
    expect(sampleRoads(data, 500, 520)).toEqual([{ label: '最寄りの道路', value: '一般道（20m）' }]);
  });
  it('折れ曲がりの後の線分も拾う', () => {
    expect(sampleRoads(data, 1060, 800)[0].value).toBe('国道 国道1号（60m）');
  });
  it('100m を超えても 300m 以内なら拾う', () => {
    expect(sampleRoads(data, 500, 700)).toEqual([{ label: '最寄りの道路', value: '一般道（200m）' }]);
  });
  it('300m を超えると null', () => {
    expect(sampleRoads(data, 500, 799)[0].value).toBe('一般道（299m）'); // 道路 y=500 まで 299m
    expect(sampleRoads(data, 500, 801)).toEqual([{ label: '最寄りの道路', value: null }]);
  });
  it('道路がないデータ', () => {
    const empty = buildRoadData({ type: 'FeatureCollection', features: [] });
    expect(sampleRoads(empty, 0, 0)[0].value).toBeNull();
  });
  it('roadDescription', () => {
    expect(roadDescription('prefectural', '環七通り')).toBe('都道府県道 環七通り');
    expect(roadDescription('motorway', null)).toBe('高速道路');
  });
});
