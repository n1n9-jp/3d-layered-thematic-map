import { describe, expect, it } from 'vitest';
import { DEFAULT_OPTIONS } from '../config';
import population, { buildPopulationData } from './population';
import type { PopulationCollection } from '../types';

/** 100 m 四方のメッシュ。(x0, y0) が南西の角。 */
/** elderly は65歳以上人口（既定は人口の 3 割。秘匿なら null）。 */
const mesh = (x0: number, y0: number, pop: number, elderly: number | null = Math.round(pop * 0.3)) => ({
  type: 'Feature' as const,
  geometry: {
    type: 'Polygon' as const,
    coordinates: [
      [
        [x0, y0],
        [x0 + 100, y0],
        [x0 + 100, y0 + 100],
        [x0, y0 + 100],
        [x0, y0],
      ] as [number, number][],
    ],
  },
  properties: { meshCode: `${x0}_${y0}`, population: pop, density: (pop / 10000) * 1e6, elderly, elderlyMerged: false },
});

const fc: PopulationCollection = {
  type: 'FeatureCollection',
  features: [
    mesh(0, 0, 100), // 中心 (50, 50)
    mesh(100, 0, 200), // 中心 (150, 50)
    mesh(200, 0, 300), // 中心 (250, 50)
    mesh(0, 100, 0), // 中心 (50, 150)：人口 0
    mesh(1000, 1000, 999),
  ],
};
const data = buildPopulationData(fc);

describe('population.subset', () => {
  it('セルの中心が円の中にあるメッシュだけ（縁の上は中）', () => {
    // 中心 (100, 50)、半径 50：(50,50) と (150,50) は縁の上で中、(250,50) は外、(50,150) は距離 111 で外
    const sub = population.subset(data, 100, 50, 50);
    expect(sub.cells.map((c) => c.population)).toEqual([100, 200]);
    // 半径を縁より少し小さくすると外になる
    expect(population.subset(data, 100, 50, 49.9).cells).toHaveLength(0);
  });

  it('メッシュの一部だけが円にかかるとき、中心が円の外なら含めない', () => {
    const sub = population.subset(data, 100, 50, 60); // (250,50) の左端 200 は円の外
    expect(sub.cells.map((c) => c.population)).toEqual([100, 200]);
    const wide = population.subset(data, 100, 50, 160); // 中心 (250,50) は距離 150 で中
    expect(wide.cells.map((c) => c.population)).toEqual([100, 200, 300, 0]);
  });

  it('元のデータは変えず、描画用のセルは同じ参照を使い回す', () => {
    const sub = population.subset(data, 100, 50, 50);
    expect(data.cells).toHaveLength(5);
    expect(sub.cells[0]).toBe(data.cells[0]);
  });

  it('sample：円の中のメッシュでは全体と同じ値、円の外では値なし', () => {
    const sub = population.subset(data, 100, 50, 50);
    for (const [x, y] of [
      [50, 50],
      [150, 50],
    ] as const)
      expect(population.sample(sub, x, y)).toEqual(population.sample(data, x, y));
    expect(population.sample(sub, 50, 50)).toEqual([
      { label: '人口', value: 100, unit: '人' },
      { label: '65歳以上', value: 30, unit: '人' },
      { label: '人口密度', value: 10000, unit: '人/km²' },
    ]);
    const none = [
      { label: '人口', value: null },
      { label: '65歳以上', value: null },
    ];
    expect(population.sample(sub, 250, 50)).toEqual(none); // 切り出されていない
    // メッシュ (0,0) の中でも円の外の地点は値なし
    expect(population.sample(sub, 5, 5)).toEqual(none);
  });

  it('切り出しを重ねられる', () => {
    const sub = population.subset(population.subset(data, 100, 50, 160), 50, 50, 10);
    expect(sub.cells.map((c) => c.population)).toEqual([100]);
  });
});

describe('population.summarize', () => {
  it('人口の合計と、合計 ÷ メッシュの面積の合計', () => {
    const sub = population.subset(data, 100, 50, 160); // 100, 200, 300, 0 の4メッシュ = 0.04 km²
    expect(population.summarize(sub, DEFAULT_OPTIONS)).toEqual([
      { label: '人口', value: 600, unit: '人' },
      { label: '65歳以上', value: 180, unit: '人' }, // 30 + 60 + 90 + 0
      { label: '人口密度', value: 15000, unit: '人/km²' },
    ]);
  });

  it('65歳以上が秘匿されたメッシュは、65歳以上の合計に入れず、「65歳以上が不明」に数と総人口を出す', () => {
    const d = buildPopulationData({
      type: 'FeatureCollection',
      features: [mesh(0, 0, 100), mesh(100, 0, 200, null), mesh(200, 0, 50, null)],
    });
    expect(population.summarize(d, DEFAULT_OPTIONS)).toEqual([
      { label: '人口', value: 350, unit: '人' },
      { label: '65歳以上', value: 30, unit: '人' },
      { label: '65歳以上が不明', value: '2 メッシュ（総人口 250 人）' },
      { label: '人口密度', value: 11667, unit: '人/km²' }, // 350 ÷ 0.03 km²
    ]);
  });

  it('メッシュが無ければ、人口は 0、密度は値なし', () => {
    const sub = population.subset(data, -5000, -5000, 10);
    expect(population.summarize(sub, DEFAULT_OPTIONS)).toEqual([
      { label: '人口', value: 0, unit: '人' },
      { label: '65歳以上', value: 0, unit: '人' },
      { label: '人口密度', value: null },
    ]);
  });

  it('メッシュの面積は多角形から求める（斜めのメッシュでも）', () => {
    const skew: PopulationCollection = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { meshCode: 'a', population: 500, density: 0, elderly: 100, elderlyMerged: false },
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [0, 0],
                [1000, 0],
                [1000, 500],
                [0, 500],
                [0, 0],
              ],
            ],
          },
        },
      ],
    };
    const d = buildPopulationData(skew); // 0.5 km²
    expect(population.summarize(d, DEFAULT_OPTIONS).at(-1)).toEqual({ label: '人口密度', value: 1000, unit: '人/km²' });
  });
});
