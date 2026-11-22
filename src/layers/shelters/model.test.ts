import { describe, expect, it } from 'vitest';
import type { WardExposure } from '../../aggregate/wardExposure';
import type { BoundaryData, FacilityCollection, ShelterCollection, ShelterSummary } from '../../types';
import {
  buildShelterData,
  mergeSpans,
  sampleShelters,
  sectionGaps,
  sectionShelters,
  shelterOverview,
  subsetShelters,
  summarizeShelters,
  usageLabel,
  wardNote,
  wardsTouching,
} from './model';

/** 4つの区（1 km 四方）：西から A（公開・洪水用あり）、B（未公開）、C（公開・洪水・高潮用が 0 件）、D（公開・洪水用あり）。 */
const sq = (x0: number): [number, number][] => [[x0, 0], [x0 + 1000, 0], [x0 + 1000, 1000], [x0, 1000], [x0, 0]];
const boundary = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: { code: '1', name: 'A区' }, geometry: { type: 'Polygon', coordinates: [sq(0)] } },
    { type: 'Feature', properties: { code: '2', name: 'B区' }, geometry: { type: 'Polygon', coordinates: [sq(1000)] } },
    { type: 'Feature', properties: { code: '3', name: 'C区' }, geometry: { type: 'Polygon', coordinates: [sq(2000)] } },
    { type: 'Feature', properties: { code: '4', name: 'D区' }, geometry: { type: 'Polygon', coordinates: [sq(3000)] } },
  ],
} as unknown as BoundaryData;

const sp = (name: string, ward: string, x: number, y: number, o: { flood?: boolean; tide?: boolean }) => ({
  type: 'Feature' as const,
  geometry: { type: 'Point' as const, coordinates: [x, y] as [number, number] },
  properties: { name, address: '', ward, flood: !!o.flood, tide: !!o.tide, inland: false, quake: true, fire: false, tsunami: false, landslide: false, note: null },
});
const shelters = {
  type: 'FeatureCollection',
  features: [
    sp('A小', 'A区', 200, 500, { flood: true, tide: true }),
    sp('A中', 'A区', 800, 500, { flood: true }),
    sp('A高', 'A区', 600, 900, {}),
    sp('C小', 'C区', 2500, 500, {}),
    sp('D小', 'D区', 3500, 500, { tide: true }),
  ],
} as unknown as ShelterCollection;
const facilities = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: { kind: 'hospital', name: 'B病院', subtype: '病院' }, geometry: { type: 'Point', coordinates: [1500, 500] } },
    { type: 'Feature', properties: { kind: 'school', name: 'ただの学校', subtype: '' }, geometry: { type: 'Point', coordinates: [1600, 500] } },
  ],
} as unknown as FacilityCollection;
const summary: ShelterSummary = {
  updated: '2026-10-19',
  total: 5,
  wards: [
    { code: '1', name: 'A区', total: 3, flood: 2, tide: 1, published: true, updated: '2025-01-01' },
    { code: '2', name: 'B区', total: 0, flood: 0, tide: 0, published: false, updated: '2025-01-01' },
    { code: '3', name: 'C区', total: 1, flood: 0, tide: 0, published: true, updated: '2025-01-01' },
    { code: '4', name: 'D区', total: 1, flood: 0, tide: 1, published: true, updated: '2025-01-01' },
  ],
};
// 区ごとの浸水の想定（深さ 3m 以上の区域に住む人の割合）：C区は浅い（2%）。D区は洪水・高潮用があるので、分類に使わない
const wardExposure = new Map<string, WardExposure>([
  ['A区', { name: 'A区', people: 1000, flooded: 500, severe: 0, floodedShare: 0.5, severeShare: 0 }],
  ['C区', { name: 'C区', people: 1000, flooded: 300, severe: 20, floodedShare: 0.3, severeShare: 0.02 }],
]);
const data = buildShelterData(shelters, summary, facilities, boundary, wardExposure);

