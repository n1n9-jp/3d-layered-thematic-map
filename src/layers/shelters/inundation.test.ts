import { describe, expect, it } from 'vitest';
import { DEFAULT_OPTIONS } from '../../config';
import type { FloodScenario } from '../../config';
import type { BoundaryData, FacilityCollection, ShelterCollection, ShelterSummary } from '../../types';
import type { FloodData } from '../flood/model';
import { INSIDE_MIN_POSITION, computeInundation, isInside } from './inundation';
import { buildShelterData, insideCounts, insideText, sampleShelters, sectionShelters, subsetShelters, summarizeShelters, usableSplit } from './model';

/** 100 m セルの格子（x 0〜1000、y 0〜1000）。列 c のセルの値を、river(c)・tide(c) で決める。継続時間は、深さと無関係な値（全セル 7・5）にして、判定が深さだけに従うことを確かめる。 */
function floodGrid(river: (col: number) => number, tide: (col: number) => number): FloodData {
  const width = 10;
  const height = 10;
  const make = (f: (c: number) => number) => Uint8Array.from({ length: width * height }, (_, i) => f(i % width));
  return {
    width,
    height,
    cellSize: 100,
    minX: 0,
    minY: 0,
    maxX: 1000,
    maxY: 1000,
    riverDepth: make(river),
    tideDepth: make(tide),
    riverDuration: make(() => 7),
    tideDuration: make(() => 5),
  };
}

const sp = (name: string, x: number, y: number, o: { flood?: boolean; tide?: boolean }) => ({
  type: 'Feature' as const,
  geometry: { type: 'Point' as const, coordinates: [x, y] as [number, number] },
  properties: { name, address: '', ward: 'A区', flood: !!o.flood, tide: !!o.tide, inland: false, quake: true, fire: false, tsunami: false, landslide: false, note: null },
});
const boundary = {
  type: 'FeatureCollection',
  features: [{ type: 'Feature', properties: { code: '1', name: 'A区' }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1000, 0], [1000, 1000], [0, 1000], [0, 0]]] } }],
} as unknown as BoundaryData;
const summary: ShelterSummary = { updated: '', total: 6, wards: [{ code: '1', name: 'A区', total: 6, flood: 5, tide: 5, published: true, updated: '' }] };
const noFacilities = { type: 'FeatureCollection', features: [] } as unknown as FacilityCollection;

/**
 * 列ごとの（洪水, 高潮）の深さのランク：
 *   列 0: (1, 1) 0.5m 未満             列 1: (2, 1) 洪水だけ 0.5m 以上
 *   列 2: (1, 2) 高潮だけ 0.5m 以上     列 3: (0, 0) 浸水なし
 *   列 4: (6, 0) 20m 以上              列 5: (255, 255) 23区の外
 */
const RIVER = [1, 2, 1, 0, 6, 255];
const TIDE = [1, 1, 2, 0, 0, 255];
const flood = floodGrid((c) => RIVER[c] ?? 0, (c) => TIDE[c] ?? 0);
const at = (col: number) => col * 100 + 50;

const shelters = {
  type: 'FeatureCollection',
  features: [
    sp('列0', at(0), 500, { flood: true }),
    sp('列1', at(1), 500, { flood: true }),
    sp('列2', at(2), 500, { tide: true }),
    sp('列3', at(3), 500, { flood: true, tide: true }),
    sp('列4', at(4), 500, { flood: true }),
    sp('列5', at(5), 500, { flood: true }),
    sp('その他', at(1), 500, {}),
  ],
} as unknown as ShelterCollection;
const data = buildShelterData(shelters, summary, noFacilities, boundary, flood);
const names = (ps: [number, number][]) => ps.map((p) => `列${Math.floor(p[0] / 100)}`);

describe('「中」は深さ 0.5m 以上（深さの段 2 以上）', () => {
  it('深さの段 2（0.5〜3m）が、中になる最初の段', () => {
    expect(INSIDE_MIN_POSITION).toBe(2);
  });
  it('想定ごとに判定する：洪水・高潮・大きいほう', () => {
    const inside = (s: FloodScenario) => names(usableSplit(data, s).in);
    expect(inside('river')).toEqual(['列1', '列4']);
    expect(inside('tide')).toEqual(['列2']);
    expect(inside('max')).toEqual(['列1', '列2', '列4']);
  });
  it('0.5m 未満（段 1）、浸水なし（段 0）、浸水想定の外（255）は外', () => {
    expect(names(usableSplit(data, 'max').out)).toEqual(['列0', '列3', '列5']);
    expect(isInside(flood, 'max', at(5), 500)).toBe(false);
    expect(isInside(flood, 'max', at(0), 500)).toBe(false);
    expect(isInside(flood, 'max', -10, 500)).toBe(false); // 格子の外
  });
  it('継続時間（見るもの）には従わない：継続時間が長くても、深さが 0.5m 未満なら外', () => {
    expect(isInside(flood, 'river', at(0), 500)).toBe(false);
    expect(isInside(flood, 'tide', at(3), 500)).toBe(false);
  });
  it('洪水・高潮で使える避難場所だけを分ける（それ以外の避難場所は入らない）', () => {
    const s = usableSplit(data, 'max');
    expect(s.in.length + s.out.length).toBe(data.points.usable.length);
    expect(s.known).toBe(true);
  });
  it('同じデータと想定には、同じ分け方（参照が等しい）を返す', () => {
    expect(usableSplit(data, 'max')).toBe(usableSplit(data, 'max'));
    expect(usableSplit(data, 'max')).not.toBe(usableSplit(data, 'tide'));
  });
  it('computeInundation：3つの想定の判定が、データの並びと同じ添字で入る', () => {
    const r = computeInundation(data.all, flood);
    expect(Array.from(r.max)).toEqual([0, 1, 1, 0, 1, 0, 1]); // 最後は「それ以外の避難場所」（列1のセル）。判定は求めるが、描画には使わない
    expect(Array.from(r.river)).toEqual([0, 1, 0, 0, 1, 0, 1]);
    expect(Array.from(r.tide)).toEqual([0, 0, 1, 0, 0, 0, 0]);
  });
  it('想定ごとの外・中の数', () => {
    expect(insideCounts(data, 'max')).toEqual({ out: 3, in: 3 });
    expect(insideCounts(data, 'river')).toEqual({ out: 4, in: 2 });
    expect(insideCounts(data, 'tide')).toEqual({ out: 5, in: 1 });
  });
});

