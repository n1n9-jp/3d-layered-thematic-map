import { describe, expect, it } from 'vitest';
import type { FacilityCollection, FacilityProps } from '../types';
import { buildFacilityData, sampleFacilities, subsetFacilities, summarizeFacilities } from './facilitiesModel';

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

describe('subsetFacilities / summarizeFacilities', () => {
  // 円：中心 (0, 0)、半径 300。第一小学校 (180,0)、第二中学校 (-100,100)、中央病院 (0,-300)（縁の上）が中
  const sub = subsetFacilities(data, 0, 0, 300);

  it('円の中の点だけ（縁の上は中）。種別・名前を引き継ぐ', () => {
    expect(sub.name).toEqual(['第一小学校', '第二中学校', '中央病院']);
    expect(sub.kind).toEqual(['school', 'school', 'hospital']);
    expect(sub.points.school).toEqual([[180, 0], [-100, 100]]);
    expect(sub.points.hospital).toEqual([[0, -300]]);
    expect(sub.all).toHaveLength(3);
  });

  it('縁の外は含まない', () => {
    expect(subsetFacilities(data, 0, 0, 299.9).name).toEqual(['第一小学校', '第二中学校']);
  });

  it('全体のデータは変えない', () => {
    expect(data.kind).toHaveLength(5);
    expect(data.points.school).toHaveLength(3);
  });

  it('sample：円の中の地点では全体と同じ値、円の外では値なし', () => {
    // 施設から遠い（500 m 以内の点がすべて円の中）地点では、全体と同じ
    expect(sampleFacilities(sub, 0, 0)).toEqual(sampleFacilities(data, 0, 0));
    expect(sampleFacilities(sub, 0, 0)[0].value).toBe('学校 2、病院 1');
    expect(sampleFacilities(sub, 600, 0)).toEqual([
      { label: '500m以内', value: null },
      { label: '最寄りの施設', value: null },
    ]);
    expect(sampleFacilities(data, 600, 0)[0].value).not.toBeNull();
  });

  it('summarize：学校と病院の数', () => {
    expect(summarizeFacilities(sub)).toEqual([
      { label: '学校', value: 2, unit: '校' },
      { label: '病院', value: 1, unit: '院' },
    ]);
    expect(summarizeFacilities(subsetFacilities(data, 0, 0, 100000))).toEqual([
      { label: '学校', value: 3, unit: '校' },
      { label: '病院', value: 2, unit: '院' },
    ]);
    expect(summarizeFacilities(subsetFacilities(data, 90000, 0, 10))).toEqual([
      { label: '学校', value: 0, unit: '校' },
      { label: '病院', value: 0, unit: '院' },
    ]);
  });
});