describe('buildShelterData', () => {
  it('洪水か高潮で使える避難場所、それ以外の避難場所、病院に分ける。学校は入れない', () => {
    expect(data.points.usable).toHaveLength(3);
    expect(data.points.other).toHaveLength(2);
    expect(data.points.hospital).toHaveLength(1);
    expect(data.all).toHaveLength(6);
  });
  it('区ごとの公開の有無と、洪水・高潮用の数（データから数えた値）', () => {
    expect(data.wards.map((w) => [w.name, w.published, w.usable, w.total])).toEqual([
      ['A区', true, 2, 3],
      ['B区', false, 0, 0],
      ['C区', true, 0, 1],
      ['D区', true, 1, 1],
    ]);
  });
  it('データ未公開の区にだけ、網掛けの線がある（区の中に収まる 45 度の線）', () => {
    expect(data.gapPolygons).toHaveLength(1);
    expect(data.hatch.length).toBeGreaterThan(2);
    for (const [a, b] of data.hatch) {
      for (const [x, y] of [a, b]) {
        expect(x).toBeGreaterThanOrEqual(999);
        expect(x).toBeLessThanOrEqual(2001);
        expect(y).toBeGreaterThanOrEqual(-1);
        expect(y).toBeLessThanOrEqual(1001);
      }
      expect(Math.abs(b[0] - a[0])).toBeCloseTo(Math.abs(b[1] - a[1]), -1);
    }
  });
  it('概況：使える数、未公開の区、洪水・高潮用が 0 件の区', () => {
    const o = shelterOverview(data);
    expect(o.usable).toBe(3);
    expect(o.unpublished).toEqual(['B区']);
    expect(o.unpublishedShallow.map((w) => w.name)).toEqual(['B区']); // 浸水の想定を渡していない区は、浸水が小さい側に入れる
    expect(o.unpublishedDeep).toEqual([]);
    expect(o.deepWithoutShelter).toEqual([]);
    expect(o.zeroUsable).toEqual(['C区']);
    expect(o.deepNone).toEqual([]);
    expect(o.shallowNone).toEqual([{ name: 'C区', total: 1, severeShare: 0.02, floodedShare: 0.3 }]);
  });
  it('区の種類：未公開、浸水が深いのに指定なし、浸水が小さく指定なし、指定あり（null）、浸水の想定なし（unrated）', () => {
    expect(data.wards.map((w) => [w.name, w.gap])).toEqual([
      ['A区', null],
      ['B区', 'unpublished'],
      ['C区', 'shallow-none'],
      ['D区', null],
    ]);
    const deep = buildShelterData(shelters, summary, facilities, boundary, new Map([['C区', { ...wardExposure.get('C区')!, severeShare: 0.6 }]]));
    expect(deep.wards.find((w) => w.name === 'C区')?.gap).toBe('deep-none');
    expect(shelterOverview(deep).deepNone.map((w) => w.name)).toEqual(['C区']);
    expect(deep.deep.polygons).toHaveLength(1);
    expect(deep.deep.hatch.length).toBeGreaterThan(2);
    expect(deep.deep.outline.length).toBe(1);
    expect(deep.deep.labels).toEqual([{ position: [2500, 500], text: 'C区\n指定なし' }]);
    expect(deep.shallow).toEqual([]);
    expect(deep.unpubDeep).toEqual({ polygons: [], outline: [], labels: [] });
    // 浸水の想定を渡さなければ unrated（深い・小さいとは言わない）
    expect(buildShelterData(shelters, summary, facilities, boundary).wards.find((w) => w.name === 'C区')?.gap).toBe('unrated');
  });
  it('データ未公開の区も、同じ基準で、浸水が深い区と小さい区に分かれる。深い区は、灰の網掛けに琥珀の塗り・縁・ラベルが重なる', () => {
    const ex = (share: number): WardExposure => ({ name: 'B区', people: 1000, flooded: 900, severe: share * 1000, floodedShare: 0.9, severeShare: share });
    const deep = buildShelterData(shelters, summary, facilities, boundary, new Map([['B区', ex(0.745)]]));
    expect(deep.wards.find((w) => w.name === 'B区')?.gap).toBe('unpublished-deep');
    expect(deep.gapPolygons).toHaveLength(1); // 網掛けは、深い・小さいで同じ
    expect(deep.hatch.length).toBeGreaterThan(2);
    expect(deep.unpubDeep.polygons).toHaveLength(1);
    expect(deep.unpubDeep.outline).toHaveLength(1);
    expect(deep.unpubDeep.labels).toEqual([{ position: [1500, 500], text: 'B区\n未公開' }]);
    expect(deep.deep.polygons).toEqual([]); // 琥珀の斜線（指定がない区）には入れない
    const o = shelterOverview(deep);
    expect(o.unpublishedDeep).toEqual([{ name: 'B区', total: 0, severeShare: 0.745, floodedShare: 0.9 }]);
    expect(o.unpublishedShallow).toEqual([]);
    expect(o.unpublished).toEqual(['B区']);
    expect(o.deepWithoutShelter.map((w) => w.name)).toEqual(['B区']);
    const shallow = buildShelterData(shelters, summary, facilities, boundary, new Map([['B区', ex(0.0)]]));
    expect(shallow.wards.find((w) => w.name === 'B区')?.gap).toBe('unpublished');
    expect(shallow.unpubDeep.polygons).toEqual([]);
  });
  it('浸水が深い区の数は、指定がない区とデータ未公開の区を合わせる（浸水の深さの大きい順）', () => {
    const ex = (name: string, share: number): [string, WardExposure] => [name, { name, people: 1000, flooded: 900, severe: share * 1000, floodedShare: 0.9, severeShare: share }];
    const d = buildShelterData(shelters, summary, facilities, boundary, new Map([ex('B区', 0.6), ex('C区', 0.75)]));
    const o = shelterOverview(d);
    expect(o.deepNone.map((w) => w.name)).toEqual(['C区']);
    expect(o.unpublishedDeep.map((w) => w.name)).toEqual(['B区']);
    expect(o.deepWithoutShelter.map((w) => w.name)).toEqual(['C区', 'B区']);
    // 区の名前は決め打ちにしない：浸水の想定が入れ替わると、区の分類も入れ替わる
    const swapped = shelterOverview(buildShelterData(shelters, summary, facilities, boundary, new Map([ex('B区', 0.01), ex('C区', 0.01)])));
    expect(swapped.deepWithoutShelter).toEqual([]);
    expect(swapped.unpublishedShallow.map((w) => w.name)).toEqual(['B区']);
    expect(swapped.shallowNone.map((w) => w.name)).toEqual(['C区']);
  });
  it('浸水が小さい区は、薄い塗りだけ（斜線・縁・ラベルなし）', () => {
    expect(data.shallow).toHaveLength(1);
    expect(data.deep.polygons).toEqual([]);
    expect(data.deep.hatch).toEqual([]);
    expect(data.deep.labels).toEqual([]);
  });
});