describe('浸水想定が読めないとき', () => {
  const none = buildShelterData(shelters, summary, noFacilities, boundary);
  it('中・外は分からない（inside は null）。点はすべて外（塗り）に置き、known は false', () => {
    expect(none.inside).toBeNull();
    const s = usableSplit(none, 'max');
    expect(s.known).toBe(false);
    expect(s.in).toHaveLength(0);
    expect(s.out).toHaveLength(none.points.usable.length);
    expect(insideCounts(none, 'max')).toBeNull();
  });
  it('探針・集計・断面は、中・外のことを言わない', () => {
    expect(sampleShelters(none, at(1), 500).map((v) => v.label)).toEqual(['最寄りの避難場所', '最寄りの病院']);
    expect(summarizeShelters(none).map((v) => v.label)).not.toContain('うち浸水が想定される区域の中');
    const marks = sectionShelters(none, { ax: 0, ay: 500, bx: 1000, by: 500 }).marks;
    expect(marks.every((m) => m.inside === undefined)).toBe(true);
  });
});

describe('探針の値（最寄りの避難場所の位置）', () => {
  it('主な値（最寄りの避難場所の名前・距離）は今のまま。位置は別の値として足す', () => {
    const v = sampleShelters(data, at(1) + 10, 500, { ...DEFAULT_OPTIONS, floodScenario: 'river' });
    expect(v.map((x) => x.label)).toEqual(['最寄りの避難場所', '最寄りの病院', '最寄りの避難場所の位置']);
    expect(v[0].value).toMatch(/^列1（A区・洪水・/);
    expect(v[2].value).toBe(insideText(true, 'river'));
  });
  it('想定が変わると、同じ避難場所の中・外が変わる（列2は高潮だけ 0.5m 以上）', () => {
    const near = (s: FloodScenario) => sampleShelters(data, at(2), 500, { ...DEFAULT_OPTIONS, floodScenario: s }).at(-1)?.value;
    expect(near('river')).toBe(insideText(false, 'river'));
    expect(near('tide')).toBe(insideText(true, 'tide'));
    expect(near('max')).toBe(insideText(true, 'max'));
  });
  it('位置の文は、使える・使えないを言わない', () => {
    for (const inside of [true, false]) expect(insideText(inside, 'max')).not.toMatch(/使え|避難できない|安全/);
    expect(insideText(true, 'max')).toContain('浸水が想定される区域の中');
    expect(insideText(false, 'max')).toContain('浸水が想定される区域の外');
  });
});

describe('円の切り出し・集計・断面', () => {
  it('切り出しても、残った点の中・外は変わらない', () => {
    const sub = subsetShelters(data, at(1), 500, 150); // 列0〜2
    expect(names(usableSplit(sub, 'max').in)).toEqual(['列1', '列2']);
    expect(names(usableSplit(sub, 'max').out)).toEqual(['列0']);
    expect(names(usableSplit(sub, 'river').in)).toEqual(['列1']);
  });
  it('半径内の集計：使える避難場所の数のあとに、うち外・うち中が付く。想定に従う', () => {
    const sub = subsetShelters(data, at(1), 500, 150);
    const rows = (s: FloodScenario) => summarizeShelters(sub, { ...DEFAULT_OPTIONS, floodScenario: s }).slice(0, 3).map((r) => [r.label, r.value]);
    expect(rows('max')).toEqual([
      ['洪水・高潮で使える避難場所', 3],
      ['うち浸水が想定される区域の外', 1],
      ['うち浸水が想定される区域の中', 2],
    ]);
    expect(rows('river')[2]).toEqual(['うち浸水が想定される区域の中', 1]);
  });
  it('断面：洪水・高潮で使える避難場所の印に、中か外かが付く。それ以外には付かない', () => {
    const line = { ax: 0, ay: 500, bx: 1000, by: 500 };
    const marks = sectionShelters(data, line, { ...DEFAULT_OPTIONS, floodScenario: 'max' }).marks;
    const usable = marks.filter((m) => m.category === 'shelter-usable');
    expect(usable.map((m) => [m.name, m.inside])).toEqual([
      ['列0', false],
      ['列1', true],
      ['列2', true],
      ['列3', false],
      ['列4', true],
      ['列5', false],
    ]);
    expect(usable.find((m) => m.inside)?.categoryLabel).toContain('浸水が想定される区域の中');
    expect(usable.find((m) => !m.inside)?.categoryLabel).toContain('浸水が想定される区域の外');
    expect(marks.filter((m) => m.category === 'shelter-other').every((m) => m.inside === undefined)).toBe(true);
  });
});
