import { describe, expect, it } from 'vitest';
import { buildPopulationData } from '../layers/population';
import type { PopulationCollection, ElevationData } from '../types';
import type { FloodData } from '../layers/flood/model';
import { OUTSIDE } from '../layers/flood/classes';
import { approxPeople, computeExposure, wholeExposure } from './exposure';

/** 4×1 セル（50 m）：西から 浸水なし、洪水 0.5〜3m、洪水 3〜5m（高潮は 10〜20m）、23区の外。 */
const flood: FloodData = {
  width: 4,
  height: 1,
  cellSize: 50,
  minX: 0,
  minY: 0,
  maxX: 200,
  maxY: 50,
  riverDepth: Uint8Array.from([0, 2, 3, OUTSIDE]),
  tideDepth: Uint8Array.from([0, 0, 5, OUTSIDE]),
  riverDuration: new Uint8Array(4),
  tideDuration: new Uint8Array(4),
};
const elevation: ElevationData = {
  width: 4,
  height: 1,
  cellSize: 50,
  minX: 0,
  minY: 0,
  maxX: 200,
  maxY: 50,
  min: -1,
  max: 5,
  values: Float32Array.from([3, -0.5, NaN, 2]),
};
/** メッシュ（50 m 四方）を、セルの位置に1つずつ。 */
function mesh(i: number, population: number, elderly: number | null) {
  const x = i * 50;
  return {
    type: 'Feature' as const,
    properties: { meshCode: `m${i}`, population, density: population / 0.0025, elderly, elderlyMerged: false },
    geometry: { type: 'Polygon' as const, coordinates: [[[x, 0], [x + 50, 0], [x + 50, 50], [x, 50], [x, 0]]] as [number, number][][] },
  };
}
const pop = buildPopulationData({
  type: 'FeatureCollection',
  features: [mesh(0, 100, 10), mesh(1, 200, 50), mesh(2, 400, null), mesh(3, 800, 80)],
} as unknown as PopulationCollection);

describe('computeExposure：メッシュの中心を含むセルのランクで、メッシュの人口を丸ごと数える', () => {
  it('大きいほう：区分ごとの人口と65歳以上人口。65歳以上が不明のメッシュは、65歳以上の合計に入れない', () => {
    const e = computeExposure(pop, flood, 'max', elevation);
    const by = Object.fromEntries(e.classes.map((c) => [c.position, [c.people, c.elderly]]));
    expect(by[0]).toEqual([100, 10]);
    expect(by[2]).toEqual([200, 50]);
    expect(by[5]).toEqual([400, 0]); // 高潮の 10〜20m が大きいほう。65歳以上は不明（0 とみなさず、合計に入れない）
    expect(e.total).toEqual({ people: 700, elderly: 60 });
    expect(e.flooded).toEqual({ people: 600, elderly: 50 });
    expect(e.severe).toEqual({ people: 400, elderly: 0 }); // 3m 以上
    expect(e.elderlyUnknown).toEqual({ meshes: 1, people: 400 });
    expect(e.outside).toEqual({ meshes: 1, people: 800 });
  });
  it('想定に従う：洪水だけ・高潮だけ', () => {
    const river = computeExposure(pop, flood, 'river');
    expect(river.classes.find((c) => c.position === 3)?.people).toBe(400);
    expect(river.severe.people).toBe(400);
    const tide = computeExposure(pop, flood, 'tide');
    expect(tide.classes.find((c) => c.position === 2)?.people ?? 0).toBe(0);
    expect(tide.classes.find((c) => c.position === 5)?.people).toBe(400);
    expect(tide.flooded.people).toBe(400);
  });
  it('区分の人口の合計は、数えたメッシュの人口の合計に一致する', () => {
    for (const sc of ['max', 'river', 'tide'] as const) {
      const e = computeExposure(pop, flood, sc);
      expect(e.classes.reduce((a, c) => a + c.people, 0)).toBe(e.total.people);
      expect(e.classes.reduce((a, c) => a + c.elderly, 0)).toBe(e.total.elderly);
      expect(e.total.people + e.outside.people).toBe(1500);
    }
  });
  it('標高 0m 未満の土地の人口：標高のセル（中心を含むもの）が 0m 未満のメッシュ。標高なし（水面）は数えない', () => {
    const e = computeExposure(pop, flood, 'max', elevation);
    expect(e.belowSea).toEqual({ people: 200, elderly: 50 });
    expect(computeExposure(pop, flood, 'max').belowSea).toBeNull();
  });
  it('円で切り出した人口（subset）にも使える', () => {
    const sub = { cells: pop.cells.slice(0, 2) };
    expect(computeExposure(sub, flood, 'max').total.people).toBe(300);
  });
  it('wholeExposure は、同じ組なら同じ結果を返す', () => {
    expect(wholeExposure(pop, flood, 'max', elevation)).toBe(wholeExposure(pop, flood, 'max', elevation));
    expect(wholeExposure(pop, flood, 'tide', elevation)).not.toBe(wholeExposure(pop, flood, 'max', elevation));
  });
});

describe('approxPeople（大きく見せる数字の概数）', () => {
  it('100 万人以上・10 万人以上は、万人単位の整数', () => {
    expect(approxPeople(2415153)).toBe('約242万人');
    expect(approxPeople(559789)).toBe('約56万人');
    expect(approxPeople(962288)).toBe('約96万人');
    expect(approxPeople(5553930)).toBe('約555万人');
  });
  it('10 万人未満は小数1桁の万人、1 万人未満は百の位、1,000 人未満はそのまま', () => {
    expect(approxPeople(94500)).toBe('約9.5万人');
    expect(approxPeople(12000)).toBe('約1.2万人');
    expect(approxPeople(4083)).toBe('約4,100人');
    expect(approxPeople(122)).toBe('122人');
    expect(approxPeople(0)).toBe('0人');
  });
  it('不正な値は —', () => {
    expect(approxPeople(NaN)).toBe('—');
    expect(approxPeople(-1)).toBe('—');
  });
});
