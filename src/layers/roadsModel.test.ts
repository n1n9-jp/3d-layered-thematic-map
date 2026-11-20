import { describe, expect, it } from 'vitest';
import type { RoadCollection, RoadProps } from '../types';
import { ROAD_DRAW_TOLERANCE, buildRoadData, roadDescription, sampleRoads, subsetRoads, summarizeRoads } from './roadsModel';

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

describe('描画用の線の間引き', () => {
  // 500 m 地点の頂点が、両端を結ぶ直線から 2 m だけずれた道路（許容誤差より小さい）
  const bump = buildRoadData({
    type: 'FeatureCollection',
    features: [road([[0, 0], [500, 2], [1000, 0]], { class: 'national', name: '国道1号' })],
  });

  it('描画用の paths は、許容誤差内の頂点を間引く', () => {
    expect(2).toBeLessThanOrEqual(ROAD_DRAW_TOLERANCE);
    expect(bump.paths.national).toEqual([[[0, 0], [1000, 0]]]);
  });
  it('探針の参照は元の線のままで、距離は元のデータから求める', () => {
    expect(bump.segClass).toHaveLength(2);
    expect(sampleRoads(bump, 500, 12)[0].value).toBe('国道 国道1号（10m）'); // 間引いた線なら 12m になる
  });
  it('許容誤差を超えて曲がる頂点は描画にも残す', () => {
    const bend = buildRoadData({
      type: 'FeatureCollection',
      features: [road([[0, 0], [500, 100], [1000, 0]], { class: 'other' })],
    });
    expect(bend.paths.other[0]).toHaveLength(3);
  });
});

describe('subsetRoads / summarizeRoads', () => {
  const sfc: RoadCollection = {
    type: 'FeatureCollection',
    features: [
      // 東西に 0〜10 km の国道。円の中心 (2000, 0)・半径 2 km なら、0〜4 km の 4.0 km が円の中
      road([[0, 0], [5000, 0], [10000, 0]], { class: 'national', name: '国道1号' }),
      // 円を出て戻る一般道（北へ 3 km 出てから戻る）
      road([[1000, 1000], [1000, 3000], [3000, 3000], [3000, 1000]], { class: 'other' }),
      // 円の外
      road([[0, 8000], [1000, 8000]], { class: 'motorway', name: '首都高' }),
      // 描画用には間引かれる（ほぼ直線）が、切り出した円の中では元の形を使う
      road([[0, -500], [1000, -497], [2000, -500], [3000, -500]], { class: 'prefectural', name: '県道' }),
    ],
  };
  const full = buildRoadData(sfc);
  const sub = subsetRoads(full, 2000, 0, 2000);

  it('円で切った線を、種別と名前を引き継いで返す', () => {
    expect(sub.paths.national).toHaveLength(1);
    expect(sub.paths.national[0]).toEqual([[0, 0], [2000 + 2000, 0]]);
    expect(sub.paths.motorway).toHaveLength(0);
    expect(sub.paths.other).toHaveLength(2); // 出て戻る：2本。円の北端 (2000, 2000) より外の部分は含まない
    expect(sub.segName.filter((n) => n === '国道1号')).toHaveLength(1);
    expect(sub.segClass.filter((c) => c === 'national')).toHaveLength(1);
    expect(sub.segName).toContain('県道');
  });

  it('全体のデータは変えない', () => {
    expect(full.paths.motorway).toHaveLength(1);
    expect(full.lines).toHaveLength(4);
  });

  it('描画用の形は、間引く前の元の形から作る', () => {
    // 間引くと (1000, -497) は落ちる（直線から 3 m 以内）。円の中では残る。
    expect(full.paths.prefectural[0]).toHaveLength(2);
    expect(sub.paths.prefectural[0]).toHaveLength(4);
    expect(sub.paths.prefectural[0].slice(1, 3)).toEqual([[1000, -497], [2000, -500]]);
  });

  it('sample：円の中の地点では全体と同じ値、円の外では値なし', () => {
    expect(sampleRoads(sub, 2000, 40)).toEqual(sampleRoads(full, 2000, 40));
    expect(sampleRoads(sub, 2000, 40)[0].value).toBe('国道 国道1号（40m）');
    // 円の外の地点：全体のデータなら道路が近くにあっても値なし
    expect(sampleRoads(full, 4100, 40)[0].value).not.toBeNull();
    expect(sampleRoads(sub, 4100, 40)).toEqual([{ label: '最寄りの道路', value: null }]);
  });

  it('summarize：延長と種別ごとの内訳（km、小数1桁）', () => {
    // 円の中の延長：国道 4000 m、県道 約 2936 m（y=-500 の弦のうち x=3000 まで）、一般道 約 732 + 732 m（x=1000 と x=3000 の弦）
    expect(summarizeRoads(sub)).toEqual([
      { label: '道路の延長', value: 8.4, unit: 'km' },
      { label: '内訳', value: '高速 0.0、国道 4.0、都道府県道 2.9、一般道 1.5', unit: 'km' },
    ]);
  });

  it('summarize：内訳の値（手計算）', () => {
    const d = buildRoadData({
      type: 'FeatureCollection',
      features: [
        road([[0, 0], [3200, 0]], { class: 'motorway' }),
        road([[0, 100], [5100, 100]], { class: 'national' }),
        road([[0, 200], [14000, 200]], { class: 'prefectural' }),
        road([[0, 300], [6000, 300], [6000, 6500]], { class: 'other' }),
      ],
    });
    expect(summarizeRoads(d)).toEqual([
      { label: '道路の延長', value: 34.5, unit: 'km' },
      { label: '内訳', value: '高速 3.2、国道 5.1、都道府県道 14.0、一般道 12.2', unit: 'km' },
    ]);
  });

  it('道路が無ければ値なし', () => {
    const none = subsetRoads(full, 50000, 50000, 100);
    expect(summarizeRoads(none)).toEqual([
      { label: '道路の延長', value: null },
      { label: '内訳', value: null },
    ]);
  });

  it('半径を 2 倍にすると、延長はおおむね 4 倍', () => {
    // 格子状の道路網（500 m 間隔）。円の中の延長は面積に比例する。
    const feats: RoadCollection['features'] = [];
    for (let k = -40; k <= 40; k++) {
      feats.push(road([[-20000, k * 500], [20000, k * 500]], { class: 'other' }));
      feats.push(road([[k * 500, -20000], [k * 500, 20000]], { class: 'other' }));
    }
    const grid = buildRoadData({ type: 'FeatureCollection', features: feats });
    const km = (r: number) => summarizeRoads(subsetRoads(grid, 250, 250, r))[0].value as number;
    expect(km(4000) / km(2000)).toBeGreaterThan(3.8);
    expect(km(4000) / km(2000)).toBeLessThan(4.2);
  });

  it('切り出しを重ねられる', () => {
    const again = subsetRoads(sub, 2000, 0, 1000);
    expect(again.paths.national[0]).toEqual([[1000, 0], [3000, 0]]);
  });
});
