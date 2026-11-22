import { describe, expect, it } from 'vitest';
import type { BoundaryData, FacilityCollection, ShelterCollection, ShelterSummary } from '../../types';
import {
  buildShelterData,
  classifyWard,
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
const data = buildShelterData(shelters, summary, facilities, boundary);

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
  it('概況：使える数、未公開の区、指定なしの区（地震・火事などの数つき）', () => {
    const o = shelterOverview(data);
    expect(o.usable).toBe(3);
    expect(o.unpublished).toEqual(['B区']);
    expect(o.none).toEqual([{ name: 'C区', total: 1 }]);
  });
  it('区の種類は2つ：指定なし（データに載っていて 0 件）、未公開（データに載っていない）。使える場所のある区は null', () => {
    expect(data.wards.map((w) => [w.name, w.gap])).toEqual([
      ['A区', null],
      ['B区', 'unpublished'],
      ['C区', 'none'],
      ['D区', null],
    ]);
    expect(classifyWard({ published: false, usable: 0 })).toBe('unpublished');
    expect(classifyWard({ published: true, usable: 0 })).toBe('none');
    expect(classifyWard({ published: true, usable: 3 })).toBeNull();
  });
  it('指定なしの区は、輪郭の枠（斜線や塗りはない）。札は2区とも出る（区名／指定なし、区名／未公開）', () => {
    expect(data.frame).toHaveLength(1);
    expect(data.labels).toEqual([
      { position: [1500, 500], text: 'B区\n未公開', name: 'B区', status: '未公開', kind: 'unpublished' },
      { position: [2500, 500], text: 'C区\n指定なし', name: 'C区', status: '指定なし', kind: 'none' },
    ]);
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
  it('未公開の区では、その旨を添える。指定なしの区でも、その旨を添える', () => {
    const b = sampleShelters(data, 1500, 500);
    expect(b[2].label).toBe('この区のデータ');
    expect(String(b[2].value)).toContain('B区は未公開');
    const c = sampleShelters(data, 2400, 500);
    expect(String(c[2].value)).toBe('C区は指定なし（洪水・高潮用の指定が 0 件。地震・火事など 1 件）');
    // 公開していて、使える場所がある区では、添えない
    expect(sampleShelters(data, 600, 500)).toHaveLength(2);
  });
  it('wardNote：書き分け。「指定なし」と「避難できない」を取り違えない（避難計画の内容は書かない）', () => {
    const w = (over: Partial<(typeof data.wards)[number]>) => ({ ...data.wards[2], ...over });
    const none = wardNote(w({ name: 'Z区', gap: 'none' }))!;
    expect(none).toBe('Z区は指定なし（洪水・高潮用の指定が 0 件。地震・火事など 1 件）');
    const unpub = wardNote(w({ name: 'X区', gap: 'unpublished', published: false }))!;
    expect(unpub).toBe('X区は未公開（このデータに指定緊急避難場所が載っていない。「ない」とは限らない）');
    expect(wardNote(w({ gap: null }))).toBeNull();
    for (const t of [none, unpub]) expect(t).not.toMatch(/避難できない|広域避難|避難計画|浸水/);
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
  it('円がかかる、未公開の区と、指定なしの区の名前を添える', () => {
    const rows = summarizeShelters(subsetShelters(data, 1500, 500, 600));
    expect(rows.find((r) => r.label === '未公開の区')?.value).toContain('B区');
    const both = summarizeShelters(subsetShelters(data, 2000, 500, 300));
    expect(both.find((r) => r.label === '未公開の区')?.value).toContain('B区');
    expect(both.find((r) => r.label === '指定なしの区')?.value).toContain('C区');
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
  it('切り出しは、指定なしの枠の線と札も、円の中のものだけにする', () => {
    const s = subsetShelters(data, 2500, 500, 600);
    expect(s.frame.length).toBeGreaterThan(0);
    for (const seg of s.frame) for (const [x, y] of seg) expect(Math.hypot(x - 2500, y - 500)).toBeLessThanOrEqual(600.5);
    expect(s.labels.map((l) => l.name)).toEqual(['C区']);
    expect(subsetShelters(data, 200, 500, 100).labels).toEqual([]);
  });
  it('wardsTouching：円の中心が区の中、または区の輪郭が円を通る', () => {
    expect(wardsTouching(data.wards, { cx: 500, cy: 500, r: 100 })).toEqual({ none: [], unpublished: [] });
    expect(wardsTouching(data.wards, { cx: 2500, cy: 500, r: 100 }).none).toEqual(['C区']);
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
  it('線が通る、未公開の区と、指定なしの区の区間', () => {
    const gaps = sectionGaps(data, line);
    expect(gaps.map((g) => [g.kind, Math.round(g.d0), Math.round(g.d1)])).toEqual([
      ['unpublished', 900, 1900],
      ['none', 1900, 2900],
    ]);
    expect(gaps[0].label).toBe('B区（未公開：データに載っていない）');
    expect(gaps[1].label).toBe('C区（指定なし：洪水・高潮用の指定 0 件）');
    expect(sectionShelters(data, line).gaps?.map((g) => g.kind)).toEqual(['unpublished', 'none']);
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
