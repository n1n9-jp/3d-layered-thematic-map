import { describe, expect, it } from 'vitest';
import type { FacilityCollection, FacilityProps } from '../types';
import { buildFacilityData, sampleFacilities } from './facilitiesModel';

const fac = (xy: [number, number], props: Partial<FacilityProps>) => ({
  type: 'Feature' as const,
  geometry: { type: 'Point' as const, coordinates: xy },
  properties: { kind: 'school' as const, name: '', subtype: '', ...props },
});

const fc: FacilityCollection = {
  type: 'FeatureCollection',
  features: [
    fac([180, 0], { name: '第一小学校' }),
    fac([-100, 100], { name: '第二中学校' }),
    fac([0, -300], { kind: 'hospital', name: '中央病院' }),
    fac([600, 0], { name: '遠い小学校' }),
    fac([5000, 0], { kind: 'hospital', name: '' }),
    fac([1, 1], { kind: 'park' as never, name: '公園' }), // 対象外
  ],
};
const data = buildFacilityData(fc);

describe('buildFacilityData', () => {
  it('学校と病院だけを種別ごとに集める', () => {
    expect(data.points.school).toHaveLength(3);
    expect(data.points.hospital).toHaveLength(2);
    expect(data.kind).toHaveLength(5);
  });
});

describe('sampleFacilities', () => {
  it('500m 以内の件数と最寄りの施設', () => {
    expect(sampleFacilities(data, 0, 0)).toEqual([
      { label: '500m以内', value: '学校 2、病院 1' },
      { label: '最寄りの施設', value: '第二中学校（141m）' },
    ]);
  });
  it('500m ちょうどは含む', () => {
    expect(sampleFacilities(data, 1100, 0)[0].value).toBe('学校 1、病院 0'); // 600 まで 500m
  });
  it('件数が 0 でも最寄りを示す。名前がなければ種別名', () => {
    expect(sampleFacilities(data, 5000, 2000)).toEqual([
      { label: '500m以内', value: '学校 0、病院 0' },
      { label: '最寄りの施設', value: null }, // 2km 先は上限（1km）の外
    ]);
  });
  it('最寄りは 1km まで。ちょうど 1km は含み、それより遠いと値なし', () => {
    expect(sampleFacilities(data, 5000, 1000)[1].value).toBe('病院（1.0km）');
    expect(sampleFacilities(data, 5000, 1001)[1].value).toBeNull();
    expect(sampleFacilities(data, 0, -2000)[1].value).toBeNull();
  });
  it('施設がなければ最寄りは null', () => {
    const empty = buildFacilityData({ type: 'FeatureCollection', features: [] });
    expect(sampleFacilities(empty, 0, 0)).toEqual([
      { label: '500m以内', value: '学校 0、病院 0' },
      { label: '最寄りの施設', value: null },
    ]);
  });
});