describe('sampleShelters（探針）', () => {
  it('洪水・高潮で使える最寄りの避難場所と、最寄りの病院を、名前と距離で', () => {
    const v = sampleShelters(data, 600, 500);
    expect(v[0]).toEqual({ label: '最寄りの避難場所', value: 'A中（A区・洪水・200m）' });
    expect(v[1].value).toBe('B病院（900m）');
  });
  it('使える場所は、地震・火事用（A高、C小）より遠くても、使えるほうを選ぶ', () => {
    const v = sampleShelters(data, 2400, 500);
    expect(String(v[0].value)).toContain('D小');
    expect(String(v[0].value)).toContain('高潮');
  });
  it('未公開の区では、その旨を添える。洪水・高潮用が 0 件の区でも、その旨を添える', () => {
    const b = sampleShelters(data, 1500, 500);
    expect(b[2].label).toBe('この区のデータ');
    expect(String(b[2].value)).toContain('B区は未公開');
    const c = sampleShelters(data, 2400, 500);
    expect(String(c[2].value)).toContain('C区は洪水・高潮用の指定が 0 件');
    expect(String(c[2].value)).toContain('浸水が小さく指定がない');
    expect(String(c[2].value)).toContain('2.0%');
    // 公開していて、使える場所がある区では、添えない
    expect(sampleShelters(data, 600, 500)).toHaveLength(2);
  });
  it('wardNote：書き分け。「指定がない」と「避難できない」を取り違えない（避難計画の内容は書かない）', () => {
    const w = (over: Partial<(typeof data.wards)[number]>) => ({ ...data.wards[2], ...over });
    const deep = wardNote(w({ name: 'Z区', gap: 'deep-none', exposure: { name: 'Z区', people: 100, flooded: 99, severe: 60, floodedShare: 0.99, severeShare: 0.603 } }))!;
    expect(deep).toBe('Z区は洪水・高潮用の指定が 0 件（地震・火事など 1 件）。人口の 60% が深さ 3m 以上の区域に住む：浸水が深いのに指定がない');
    const shallow = wardNote(w({ name: 'Y区', gap: 'shallow-none', exposure: { name: 'Y区', people: 100, flooded: 30, severe: 1, floodedShare: 0.3, severeShare: 0.007 } }))!;
    expect(shallow).toBe('Y区は洪水・高潮用の指定が 0 件（地震・火事など 1 件）。深さ 3m 以上の区域に住む人は人口の 0.7%：浸水が小さく指定がない');
    expect(wardNote(w({ name: 'X区', gap: 'unpublished', published: false, exposure: undefined }))).toBe('X区は未公開（このデータに指定緊急避難場所が載っていない。「ない」とは限らない）');
    const unpubShallow = wardNote(w({ name: 'X区', gap: 'unpublished', published: false, exposure: { name: 'X区', people: 100, flooded: 20, severe: 0, floodedShare: 0.2, severeShare: 0 } }))!;
    expect(unpubShallow).toBe('X区は未公開（このデータに指定緊急避難場所が載っていない。「ない」とは限らない）。深さ 3m 以上の区域に住む人は人口の 0%：浸水が小さい');
    const unpubDeep = wardNote(w({ name: 'S区', gap: 'unpublished-deep', published: false, exposure: { name: 'S区', people: 100, flooded: 100, severe: 75, floodedShare: 1, severeShare: 0.745 } }))!;
    expect(unpubDeep).toBe('S区は未公開（このデータに指定緊急避難場所が載っていない。「ない」とは限らない）。人口の 75% が深さ 3m 以上の区域に住む：浸水が深い');
    expect(wardNote(w({ gap: null }))).toBeNull();
    for (const t of [deep, shallow, unpubShallow, unpubDeep]) expect(t).not.toMatch(/避難できない|広域避難|避難計画/);
  });
  it('usageLabel', () => {
    expect(usageLabel(true, true)).toBe('洪水・高潮');
    expect(usageLabel(true, false)).toBe('洪水');
    expect(usageLabel(false, true)).toBe('高潮');
  });
});

