import { describe, expect, it } from 'vitest';
import type { FloodData } from '../layers/flood/model';
import type { PopulationData } from '../layers/population';
type Cell = PopulationData['cells'][number];
import type { BoundaryData } from '../types';
import { DEEP_SHARE_THRESHOLD, approxPeople, classifyWard, computeWardExposure, shareLabel } from './wardExposure';

/** 4 x 2 のセル（100 m）の浸水想定。西の区 W（x 0〜200）と東の区 E（x 200〜400）。値は 洪水のランク（高潮は 0）。 */
const flood = (river: number[]): FloodData =>
  ({
    width: 4,
    height: 1,
    cellSize: 100,
    minX: 0,
    minY: 0,
    maxX: 400,
    maxY: 100,
    riverDepth: Uint8Array.from(river),
    tideDepth: Uint8Array.from([0, 0, 0, 0]),
    riverDuration: new Uint8Array(4),
    tideDuration: new Uint8Array(4),
  }) as unknown as FloodData;

const sq = (x0: number, x1: number): [number, number][] => [[x0, 0], [x1, 0], [x1, 100], [x0, 100], [x0, 0]];
const boundary = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: { code: '1', name: 'W区' }, geometry: { type: 'Polygon', coordinates: [sq(0, 200)] } },
    { type: 'Feature', properties: { code: '2', name: 'E区' }, geometry: { type: 'Polygon', coordinates: [sq(200, 400)] } },
  ],
} as unknown as BoundaryData;
const cell = (x: number, population: number) => ({ center: [x, 50] as [number, number], population }) as unknown as Cell;

describe('computeWardExposure', () => {
  it('メッシュの中心を含む区に、メッシュの人口を丸ごと数える。浸水が想定される区域と、3m 以上（ランク 3 以上）の区域の割合', () => {
    // W: 浸水なし(0)・0.5m未満(1)、E: 3〜5m(3)・20m以上(6)
    const r = computeWardExposure({ cells: [cell(50, 100), cell(150, 100), cell(250, 300), cell(350, 100)] }, flood([0, 1, 3, 6]), boundary);
    const w = r.get('W区')!;
    expect(w).toMatchObject({ people: 200, flooded: 100, severe: 0, floodedShare: 0.5, severeShare: 0 });
    const e = r.get('E区')!;
    expect(e).toMatchObject({ people: 400, flooded: 400, severe: 400, floodedShare: 1, severeShare: 1 });
  });
  it('0.5〜3m（ランク 2）は、3m 以上に入れない', () => {
    const r = computeWardExposure({ cells: [cell(50, 100)] }, flood([2, 0, 0, 0]), boundary);
    expect(r.get('W区')).toMatchObject({ flooded: 100, severe: 0 });
  });
  it('格子の外のメッシュは数えない。人口のない区の割合は 0', () => {
    const r = computeWardExposure({ cells: [cell(-50, 999), cell(450, 999)] }, flood([6, 6, 6, 6]), boundary);
    expect(r.get('W区')).toMatchObject({ people: 0, severeShare: 0 });
    expect(r.get('E区')).toMatchObject({ people: 0, floodedShare: 0 });
  });
  it('洪水と高潮の大きいほうで数える（高潮だけが深いセルも 3m 以上）', () => {
    const f = flood([0, 0, 0, 0]);
    f.tideDepth = Uint8Array.from([4, 0, 0, 0]);
    const r = computeWardExposure({ cells: [cell(50, 100)] }, f, boundary);
    expect(r.get('W区')).toMatchObject({ severe: 100 });
  });
});

describe('classifyWard：洪水・高潮用が 0 件の区を、深さ 3m 以上の区域に住む人の割合で分ける', () => {
  const pub = { published: true, usable: 0 };
  it('基準は 10%（境目の値は「深い」に入る）', () => {
    expect(DEEP_SHARE_THRESHOLD).toBe(0.1);
    expect(classifyWard(pub, { severeShare: 0.1 })).toBe('deep-none');
    expect(classifyWard(pub, { severeShare: 0.0999 })).toBe('shallow-none');
    expect(classifyWard(pub, { severeShare: 0.603 })).toBe('deep-none');
    expect(classifyWard(pub, { severeShare: 0.007 })).toBe('shallow-none');
  });
  it('未公開は、同じ基準（10%）で、浸水が深い unpublished-deep と、小さい unpublished に分ける。浸水の想定がなければ unpublished。洪水・高潮用があれば null。公開していて浸水の想定がなければ unrated', () => {
    const unpub = { published: false, usable: 0 };
    expect(classifyWard(unpub, { severeShare: 0.9 })).toBe('unpublished-deep');
    expect(classifyWard(unpub, { severeShare: 0.1 })).toBe('unpublished-deep');
    expect(classifyWard(unpub, { severeShare: 0.0999 })).toBe('unpublished');
    expect(classifyWard(unpub, { severeShare: 0 })).toBe('unpublished');
    expect(classifyWard(unpub, undefined)).toBe('unpublished');
    expect(classifyWard({ published: true, usable: 3 }, { severeShare: 0.9 })).toBeNull();
    expect(classifyWard(pub, undefined)).toBe('unrated');
  });
  it('基準は引数で変えられる', () => {
    expect(classifyWard(pub, { severeShare: 0.3 }, 0.5)).toBe('shallow-none');
    expect(classifyWard({ published: false, usable: 0 }, { severeShare: 0.3 }, 0.5)).toBe('unpublished');
  });
});

describe('shareLabel', () => {
  it('10% 以上は整数、それ未満は小数1桁', () => {
    expect(shareLabel(0.603)).toBe('60%');
    expect(shareLabel(0.754)).toBe('75%');
    expect(shareLabel(0.007)).toBe('0.7%');
    expect(shareLabel(0.0999)).toBe('10%');
    expect(shareLabel(0.1)).toBe('10%');
  });
  it('0 は 0%、ごく小さい値は「0.1% 未満」、不正は —', () => {
    expect(shareLabel(0)).toBe('0%');
    expect(shareLabel(0.0001)).toBe('0.1% 未満');
    expect(shareLabel(NaN)).toBe('—');
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