describe('subset・summarize（クローズアップ）', () => {
  it('円の中の数：洪水・高潮で使えるもの、それ以外、病院', () => {
    const s = subsetShelters(data, 500, 500, 400);
    const sum = summarizeShelters(s);
    expect(sum.slice(0, 3).map((v) => v.value)).toEqual([2, 0, 0]); // A小・A中
    const wide = summarizeShelters(subsetShelters(data, 2000, 500, 5000));
    expect(wide.slice(0, 3).map((v) => v.value)).toEqual([3, 2, 1]);
  });
  it('円がかかる、未公開の区と、洪水・高潮用が 0 件の区の名前を添える', () => {
    const rows = summarizeShelters(subsetShelters(data, 1500, 500, 600));
    expect(rows.find((r) => r.label === 'データ未公開で浸水が小さい区')?.value).toContain('B区');
    const both = summarizeShelters(subsetShelters(data, 2000, 500, 300));
    expect(both.find((r) => r.label === 'データ未公開で浸水が小さい区')?.value).toContain('B区');
    // 浸水が深いデータ未公開の区は、別の行に出る
    const deepData = buildShelterData(shelters, summary, facilities, boundary, new Map([['B区', { name: 'B区', people: 1000, flooded: 900, severe: 700, floodedShare: 0.9, severeShare: 0.7 }]]));
    const deepRows = summarizeShelters(subsetShelters(deepData, 1500, 500, 600));
    expect(deepRows.find((r) => r.label === 'データ未公開で浸水が深い区')?.value).toContain('B区');
    expect(deepRows.find((r) => r.label === 'データ未公開で浸水が小さい区')).toBeUndefined();
    expect(both.find((r) => r.label === '浸水が小さく洪水・高潮用の指定がない区')?.value).toContain('C区');
    // A 区の中だけの小さな円には、どちらも付かない
    const none = summarizeShelters(subsetShelters(data, 200, 500, 100));
    expect(none).toHaveLength(3);
  });
  it('切り出しは、網掛けを円で切る。円の外の sample は値なし', () => {
    const s = subsetShelters(data, 1500, 500, 300);
    expect(s.hatch.length).toBeGreaterThan(0);
    for (const seg of s.hatch) for (const [x, y] of seg) expect(Math.hypot(x - 1500, y - 500)).toBeLessThanOrEqual(300.5);
    expect(sampleShelters(s, 100, 100).map((v) => v.value)).toEqual([null, null]);
    expect(s.gapPolygons).toEqual([]);
  });
  it('wardsTouching：円の中心が区の中、または区の輪郭が円を通る', () => {
    expect(wardsTouching(data.wards, { cx: 500, cy: 500, r: 100 })).toEqual({ 'unpublished-deep': [], unpublished: [], 'deep-none': [], 'shallow-none': [], unrated: [] });
    expect(wardsTouching(data.wards, { cx: 2500, cy: 500, r: 100 })['shallow-none']).toEqual(['C区']);
    expect(wardsTouching(data.wards, { cx: 950, cy: 500, r: 100 }).unpublished).toEqual(['B区']);
    expect(wardsTouching(data.wards, { cx: 1500, cy: 500, r: 10 }).unpublished).toEqual(['B区']);
  });
});

describe('sectionShelters（断面）', () => {
  const line = { ax: 100, ay: 500, bx: 3900, by: 500 };
  it('線から 1 km 以内の避難場所と病院を、洪水・高潮用／それ以外／病院で見分ける（学校は出さない）', () => {
    const t = sectionShelters(data, line);
    expect(t.radius).toBe(1000);
    expect(t.marks.map((m) => [m.name, m.category])).toEqual([
      ['A小', 'shelter-usable'],
      ['A高', 'shelter-other'],
      ['A中', 'shelter-usable'],
      ['B病院', 'hospital'],
      ['C小', 'shelter-other'],
      ['D小', 'shelter-usable'],
    ]);
    // 線の左（北）が正
    expect(t.marks.find((m) => m.name === 'A高')?.offset).toBeCloseTo(400, 6);
    expect(t.marks.find((m) => m.name === 'A小')?.offset).toBeCloseTo(0, 6);
  });
  it('線から離れた避難場所は、線への垂線の足が線の外なら出さない', () => {
    const t = sectionShelters(data, { ax: 700, ay: 500, bx: 1600, by: 500 });
    expect(t.marks.map((m) => m.name)).toEqual(['A中', 'B病院']); // A小・A高は足が線の始点より手前、C小・D小は 1 km を超える
  });
  it('線が通る、未公開の区と、洪水・高潮用が 0 件の区の区間', () => {
    const gaps = sectionGaps(data, line);
    expect(gaps.map((g) => [g.kind, Math.round(g.d0), Math.round(g.d1)])).toEqual([
      ['unpublished', 900, 1900],
      ['shallow-none', 1900, 2900],
    ]);
    expect(gaps[0].label).toContain('B区');
    expect(gaps[0].label).toContain('データ未公開');
    expect(gaps[1].label).toContain('0 件');
    expect(gaps[1].label).toContain('浸水が小さく指定がない');
    expect(gaps[1].label).toContain('2.0%');
  });
  it('データ未公開で浸水が深い区間は、unpublished-deep で、割合と「浸水が深い」を添える', () => {
    const d = buildShelterData(shelters, summary, facilities, boundary, new Map([['B区', { name: 'B区', people: 1000, flooded: 990, severe: 745, floodedShare: 0.99, severeShare: 0.745 }]]));
    const gaps = sectionGaps(d, line);
    expect(gaps[0].kind).toBe('unpublished-deep');
    expect(gaps[0].label).toBe('B区（データ未公開。人口の 75% が深さ 3m 以上の区域に住む：浸水が深い）');
    expect(sectionShelters(d, line).gaps?.[0].kind).toBe('unpublished-deep');
  });
  it('mergeSpans：重なりと接する区間をつなぐ', () => {
    expect(mergeSpans([[5, 8], [0, 3], [2, 4], [8, 9]])).toEqual([[0, 4], [5, 9]]);
  });
  it('長さ 0 の線は、何も出さない', () => {
    const t = sectionShelters(data, { ax: 0, ay: 0, bx: 0, by: 0 });
    expect(t.marks).toEqual([]);
    expect(t.gaps).toEqual([]);
  });
});
